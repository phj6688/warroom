const { log } = require('./logger');

const EMBEDDING_URL = process.env.EMBEDDING_URL || 'http://localhost:11434/api/embed';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const EMBEDDING_DIM = 768;
const EMBEDDING_TIMEOUT = 10000; // 10s

/**
 * Embed text into a Float32Array[768] via Ollama.
 * Returns null if Ollama is unavailable (graceful degradation).
 */
async function embed(text) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT);

    const res = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text() }, 'embedding error');
      return null;
    }

    const data = await res.json();
    const raw = data.embeddings?.[0];
    if (!raw || raw.length !== EMBEDDING_DIM) {
      log.warn({ expected: EMBEDDING_DIM, got: raw?.length || 0 }, 'embedding dimension mismatch');
      return null;
    }

    return new Float32Array(raw);
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('embedding request timed out');
    } else {
      log.warn({ err: err.message }, 'embedding unavailable');
    }
    return null;
  }
}

/**
 * Rough token count estimate (~4 chars per token).
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

module.exports = { embed, estimateTokens, EMBEDDING_DIM };
