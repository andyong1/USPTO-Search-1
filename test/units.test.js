// Unit tests for the brittle pure functions (doc-code matching, date logic,
// regex detectors). Run with: npm test  (node --test, Node 18+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect325d, parseReexamOutcome, certCitesProceeding } from '../lib/reexamOutcome.js';
import { analyzePetition, classifyRequester, determinationLabel, validateSearchShape } from '../lib/uspto.js';
import { safeEqual, unsubToken, unsubTokenOk } from '../lib/secure.js';
import { classifyFwd, detectDdDecision } from '../lib/ptab-classify.js';
import { extractReferences, extractReferenceNames, extractAllRefs, extractTrialNumbers, canonTrial, compareGrounds, isPetitionDoc, classify325d } from '../lib/grounds.js';
import { normCourt, petitionerToken, extractRelatedLitigation, petitionFrontmatter } from '../lib/litigation.js';

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
test('classifyFwd — adverse judgment is its own outcome (DA-5)', () => {
  assert.equal(classifyFwd('Judgment — Final Written Decision — Adverse Judgment After Institution').outcome, 'adverse_judgment');
});
test('classifyFwd — settlement termination is its own outcome (DA-5)', () => {
  assert.equal(classifyFwd('Termination of the proceeding in view of settlement between the parties under 35 U.S.C. 317.').outcome, 'settled');
  assert.equal(classifyFwd('Order granting the joint motion to terminate the proceeding.').outcome, 'settled');
});
test('classifyFwd — unmatched text => needs_review, not other (DA-5)', () => {
  assert.equal(classifyFwd('The proceeding is dismissed as moot following disclaimer of all claims.').outcome, 'needs_review');
  assert.equal(classifyFwd('').outcome, 'needs_review');
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


// ── Audit-remediation coverage (DA-16) ──────────────────────────────

test('determinationLabel — case-normalized determination codes (DA-12)', () => {
  assert.equal(determinationLabel('RXREXO'), 'Reexam Ordered');
  assert.equal(determinationLabel('rxrexo'), 'Reexam Ordered');
  assert.equal(determinationLabel(' RxReXd '), 'Reexam Denied');
  assert.equal(determinationLabel('RX.SE.ORDER'), 'Reexam Ordered (Suppl. Exam)'); // probe-verified 96-series order code (DA-4)
  assert.equal(determinationLabel('rx.se.order'), 'Reexam Ordered (Suppl. Exam)');
  assert.equal(determinationLabel('RXCERT'), null);
  assert.equal(determinationLabel(''), null);
  assert.equal(determinationLabel(null), null);
});

test('detect325d — requires the (d) subsection specifically (DA-8)', () => {
  assert.equal(detect325d('35 U.S.C. § 325(d)'), true);
  assert.equal(detect325d('section 325 ( d )'), true);
  assert.equal(detect325d('35 U.S.C. 325(a) estoppel provisions'), false);
  assert.equal(detect325d('as discussed in section 325 above'), false);
});

test('validateSearchShape — contract violations throw, valid shapes pass (DA-3)', () => {
  assert.deepEqual(validateSearchShape({ count: 0, patentFileWrapperDataBag: [] }), { count: 0, patentFileWrapperDataBag: [] });
  assert.ok(validateSearchShape({ count: 12 })); // count-only responses are valid
  assert.throws(() => validateSearchShape(null));
  assert.throws(() => validateSearchShape('<html>error</html>'));
  assert.throws(() => validateSearchShape({ patentFileWrapperDataBag: 'oops' }));
  assert.throws(() => validateSearchShape({ unrelated: true })); // no bag, no count
});

test('secure helpers — constant-time compare + unsubscribe tokens (SEC-2/SEC-4)', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), true);
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const t = unsubToken('User@Example.com');
    assert.equal(t.length, 32);
    assert.equal(unsubTokenOk('user@example.com', t), true); // email case-insensitive
    assert.equal(unsubTokenOk('other@example.com', t), false);
    assert.equal(unsubTokenOk('user@example.com', 'wrong'), false);
    assert.equal(unsubTokenOk('user@example.com', ''), false);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

test('unsubToken — no CRON_SECRET => no token, nothing verifies (fail closed)', () => {
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal(unsubToken('a@b.com'), '');
    assert.equal(unsubTokenOk('a@b.com', ''), false);
  } finally {
    if (prev !== undefined) process.env.CRON_SECRET = prev;
  }
});

