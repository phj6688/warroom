const { readFileSync } = require('fs');
const { join } = require('path');

const E2E_REAL = process.env.E2E_REAL === '1';

describe.skipIf(!E2E_REAL)('e2e: real services roundtrip', () => {
  let warroomBaseUrl;
  let fsConfig;

  beforeAll(async () => {
    warroomBaseUrl = process.env.WARROOM_URL || 'http://localhost:8090';
    const res = await fetch(`${warroomBaseUrl}/api/files-service-config`);
    expect(res.ok).toBe(true);
    fsConfig = await res.json();
    expect(fsConfig.url).toBeTruthy();
    expect(fsConfig.token).toBeTruthy();
  });

  it('uploads a file to files-service and gets metadata back', async () => {
    const samplePath = join(__dirname, 'fixtures', 'sample.txt');
    const sampleContent = readFileSync(samplePath, 'utf-8');

    const form = new FormData();
    form.append('files', new Blob([sampleContent], { type: 'text/plain' }), 'sample.txt');

    const upRes = await fetch(`${fsConfig.url}/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fsConfig.token}` },
      body: form,
    });
    expect(upRes.ok).toBe(true);
    const { files } = await upRes.json();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBeTruthy();
    expect(files[0].tokens).toBeGreaterThan(0);
    expect(files[0].extraction_status).toBe('ok');
  }, 30000);

  it('creates a session with file_ids and gets a session back', async () => {
    // Upload first
    const form = new FormData();
    form.append('files', new Blob(['Test content for e2e'], { type: 'text/plain' }), 'e2e-test.txt');

    const upRes = await fetch(`${fsConfig.url}/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fsConfig.token}` },
      body: form,
    });
    expect(upRes.ok).toBe(true);
    const { files } = await upRes.json();

    // Create session with the file_id
    const sessRes = await fetch(`${warroomBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'E2E test: analyze the attached document',
        file_ids: [files[0].id],
      }),
    });
    expect(sessRes.ok).toBe(true);
    const session = await sessRes.json();
    expect(session.id).toBeTruthy();
  }, 30000);
});
