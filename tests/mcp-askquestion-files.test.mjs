// HLB-878 — MCP askQuestion inlined attached files by reading f.name / f.content,
// but after migration 013 session_files holds file_id + denormalized metadata
// (file_name, file_tokens, file_mime) with no content column, so every file
// rendered as "FILE: undefined\n[binary]". The formatting is now a pure helper
// that reads the real columns and surfaces honest metadata. Driven through a
// child script per the project convention (no test imports lib/*/mcp/* in-process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { formatAttachedFiles } = require('./mcp/http.js');

// Rows exactly as getSessionFiles returns them post-013 (SELECT * FROM session_files).
const rows = [
  { session_id: 's1', file_id: 'f1', file_sha256: 'abc', file_name: 'notes.txt', file_tokens: 42, file_mime: 'text/plain' },
  { session_id: 's1', file_id: 'f2', file_sha256: 'def', file_name: 'data.csv', file_tokens: 7, file_mime: 'text/csv' },
];
const out = formatAttachedFiles(rows);
assert.ok(out.includes('FILE: notes.txt (42 tokens, text/plain)'), 'first file rendered from the real columns');
assert.ok(out.includes('FILE: data.csv (7 tokens, text/csv)'), 'second file rendered');
assert.ok(!out.includes('undefined'), 'no "undefined" (the pre-013 f.name bug)');
assert.ok(!out.includes('[binary]'), 'no "[binary]" placeholder (the pre-013 f.content bug)');
assert.equal(formatAttachedFiles([]), '', 'empty list yields empty string');
assert.equal(formatAttachedFiles(null), '', 'null yields empty string');
console.log('mcp-askquestion-files assertions passed');
`;

test('askQuestion formats attached files from the post-013 columns, never "undefined" (HLB-878)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /mcp-askquestion-files assertions passed/);
});
