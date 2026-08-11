// warroom_list_models — MCP clients could set a model but had no way to see
// which ids the provider actually serves. The tool returns the same catalog
// GET /api/settings/models serves the panel, so both surfaces agree. Driven
// through a real MCP client against a spawned server and a stub gateway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer, getFreePort } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-listmodels0001';

let stub, stubPort, server, client;

before(async () => {
  stubPort = await getFreePort();
  stub = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'claude-opus-5' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

  server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      MCP_API_KEY: MCP_KEY,
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENAI_API_KEY: 'stub-key',
      MODEL: 'claude-opus-5',
      OPENROUTER_API_KEY: '',
    },
  });
  client = new Client({ name: 'list-models-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`)));
});

after(async () => {
  await client?.close();
  await server?.dispose();
  await new Promise((r) => stub.close(r));
});

function textOf(res) {
  return (res.content || []).map(c => c.text || '').join('\n');
}

test('warroom_list_models is advertised and lists the default provider catalog', async () => {
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.ok(tools.includes('warroom_list_models'));

  const res = await client.callTool({ name: 'warroom_list_models', arguments: {} });
  const text = textOf(res);
  assert.match(text, /2 models via default/);
  assert.match(text, /claude-opus-5/);
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /warroom_set_model/);
});

test('a credential-less route answers FAILED as data', async () => {
  const res = await client.callTool({ name: 'warroom_list_models', arguments: { route: 'openrouter' } });
  assert.match(textOf(res), /FAILED — openrouter: .*no credentials/i);
});

test('an unknown route is a tool error naming the valid ids', async () => {
  const res = await client.callTool({ name: 'warroom_list_models', arguments: { route: 'bogus' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /unknown route: bogus/);
});
