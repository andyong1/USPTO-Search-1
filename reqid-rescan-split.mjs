// Split the rescan manifest into chunk files for parallel classification.
// Each chunk carries everything a classifier needs: the OCR file name, the
// patent owner, and the litigation captions (for the A-explicit / B-inference
// rules in reqid-rescan-verify.md). Writes snq-cumulative/reqid-rescan/chunks/chunk-NN.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const DIR = 'snq-cumulative/reqid-rescan';
const SIZE = 30;
const manifest = JSON.parse(await readFile(`${DIR}/manifest.json`, 'utf-8'));
await mkdir(`${DIR}/chunks`, { recursive: true });
let n = 0;
for (let i = 0; i < manifest.length; i += SIZE) {
  const slice = manifest.slice(i, i + SIZE).map((m) => ({
    application_number: m.application_number, req_file: m.req_file,
    patent_owner: m.patent_owner || null, litigation: m.litigation || [],
  }));
  const nn = String(n).padStart(2, '0');
  await writeFile(`${DIR}/chunks/chunk-${nn}.json`, JSON.stringify(slice, null, 1), 'utf-8');
  n++;
}
console.log(`Wrote ${n} chunk(s) of up to ${SIZE} from ${manifest.length} manifest entries.`);
