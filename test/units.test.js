// Unit tests for the brittle pure functions (doc-code matching, date logic,
// regex detectors). Run with: npm test  (node --test, Node 18+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect325d, parseReexamOutcome, certCitesProceeding } from '../lib/reexamOutcome.js';
import { analyzePetition, classifyRequester } from '../lib/uspto.js';
import { classifyFwd, detectDdDecision } from '../lib/ptab-classify.js';

test('detectDdDecision — finds the Director Discretionary Decision subtype', () => {
  const docs = [
    { typeDesc: 'EXHIBIT', title: 'Some exhibit' },
    { typeDesc: 'Director Discretionary Decision: Refer', title: 'Director Discretionary Decision: Refer' },
    { typeDesc: 'Institution Decision:  Grant', title: '' },
  ];
  assert.equal(detectDdDecision(docs), 'refer');
  assert.equal(detectDdDecision([{ typeDesc: 'Director Discretionary Decision: Deny' }]), 'deny');
  assert.equal(detectDdDecision([{ typeDesc: 'PO Discretionary Denial Brief' }, { typeDesc: 'EXHIBIT' }]), 'none');
  assert.equal(detectDdDecision([]), 'none');
});

test('classifyFwd — caption: petitioner total win (All Challenged Claims Unpatentable)', () => {
  assert.equal(classifyFwd('... FINAL WRITTEN DECISION Determining All Challenged Claims Unpatentable 35 U.S.C. 318(a) ...').outcome, 'petitioner_all');
  assert.equal(classifyFwd('Determining All of the Challenged Claims Unpatentable').outcome, 'petitioner_all');
});
test('classifyFwd — caption: patent owner total win (No Challenged Claims Unpatentable)', () => {
  assert.equal(classifyFwd('Final Written Decision Determining No Challenged Claims Unpatentable').outcome, 'po_none');
  // "Challenged" omitted (IPR2023-00447): "Determining No Claims Unpatentable".
  assert.equal(classifyFwd('Final Written Decision Determining No Claims Unpatentable 35 U.S.C. § 318(a)').outcome, 'po_none');
  assert.equal(classifyFwd('JUDGMENT Determining All Claims Unpatentable').outcome, 'petitioner_all');
});
test('classifyFwd — caption without a quantifier (Determining Challenged Claim(s) Unpatentable)', () => {
  // IPR2025-00615 / IPR2023-00203: singular, no All/No/Some → petitioner win.
  assert.equal(classifyFwd('Final Written Decision Determining Challenged Claim Unpatentable 35 U.S.C. § 318(a)').outcome, 'petitioner_all');
  // IPR2022-01225: specific claims listed. With no survivors in the body → all
  // challenged claims were listed → petitioner win.
  assert.equal(classifyFwd('Final Written Decision Determining Challenged Claims 1, 3–11, 13, 14, 16–24, and 26 Unpatentable').outcome, 'petitioner_all');
  // Same caption but the body shows some challenged claims survived → partial.
  assert.equal(classifyFwd('Determining Challenged Claims 1, 3–11 Unpatentable. Petitioner has not shown claims 2 and 12 are unpatentable.').outcome, 'partial');
});
test('classifyFwd — caption: partial (Some Challenged Claims)', () => {
  assert.equal(classifyFwd('JUDGMENT Final Written Decision Determining Some Challenged Claims Unpatentable and Some Not Unpatentable').outcome, 'partial');
});
test('classifyFwd — ORDER fallback, negation-aware', () => {
  // Petitioner win: affirmative "held unpatentable" holding.
  assert.equal(classifyFwd("it is ORDERED that claims 1-20 of the '889 patent are held unpatentable.").outcome, 'petitioner_all');
  // PO win: "has not shown ... unpatentable" must NOT read as an unpatentability holding.
  assert.equal(classifyFwd('Petitioner has not shown by a preponderance of the evidence that any of the challenged claims are unpatentable.').outcome, 'po_none');
  // Partial: one clause holds claims unpatentable, another says not shown.
  assert.equal(classifyFwd('Claims 1-5 are held unpatentable; Petitioner has not shown that claims 6-10 are unpatentable.').outcome, 'partial');
});
test('classifyFwd — quantifier disposition (singular claim / stated in ORDER)', () => {
  // The IPR2025-00247 case: singular "no challenged claim ... unpatentable" => PO win.
  assert.equal(classifyFwd('We determine that no challenged claim is unpatentable.').outcome, 'po_none');
  // Singular caption variant.
  assert.equal(classifyFwd('Final Written Decision Determining No Challenged Claim Unpatentable').outcome, 'po_none');
  // "none of the challenged claims ... unpatentable" => PO win.
  assert.equal(classifyFwd('Petitioner has established that none of the challenged claims are unpatentable? No.').outcome, 'po_none');
  // "all challenged claims ... unpatentable" stated in the order (no caption) => petitioner win.
  assert.equal(classifyFwd('For the foregoing reasons, all challenged claims are unpatentable.').outcome, 'petitioner_all');
  // Negation guard: "has not shown that all challenged claims are unpatentable" => PO win, NOT petitioner.
  assert.equal(classifyFwd('Petitioner has not shown that all challenged claims are unpatentable.').outcome, 'po_none');
  // "some challenged claims ... unpatentable" => partial.
  assert.equal(classifyFwd('We conclude some challenged claims are unpatentable and others are not.').outcome, 'partial');
  // The IPR2025-00221 case: "each of the challenged claims—i.e., ...—is unpatentable"
  // with verb "has demonstrated" (not "has shown"); abbreviation periods must not cut it short.
  assert.equal(classifyFwd("we find that Petitioner has demonstrated by a preponderance of the evidence that each of the challenged claims—i.e., claims 1–8 of the '889 patent—is unpatentable.").outcome, 'petitioner_all');
  // Negation guard on the new verbs: "has not demonstrated ... unpatentable" => PO win.
  assert.equal(classifyFwd('Petitioner has not demonstrated that each of the challenged claims is unpatentable.').outcome, 'po_none');
});
test('classifyFwd — non-standard disposition => other', () => {
  assert.equal(classifyFwd('Judgment — Final Written Decision — Adverse Judgment After Institution').outcome, 'other');
  assert.equal(classifyFwd('').outcome, 'other');
});