// ── Grounds / prior-art overlap extraction (lib/grounds.js) ──────────
test('extractReferences — utility patents and pre-grant pubs, OCR-tolerant', () => {
  const t = 'rejected as anticipated by US 5,575,861 to Younan, obvious over US 6,869,981 '
    + 'in view of US 2008/0216889 to Blong. See also US 10,009,208 B2.';
  assert.deepEqual(extractReferences(t), ['10009208', '20080216889', '5575861', '6869981']);
  // stray OCR spaces inside the number groups are tolerated
  assert.deepEqual(extractReferences('US 5,575,86 1 and US 4,860, 509'), ['4860509', '5575861']);
});

test('extractReferences — ignores statutes, claim ranges, bare numbers', () => {
  assert.deepEqual(extractReferences('under 35 U.S.C. 103, claims 1-25 of the 8,438,796 patent'), []);
  assert.deepEqual(extractReferences(''), []);
});

test('extractTrialNumbers — canonicalizes IPR/PGR/CBM with OCR separators', () => {
  assert.deepEqual(extractTrialNumbers('see IPR2020-00019 and IPR 2024 01428, plus PGR2021-00001'),
    ['IPR2020-00019', 'IPR2024-01428', 'PGR2021-00001']);
  assert.deepEqual(extractTrialNumbers('no trials here'), []);
});

test('canonTrial — normalizes an externally-supplied trial number', () => {
  assert.equal(canonTrial('IPR2020-00019'), 'IPR2020-00019');
  assert.equal(canonTrial('ipr 2020 00019'), 'IPR2020-00019');
  assert.equal(canonTrial('not a trial'), null);
});

test('compareGrounds — mention + shared-reference intersection', () => {
  const r = compareGrounds({
    orderRefs: ['5575861', '6869981', '20080216889'],
    orderTrials: ['IPR2020-00019'],
    ptabRefs: ['6869981', '9999999'],
    trialNumber: 'IPR2020-00019',
  });
  assert.equal(r.mentioned, true);
  assert.deepEqual(r.sharedRefs, ['6869981']);
  // not mentioned, no shared art
  const r2 = compareGrounds({ orderRefs: ['5575861'], orderTrials: [], ptabRefs: ['1234567'], trialNumber: 'IPR2024-00545' });
  assert.equal(r2.mentioned, false);
  assert.deepEqual(r2.sharedRefs, []);
});

test('isPetitionDoc — identifies the operative petition, excludes replies/responses', () => {
  for (const s of ['Petition', 'Petition for Inter Partes Review', 'Corrected Petition']) assert.equal(isPetitionDoc(s), true, s);
  for (const s of ["Petitioner Reply", "Petitioner's Reply to Patent Owner Response", 'Patent Owner Preliminary Response',
    'Petitioner Opposition to Motion', 'Notice of Filing Petition', "Petitioner's Updated Exhibit List", 'Power of Attorney', '']) {
    assert.equal(isPetitionDoc(s), false, s);
  }
});

