const { encodingForModel } = require('js-tiktoken');
const { log } = require('./logger');

// cl100k_base is used by Claude, GPT-4, etc.
const enc = encodingForModel('gpt-4o');

// Model context windows (tokens)
const MODEL_WINDOWS = {
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5': 200000,
  'claude-opus-4-8': 200000,
  'anthropic/claude-sonnet-4-5': 200000,
  'anthropic/claude-sonnet-4-6': 200000,
  'anthropic/claude-haiku-4-5': 200000,
  'anthropic/claude-opus-4-8': 200000,
};
const DEFAULT_WINDOW = 200000;

// Reserve tokens for system prompt + response
const SYSTEM_PROMPT_RESERVE = 2000;
const RESPONSE_RESERVE = 4000;

/**
 * Count exact tokens in text using cl100k_base encoding.
 */
function countTokens(text) {
  if (!text) return 0;
  return enc.encode(text).length;
}

/**
 * Trim messages array to fit within maxTokens budget.
 * Removes oldest messages first, always keeping the last message.
 */
function trimContext(messages, maxTokens) {
  if (!messages || messages.length === 0) return [];

  // Count total tokens
  let total = 0;
  const tokenCounts = messages.map(m => {
    const count = countTokens(typeof m === 'string' ? m : (m.content || ''));
    total += count;
    return count;
  });

  if (total <= maxTokens) return messages;

  // Always keep the last message (current prompt)
  const result = [...messages];
  let currentTotal = total;

  // Remove from the front until we're under budget
  while (result.length > 1 && currentTotal > maxTokens) {
    const removed = tokenCounts.shift();
    result.shift();
    currentTotal -= removed;
  }

  if (result.length < messages.length) {
    const trimmed = messages.length - result.length;
    log.info({ trimmed, before: total, after: currentTotal }, 'tokens: trimmed messages to fit context budget');
  }

  return result;
}

/**
 * Return available tokens for context after system prompt and response reserves.
 */
function contextBudget(model) {
  const window = MODEL_WINDOWS[model] || DEFAULT_WINDOW;
  return window - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;
}

module.exports = { countTokens, trimContext, contextBudget };