// classifyRequester takes a flat list of USPTO code strings (union of document +
// transaction codes). Third-party requires a positive third-party code; patent
// owner requires a request receipt (RXOSUB*) with no third-party code.
test('classifyRequester — third party via RXOSUB.R (transaction event)', () => {
  assert.equal(classifyRequester(['BIB', 'RXOSUB', 'RXOSUB.R', 'RXREXO']), 'third_party');
});
test('classifyRequester — third party via length variants', () => {
  assert.equal(classifyRequester(['RXOSUB', 'RXOSUB.R.40']), 'third_party'); // <40-page variant
  assert.equal(classifyRequester(['RXO_40.R']), 'third_party');
});
test('classifyRequester — third party via 3rd-party IDS/affidavit/petition', () => {
  assert.equal(classifyRequester(['RXIDS.R']), 'third_party');
  assert.equal(classifyRequester(['RXAF/DR']), 'third_party');
  assert.equal(classifyRequester(['RXPET']), 'third_party');
  assert.equal(classifyRequester(['rxosub.r']), 'third_party'); // case-insensitive
});
test('classifyRequester — director-initiated via RXDOR (no request receipt)', () => {
  // 90020162: Director Initiated Order, no RXOSUB request receipt.
  assert.equal(classifyRequester(['RXREXO', 'RXDOR', 'BIB', 'RXR.NF']), 'director');
  // RXDOR takes precedence even if a stray third-party-ish code appears.
  assert.equal(classifyRequester(['RXDOR', 'RXC/SR']), 'director');
});
test('classifyRequester — third party via certificate of service (no RXOSUB.R)', () => {
  // 90015445: only bare RXOSUB, but RXC/SR (cert of service) ⇒ another party served.
  assert.equal(classifyRequester(['RXOSUB', 'RXC/SR', 'RXREXO', 'TRNA']), 'third_party');
});
test('classifyRequester — generic IDS/affidavit are NOT third-party markers', () => {
  // RXIDS. / RXAF/D (no trailing R) are generic; only RXOSUB → patent_owner.
  assert.equal(classifyRequester(['RXOSUB', 'RXIDS.', 'RXAF/D', 'RXREXO']), 'patent_owner');
});
test('classifyRequester — patent owner when request received with no third-party code', () => {
  assert.equal(classifyRequester(['RXOSUB', 'RXREXO', 'BIB']), 'patent_owner');
});
test('classifyRequester — unknown when no request/transaction codes', () => {
  assert.equal(classifyRequester(['BIB', 'RXREXO']), 'unknown'); // determination but no RXOSUB seen
  assert.equal(classifyRequester([]), 'unknown');
  assert.equal(classifyRequester(null), 'unknown');
});

