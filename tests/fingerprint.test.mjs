// HLB — fingerprint classifier must only ever persist one of the 10 archetype
// ids the prompt offers. A model that ignores the closed list and free-writes
// its own label used to be stored verbatim, which never matches
// ARCHETYPE_CONFIG in public/index.html and renders as permanently unclassified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFingerprintClassifier, buildClassifierUserTurn, ARCHETYPE_IDS } from '../lib/fingerprint.js';

const PROBLEM = 'Should we migrate the ingest pipeline from polling to a message queue?';

function classifierWithResponse(responseText) {
  const callAnthropic = async () => responseText;
  return createFingerprintClassifier({ callAnthropic, db: null, stmts: null, onTokenUsage: null });
}

// Captures what classify() actually puts on the wire.
function classifierCapturing(responseText = 'ARCHETYPE: technical-architecture\nCONFIDENCE: 0.9\nSPECIALISTS: none\nREASONING: x') {
  const calls = [];
  const callAnthropic = async (system, messages, agentId, maxTokens) => {
    calls.push({ system, messages, agentId, maxTokens });
    return responseText;
  };
  return { calls, ...createFingerprintClassifier({ callAnthropic, db: null, stmts: null, onTokenUsage: null }) };
}

test('classify() keeps an archetype id that is on the closed list', async () => {
  const { classify } = classifierWithResponse(
    'ARCHETYPE: technical-architecture\nCONFIDENCE: 0.9\nSPECIALISTS: engineering-infra\nREASONING: infra choice'
  );
  const result = await classify(PROBLEM);
  assert.equal(result.archetype, 'technical-architecture');
  assert.equal(result.confidence, 0.9);
});

test('classify() discards a free-text archetype the model invented off-list', async () => {
  const { classify } = classifierWithResponse(
    'ARCHETYPE: Message Queue Migration Strategy Review\nCONFIDENCE: 0.95\nSPECIALISTS: none\nREASONING: bespoke label'
  );
  const result = await classify(PROBLEM);
  assert.equal(result.archetype, null);
  assert.equal(result.confidence, 0.95, 'other fields still parse');
});

test('classify() is case-sensitive and whitespace-tolerant against the closed list', async () => {
  const { classify } = classifierWithResponse(
    'ARCHETYPE:   technical-architecture   \nCONFIDENCE: 0.8\nSPECIALISTS: none\nREASONING: padded'
  );
  const result = await classify(PROBLEM);
  assert.equal(result.archetype, 'technical-architecture');

  const { classify: classify2 } = classifierWithResponse(
    'ARCHETYPE: Technical-Architecture\nCONFIDENCE: 0.8\nSPECIALISTS: none\nREASONING: wrong case'
  );
  const result2 = await classify2(PROBLEM);
  assert.equal(result2.archetype, null, 'wrong-case id is not silently normalized');
});

// A gateway that fronts Claude Max replaces the caller's system prompt with its
// own, so the model can only ever act on the user turn. Everything the parser
// enforces has to be reachable from that turn alone.
test('the user turn alone carries every id the guard accepts', () => {
  const turn = buildClassifierUserTurn(PROBLEM);
  for (const id of ARCHETYPE_IDS) {
    assert.ok(turn.includes(id), `closed list is missing ${id} on the user turn`);
  }
});

test('the user turn alone names all four output labels', () => {
  const turn = buildClassifierUserTurn(PROBLEM);
  for (const label of ['ARCHETYPE:', 'CONFIDENCE:', 'SPECIALISTS:', 'REASONING:']) {
    assert.ok(turn.includes(label), `user turn is missing ${label}`);
  }
});

test('the user turn says ARCHETYPE is a category, not an answer to the problem', () => {
  // The observed failure was a model answering the brief: "ARCHETYPE: NO-GO".
  assert.match(buildClassifierUserTurn(PROBLEM), /not (your|the) (answer|verdict)/i);
});

test('classify() sends the closed list on the user turn, not only the system prompt', async () => {
  const c = classifierCapturing();
  await c.classify(PROBLEM);
  assert.equal(c.calls.length, 1);
  const userTurn = c.calls[0].messages[0].content;
  assert.equal(c.calls[0].messages[0].role, 'user');
  for (const id of ARCHETYPE_IDS) assert.ok(userTurn.includes(id), `${id} missing from the wire`);
  assert.ok(userTurn.includes(PROBLEM), 'problem statement missing from the wire');
});

test('classify() leaves enough token budget for all four lines', async () => {
  // Every live call came back at exactly 200 completion tokens, i.e. clipped.
  const c = classifierCapturing();
  await c.classify(PROBLEM);
  assert.ok(c.calls[0].maxTokens >= 300, `token budget too tight: ${c.calls[0].maxTokens}`);
});

test('the problem statement is still truncated before it goes on the wire', () => {
  const huge = 'x'.repeat(9000);
  const turn = buildClassifierUserTurn(huge);
  assert.ok(turn.includes('x'.repeat(5000)), 'problem statement was cut short of the 5000-char budget');
  assert.ok(!turn.includes('x'.repeat(5001)), 'problem statement was not truncated to 5000 chars');
});

test('the user turn alone carries the specialist vocabulary', () => {
  // spawnSpecialists() skips domains it cannot find in agent_templates, so a
  // model guessing names yields no specialists rather than wrong ones.
  const turn = buildClassifierUserTurn(PROBLEM);
  for (const domain of ['legal', 'security', 'engineering-infra', 'ux-design', 'research-methods']) {
    assert.ok(turn.includes(domain), `specialist domain ${domain} missing from the user turn`);
  }
});

// The behavioural version of the test above: this fake stands in for a gateway
// that discards the system prompt, so it never looks at `system` at all and can
// only answer by reading the closed list out of the user turn. It fails on any
// revision where the list lives solely in the system prompt — which is exactly
// the state that classified 0 of 52 sessions in production.
test('a model that never sees the system prompt can still answer from the user turn', async () => {
  const gatewayThatDropsSystemPrompts = async (_system, messages) => {
    const turn = messages[0].content;
    const offered = [...turn.matchAll(/^- ([a-z-]+)$/gm)].map((m) => m[1]);
    if (offered.length === 0) return 'I am not sure what an ARCHETYPE is.\nARCHETYPE: NO-GO\nCONFIDENCE: 0.95';
    const problemIsInfra = /queue|pipeline|infrastructure/i.test(turn);
    const pick = problemIsInfra ? offered.find((o) => o === 'technical-architecture') : offered[0];
    return `ARCHETYPE: ${pick}\nCONFIDENCE: 0.9\nSPECIALISTS: none\nREASONING: derived from the user turn alone`;
  };
  const { classify } = createFingerprintClassifier({
    callAnthropic: gatewayThatDropsSystemPrompts, db: null, stmts: null, onTokenUsage: null,
  });
  const result = await classify(PROBLEM);
  assert.equal(result.archetype, 'technical-architecture');
  assert.equal(result.confidence, 0.9);
});

test('the exported archetype list cannot be widened by an importer', () => {
  assert.throws(() => { ARCHETYPE_IDS.push('anything-goes'); }, TypeError);
  assert.equal(ARCHETYPE_IDS.length, 10);
});
