// Returns recently detected reexamination determinations for the /reexam page,
// or — with ?petitions=1 — post-grant patent owner petitions for /reexam-petitions.
//   GET /api/reexam              →  { determinations: [...] }
//   GET /api/reexam?petitions=1  →  { petitions: [...] }
//   GET /api/reexam?actions=1    →  { actions: [...] }
//   GET /api/reexam?nirc=1       →  { nirc: [...] } — request-vs-NIRC art comparison
//   GET /api/reexam?manifest=1   →  a curl config (text) to bulk-download every
//                                   determination + office-action PDF locally.
import { listRecentDeterminations, listPostOrderPetitions, listReexamActions, listNircArt, listPetitionTrailDocs, getPetitionUniverse, listReexamFirms } from '../lib/db.js';
import { threadPetitions } from '../lib/petitions.js';
import { canonicalizeFirmKeys, firmDisplayCorrections } from '../lib/firms.js';
import { clientErrorDetail } from '../lib/secure.js';

const san = (s) => String(s || '').replace(/[^0-9A-Za-z._-]/g, '_');
const ymd = (s) => { const m = String(s || '').match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : 'nodate'; };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }
  try {
    // Always serve fresh data — no edge/browser caching — so updates from the cron
    // and backfills show up immediately rather than after a stale-cache window.
    res.setHeader('Cache-Control', 'no-store');
    // A curl config file: run `curl --create-dirs -K reexam-downloads.txt` to pull
    // every determination + office-action PDF into reexam-docs/ locally. Needs only
    // curl.exe (built into Windows 10/11) — no Node, npm, or PowerShell scripts.
    if (req.query && req.query.manifest) {
      // Env-only base (SEC-7): never derive links from the client-controlled Host
      // header. Requires APP_BASE_URL (or Vercel's production URL) to be set.
      const base = (process.env.APP_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, '');
      if (!base) { res.status(500).json({ error: 'APP_BASE_URL is not configured.' }); return; }
      const [dets, acts] = [await listRecentDeterminations(), await listReexamActions()];
      const lines = [];
      const add = (appNum, docId, dir, name) => {
        if (!appNum || !docId) return;
        lines.push(`url = "${base}/api/document?appNum=${encodeURIComponent(appNum)}&documentId=${encodeURIComponent(docId)}&format=PDF&disposition=attachment"`);
        lines.push(`output = "reexam-docs/${dir}/${name}.pdf"`);
      };
      for (const d of dets) add(d.application_number, d.document_identifier, 'determinations',
        `${san(d.application_number)}_${san(d.determination_type || 'determination')}_${ymd(d.official_date)}_${san(d.document_identifier)}`);
      for (const a of acts) {
        add(a.application_number, a.nonf_doc_id, 'office-actions', `${san(a.application_number)}_nonfinal_${ymd(a.nonf_date)}_${san(a.nonf_doc_id)}`);
        add(a.application_number, a.finl_doc_id, 'office-actions', `${san(a.application_number)}_final_${ymd(a.finl_date)}_${san(a.finl_doc_id)}`);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reexam-downloads.txt"');
      res.status(200).send(lines.join('\n') + '\n');
      return;
    }
    if (req.query && req.query.petitions) {
      const petitions = await listPostOrderPetitions();
      res.status(200).json({ petitions });
      return;
    }
    // Full petition trail for /reexam-petition-decisions: every petition /
    // opposition / decision doc per proceeding, threaded server-side.
    if (req.query && req.query.trail) {
      const [all, universe] = await Promise.all([listPetitionTrailDocs(), getPetitionUniverse()]);
      // Reading the petitions revealed that ~20% of documents filed under petition
      // codes are exhibits, standalone oppositions, or Office papers rather than
      // requests for relief. Threading them produced phantom "pending petition"
      // rows, so drop them before pairing — but only once classification has
      // actually judged them (req_is_petition defaults true when unclassified).
      // The opposition codes carry the same junk: reading all 234 turned up 14
      // documents that are appendix copies of decisions from other proceedings,
      // requester exhibit lists, and unrelated correspondence. Same treatment,
      // same default -- opp_is_opposition is true until classification says
      // otherwise.
      let excluded = 0;
      const docs = all.filter((d) => {
        if (d.kind === 'petition' && d.req_is_petition === false) { excluded++; return false; }
        if (d.kind === 'opposition' && d.opp_is_opposition === false) { excluded++; return false; }
        return true;
      });
      const byApp = new Map();
      for (const d of docs) {
        if (!byApp.has(d.application_number)) byApp.set(d.application_number, { ctx: d, rows: [] });
        byApp.get(d.application_number).rows.push(d);
      }
      const trail = [];
      for (const [app, { ctx, rows: appRows }] of byApp) {
        for (const t of threadPetitions(appRows)) {
          trail.push({
            application_number: app,
            underlying_patent: ctx.underlying_patent, patent_owner: ctx.patent_owner,
            requester_name: ctx.requester_name, requester_type: ctx.requester_type,
            cert_date: ctx.cert_date,
            petition: t.petition && {
              doc_id: t.petition.doc_id, date: t.petition.official_date, code: t.petition.doc_code,
              // Relief AS FILED, read from the petition itself. Supplies relief for
              // petitions with no decision yet, and cross-checks the Office's
              // characterization where a decision exists.
              reliefs: t.petition.req_reliefs || null,
              primary_relief: t.petition.req_primary_relief || null,
              relief_verbatim: t.petition.req_verbatim || null,
              petitioner: t.petition.req_party || null,
              confidence: t.petition.req_confidence || null,
            },
            opposition: t.opposition && {
              doc_id: t.opposition.doc_id, date: t.opposition.official_date, code: t.opposition.doc_code,
              // What the paper says it answers, so an unpaired opposition can say
              // WHY it is unpaired instead of leaving the reader to guess.
              opposes_date: t.opposition.opp_opposes_date || null,
              party: t.opposition.opp_party || null,
            },
            decision: t.decision && {
              doc_id: t.decision.doc_id, date: t.decision.official_date,
              code: t.decision.doc_code, outcome: t.decision.outcome,
              // Subject matter from the OCR + AI pass. reliefs is multi-label;
              // merits_outcome is the disposition of the SUBSTANTIVE ask (so an
              // ancillary rule waiver granted en route to a dismissal doesn't
              // read as a win). ancillary_waiver keeps that procedural leg.
              reliefs: t.decision.reliefs || null,
              primary_relief: t.decision.primary_relief || null,
              merits_outcome: t.decision.merits_outcome || null,
              ancillary_waiver: t.decision.ancillary_waiver || null,
              // Which relief was actually granted, and — where the § 325(d) question
              // was referred to the CRU — how the reexamination determination
              // answered it, since no further petition decision ever issues.
              granted_relief: t.decision.granted_relief || null,
              referred_to_cru: t.decision.referred_to_cru === true,
              det_type: t.decision.det_type || null,
              det_date: t.decision.det_date || null,
              rules: t.decision.rules || null,
              relief_verbatim: t.decision.relief_verbatim || null,
              subj_confidence: t.decision.subj_confidence || null,
              petitioner: t.decision.pet_party || null,
            },
          });
        }
      }
      // excludedNonPetitions is reported so the page can disclose what was filtered
      // rather than silently shrinking the count.
      res.status(200).json({ trail, excludedNonPetitions: excluded, universe });
      return;
    }
    // Law-firm attribution, both sides, one row per proceeding. Returns the raw
    // rows rather than server-side aggregates so the page can re-group live as
    // the minimum-volume threshold and filer-type filters change, and can drill
    // into a firm's individual proceedings, all without refetching.
    if (req.query && req.query.firms) {
      const firms = await listReexamFirms();
      // The cover sheet clips long correspondent lines, so one firm arrives under
      // several truncated keys. Collapse them corpus-wide before the page groups,
      // or a single firm lists as several rows with contradictory records. Both
      // sides are pooled into one key universe so a firm canonicalizes the same
      // way whichever side it appeared on.
      const counts = new Map();
      for (const r of firms) {
        for (const k of [r.owner_firm_key, r.requester_firm_key]) {
          if (k) counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      const canon = canonicalizeFirmKeys(counts);
      for (const r of firms) {
        if (r.owner_firm_key) r.owner_firm_key = canon.get(r.owner_firm_key) || r.owner_firm_key;
        if (r.requester_firm_key) r.requester_firm_key = canon.get(r.requester_firm_key) || r.requester_firm_key;
      }
      // Corrected names for the groups where the majority reading is the error,
      // so the page can label them properly. Sent separately rather than written
      // over the row values: the drill-down should keep showing what each
      // document actually said.
      res.status(200).json({ firms, corrections: [...firmDisplayCorrections()] });
      return;
    }
    if (req.query && req.query.actions) {
      const actions = await listReexamActions();
      res.status(200).json({ actions });
      return;
    }
    if (req.query && req.query.nirc) {
      const nirc = await listNircArt();
      res.status(200).json({ nirc });
      return;
    }
    const determinations = await listRecentDeterminations(); // no limit
    res.status(200).json({ determinations });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load.', detail: clientErrorDetail(err) });
  }
}
