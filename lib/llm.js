const { log } = require('./logger');

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || null;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || null;
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
    return data.choices[0].message.content;
  }
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const modelId = model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
    const response = await client.messages.create({ model: modelId, max_tokens: maxTokens, system: systemPrompt, messages });
    if (!response.content?.[0]?.text) throw new Error('Anthropic returned empty response');
    return response.content[0].text;
  }
  throw new Error('No LLM configuration available');
}

module.exports = { callAnthropic, resolveModel, QUALITY_MODEL, anyLLMInFlight, inFlightLLMCount };
