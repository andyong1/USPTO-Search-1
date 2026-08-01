// USITC Section 337 — one-time ALJ backfill. Fills itc_investigation.alj for
// investigations that lack a presiding-judge name, from two sources:
//   1) the improved "Assignment of (AC)ALJ <name>" document-title regex, and
//   2) a fallback caption/signature parse of the dispositive-document TEXT
//      ("... <Name>, [Chief] Administrative Law Judge" or "Before the Honorable
//      <Name>"), which is where old (pre-EDIS) IDs name the judge.
// Metadata + text are already in Neon — no EDIS token, no OCR here.
//   node itc-alj-backfill.mjs --dry   # report counts, no writes
//   node itc-alj-backfill.mjs

import { sql } from '@vercel/postgres';
const DRY = process.argv.includes('--dry');
async function q(fn) { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 1000 * i)); } } }

const TITLE_RE = /(?:re)?assignment (?:of|to)\s+(?:the presiding\s+)?(?:(?:acting\s+)?chief\s+)?(?:a?c?alj|administrative law judge)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/i;
// Text: a proper 2-3 token name adjacent to "Administrative Law Judge" (either order),
// or after "Before the Honorable". Validated to look like a name, not stray words.
const STOP = /\b(the|and|order|issued|presiding|initial|determination|commission|investigation|section|no|this|that|final|honorable|united|states)\b/i;
const looksName = (s) => /^[A-Z][a-z.'-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z.'-]+){1,2}$/.test(s.trim()) && !STOP.test(s);
function fromText(text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const pats = [
    /([A-Z][a-z.'-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z.'-]+),?\s+(?:Chief\s+)?Administrative Law Judge/,
    /(?:Chief\s+)?Administrative Law Judge\s+([A-Z][a-z.'-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z.'-]+)/,
    /Before(?:\s+the\s+Honorable)?\s+([A-Z][a-z.'-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z.'-]+)\s*,?\s*(?:Chief\s+)?Administrative Law Judge/,
  ];
  for (const re of pats) { const m = t.match(re); if (m && looksName(m[1])) return m[1].trim().replace(/\s+/g, ' '); }
  return null;
}

// Canonical ITC ALJ surnames with tolerant (OCR-aware) matchers, incl. the unique
// first-name+initial truncations the caption parse sometimes yields. Names matching
// none are DROPPED (garbage like "Returned", "Would Find") so this stays nightly-safe.
const ROSTER = [
  ['Luckern', /luc[gk]e[a-z]{0,3}|luckern|paul j/i], ['Harris', /harris|hafis|s[fi]dne[vy]|harf\b|hqdris/i],
  ['Morriss', /morris|debra/i], ['Bullock', /bullock|charles e/i], ['Charneski', /cha[mr]e?neski|carl c/i],
  ['Essex', /essex|theodore [re]/i], ['Gildea', /gildea|james g/i], ['Rogers', /rogers|robert k/i],
  ['Pender', /pender|thomas b/i], ['Shaw', /\bshaw\b|david p/i], ['Lord', /\blord\b|dee lord/i],
  ['Saxon', /saxon|janet d/i], ['Cheney', /cheney|clark s/i], ['McNamara', /mc ?namara|mary ?joan/i],
  ['Elliott', /elliott?\b|cameron [re]?/i], ['Moore', /\bmoore\b/i], ['Bhattacharyya', /bhattacharyya|monica/i],
  ['Johnson Hines', /johnson hines|\bhines\b/i], ['Lockhart', /lockhart/i], ['Barton', /barton/i], ['Stein', /\bstein\b/i],
];
const canon = (raw) => { for (const [name, re] of ROSTER) if (re.test(raw || '')) return name; return null; };

const noAlj = (await q(() => sql`SELECT DISTINCT investigation_number FROM itc_investigation WHERE alj IS NULL AND public_number LIKE '337-TA-%'`)).rows.map((r) => r.investigation_number);
console.log(`${noAlj.length} investigation(s) without an ALJ.`);

const found = new Map();   // investigation_number -> {name, src}
// 1) title regex
for (let i = 0; i < noAlj.length; i += 500) {
  const chunk = noAlj.slice(i, i + 500);
  const { rows } = await q(() => sql.query(
    `SELECT investigation_number, document_title FROM itc_document WHERE investigation_number = ANY($1) AND document_title ~* 'assignment of (a?c?alj|administrative law)' ORDER BY received_date DESC`, [chunk]));
  for (const d of rows) { const m = (d.document_title || '').match(TITLE_RE); if (m && !found.has(d.investigation_number)) found.set(d.investigation_number, { name: m[1].trim().replace(/\s+/g, ' '), src: 'title' }); }
}
// 2) text caption fallback for the rest
const rest = noAlj.filter((n) => !found.has(n));
for (let i = 0; i < rest.length; i += 300) {
  const chunk = rest.slice(i, i + 300);
  const { rows } = await q(() => sql.query(
    `SELECT DISTINCT ON (investigation_number) investigation_number, text FROM itc_doc_text WHERE investigation_number = ANY($1) AND coalesce(text,'')<>'' ORDER BY investigation_number, received_date DESC`, [chunk]));
  for (const r of rows) { const name = fromText(r.text); if (name) found.set(r.investigation_number, { name, src: 'text' }); }
}

// Canonicalize; drop names that match no ITC judge (OCR garbage).
for (const [k, v] of found) { const c = canon(v.name); if (c) v.name = c; else found.delete(k); }
const byTitle = [...found.values()].filter((v) => v.src === 'title').length;
console.log(`Resolved ${found.size} canonical ALJ(s): ${byTitle} from titles, ${found.size - byTitle} from text captions.`);
if (DRY) { console.log('(dry run — no writes)\nSamples:', [...found.entries()].slice(0, 12).map(([k, v]) => `${k}=${v.name}[${v.src}]`).join(', ')); process.exit(0); }

let n = 0;
for (const [number, v] of found) { await q(() => sql`UPDATE itc_investigation SET alj = ${v.name} WHERE investigation_number = ${number} AND alj IS NULL`); n++; }
console.log(`Updated ${n} investigation(s). Re-run edis-upload.mjs --publish-only to refresh the projection.`);
process.exit(0);
