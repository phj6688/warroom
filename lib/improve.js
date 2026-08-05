'use strict';

// Problem-statement rewriter, shared by POST /api/improve and the MCP tool.
// The problem statement is the single largest quality lever on a deliberation,
// so both intake paths must rewrite it the same way.

const path = require('path');
const fs = require('fs');

const IMPROVER_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'meta', 'improver.md');

// Prompt file wins, env var is the fallback. Returns null when neither is
// usable, which callers surface as "improver not configured" rather than
// silently rewriting with an empty system prompt.
function improverSystemPrompt() {
  let systemPrompt = process.env.IMPROVER_SYSTEM_PROMPT;
  try {
    const fromFile = fs.readFileSync(IMPROVER_PROMPT_PATH, 'utf8').trim();
    if (fromFile) systemPrompt = fromFile;
  } catch (_) { /* file missing — fall through to env var */ }
  if (!systemPrompt || !systemPrompt.trim() || systemPrompt.trim() === '__PLACEHOLDER__') return null;
  return systemPrompt;
}

function improverUserMessage(problem) {
  return [
    'You are a prompt rewriter. Rewrite the PROBLEM STATEMENT below into a clearer, more structured version.',
    'Output ONLY the rewritten text. No preamble, no commentary, no questions, no solutions, no code.',
    'If it mentions attached files/screenshots, keep those references — do not ask to see them.',
    '',
    'PROBLEM STATEMENT:',
    `"""${problem}"""`,
    '',
    'REWRITTEN VERSION:',
  ].join('\n');
}

module.exports = { improverSystemPrompt, improverUserMessage, IMPROVER_PROMPT_PATH };
