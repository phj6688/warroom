// Stub logger before requiring content-blocks
vi.mock('../../lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createContentBlockBuilder } = require('../../lib/prompt/content-blocks');

function stubDb(files = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => files),
    })),
  };
}

function stubClient(overrides = {}) {
  return {
    getFile: vi.fn(async (id, opts) => ({
      id,
      sha256: 'sha_' + id,
      name: 'file_' + id,
      mime: 'text/plain',
      tokens: 100,
      extraction_status: 'completed',
      extracted_text: 'extracted content for ' + id,
      ...overrides,
    })),
    getFileBlob: vi.fn(async () => ({
      buffer: Buffer.from('fake-image-data'),
      mime: 'image/png',
    })),
    getRagStatus: vi.fn(async () => ({ rag_status: 'ready' })),
    triggerChunking: vi.fn(async () => ({})),
    retrieve: vi.fn(async () => ({
      results: [
        { chunk_index: 0, similarity: 0.95, text: 'chunk text' },
      ],
    })),
  };
}

describe('content-blocks builder', () => {
  const session = { id: 'sess1', problem: 'What is the meaning of life?' };
  const config = { fileTokenBudget: 150000 };

  it('returns only problem text when no files attached', async () => {
    const builder = createContentBlockBuilder({ db: stubDb([]), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: session.problem });
  });

  it('emits text block for text-bearing file with correct Path C shape', async () => {
    const files = [{ file_id: 'f1', file_sha256: 'sha_f1', file_name: 'report.txt', file_tokens: 500, file_mime: 'text/plain' }];
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('===== ATTACHED FILE: report.txt');
    expect(blocks[0].text).toContain('extracted content for f1');
    expect(blocks[0].text).toContain('===== END FILE: report.txt =====');
    // Problem text is last
    expect(blocks[1]).toEqual({ type: 'text', text: session.problem });
  });

  it('emits image_url block for image file', async () => {
    const files = [{ file_id: 'img1', file_sha256: 'sha_img1', file_name: 'photo.png', file_tokens: 50, file_mime: 'image/png' }];
    const client = stubClient({ extraction_status: 'image' });
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: client, config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image_url');
    expect(blocks[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    // No cache_control
    expect(blocks[0]).not.toHaveProperty('cache_control');
  });

  it('emits error stub for failed extraction', async () => {
    const files = [{ file_id: 'bad1', file_sha256: 'sha_bad1', file_name: 'corrupt.pdf', file_tokens: 100, file_mime: 'application/pdf' }];
    const client = stubClient({ extraction_status: 'failed', extraction_error: 'corrupt header' });
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: client, config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('could not be extracted');
    expect(blocks[0].text).toContain('corrupt header');
  });

  it('emits error stub on sha256 mismatch', async () => {
    const files = [{ file_id: 'f1', file_sha256: 'wrong_sha', file_name: 'tampered.txt', file_tokens: 100, file_mime: 'text/plain' }];
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('integrity check failed');
  });

  it('routes largest file to RAG when budget exceeded', async () => {
    const files = [
      { file_id: 'small', file_sha256: 'sha_small', file_name: 'small.txt', file_tokens: 100, file_mime: 'text/plain' },
      { file_id: 'huge', file_sha256: 'sha_huge', file_name: 'huge.txt', file_tokens: 200000, file_mime: 'text/plain' },
    ];
    const client = stubClient();
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: client, config });
    const blocks = await builder.buildContentBlocks(session, {
      query: 'test query',
    });
    // small.txt inlined, huge.txt RAG-routed
    const textBlocks = blocks.filter(b => b.type === 'text');
    const inlinedFile = textBlocks.find(b => b.text.includes('===== ATTACHED FILE: small.txt'));
    const ragFile = textBlocks.find(b => b.text.includes('===== RAG RETRIEVAL: huge.txt'));
    expect(inlinedFile).toBeDefined();
    expect(ragFile).toBeDefined();
  });

  it('problem text is ALWAYS the last block', async () => {
    const files = [
      { file_id: 'f1', file_sha256: 'sha_f1', file_name: 'a.txt', file_tokens: 100, file_mime: 'text/plain' },
      { file_id: 'f2', file_sha256: 'sha_f2', file_name: 'b.txt', file_tokens: 100, file_mime: 'text/plain' },
    ];
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session);
    const last = blocks[blocks.length - 1];
    expect(last).toEqual({ type: 'text', text: session.problem });
  });

  it('uses contextText as final block when provided', async () => {
    const files = [{ file_id: 'f1', file_sha256: 'sha_f1', file_name: 'a.txt', file_tokens: 100, file_mime: 'text/plain' }];
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session, { contextText: 'FULL CONTEXT HERE' });
    const last = blocks[blocks.length - 1];
    expect(last.text).toBe('FULL CONTEXT HERE');
  });

  it('NEGATIVE: no cache_control anywhere in blocks', async () => {
    const files = [
      { file_id: 'f1', file_sha256: 'sha_f1', file_name: 'a.txt', file_tokens: 100, file_mime: 'text/plain' },
      { file_id: 'img1', file_sha256: 'sha_img1', file_name: 'photo.png', file_tokens: 50, file_mime: 'image/png' },
    ];
    const client = stubClient();
    client.getFile.mockImplementation(async (id) => {
      if (id === 'img1') return { id, sha256: 'sha_img1', extraction_status: 'image' };
      return { id, sha256: 'sha_' + id, extraction_status: 'completed', extracted_text: 'text' };
    });
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: client, config });
    const blocks = await builder.buildContentBlocks(session);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('cache_control');
  });

  it('NEGATIVE: no type "document" anywhere in blocks', async () => {
    const files = [{ file_id: 'f1', file_sha256: 'sha_f1', file_name: 'a.txt', file_tokens: 100, file_mime: 'text/plain' }];
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: stubClient(), config });
    const blocks = await builder.buildContentBlocks(session);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('"type":"document"');
  });

  it('emits error stub when files-service fetch fails', async () => {
    const files = [{ file_id: 'f1', file_sha256: 'sha_f1', file_name: 'unreachable.txt', file_tokens: 100, file_mime: 'text/plain' }];
    const client = stubClient();
    client.getFile.mockRejectedValue(new Error('ECONNREFUSED'));
    const builder = createContentBlockBuilder({ db: stubDb(files), filesServiceClient: client, config });
    const blocks = await builder.buildContentBlocks(session);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('could not be fetched from files-service');
    expect(blocks[0].text).toContain('ECONNREFUSED');
  });
});
