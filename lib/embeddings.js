const { log } = require('./logger');

// embed-gateway speaks OpenAI's embeddings shape. Old direct-to-Ollama
// shape (`embeddings: [[...]]`) is no longer accepted by this client —
// pointing it at raw Ollama will fail loudly via the dim/shape guard.
const EMBED_GATEWAY_URL = process.env.EMBED_GATEWAY_URL || 'http://embed-gateway:8200';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || 768;
const EMBEDDING_TIMEOUT = Number(process.env.EMBEDDING_TIMEOUT_MS) || 10000;

/**
 * Embed text into a Float32Array via the embed-gateway.
 * Returns null on any failure — caller continues without semantic recall.
 *
 * Contract: single-input request. Response is `{data: [{embedding, index}], ...}`.
 * Batch would require sorting by `data[i].index`; we read `data[0].embedding`
 * directly here since the request is a single string.
 */
async function embed(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT);

  try {
    const res = await fetch(`${EMBED_GATEWAY_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let bodyText = '';
      let requestId;
      let code;
      let message;
      try {
        const errBody = await res.json();
        if (errBody && typeof errBody === 'object' && errBody.error) {
          requestId = errBody.error.request_id;
          code = errBody.error.code;
          message = errBody.error.message;
        }
        bodyText = JSON.stringify(errBody);
      } catch {
        try { bodyText = await res.text(); } catch { bodyText = ''; }
      }
      log.warn(
        { status: res.status, code, message, request_id: requestId, body: bodyText },
        'embed-gateway error'
      );
      return null;
    }

    const data = await res.json();
    const raw = data.data?.[0]?.embedding;
    if (!Array.isArray(raw) || raw.length !== EMBEDDING_DIM) {
      log.warn(
        { expected: EMBEDDING_DIM, got: Array.isArray(raw) ? raw.length : 0 },
        'embedding dimension mismatch'
      );
      return null;
    }

    return new Float32Array(raw);
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('embed-gateway request timed out');
    } else {
      log.warn({ err: err.message }, 'embed-gateway unavailable');
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Rough token count estimate (~4 chars per token).
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

module.exports = { embed, estimateTokens, EMBEDDING_DIM };
