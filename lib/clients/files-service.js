const TIMEOUT_MS = 30_000;

class FilesServiceError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = 'FilesServiceError';
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

function createFilesServiceClient({ url, token }) {
  if (!url || !token) throw new Error('files-service client requires url + token');
  const base = url.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${token}` };

  async function req(method, path, { body, headers } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...auth, ...(headers || {}) },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      if (!res.ok) throw new FilesServiceError(`${method} ${path} ${res.status}`, { status: res.status, body: json });
      return json;
    } catch (err) {
      if (err instanceof FilesServiceError) throw err;
      throw new FilesServiceError(`${method} ${path} network error: ${err.message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async health() {
      return req('GET', '/healthz');
    },

    async uploadFiles(buffers /* [{ buffer, name, mime }] */) {
      const form = new FormData();
      for (const f of buffers) {
        const blob = new Blob([f.buffer], { type: f.mime || 'application/octet-stream' });
        form.append('files', blob, f.name || 'unnamed');
      }
      return req('POST', '/v1/files', { body: form });
    },

    async getFile(id, { includeText = false } = {}) {
      return req('GET', `/v1/files/${encodeURIComponent(id)}${includeText ? '?include_text=true' : ''}`);
    },

    async getFileText(id) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/files/${encodeURIComponent(id)}/text`, {
          headers: auth, signal: ctrl.signal,
        });
        if (!res.ok) throw new FilesServiceError(`GET /text ${res.status}`, { status: res.status });
        return await res.text();
      } catch (err) {
        if (err instanceof FilesServiceError) throw err;
        throw new FilesServiceError(`GET /text network error: ${err.message}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    },

    async getFileBlob(id) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/files/${encodeURIComponent(id)}/blob`, {
          headers: auth, signal: ctrl.signal,
        });
        if (!res.ok) throw new FilesServiceError(`GET /blob ${res.status}`, { status: res.status });
        return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') };
      } catch (err) {
        if (err instanceof FilesServiceError) throw err;
        throw new FilesServiceError(`GET /blob network error: ${err.message}`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    },

    async triggerChunking(id) {
      return req('POST', `/v1/files/${encodeURIComponent(id)}/chunks`);
    },

    async getRagStatus(id) {
      return req('GET', `/v1/files/${encodeURIComponent(id)}/rag-status`);
    },

    async retrieve(id, query, topK = 5) {
      return req('POST', `/v1/files/${encodeURIComponent(id)}/retrieve`, {
        body: JSON.stringify({ query, top_k: topK }),
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

module.exports = { createFilesServiceClient, FilesServiceError };
