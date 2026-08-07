// Split the petsubj manifest into chunk files for parallel AI classification.
// Each chunk lists {doc_id, application_number, decision_date, file} — deliberately
// WITHOUT code_outcome, so the classifier's reading of the text stays a blind
// cross-check of the USPTO document code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const DIR = `snq-cumulative/${process.argv[2] || 'petsubj-prod'}`;
const SIZE = Number(process.argv[3] || 29);
const manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8'));
await mkdir(`${DIR}/chunks`, { recursive: true });
let n = 0;
for (let i = 0; i < manifest.length; i += SIZE) {
  const slice = manifest.slice(i, i + SIZE).map((m) => ({
    doc_id: m.doc_id, application_number: m.application_number,
    decision_date: m.decision_date, file: m.file,
  }));
  await writeFile(`${DIR}/chunks/chunk-${String(n).padStart(2, '0')}.json`, JSON.stringify(slice, null, 1), 'utf-8');
  n++;
}
console.log(`Wrote ${n} chunk(s) of up to ${SIZE} from ${manifest.length} entries.`);