test('detect325d', () => {
  assert.equal(detect325d('discusses 35 U.S.C. 325(d) here'), true);
  assert.equal(detect325d('§ 325 (d) analysis'), true);
  assert.equal(detect325d('under Section 325 of the statute'), false); // bare section 325 is NOT a 325(d) signal (DA-8)
  assert.equal(detect325d('nothing relevant here'), false);
  assert.equal(detect325d(''), false);
  assert.equal(detect325d(null), false);
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

test('parseReexamOutcome — verb dropped: patentability-is = confirmed, amended, new', () => {
  // OCR dropped "confirmed"/"added" and mangled "of"; "previously cancelled" is
  // NOT a current-reexam cancellation and must be ignored.
  const o = parseReexamOutcome(
    'AS A RESULT OF REEXAMINATION patentability or claims 8 and 12-15 is ' +
    'Claims 10-11 were previously cancelled. Claims 5, 9, 16 and 19 are to as amended.');
  assert.ok(o);
  assert.equal(o.confirmed, '8 and 12-15');
  assert.equal(o.amended, '5, 9, 16 and 19');
  assert.equal(o.cancelled, '');
});

test('parseReexamOutcome — new claims with "claims"/"added" dropped by OCR', () => {
  const o = parseReexamOutcome('patentability Of Claims 1-2 is New 29-122 are and determined to be patentable.');
  assert.ok(o);
  assert.equal(o.confirmed, '1-2');
  assert.equal(o.added, '29-122');
});

test('parseReexamOutcome — two-column OCR interleaving splits "as amended" (90015341)', () => {
  // Claim-body text from the adjacent column is interleaved into the disposition,
  // separating "patentable as" from "amended"; dependent-on-amended claims join
  // the amended group; new claims are captured separately.
  const o = parseReexamOutcome(
    'AS A RESULT OF REEXAMINATION, IT HAS BEEN DETERMINED THAT: ' +
    'Claims 1-8 and 11-18 are determined to be patentable as straps affixed to the ' +
    'outer shell, wherein the pair of straps amended. Claims 9-10, dependent on an ' +
    'amended claim, determined to be patentable. New claims 19-41 are added and ' +
    'determined to be 20 patentable.');
  assert.ok(o);
  assert.equal(o.amended, '1-8 and 11-18, 9-10');
  assert.equal(o.added, '19-41');
  assert.equal(o.confirmed, '');
});

test('parseReexamOutcome — OCR confusions: footnote degree, 1->I, are->arc', () => {
  // 90019971: a footnote "1°" injected into the confirmed claim list.
  const a = parseReexamOutcome(
    'NO AMENDMENTS HAVE BEEN MADE TO THE PATENT AS A RESULT OF REEXAMINATION, ' +
    'IT HAS BEEN DETERMINED THAT: The patentability of claims 38, 39, 43, 47, ' +
    '49-54, 56 and 1° 57 is confirmed. Claims 40-42 were not reexamined.');
  assert.equal(a.confirmed, '38, 39, 43, 47, 49-54, 56 and 57');
  // 90019715: "claim I is cancelled" (1 read as I).
  const b = parseReexamOutcome('AS A RESULT OF REEXAMINATION, IT HAS BEEN DETERMINED claim I is cancelled, 2');
  assert.equal(b.cancelled, '1');
  // 90019767: "01'" for of, "I -6" for 1-6, "arc" for are.
  const c = parseReexamOutcome(
    'patentability 01\' claims I -6, 8 and 16 is confirmed. Claims 7, 9 and 10 arc cancelled.');
  assert.equal(c.confirmed, '1-6, 8 and 16');
  assert.equal(c.cancelled, '7, 9 and 10');
});

test('parseReexamOutcome — OCR dropped the word "claim" (90019701)', () => {
  // "The patentability of claim 1 is confirmed." OCR dropped "claim".
  const o = parseReexamOutcome(
    'NO AMENDMENTS HAVE BEEN MADE TO THE PATENT AS A RESULT OF REEXAMINATION, ' +
    'IT HAS BEEN DETERMINED THAT: The patentability of 1 is confirmed. * 10');
  assert.ok(o);
  assert.equal(o.confirmed, '1');
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