test('extractReferenceNames — surnames from obviousness/anticipation grounds', () => {
  const t = 'Claims 1-7 are obvious over Asada in view of Kinoshita. Claim 15 is obvious over '
    + 'Asada in view of Kinoshita and Dejima. Claim 20 is anticipated by Younan.';
  const n = extractReferenceNames(t);
  assert.ok(n.includes('asada') && n.includes('kinoshita') && n.includes('younan') && n.includes('dejima'), JSON.stringify(n));
  // full chain captured (tertiary and beyond): "and", comma, and "further in view of"
  assert.deepEqual(extractReferenceNames('obvious over Asada in view of Kinoshita and Dejima and Ashdown'),
    ['asada', 'ashdown', 'dejima', 'kinoshita']);
  assert.deepEqual(extractReferenceNames('obvious over Asada, Kinoshita, and Dejima'), ['asada', 'dejima', 'kinoshita']);
  // chain stops at a sentence boundary / stopword, not run into prose
  assert.deepEqual(extractReferenceNames('obvious over Asada in view of Kinoshita. The Board and Requester agree'),
    ['asada', 'kinoshita']);
  // stopwords / non-references after an anchor are excluded
  assert.deepEqual(extractReferenceNames('rendered obvious over the claims and Requester'), []);
  // OCR-joined "ofName"
  assert.ok(extractReferenceNames('obvious over Asada in view ofKinoshita').includes('kinoshita'));
});

test('extractAllRefs — merges numbers and names, de-duped', () => {
  // "to Kinoshita" is the assignee of the numbered patent (not an anchor), so the
  // number represents it; the name after "over" is captured.
  assert.deepEqual(extractAllRefs('obvious over Asada in view of US 5,575,861 to Kinoshita'), ['5575861', 'asada']);
  // named-only grounds (no patent numbers) still yield the reference surnames
  assert.deepEqual(extractAllRefs('obvious over Asada in view of Kinoshita'), ['asada', 'kinoshita']);
});

test('classify325d — level reflects substance, not mere presence', () => {
  // none: statute not cited
  assert.equal(classify325d('The request is denied for lack of a substantial new question.').level, 'none');
  // recited: statute cited with boilerplate but no related proceeding + no structure
  assert.equal(classify325d('We considered 35 U.S.C. 325(d) and the same or substantially the same art standard.').level, 'recited');
  // substantive: statute + related proceeding + side-by-side "proposed grounds" structure
  const sub = classify325d('Inter Partes Review IPR2025-01526. The petition included the following proposed grounds material for the 35 U.S.C. 325(d) analysis: obvious over Asada in view of Kinoshita.');
  assert.equal(sub.level, 'substantive');
  assert.deepEqual(sub.relatedProceedings, ['IPR2025-01526']);
  // substantive via a prior reexam (no PTAB trial) + framework name
  assert.equal(classify325d('A co-pending reexamination raised these grounds; under Advanced Bionics and 325(d) ...').level, 'substantive');
  // cited + trial but NO grounds structure => recited, not substantive
  assert.equal(classify325d('See IPR2020-00019. We decline to exercise discretion under 35 U.S.C. 325(d).').level, 'recited');
});

test('extractTrialNumbers — OCR-mangled type/separators (90016048 case)', () => {
  // broken hyphen (replacement char) and a space split inside "IPR"
  assert.deepEqual(extractTrialNumbers('inter partes review IPR2025�01371'), ['IPR2025-01371']);
  assert.deepEqual(extractTrialNumbers('I PR 2025-01371 and I P R 2024 00019'), ['IPR2024-00019', 'IPR2025-01371']);
});

test('classify325d — substantive via "challenges ... material for the 35 U.S.C. 325(d) analysis"', () => {
  // 90016048: label is "challenges" not "proposed grounds"; periods in U.S.C.
  const t = 'Inter Partes Review IPR2025�01371. The petition included the following challenges '
    + 'which are material for the 35 U.S.C. 325 (d) analysis: claims 4, 7-12 as obvious over Kotzin.';
  const r = classify325d(t);
  assert.equal(r.level, 'substantive');
  assert.deepEqual(r.relatedProceedings, ['IPR2025-01371']);
});

