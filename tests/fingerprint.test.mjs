// HLB — fingerprint classifier must only ever persist one of the 10 archetype
// ids the prompt offers. A model that ignores the closed list and free-writes
// its own label used to be stored verbatim, which never matches
// ARCHETYPE_CONFIG in public/index.html and renders as permanently unclassified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFingerprintClassifier } from '../lib/fingerprint.js';

const PROBLEM = 'Should we migrate the ingest pipeline from polling to a message queue?';

function classifierWithResponse(responseText) {
  const callAnthropic = async () => responseText;
  return createFingerprintClassifier({ callAnthropic, db: null, stmts: null, onTokenUsage: null });
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
