// USITC Section 337 — COUNSEL representation aggregate. For each firm, count the
// investigations where it represented a COMPLAINANT vs a RESPONDENT, by matching
// each filing's firm_organization/on_behalf_of against the AI-roled parties
// (itc_parties). Publishes itc/counsel.json for the /itc "Counsel" tab.
//
// Requires POSTGRES_URL, BLOB_READ_WRITE_TOKEN (+ NODE_OPTIONS=--use-system-ca).
//   node itc-counsel.mjs

import { put } from '@vercel/blob';
import { sql } from '@vercel/postgres';
import { listParties } from './lib/itc-db.js';

for (const v of ['POSTGRES_URL', 'BLOB_READ_WRITE_TOKEN']) { if (!process.env[v]) { console.error(`${v} is not set. Load grounds-secrets.env first.`); process.exit(1); } }
async function q(fn) { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 1200 * i)); } } }

const isCommission = (s) => /usitc|office of the secretary|office of unfair import|international trade commission|commission investigative|administrative law judge|chief administrative|dockets? services/i.test(s || '');
// Normalize a party/counsel name for matching: drop punctuation + common corporate
// suffixes so "Archer Aviation Inc." matches "Archer Aviation".
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[.,'"()]/g, ' ')
  .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|lp|llp|gmbh|ag|kg|s\.a|sa|n\.v|nv|b\.v|bv|plc|pte|holdings|group|technologies|technology|usa|u\.s\.a|america|american|international|dba|d\/b\/a|fka|f\/k\/a)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

const parties = await q(() => listParties());
const pByNum = new Map(parties.map((p) => [p.investigation_number, { comp: (p.complainants || []).map(norm).filter((x) => x.length > 4), resp: (p.respondents || []).map(norm).filter((x) => x.length > 4) }]));
const nums = [...pByNum.keys()];
console.log(`${nums.length} investigations with roled parties.`);

// (investigation, firm, on_behalf_of) with filing counts for those investigations.
const rows = [];
for (let i = 0; i < nums.length; i += 500) {
  const chunk = nums.slice(i, i + 500);
  const { rows: r } = await q(() => sql.query(
    `SELECT investigation_number, firm_organization, on_behalf_of, count(*)::int AS n FROM itc_document
     WHERE investigation_number = ANY($1) AND firm_organization IS NOT NULL AND on_behalf_of IS NOT NULL
     GROUP BY 1, 2, 3`, [chunk]));
  rows.push(...r);
}

// Weigh each (firm, investigation) by filings per side, then assign the
// investigation to the firm's MAJORITY side. EDIS occasionally records a joint
// or unopposed filing under one firm with an on_behalf_of naming the OTHER
// party, so per-filing crediting put ~46 firms on both sides of the same
// investigation; majority-side assignment drops those stray wrong-side credits
// (a genuine tie — equal filings both ways — keeps both, and stays rare).
const weights = new Map();   // "firm\tinv" -> { c: filings, r: filings }
for (const row of rows) {
  const firm = row.firm_organization;
  if (/^\*?not listed$/i.test(firm.trim())) continue;   // EDIS placeholder for "no firm recorded"
  if (isCommission(firm) || isCommission(row.on_behalf_of)) continue;
  const p = pByNum.get(row.investigation_number); if (!p) continue;
  const obo = norm(row.on_behalf_of);
  const forComp = p.comp.some((c) => obo.includes(c));
  const forResp = p.resp.some((c) => obo.includes(c));
  if (!forComp && !forResp) continue;
  if (forComp && forResp) continue;   // joint/combined on_behalf_of (names both sides) — ambiguous, skip
  const key = `${firm}\t${row.investigation_number}`;   // tab-safe: firm names contain spaces
  if (!weights.has(key)) weights.set(key, { c: 0, r: 0 });
  weights.get(key)[forComp ? 'c' : 'r'] += row.n;
}

// firm -> { comp:Set<inv>, resp:Set<inv> }
const byFirm = new Map();
for (const [key, w] of weights) {
  const [firm, inv] = key.split('\t');
  if (!byFirm.has(firm)) byFirm.set(firm, { comp: new Set(), resp: new Set() });
  const f = byFirm.get(firm);
  if (w.c >= w.r && w.c > 0) f.comp.add(inv);
  if (w.r >= w.c && w.r > 0) f.resp.add(inv);
}

const counsel = [...byFirm.entries()].map(([firm, f]) => {
  const total = new Set([...f.comp, ...f.resp]).size;
  return { firm, comp: f.comp.size, resp: f.resp.size, total };
}).filter((x) => x.total >= 2).sort((a, b) => b.total - a.total).slice(0, 80);

const payload = { generatedAt: new Date().toISOString(), counsel };
const res = await q(() => put('itc/counsel.json', JSON.stringify(payload), {
  access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 300,
}));
console.log(`Published ${counsel.length} firms → ${res.url}`);
console.log('Top 5:', counsel.slice(0, 5).map((c) => `${c.firm} (C:${c.comp}/R:${c.resp})`).join(' · '));