// ── Related district-court litigation from IPR petitions (lib/litigation.js) ──
test('normCourt — reporter abbreviations and ECF codes map to shorthand', () => {
  assert.equal(normCourt('E.D. Tex.'), 'E.D. Tex.');
  assert.equal(normCourt('DDE'), 'D. Del.');
  assert.equal(normCourt('D. Del.'), 'D. Del.');
  assert.equal(normCourt('TXED'), 'E.D. Tex.');
  assert.equal(normCourt('US'), null);          // not a court (e.g. "Nielsen (US)")
  assert.equal(normCourt("the '402 patent"), null);
});

test('petitionerToken — first distinctive word past articles/corporate forms', () => {
  assert.equal(petitionerToken('Uber Technologies, Inc.'), 'uber');
  assert.equal(petitionerToken('The Nielsen Company (US), LLC'), 'nielsen');
  assert.equal(petitionerToken('VideoAmp, Inc.'), 'videoamp');
});

test('extractRelatedLitigation — petitioner vs other, real petition snippets', () => {
  // IPR2026-00309: petitioner Uber is a defendant in the E.D. Tex. case.
  const a = extractRelatedLitigation(
    'Related Matters: The ’071 patent is asserted by PO against Petitioners in '
    + 'Carma Technology, Corp. v. Uber Technologies, Inc., Case No. 2:25-cv-00029 (E.D. Tex.).',
    'Uber Technologies, Inc.');
  assert.deepEqual(a, { petitioner: ['E.D. Tex.'], other: [] });

  // IPR2026-00310: litigation listed in the exhibit list; ECF code (DDE); two
  // Delaware complaints against petitioner VideoAmp -> de-duped to one D. Del.
  const b = extractRelatedLitigation(
    'VA-1004 Complaint, The Nielsen Company (US), LLC v. VideoAmp, Inc., 1-25-cv-00408 (DDE), filed April 2, 2025. '
    + 'VA-1014 Complaint, The Nielsen Company (US), LLC v. VideoAmp, Inc., 1-24-cv-00123-1 (DDE), filed January 31, 2024.',
    'VideoAmp, Inc.');
  assert.deepEqual(b, { petitioner: ['D. Del.'], other: [] });

  // Same patent asserted against a different party -> "other".
  const c = extractRelatedLitigation(
    'Acme Corp. v. Someone Else, Inc., Case No. 1:24-cv-00500 (D. Del.).', 'Uber Technologies, Inc.');
  assert.deepEqual(c, { petitioner: [], other: ['D. Del.'] });

  // A bare "(N.D. Cal.)" with no caption/case number nearby (no Related Matters
  // heading -> fallback guard) is not counted.
  assert.deepEqual(extractRelatedLitigation('as discussed by the court (N.D. Cal.) in dicta', 'Apple Inc.'),
    { petitioner: [], other: [] });
});

test('extractRelatedLitigation — long-form courts and bare ECF codes in the section', () => {
  // IPR2018-00043 shape: long-form court stated once for a case list; petitioner
  // is one of the named defendants.
  const a = extractRelatedLitigation(
    'B. Related Matters. As of the filing date, the ’748 Patent is involved in the following matters, all in the '
    + 'United States District Court for the Eastern District of Texas: Fall Line Patents, LLC v. Choice Hotels Int’l, Inc. '
    + '6:17-cv-00407; Fall Line Patents, LLC v. Uber Technologies, Inc. 6:17-cv-00408. C. Lead and Back-up Counsel.',
    'Uber Technologies, Inc.');
  assert.deepEqual(a, { petitioner: ['E.D. Tex.'], other: [] });

  // IPR2016-00820 shape: bare "DED" court code in a case table.
  const b = extractRelatedLitigation(
    'B. Related Matters. Petitioner identifies the following judicial proceedings. "DED" stands for District of Delaware. '
    + 'Enzo Life Sciences, Inc. v. Hologic, Inc. 1-15-cv-00271 DED. IV. Lead and Back-up Counsel.',
    'Gen-Probe Incorporated');
  assert.ok(b.petitioner.concat(b.other).includes('D. Del.'), JSON.stringify(b));

  // Long-form "District of Delaware" with the petitioner as defendant.
  assert.deepEqual(extractRelatedLitigation(
    'B. Related Matters. The patent is asserted in Foo LLC v. Bar Inc., No. 1:24-cv-100, in the District of Delaware. Lead counsel: …',
    'Bar Inc.'), { petitioner: ['D. Del.'], other: [] });

  // IPR2026-00276 shape: no "Related Matters" heading — anchored on the §42.8(b)(2)
  // citation, ends at §42.8(b)(3). Related IPRs in the list are ignored (not DC).
  const d = extractRelatedLitigation(
    'V. NOTICES AND STATEMENTS Pursuant to 37 C.F.R. §42.8(b)(1), Amazon.com Services LLC and Amazon.com, Inc. are the '
    + 'real parties-in-interest. Pursuant to 37 C.F.R. §42.8(b)(2), Petitioner identifies the following related matter. '
    + 'Smart Speaker LLC v. Amazon.com Services LLC, No. 2-25-cv-00707 (E.D. Tex.) IPR2026-00145, Amazon.com Services LLC v. '
    + 'Smart Speaker LLC, Patent No. 11,128,710. Pursuant to 37 C.F.R. §42.8(b)(3), Petitioner identifies the following counsel.',
    'Amazon.com Services LLC');
  assert.deepEqual(d, { petitioner: ['E.D. Tex.'], other: [] });
});

