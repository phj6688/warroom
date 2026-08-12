const { log } = require('./logger');
const { appendFileSync } = require('fs');
const { join } = require('path');
const { normalizeUsage, sumUsage } = require('./token-usage');
const appConfig = require('./app-config');

const BASELINE_LOG = process.env.BASELINE_LOG || null;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.MODEL || 'anthropic/claude-opus-4-8';
// An agent turn is uncapped by default. Any finite output budget is a guess at
// how many tokens a model will spend on reasoning before it emits its first
// character, and a low guess does not truncate the answer, it erases it: the
// call comes back finish_reason=length with empty content, which _callOnce
// throws as "Gateway returned empty response". 1500 did that on claude-opus-5
// via CLIProxy, and the 8000 that replaced it does the same on
// moonshotai/kimi-k3 via OpenRouter (measured: 8000 completion tokens, zero
// characters of content). Guessing higher only moves the cliff. So the default
// budget is no budget: OpenAI-compatible endpoints omit max_tokens and inherit
// the model's own ceiling, which on kimi-k3 is the full 1M context.
// Set AGENT_MAX_TOKENS to a positive integer to opt a deployment back into a cap.
const UNCAPPED = null;
// The Anthropic Messages API requires max_tokens, so there is no omit-it path
// on that transport. Uncapped there means the largest output every current
// Claude model accepts (Haiku 4.5 stops at 64K, Opus and Sonnet at 128K). A
// model with a lower ceiling names it in the 400, and _anthropicMaxTokens
// retries once at that number instead of failing the turn.
const ANTHROPIC_UNCAPPED_MAX_TOKENS = parsePositiveInt(process.env.ANTHROPIC_MAX_TOKENS) || 64000;
// Below this, reasoning models reliably burn the whole budget on reasoning and
// return empty content. Measured on claude-opus-5: 1024 and 1500 empty, 4096
// fine. Only relevant now to callers that still pass an explicit budget.
const REASONING_FLOOR = 4096;
// `parseInt` is not safe here: it accepts numeric prefixes, so a typo like
// `1500oops` would parse to 1500 and silently reinstate the exact dead zone
// this parser exists to keep out. Require a clean positive integer.
function parsePositiveInt(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
// Anything that is not a clean positive integer means uncapped, including 0 and
// the words an operator reaches for. A malformed value must never resolve to a
// number, because the failure mode of a wrong number is a silently empty agent.
function parseAgentMaxTokens(raw) {
  return parsePositiveInt(raw) || UNCAPPED;
}
const AGENT_MAX_TOKENS = parseAgentMaxTokens(process.env.AGENT_MAX_TOKENS);
if (process.env.AGENT_MAX_TOKENS && AGENT_MAX_TOKENS === UNCAPPED
    && !/^\s*(0|unlimited|none|off)\s*$/i.test(process.env.AGENT_MAX_TOKENS)) {
  log.warn({ raw: process.env.AGENT_MAX_TOKENS },
    'AGENT_MAX_TOKENS is not a positive integer; running uncapped');
} else if (AGENT_MAX_TOKENS !== UNCAPPED && AGENT_MAX_TOKENS < REASONING_FLOOR) {
  log.warn({ AGENT_MAX_TOKENS, REASONING_FLOOR },
    'AGENT_MAX_TOKENS is below the reasoning floor; reasoning models may return empty content');
}

// The Anthropic 400 for an over-ceiling budget names the real limit, e.g.
// "max_tokens: 200000 > 64000, which is the maximum allowed number of output
// tokens for claude-haiku-4-5".
function anthropicCeilingFromError(err) {
  const msg = String((err && err.message) || '');
  const m = msg.match(/max_tokens:\s*\d+\s*>\s*(\d+)/)
    || msg.match(/(\d+),?\s*which is the maximum allowed number of output tokens/i);
  return m ? Number(m[1]) : null;
}

// Run an Anthropic-transport call with a concrete max_tokens, since the API
// demands one. An explicit caller budget is passed through untouched; an
// uncapped turn asks for ANTHROPIC_UNCAPPED_MAX_TOKENS and, if the model says
// that is too high, retries once at the ceiling the model reported.
async function _anthropicMaxTokens(maxTokens, run) {
  const requested = maxTokens == null ? ANTHROPIC_UNCAPPED_MAX_TOKENS : maxTokens;
  try {
    return await run(requested);
  } catch (err) {
    if (maxTokens != null) throw err;
    const ceiling = anthropicCeilingFromError(err);
    if (!ceiling || ceiling >= requested) throw err;
    log.warn({ requested, ceiling }, 'model caps output below the uncapped default; retrying at its ceiling');
    return await run(ceiling);
  }
}
// Every LLM call carries a deadline. Nothing else in the deliberation loop has
// one: a provider that accepts a request and never answers parks the agent
// turn, its phase, and the whole session behind it, with no log line, no error
// row, and no phase advance to show for it.
//
// The default is generous on purpose. Measured on the 2026-08-12 run: a normal
// uncapped turn takes 60-300s (longest legitimate turn 304s), so a hung call is
// indistinguishable from a slow one for minutes. Ten minutes is past the
// slowest real turn and still finite, which is the whole point.
const LLM_TIMEOUT_MS = parsePositiveInt(process.env.LLM_TIMEOUT_MS) || 600_000;

// A dead connection is not a transient fault worth three more attempts: the
// turn already spent the full window. Match our own wrapped message exactly,
// never a substring of a provider body, so a 429 that happens to say "timeout"
// keeps its normal retry treatment.
const TIMEOUT_MESSAGE = 'LLM request timed out after';
function isTimeoutError(err) {
  const name = err && err.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  // The Anthropic SDK's APIConnectionTimeoutError never sets `name` — its
  // class body only calls super, so it inherits "Error". Checking `name` alone
  // was dead code, and the misclassified timeout fell through to the transient
  // backoff for three outer attempts on top of the SDK's own two.
  const ctor = err && err.constructor && err.constructor.name;
  if (ctor === 'APIConnectionTimeoutError') return true;
  const msg = String((err && err.message) || '');
  return msg.startsWith(TIMEOUT_MESSAGE) || /^Request timed out/i.test(msg);
}

// OpenRouter reserves the model's whole output ceiling against the credit
// balance when a request omits max_tokens, then refuses the request and names
// what the balance does cover: "You requested up to 65536 tokens, but can only
// afford 20722." On 2026-08-11 that took out 21 of 21 turns across three
// sessions. Ask again once for exactly what the balance covers.
const AFFORDABLE_TOKENS_RE = /can only afford (\d+)/i;

// The deadline has to cover the body, not just the headers. `fetch` resolves
// the moment headers arrive, so clearing the timer there leaves every byte of
// the response unbounded — and a gateway that flushes 200 OK and then trickles
// (or never finishes) the JSON reproduces the original hang exactly. Both reads
// therefore happen inside the try, while the timer is still live.
//
// AbortSignal.timeout() would also work in the server, where the in-flight
// socket keeps the loop alive; an explicit controller matches the files-service
// and search clients and still fires when nothing else holds the loop open.
async function _openaiPost(url, apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    if (isTimeoutError(err)) throw new Error(`${TIMEOUT_MESSAGE} ${LLM_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Single entry point for the OpenAI-compatible transport: one deadline, one
// credit-ceiling recovery, one error shape. Returns the parsed response body.
async function _openaiChat(route, body) {
  const url = `${route.baseUrl}/chat/completions`;
  const first = await _openaiPost(url, route.apiKey, body);
  if (first.ok) return first.data;

  const afford = first.status === 402 ? Number((AFFORDABLE_TOKENS_RE.exec(first.text) || [])[1]) : NaN;
  // Below the reasoning floor the retry is worse than the failure: the model
  // spends the budget on reasoning and returns a truncated fragment, which the
  // deliberation would then record as a complete agent message.
  if (Number.isFinite(afford) && afford >= REASONING_FLOOR && (body.max_tokens == null || afford < body.max_tokens)) {
    log.warn({ afford, model: body.model }, 'provider credit ceiling; retrying once at the affordable budget');
    const second = await _openaiPost(url, route.apiKey, { ...body, max_tokens: afford });
    if (!second.ok) throw new Error(`Gateway error (${second.status}): ${second.text}`);
    return second.data;
  }
  throw new Error(`Gateway error (${first.status}): ${first.text}`);
}

const QUALITY_MODEL = process.env.QUALITY_MODEL || null;

// HLB-336 — per-agent provider routing. Each route resolves to a transport plus
// a base URL and credential from env. Defaults are unchanged: when an agent has
// no configured route, resolveRoute() reproduces the previous global selection
// (the OPENAI_BASE_URL gateway when set, else the Anthropic SDK).
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
const CLIPROXY_GATEWAY_URL = process.env.CLIPROXY_GATEWAY_URL || null;
const CLIPROXY_GATEWAY_TOKEN = process.env.CLIPROXY_GATEWAY_TOKEN || null;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || 'ollama';

// Resolve a route id to its transport + endpoint + credential, or null when the
// route's credential/URL is not configured in this deployment.
function routeCreds(route) {
  switch (route) {
    case 'anthropic-api':
      return ANTHROPIC_API_KEY ? { transport: 'anthropic', apiKey: ANTHROPIC_API_KEY } : null;
    case 'openai-api':
      return OPENAI_API_KEY ? { transport: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: OPENAI_API_KEY } : null;
    case 'openrouter':
      return OPENROUTER_API_KEY ? { transport: 'openai', baseUrl: OPENROUTER_BASE_URL, apiKey: OPENROUTER_API_KEY } : null;
    case 'subscription':
      return (CLIPROXY_GATEWAY_URL && CLIPROXY_GATEWAY_TOKEN) ? { transport: 'openai', baseUrl: CLIPROXY_GATEWAY_URL, apiKey: CLIPROXY_GATEWAY_TOKEN } : null;
    case 'ollama-local':
      return { transport: 'openai', baseUrl: OLLAMA_BASE_URL, apiKey: OLLAMA_API_KEY };
    default:
      return null;
  }
}

// The env-derived default route, identical to the pre-HLB-336 global selection.
function defaultRoute() {
  if (OPENAI_BASE_URL && OPENAI_API_KEY) return { route: 'default', transport: 'openai', baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY };
  if (ANTHROPIC_API_KEY) return { route: 'anthropic-api', transport: 'anthropic', apiKey: ANTHROPIC_API_KEY };
  return null;
}

// Which configurable routes have working credentials here (for the Settings UI).
function availableRoutes() {
  const out = {};
  for (const r of appConfig.ROUTES) out[r] = !!routeCreds(r);
  return out;
}

// Resolve { route, model, transport, baseUrl, apiKey } for an agent. Per-agent
// config (Settings panel) wins; a configured route whose credentials are missing
// falls back to the default with a warning rather than hard-failing a
// deliberation. explicitModel (callLLMRaw) overrides the resolved model.
function resolveRoute(agentId, explicitModel) {
  const cfg = appConfig.getAgentRoute(agentId);
  const model = explicitModel || (cfg && cfg.model) || resolveModel(agentId);
  if (cfg && cfg.route) {
    // A non-default route needs an explicit model. Without one, `model` is the
    // global Anthropic default, which a non-Anthropic endpoint (openai-api,
    // ollama-local) would reject. Fall back to the default route rather than
    // ship a mismatched model id. The PUT handler blocks this combination, but
    // a row predating that check (or hand-edited) is guarded here too.
    const routeModel = explicitModel || (cfg && cfg.model);
    const creds = routeModel ? routeCreds(cfg.route) : null;
    if (creds) return { route: cfg.route, model, ...creds };
    if (!routeModel) log.warn({ agentId, route: cfg.route }, 'configured route has no model; falling back to default');
    else log.warn({ agentId, route: cfg.route }, 'configured route has no credentials; falling back to default');
  }
  const def = defaultRoute();
  if (!def) return { route: null, model, transport: null };
  return { ...def, model };
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
// A provider cooldown longer than this is not worth blocking an agent turn on;
// past it we fail fast and let the caller (the deliberation loop) move on.
const RATE_LIMIT_MAX_WAIT_S = 15;

// Classify an LLM/gateway error from its message. _call*Once throws
// `Gateway error (<status>): <body>`; a CLIProxy 429 body carries
// { code: 'model_cooldown', reset_seconds } while a raw Anthropic 429
// (rate_limit_error) carries no reset. Parsing the message keeps this
// independent of which transport produced the error.
function classifyGatewayError(err) {
  const msg = err && err.message ? String(err.message) : '';
  const m = msg.match(/Gateway error \((\d+)\)/);
  const status = m ? parseInt(m[1], 10) : null;
  const rateLimit = status === 429;
  let resetSeconds = null;
  if (rateLimit) {
    const rm = msg.match(/"reset_seconds"\s*:\s*(\d+(?:\.\d+)?)/);
    if (rm) resetSeconds = Math.ceil(parseFloat(rm[1]));
  }
  return { status, rateLimit, resetSeconds };
}

// Decide how long to wait before the next retry, or -1 to stop retrying now.
// Client errors (400/401/403/404) fail identically on every attempt, so they
// are not retried. A 429 cooldown runs tens of seconds to minutes: three blind
// 1-4s retries never clear it and only amplify the rate-limit storm, so wait at
// most once, and only when the reset is short enough to be worth the block. 5xx
// and transient/network errors keep the existing bounded backoff.
function retryDelayMs(err, attempt) {
  const { status, rateLimit, resetSeconds } = classifyGatewayError(err);
  // The call already spent its whole window, and a 402 that survived the
  // affordable-budget retry means the balance is genuinely empty. Neither
  // improves by asking again.
  if (isTimeoutError(err)) return -1;
  if (status === 400 || status === 401 || status === 402 || status === 403 || status === 404) return -1;
  if (rateLimit) {
    if (attempt === 0 && resetSeconds != null && resetSeconds <= RATE_LIMIT_MAX_WAIT_S) {
      return resetSeconds * 1000;
    }
    return -1;
  }
  if (attempt < MAX_RETRIES - 1) return BACKOFF_MS[attempt];
  return -1;
}

// Agents that use haiku-class model for cost efficiency
const HAIKU_AGENTS = new Set(['quality-evaluator', 'adversarial-twin', 'memory-analyzer', 'fingerprint-classifier']);

// Parse AGENT_MODEL_<id> env vars at startup (e.g., AGENT_MODEL_process-architect=custom-model)
const AGENT_MODEL_OVERRIDES = {};
for (const [key, value] of Object.entries(process.env)) {
  const match = key.match(/^AGENT_MODEL_(.+)$/);
  if (match && value) {
    AGENT_MODEL_OVERRIDES[match[1]] = value;
  }
}
if (Object.keys(AGENT_MODEL_OVERRIDES).length > 0) {
  log.info({ overrides: AGENT_MODEL_OVERRIDES }, 'per-agent model overrides loaded');
}

function resolveModel(agentId) {
  // 1. Explicit per-agent override from env
  if (AGENT_MODEL_OVERRIDES[agentId]) return AGENT_MODEL_OVERRIDES[agentId];
  // 2. Haiku-class agents use QUALITY_MODEL
  if (HAIKU_AGENTS.has(agentId) && QUALITY_MODEL) return QUALITY_MODEL;
  // 3. Default model
  return MODEL;
}

// Settings-panel probe: fire a 1-token completion at an explicit route+model
// pair (or the env default when route is blank) and report reachability, the
// resolved pair, and latency. No retries: the panel wants the first answer,
// not a smoothed one. Errors come back as data, never thrown, so the endpoint
// can always answer 200 with a verdict.
const TEST_CONNECTION_TIMEOUT_MS = 15000;
async function testConnection({ route = '', model = '' } = {}) {
  let r;
  if (route) {
    const creds = routeCreds(route);
    if (!creds) return { ok: false, route, model: model || null, error: 'route has no credentials configured in this deployment' };
    r = { route, ...creds };
  } else {
    const def = defaultRoute();
    if (!def) return { ok: false, route: 'default', model: model || null, error: 'no default provider configured' };
    r = def;
  }
  const resolvedModel = model || (route ? '' : MODEL);
  if (!resolvedModel) return { ok: false, route: r.route, model: null, error: 'a non-default route needs an explicit model' };

  const started = Date.now();
  try {
    if (r.transport === 'openai') {
      const res = await fetch(`${r.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${r.apiKey}` },
        body: JSON.stringify({ model: resolvedModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (!res.ok) { const err = await res.text(); throw new Error(`Gateway error (${res.status}): ${err}`); }
      await res.json();
    } else if (r.transport === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: r.apiKey, timeout: TEST_CONNECTION_TIMEOUT_MS, maxRetries: 0 });
      const modelId = resolvedModel.startsWith('anthropic/') ? resolvedModel.slice('anthropic/'.length) : resolvedModel;
      await client.messages.create({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    } else {
      throw new Error('No LLM configuration available');
    }
    return { ok: true, route: r.route, model: resolvedModel, latencyMs: Date.now() - started };
  } catch (err) {
    // Cap the provider's error body so a verbose gateway page cannot flood
    // the panel; the useful part (status + code) is always at the front.
    const msg = String(err && err.message || err).slice(0, 300);
    return { ok: false, route: r.route, model: resolvedModel, latencyMs: Date.now() - started, error: msg };
  }
}

// Model catalog for a route: ask the provider which model ids it serves so the
// Settings panel and MCP clients can offer real ids instead of typed guesses.
// OpenAI-compatible endpoints expose GET /models; the Anthropic API has its own
// paginated list. Same contract as testConnection: provider failures are data
// ({ ok:false, error }), never thrown, so callers always get a verdict.
const LIST_MODELS_TIMEOUT_MS = 10000;
async function listModels({ route = '' } = {}) {
  let r;
  if (route) {
    const creds = routeCreds(route);
    if (!creds) return { ok: false, route, models: [], error: 'route has no credentials configured in this deployment' };
    r = { route, ...creds };
  } else {
    const def = defaultRoute();
    if (!def) return { ok: false, route: 'default', models: [], error: 'no default provider configured' };
    r = def;
  }
  try {
    let ids;
    if (r.transport === 'openai') {
      const res = await fetch(`${r.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${r.apiKey}` },
        signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
      });
      if (!res.ok) { const body = await res.text(); throw new Error(`Gateway error (${res.status}): ${body}`); }
      const body = await res.json();
      ids = (Array.isArray(body.data) ? body.data : []).map(m => m && m.id).filter(id => typeof id === 'string');
    } else if (r.transport === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: r.apiKey, timeout: LIST_MODELS_TIMEOUT_MS, maxRetries: 0 });
      ids = [];
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    } else {
      throw new Error('No LLM configuration available');
    }
    return { ok: true, route: r.route, models: [...new Set(ids)].sort() };
  } catch (err) {
    const msg = String(err && err.message || err).slice(0, 300);
    return { ok: false, route: r.route, models: [], error: msg };
  }
}

// In-flight LLM tracker — graceful shutdown awaits pending calls so an
// agent turn can finish writing its response before db.close() pulls the
// rug. We track promises (not just a counter) so they can also be awaited
// directly if a future caller wants to.
const inFlightLLMCalls = new Set();
function anyLLMInFlight() { return inFlightLLMCalls.size > 0; }
function inFlightLLMCount() { return inFlightLLMCalls.size; }

// `onUsage`, when supplied, is invoked once with the call's normalized usage
// ({ input_tokens, output_tokens, total_tokens }) so a session-aware caller can
// add it to that session's tally. The return value stays a bare string for
// backward compatibility with every existing call site.
async function callAnthropic(systemPrompt, messages, agentId, maxTokens = AGENT_MAX_TOKENS, onUsage = null) {
  const tracker = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await _callOnce(systemPrompt, messages, agentId, maxTokens, onUsage);
      } catch (err) {
        lastError = err;
        const delayMs = retryDelayMs(err, attempt);
        if (delayMs < 0) break;
        const rl = classifyGatewayError(err);
        if (rl.rateLimit) {
          log.warn({ agentId, resetSeconds: rl.resetSeconds, waitMs: delayMs }, 'llm rate-limited; single bounded wait before one retry');
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  })();
  inFlightLLMCalls.add(tracker);
  try {
    return await tracker;
  } finally {
    inFlightLLMCalls.delete(tracker);
  }
}

// Tool-aware variant. Returns { text, toolCalls, usage } where toolCalls is an
// array of { name, input } and usage is the call's normalized token usage
// ({ input_tokens, output_tokens, total_tokens }). Used by agent turns so
// escalations can be delivered as structured tool_use blocks instead of prose
// that the model forgets to tag.
async function callAnthropicWithTools(systemPrompt, messages, agentId, tools, maxTokens = AGENT_MAX_TOKENS) {
  const tracker = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await _callOnceWithTools(systemPrompt, messages, agentId, tools, maxTokens);
      } catch (err) {
        lastError = err;
        const delayMs = retryDelayMs(err, attempt);
        if (delayMs < 0) break;
        const rl = classifyGatewayError(err);
        if (rl.rateLimit) {
          log.warn({ agentId, resetSeconds: rl.resetSeconds, waitMs: delayMs }, 'llm rate-limited; single bounded wait before one retry');
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  })();
  inFlightLLMCalls.add(tracker);
  try {
    return await tracker;
  } finally {
    inFlightLLMCalls.delete(tracker);
  }
}

function _safeJsonParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function _reportUsage(onUsage, rawUsage) {
  if (typeof onUsage !== 'function' || !rawUsage) return;
  try { onUsage(normalizeUsage(rawUsage)); } catch (_) { /* never let accounting break a call */ }
}

async function _callOnce(systemPrompt, messages, agentId, maxTokens, onUsage = null) {
  const r = resolveRoute(agentId);
  const model = r.model;

  if (r.transport === 'openai') {
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const body = { model, messages: openaiMessages };
    if (maxTokens != null) body.max_tokens = maxTokens;
    const data = await _openaiChat(r, body);
    if (!data.choices?.[0]?.message?.content) throw new Error('Gateway returned empty response');
    if (BASELINE_LOG && data.usage) {
      const entry = JSON.stringify({ agent: agentId, model, route: r.route, usage: data.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    _reportUsage(onUsage, data.usage);
    return data.choices[0].message.content;
  }
  if (r.transport === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: r.apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
    const modelId = model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
    const response = await _anthropicMaxTokens(maxTokens, (max_tokens) =>
      client.messages.create({ model: modelId, max_tokens, system: systemPrompt, messages }));
    if (!response.content?.[0]?.text) throw new Error('Anthropic returned empty response');
    if (BASELINE_LOG && response.usage) {
      const entry = JSON.stringify({ agent: agentId, model: modelId, route: r.route, usage: response.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    _reportUsage(onUsage, response.usage);
    return response.content[0].text;
  }
  throw new Error('No LLM configuration available');
}

async function _callOnceWithTools(systemPrompt, messages, agentId, tools, maxTokens) {
  const r = resolveRoute(agentId);
  const model = r.model;

  if (r.transport === 'openai') {
    const openaiTools = (tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const body = { model, messages: openaiMessages };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (openaiTools.length > 0) body.tools = openaiTools;
    const data = await _openaiChat(r, body);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Gateway returned empty response');
    const text = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls = (msg.tool_calls || []).map(tc => ({
      name: tc.function?.name,
      input: _safeJsonParse(tc.function?.arguments) || {},
    }));
    if (BASELINE_LOG && data.usage) {
      const entry = JSON.stringify({ agent: agentId, model, route: r.route, usage: data.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    if (!text && toolCalls.length === 0) throw new Error('Gateway returned empty response');
    return { text, toolCalls, usage: normalizeUsage(data.usage), model, route: r.route };
  }
  if (r.transport === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: r.apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
    const modelId = model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
    const req = { model: modelId, system: systemPrompt, messages };
    if (tools && tools.length > 0) req.tools = tools;
    const response = await _anthropicMaxTokens(maxTokens, (max_tokens) =>
      client.messages.create({ ...req, max_tokens }));
    const blocks = response.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input }));
    if (BASELINE_LOG && response.usage) {
      const entry = JSON.stringify({ agent: agentId, model: modelId, route: r.route, usage: response.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    if (!text && toolCalls.length === 0) throw new Error('Anthropic returned empty response');
    return { text, toolCalls, usage: normalizeUsage(response.usage), model: modelId, route: r.route };
  }
  throw new Error('No LLM configuration available');
}

// ─── callLLMRaw ──────────────────────────────────────────────
// Canonical Anthropic-shape input and output. Used by the tool_use loop,
// which needs the protocol-level fidelity (stop_reason, tool_use_id) that
// callAnthropicWithTools flattens away.
//
// Input shape (Anthropic canonical):
//   - model:     string (with or without "anthropic/" prefix)
//   - system:    string
//   - messages:  [{role: 'user'|'assistant', content: string | Block[]}]
//                Block: {type:'text',text} | {type:'tool_use',id,name,input}
//                     | {type:'tool_result',tool_use_id,content,is_error?}
//   - tools:     [{name, description, input_schema}]
//   - maxTokens: number|undefined
//
// Output shape (Anthropic canonical):
//   { stop_reason, content: Block[], usage }
//
// Gateway path translates both directions to/from OpenAI's chat-completions
// format. Native Anthropic SDK path is passthrough.

function _stopReasonFromFinish(fr) {
  if (fr === 'tool_calls') return 'tool_use';
  if (fr === 'stop') return 'end_turn';
  if (fr === 'length') return 'max_tokens';
  return fr || 'end_turn';
}

function _toOpenAIMessages(messages) {
  // Expand each canonical message into one or more OpenAI messages. tool_result
  // blocks split out as separate {role:'tool'} messages; mixed user content
  // is preserved in order.
  const out = [];
  for (const msg of messages || []) {
    const role = msg.role;
    const content = msg.content;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const b of content) {
        if (b.type === 'text') textParts.push(b.text || '');
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      const assistantMsg = { role: 'assistant', content: textParts.join('') };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }

    // user
    const trailingText = [];
    for (const b of content) {
      if (b.type === 'tool_result') {
        let c = b.content;
        if (Array.isArray(c)) {
          c = c.map(x => (x && x.type === 'text') ? x.text : '').join('');
        }
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof c === 'string' ? c : JSON.stringify(c) });
      } else if (b.type === 'text') {
        trailingText.push(b.text || '');
      }
    }
    if (trailingText.length > 0) {
      out.push({ role: 'user', content: trailingText.join('') });
    }
  }
  return out;
}

function _blocksFromOpenAIMessage(msg) {
  const blocks = [];
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function?.name,
      input: _safeJsonParse(tc.function?.arguments) || {},
    });
  }
  return blocks;
}

async function callLLMRaw({ model, system, messages, tools, maxTokens = AGENT_MAX_TOKENS, agentId } = {}) {
  const tracker = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await _callLLMRawOnce({ model, system, messages, tools, maxTokens, agentId });
      } catch (err) {
        lastError = err;
        const delayMs = retryDelayMs(err, attempt);
        if (delayMs < 0) break;
        const rl = classifyGatewayError(err);
        if (rl.rateLimit) {
          log.warn({ agentId, resetSeconds: rl.resetSeconds, waitMs: delayMs }, 'llm rate-limited; single bounded wait before one retry');
        }
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  })();
  inFlightLLMCalls.add(tracker);
  try {
    return await tracker;
  } finally {
    inFlightLLMCalls.delete(tracker);
  }
}

async function _callLLMRawOnce({ model, system, messages, tools, maxTokens, agentId }) {
  const r = resolveRoute(agentId, model);
  const useModel = r.model;

  if (r.transport === 'openai') {
    const openaiTools = (tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const openaiMessages = [
      { role: 'system', content: system || '' },
      ..._toOpenAIMessages(messages),
    ];
    const body = { model: useModel, messages: openaiMessages };
    if (maxTokens != null) body.max_tokens = maxTokens;
    if (openaiTools.length > 0) body.tools = openaiTools;
    const data = await _openaiChat(r, body);
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Gateway returned empty response');
    const content = _blocksFromOpenAIMessage(choice.message || {});
    const stop_reason = _stopReasonFromFinish(choice.finish_reason);
    if (BASELINE_LOG && data.usage) {
      const entry = JSON.stringify({ agent: agentId, model: useModel, route: r.route, usage: data.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    return { stop_reason, content, usage: normalizeUsage(data.usage), model: useModel, route: r.route };
  }
  if (r.transport === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: r.apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
    const modelId = useModel.startsWith('anthropic/') ? useModel.slice('anthropic/'.length) : useModel;
    const req = { model: modelId, system, messages };
    if (tools && tools.length > 0) req.tools = tools;
    const response = await _anthropicMaxTokens(maxTokens, (max_tokens) =>
      client.messages.create({ ...req, max_tokens }));
    if (BASELINE_LOG && response.usage) {
      const entry = JSON.stringify({ agent: agentId, model: modelId, route: r.route, usage: response.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    return { stop_reason: response.stop_reason, content: response.content || [], usage: normalizeUsage(response.usage), model: modelId, route: r.route };
  }
  throw new Error('No LLM configuration available');
}

module.exports = { callAnthropic, callAnthropicWithTools, callLLMRaw, resolveModel, resolveRoute, availableRoutes, testConnection, listModels, QUALITY_MODEL, AGENT_MAX_TOKENS, REASONING_FLOOR, parseAgentMaxTokens, anyLLMInFlight, inFlightLLMCount };
