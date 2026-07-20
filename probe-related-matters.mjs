// READ-ONLY probe: for each IPR trial number, fetch its petition, full-text parse
// it, and print the "Related Matters Under 37 C.F.R. § 42.8(b)(2)" section so we
// can see the real format before building a district-court-litigation extractor.
//
// Prints only public-docket text. Run locally:
//   NODE_OPTIONS=--use-system-ca USPTO_API_KEY=... node probe-related-matters.mjs IPR2025-01371 IPR2024-00389
// Pick trials you know had parallel district-court litigation.

import { fetchPetitionDoc, extractDocFullText } from './lib/ptab.js';

const trials = process.argv.slice(2).filter(Boolean);
if (!trials.length) { console.error('Usage: node probe-related-matters.mjs <IPRxxxx-xxxxx> [more...]'); process.exit(1); }

// A few district-court shorthand cues, just to show what a parser could catch.
const COURT_RE = /\b([NSEWMD]\.?\s?D\.?\s?(?:Cal|Tex|N\.?Y|Del|Va|Ill|Fla|Pa|Ga|Wis|Mich|Ohio|Mass|N\.?C|Minn|Md|Mo|Ariz|Colo|Wash|Ind|Tenn)\.?|District of \w+(?:\s\w+)?|W\.?D\.?\s?\w+|E\.?D\.?\s?\w+)\b/gi;

async function probe(trial) {
  console.log(`\n================  ${trial}  ================`);
  const pet = await fetchPetitionDoc(trial);
  if (!pet || !pet.url) { console.log('  no petition document found'); return; }
  console.log(`  petition doc ${pet.docId} filed ${pet.filingDate || '?'}`);
  const raw = await extractDocFullText(pet.url);
  if (!raw || raw.trim().length < 200) { console.log('  petition text not extractable (image-only?)'); return; }
  const t = raw.replace(/\r/g, '');

  // Locate the SUBSTANTIVE Related Matters section — skip Table-of-Contents hits,
  // which are the "Related Matters .......... 2" lines (dot leaders + page no.).
  const heads = [...t.matchAll(/related\s+matters|related\s+district\s+court|42\.8\s*\(\s*b\s*\)\s*\(\s*2\s*\)/gi)];
  let shown = false;
  for (const h of heads) {
    const lookahead = t.slice(h.index, h.index + 160);
    if (/\.{4,}/.test(lookahead) || /\.\s*\.\s*\./.test(lookahead)) continue; // TOC entry
    const section = t.slice(Math.max(0, h.index - 60), h.index + 1600).replace(/\n{2,}/g, '\n').trim();
    console.log('  --- Related Matters (body) ---');
    console.log(section.split('\n').map((l) => '    ' + l).join('\n'));
    shown = true; break;
  }
  if (!shown) console.log(`  only TOC hits among ${heads.length} "Related Matters" occurrence(s) — body not isolated`);
  // Court cues seen anywhere in the petition (sanity check on detectability).
  const courts = [...new Set([...t.matchAll(COURT_RE)].map((x) => x[1].replace(/\s+/g, ' ').trim()))].slice(0, 20);
  console.log('  court-like tokens seen:', courts.length ? courts.join(' | ') : '(none)');
}

for (const tr of trials) { try { await probe(tr); } catch (e) { console.log(`  error: ${String(e.message || e)}`); } }
console.log('\nDone.');
