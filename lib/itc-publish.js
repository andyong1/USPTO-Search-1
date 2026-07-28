// Shared Blob-publishing helpers for the ITC 337 detail pages, used by BOTH
// edis-upload.mjs (bulk republish during derivation) and edis-mirror.mjs
// (republish just the investigations it mirrored), so the per-investigation blob
// format lives in one place.

import { readFile } from 'node:fs/promises';
import { put } from '@vercel/blob';
import { documentsForDetail } from './itc-db.js';

// From the local crawl catalog: per-number phase set, (number,phase)→status, and
// number → { publicNumber, title, phases[] } header meta for the detail blob.
export async function loadCatalogMaps(dir) {
  const catalog = JSON.parse(await readFile(`${dir}/investigations.json`, 'utf-8'));
  const phasesByNumber = new Map();
  const statusByKey = new Map();
  const metaByNumber = new Map();
  for (const inv of catalog) {
    if (!phasesByNumber.has(inv.number)) phasesByNumber.set(inv.number, new Set());
    phasesByNumber.get(inv.number).add(inv.phase);
    statusByKey.set(`${inv.number} ${inv.phase}`, inv.status);
    if (!metaByNumber.has(inv.number)) metaByNumber.set(inv.number, { publicNumber: null, title: null, phases: [] });
    const meta = metaByNumber.get(inv.number);
    meta.publicNumber = meta.publicNumber || inv.publicNumber || null;
    // Prefer the shortest title (the base Violation-phase title is the cleanest).
    if (inv.title && (!meta.title || inv.title.length < meta.title.length)) meta.title = inv.title;
    meta.phases.push({ phase: inv.phase, status: inv.status, docket: inv.docket });
  }
  return { phasesByNumber, statusByKey, metaByNumber };
}

// Publish one investigation's document list to itc/inv/<number>.json. Each doc
// carries mirrorUrl (the Blob copy when mirrored, else null); the detail page
// prefers it and otherwise links out to EDIS.
export async function publishInvestigationDocs(number, meta) {
  const docs = await documentsForDetail(number);
  const payload = {
    investigationNumber: number,
    publicNumber: meta ? meta.publicNumber : null,
    title: meta ? meta.title : null,
    phases: meta ? meta.phases : [],
    generatedAt: new Date().toISOString(),
    documents: docs.map((d) => ({
      id: d.id, phase: d.investigation_phase, type: d.document_type, title: d.document_title,
      security: d.security_level, firm: d.firm_organization, filedBy: d.filed_by,
      onBehalfOf: d.on_behalf_of, date: d.received_date || d.document_date, mirrorUrl: d.mirror_url || null,
    })),
  };
  await put(`itc/inv/${number}.json`, JSON.stringify(payload), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 300,
  });
}
