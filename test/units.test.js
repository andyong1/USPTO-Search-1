// Unit tests for the brittle pure functions (doc-code matching, date logic,
// regex detectors). Run with: npm test  (node --test, Node 18+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect325d, detectSnq, parseReexamOutcome } from '../lib/reexamOutcome.js';
import { analyzePetition } from '../lib/uspto.js';

test('detect325d', () => {
  assert.equal(detect325d('discusses 35 U.S.C. 325(d) here'), true);
  assert.equal(detect325d('§ 325 (d) analysis'), true);
  assert.equal(detect325d('under Section 325 of the statute'), true);
  assert.equal(detect325d('nothing relevant here'), false);
  assert.equal(detect325d(''), false);
  assert.equal(detect325d(null), false);
});

test('detectSnq', () => {
  assert.equal(detectSnq('a substantial new question of patentability'), true);
  assert.equal(detectSnq('the SNQ standard applies'), true);
  assert.equal(detectSnq('substantial   new   question'), true);
  assert.equal(detectSnq('no relevant phrase'), false);
  assert.equal(detectSnq(''), false);
});

test('parseReexamOutcome — confirmed + cancelled', () => {
  const o = parseReexamOutcome('Claims 1-5 are confirmed. Claims 6 and 7 are cancelled.');
  assert.ok(o);
  assert.equal(o.confirmed, '1-5');
  assert.equal(o.cancelled, '6 and 7');
});

test('parseReexamOutcome — OCR periods, cancelled, and a new claim (90019766)', () => {
  const o = parseReexamOutcome(
    'The patentability of claims 10, 14-19, 22-27 and 30-43 is confirmed. ' +
    'Claims 1-9. 11-13, 20. 21. 28 and 29 are cancelled. ' +
    'New claim 44 is added and determined to be patentable.');
  assert.ok(o);
  assert.equal(o.confirmed, '10, 14-19, 22-27 and 30-43');
  assert.equal(o.cancelled, '1-9, 11-13, 20, 21, 28 and 29');
  assert.equal(o.added, '44');
});

test('parseReexamOutcome — none recognized returns null', () => {
  assert.equal(parseReexamOutcome('no claim disposition language'), null);
  assert.equal(parseReexamOutcome(''), null);
});

test('analyzePetition — petition (within 20d) + decision after', () => {
  const docs = [
    { documentCode: 'RXPET.', officialDate: '2026-01-10', documentIdentifier: 'pet' },
    { documentCode: 'RXPTDI', officialDate: '2026-03-01', documentIdentifier: 'dec' },
  ];
  const r = analyzePetition(docs, '2026-01-01');
  assert.equal(r.petition.id, 'pet');
  assert.equal(r.decision.id, 'dec');
  assert.equal(r.decision.outcome, 'dismissed');
});

test('analyzePetition — decision is captured even without a petition doc', () => {
  // The decoupled-decision fix: a decision can post without a separately-coded
  // RXPET* petition and must still be recorded.
  const docs = [{ documentCode: 'RXPTDI', officialDate: '2026-06-12', documentIdentifier: 'dec' }];
  const r = analyzePetition(docs, '2026-05-14');
  assert.equal(r.petition, null);
  assert.equal(r.decision.id, 'dec');
});

test('analyzePetition — decision before the pre-order date is ignored', () => {
  const docs = [{ documentCode: 'RXPTGR', officialDate: '2026-04-01', documentIdentifier: 'old' }];
  const r = analyzePetition(docs, '2026-05-14');
  assert.equal(r.decision, null);
});

test('analyzePetition — RXPET. outside the 20-day window is not the petition', () => {
  const docs = [{ documentCode: 'RXPET.', officialDate: '2026-03-01', documentIdentifier: 'late' }];
  const r = analyzePetition(docs, '2026-01-01'); // 59 days later
  assert.equal(r.petition, null);
});
