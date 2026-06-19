// Unit tests for the brittle pure functions (doc-code matching, date logic,
// regex detectors). Run with: npm test  (node --test, Node 18+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect325d, detectSnq, parseReexamOutcome, certCitesProceeding } from '../lib/reexamOutcome.js';
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

test('parseReexamOutcome — NIRC PTOL-465 form layout (list follows the label)', () => {
  const o = parseReexamOutcome(
    '(c) Status Of the Claim(s): (1) patent claim(s) confirmed: 1-20, ' +
    '(2) Patent claim(s) amended (including dependent on amended claim(s)): ' +
    '(3) Patent claim(s) canceled: (4) Newly presented claim(s) patentable: ' +
    'STATEMENT OF REASONS FOR CONFIRMATION reexamination of Patent Claims 1-20 ' +
    'the Request proposed that claims 1-17 and 19 are obvious');
  assert.ok(o);
  assert.equal(o.confirmed, '1-20');
  assert.equal(o.cancelled, '');
  assert.equal(o.amended, '');
  assert.equal(o.added, '');
});

test('parseReexamOutcome — NIRC form with claims canceled, none confirmed', () => {
  const o = parseReexamOutcome(
    '(1) patent claim(s) confirmed: (2) Patent claim(s) amended: ' +
    '(3) Patent claim(s) canceled: 1-15 (4) Newly presented claim(s) patentable:');
  assert.ok(o);
  assert.equal(o.confirmed, '');
  assert.equal(o.cancelled, '1-15');
});

test('parseReexamOutcome — garbled all-confirmed certificate (90015497)', () => {
  // OCR mangled "OF"->"OT" and dropped the trailing "confirmed"; the
  // "NO AMENDMENTS ... MADE TO THE PATENT" boilerplate marks a full confirmation.
  const o = parseReexamOutcome(
    'EX PARTE REEXAMINATION CERTIFICATE NO AMENDMENTS IIAVF MADE TO THE PATENT ' +
    'AS A RESULT OF REEXAMINMON, IT HAS BEEN DETERMINED Tl patentability OT claims 1-18 is 2');
  assert.ok(o);
  assert.equal(o.confirmed, '1-18');
  assert.equal(o.cancelled, '');
});

test('parseReexamOutcome — none recognized returns null', () => {
  assert.equal(parseReexamOutcome('no claim disposition language'), null);
  assert.equal(parseReexamOutcome(''), null);
});

test('certCitesProceeding — control number present / absent / unreadable', () => {
  // Control number appears (OCR spacing / slashes / commas are tolerated).
  assert.equal(certCitesProceeding('REEXAMINATION CONTROL NO. 90/016,049 blah', '90016049'), true);
  assert.equal(certCitesProceeding('Control No. 90/015 790 and more text', '90015790'), true);
  // Readable certificate that cites a DIFFERENT proceeding -> not this one.
  assert.equal(certCitesProceeding('Certificate for Control No. 90/012,345 ' + 'x'.repeat(400), '90016049'), false);
  // Too little text to judge -> null (caller should not reject).
  assert.equal(certCitesProceeding('blank', '90016049'), null);
  assert.equal(certCitesProceeding('', '90016049'), null);
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
