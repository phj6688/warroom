const { createFilesServiceClient, FilesServiceError } = require('../../lib/clients/files-service');

describe('files-service client', () => {
  const URL = 'http://localhost:9100';
  const TOKEN = 'test-token';
  let client;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = createFilesServiceClient({ url: URL, token: TOKEN });
  });

  it('throws if url or token missing', () => {
    expect(() => createFilesServiceClient({ url: '', token: TOKEN })).toThrow('requires url + token');
    expect(() => createFilesServiceClient({ url: URL, token: '' })).toThrow('requires url + token');
  });

  it('health() calls GET /healthz with bearer header', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"status":"ok"}',
    });
    const result = await client.health();
    expect(result).toEqual({ status: 'ok' });
    expect(spy).toHaveBeenCalledOnce();
    const [url, opts] = spy.mock.calls[0];
    expect(url).toBe(`${URL}/healthz`);
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(opts.method).toBe('GET');
  });

  it('getFile() constructs correct URL with include_text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"id":"f1","sha256":"abc","name":"test.txt"}',
    });
    await client.getFile('f1', { includeText: true });
    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${URL}/v1/files/f1?include_text=true`);
  });

  it('getFile() without include_text omits query param', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"id":"f1"}',
    });
    await client.getFile('f1');
    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${URL}/v1/files/f1`);
  });

  it('throws FilesServiceError on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"error":"not found"}',
    });
    await expect(client.getFile('missing')).rejects.toThrow(FilesServiceError);
    try {
      await client.getFile('missing');
    } catch (err) {
      expect(err.status).toBe(404);
      expect(err.body).toEqual({ error: 'not found' });
    }
  });

  it('throws FilesServiceError on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client.health()).rejects.toThrow(FilesServiceError);
    try {
      await client.health();
    } catch (err) {
      expect(err.message).toContain('network error');
      expect(err.cause).toBeDefined();
    }
  });

  it('retrieve() sends JSON body with query and top_k', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"results":[]}',
    });
    await client.retrieve('f1', 'test query', 3);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${URL}/v1/files/f1/retrieve`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.query).toBe('test query');
    expect(body.top_k).toBe(3);
  });

  it('uploadFiles() sends multipart form with files', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"files":[{"id":"f1","sha256":"abc"}]}',
    });
    await client.uploadFiles([{
      buffer: Buffer.from('hello'),
      name: 'test.txt',
      mime: 'text/plain',
    }]);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe(`${URL}/v1/files`);
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('strips trailing slash from base URL', async () => {
    const c = createFilesServiceClient({ url: 'http://localhost:9100/', token: TOKEN });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{"status":"ok"}',
    });
    await c.health();
    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('http://localhost:9100/healthz');
  });
});
