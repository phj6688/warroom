const { log } = require('./logger');
const { appendFileSync } = require('fs');
const { join } = require('path');

const BASELINE_LOG = process.env.BASELINE_LOG || null;
const GATEWAY_URL = process.env.OPENAI_BASE_URL || null;
const GATEWAY_TOKEN = process.env.OPENAI_API_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';
const QUALITY_MODEL = process.env.QUALITY_MODEL || null;

const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

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

// In-flight LLM tracker — graceful shutdown awaits pending calls so an
// agent turn can finish writing its response before db.close() pulls the
// rug. We track promises (not just a counter) so they can also be awaited
// directly if a future caller wants to.
const inFlightLLMCalls = new Set();
function anyLLMInFlight() { return inFlightLLMCalls.size > 0; }
function inFlightLLMCount() { return inFlightLLMCalls.size; }

async function callAnthropic(systemPrompt, messages, agentId, maxTokens = 1500) {
  const tracker = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await _callOnce(systemPrompt, messages, agentId, maxTokens);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        }
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

// Tool-aware variant. Returns { text, toolCalls } where toolCalls is an array
// of { name, input }. Used by agent turns so escalations can be delivered as
// structured tool_use blocks instead of prose that the model forgets to tag.
async function callAnthropicWithTools(systemPrompt, messages, agentId, tools, maxTokens = 1500) {
  const tracker = (async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await _callOnceWithTools(systemPrompt, messages, agentId, tools, maxTokens);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        }
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

async function _callOnce(systemPrompt, messages, agentId, maxTokens) {
  const model = resolveModel(agentId);

  if (GATEWAY_URL && GATEWAY_TOKEN) {
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: openaiMessages })
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Gateway error (${res.status}): ${err}`); }
    const data = await res.json();
    if (!data.choices?.[0]?.message?.content) throw new Error('Gateway returned empty response');
    if (BASELINE_LOG && data.usage) {
      const entry = JSON.stringify({ agent: agentId, model, usage: data.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    return data.choices[0].message.content;
  }
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const modelId = model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
    const response = await client.messages.create({ model: modelId, max_tokens: maxTokens, system: systemPrompt, messages });
    if (!response.content?.[0]?.text) throw new Error('Anthropic returned empty response');
    if (BASELINE_LOG && response.usage) {
      const entry = JSON.stringify({ agent: agentId, model: modelId, usage: response.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    return response.content[0].text;
  }
  throw new Error('No LLM configuration available');
}

async function _callOnceWithTools(systemPrompt, messages, agentId, tools, maxTokens) {
  const model = resolveModel(agentId);

  if (GATEWAY_URL && GATEWAY_TOKEN) {
    const openaiTools = (tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const body = { model, max_tokens: maxTokens, messages: openaiMessages };
    if (openaiTools.length > 0) body.tools = openaiTools;
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Gateway error (${res.status}): ${err}`); }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Gateway returned empty response');
    const text = typeof msg.content === 'string' ? msg.content : '';
    const toolCalls = (msg.tool_calls || []).map(tc => ({
      name: tc.function?.name,
      input: _safeJsonParse(tc.function?.arguments) || {},
    }));
    if (BASELINE_LOG && data.usage) {
      const entry = JSON.stringify({ agent: agentId, model, usage: data.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    if (!text && toolCalls.length === 0) throw new Error('Gateway returned empty response');
    return { text, toolCalls };
  }
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const modelId = model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
    const req = { model: modelId, max_tokens: maxTokens, system: systemPrompt, messages };
    if (tools && tools.length > 0) req.tools = tools;
    const response = await client.messages.create(req);
    const blocks = response.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input }));
    if (BASELINE_LOG && response.usage) {
      const entry = JSON.stringify({ agent: agentId, model: modelId, usage: response.usage, ts: Date.now() });
      try { appendFileSync(join(process.cwd(), BASELINE_LOG), entry + '\n'); } catch (_) {}
    }
    if (!text && toolCalls.length === 0) throw new Error('Anthropic returned empty response');
    return { text, toolCalls };
  }
  throw new Error('No LLM configuration available');
}

module.exports = { callAnthropic, callAnthropicWithTools, resolveModel, QUALITY_MODEL, anyLLMInFlight, inFlightLLMCount };