test('extractRelatedLitigation — patent-owner-party guard filters stray citations (IPR2026-00099)', () => {
  // PO = Secure Communication Technologies (plaintiff, W.D. Tex.); petitioner =
  // Google. The M.D. Fla. mention is a claim-construction authority not involving
  // the PO — the PO-party guard drops it; only W.D. Tex. counts.
  const t = 'B. Related Matters. a. Western District of Texas. Secure Communication Technologies, LLC v. Google LLC, '
    + 'No. 1:25-cv-01207 (W.D. Tex.), filed 2025-08-04. The Board construed the term in Acme Inc. v. Beta Corp. (M.D. Fla.). '
    + 'C. Lead and Back-up Counsel.';
  const r = extractRelatedLitigation(t, 'Google LLC', 'Secure Communication Technologies, LLC');
  assert.deepEqual(r, { petitioner: ['W.D. Tex.'], other: [] });
});

test('extractRelatedLitigation — same district in both columns; adjacent case not bled', () => {
  // IPR2026-00211: two E.D. Tex. cases — one vs. petitioner (Cisco), one vs.
  // another party (Cigna). E.D. Tex. must appear in BOTH columns (bare "EDTX" code).
  const t1 = 'B. Related Matters. Damaka, Inc. v Cisco Systems, Inc. 2-25-cv-00593 EDTX May 30, 2025. '
    + 'Damaka, Inc. v. The Cigna Group 2:25-cv-00594 EDTX May 30, 2025. C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t1, 'Cisco Systems, Inc.', 'Damaka, Inc.'),
    { petitioner: ['E.D. Tex.'], other: ['E.D. Tex.'] });

  // PGR2026-00003: petitioner WHOOP is a party only in the D. Del. case; the
  // E.D. Tex. case is vs. Samsung — must be "other", not petitioner (no bleed).
  const t2 = 'B. Related Matters. The ’790 patent is the subject of suits brought by Patent Owner Omni MedSci, Inc., '
    + 'including: Omni MedSci, Inc. v. WHOOP, Inc., No. 1:25-cv-00140 (D. Del.); and Omni MedSci, Inc. v. Samsung Elecs., '
    + 'et al., No. 2:24-cv-01070 (E.D. Tex.). C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t2, 'WHOOP, Inc.', 'Omni MedSci, Inc.'),
    { petitioner: ['D. Del.'], other: ['E.D. Tex.'] });

  // IPR2026-00233: parenthetical court that trails the caption, and an OCR-dropped
  // hyphen in the case number ("cv04689"). Must still catch N.D. Ill.
  const t3 = '2. 37 C.F.R. § 42.8(b)(2): Related Matters. The ’067 patent is at issue in the following case: '
    + 'Milwaukee Electric Tools Corporation v. Klein Tools, Inc., No. 1:25-cv04689 (N.D. Ill.), filed April 29, 2025 '
    + '(the “Litigation”). C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t3, 'Klein Tools, Inc.', 'Milwaukee Electric Tools Corporation'),
    { petitioner: ['N.D. Ill.'], other: [] });

  // IPR2026-00227: a running page header (pdf-parse interleaves it) is spliced
  // into the middle of the caption, pushing the plaintiff out of the caption
  // window. Must strip the header and still catch W.D. Tex. against the PO.
  const t4 = 'B. Related Matters Under 37 C.F.R. § 42.8(b)(2) The ’230 Patent is the subject of civil action '
    + 'Bulletproof Property Attorney Docket No. 49649-0056IP1 IPR of U.S. Patent No. 11,932,230 72 '
    + 'Management, LLC v. Tesla, Inc. et al., Case No. 1:25-cv-00665 (W.D. Tex.) filed May 5, 2025. '
    + 'C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t4, 'Tesla, Inc.', 'Bulletproof Property Management, LLC'),
    { petitioner: ['W.D. Tex.'], other: [] });

  // IPR2026-00194: court written "(Dist. Del.)" instead of "(D. Del.)".
  const t5 = 'B. Related Matters (37 C.F.R. §42.8(b)(2)) The parties are currently engaged in '
    + 'district court litigation in the case captioned Treace Medical Concepts, Inc. v. Zimmer Biomet '
    + 'Holdings, Inc. and Paragon 28, Inc., C.A. No. 1:25-cv-00592-GBW (Dist. Del.). Treace Medical '
    + 'Concepts, Inc. has asserted the ’368 patent against Petitioner. C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t5, 'Paragon 28, Inc.', 'Treace Medical Concepts, Inc.'),
    { petitioner: ['D. Del.'], other: [] });
  // Bare "district court litigation" prose (no state abbrev) must NOT invent a court.
  assert.deepEqual(extractRelatedLitigation(
    'Related Matters. The parties are engaged in district court litigation. Smith v. Jones.',
    'Jones', 'Smith'), { petitioner: [], other: [] });

  // IPR2026-00252: CM/ECF code "(CDCA)" variant for C.D. Cal. Petitioner (Disney)
  // is a defendant, so it belongs in the petitioner column.
  const t6 = 'B. Related Matters Under 37 C.F.R. § 42.8(b)(2) The ‘268 patent is the subject of '
    + 'the following civil action: InterDigital, Inc. et al v. The Walt Disney Company et al., '
    + '2-25-cv-00895 (CDCA). C. Lead and Back-up Counsel.';
  assert.deepEqual(extractRelatedLitigation(t6, 'The Walt Disney Company', 'InterDigital, Inc.'),
    { petitioner: ['C.D. Cal.'], other: [] });
});

test('petitionFrontmatter — captures the Related Matters neighborhood even when deep (IPR2026-00255)', () => {
  // TOC entry early, long technical body, then the real section past 25KB.
  const toc = 'TABLE OF CONTENTS B. Related Matters Under 37 C.F.R. § 42.8(b)(2) ............ 88 ';
  const body = 'call controller forwards content. '.repeat(800); // ~28KB of technical prose
  const section = 'B. Related Matters Under 37 C.F.R. § 42.8(b)(2) 1. Judicial Matters the ’303 Patent is involved in: '
    + 'Vusura Technology LLC v. Cisco Systems, Inc. 2:25-cv-00871 E.D. Tex. 8/25/2025. 2. Administrative Matters none.';
  const fm = petitionFrontmatter(toc + body + section);
  assert.ok(fm.includes('Vusura'), 'stored window must contain the deep section');
  assert.deepEqual(extractRelatedLitigation(fm, 'Cisco Systems, Inc.', 'Vusura Technology LLC'),
    { petitioner: ['E.D. Tex.'], other: [] });
});
