// Email digest via Resend (https://resend.com). Uses the REST API directly, so
// no extra npm dependency. Sends only when the relevant env vars are present, so
// the cron degrades gracefully to "in-app only" if you haven't set email up.
//
// Required env vars to enable email:
//   RESEND_API_KEY   – your Resend API key
//   DIGEST_FROM      – a verified sender, e.g. "USPTO Watch <alerts@yourdomain.com>"
//   DIGEST_TO        – recipient(s), comma-separated
// Optional:
//   APP_BASE_URL     – overrides the auto-detected site URL used for download links

// The shared display formatter every table on the site already uses. names.js is
// a classic browser script (7 pages load it via <script>), so it has no ESM named
// export — it assigns to globalThis. Imported for that side effect rather than
// copied, because the last time a caller grew its own titleCaseName the two
// drifted apart and had to be merged back.
import '../names.js';
const titleCaseName = globalThis.titleCaseName || ((s) => s);

function baseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : '';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// USPTO dates arrive as full timestamps (e.g. "2026-07-16T00:00:00.000-0400").
// Emails only need the calendar date, so keep the leading YYYY-MM-DD.
function fmtDate(d) {
  return String(d ?? '').slice(0, 10);
}

// Normalize a comma/semicolon-separated recipient string into a clean array.
export function parseRecipients(s) {
  return String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

// Single place that talks to Resend. Returns a status object instead of throwing
// so one failing email doesn't abort the whole cron run.
async function postEmail({ to, subject, html, headers }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!apiKey || !from) return { skipped: true, reason: 'Email not configured (RESEND_API_KEY / DIGEST_FROM).' };

  const recipients = (Array.isArray(to) ? to : parseRecipients(to));
  if (!recipients.length) return { skipped: true, reason: 'No recipients.' };

  const payload = { from, to: recipients, subject, html };
  if (headers && Object.keys(headers).length) payload.headers = headers;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    return { error: `Resend HTTP ${res.status}: ${t.slice(0, 200)}`, to: recipients };
  }
  const data = await res.json().catch(() => ({}));
  return { sent: true, to: recipients, id: data.id };
}

function buildHtml(newDocs, unsubscribeUrl) {
  const base = baseUrl();

  // Group documents by application number.
  const byApp = new Map();
  for (const d of newDocs) {
    if (!byApp.has(d.applicationNumber)) byApp.set(d.applicationNumber, []);
    byApp.get(d.applicationNumber).push(d);
  }

  const sections = [...byApp.entries()].map(([appNum, docs]) => {
    const rows = docs.map((d) => {
      const formats = (Array.isArray(d.formats) ? d.formats : String(d.formats || '').split(','))
        .filter(Boolean);
      const docHref = (f, disp) =>
        `${base}/api/document?appNum=${encodeURIComponent(appNum)}&documentId=${encodeURIComponent(d.documentIdentifier)}&format=${encodeURIComponent(f)}&disposition=${disp}`;
      let links;
      if (base) {
        // "View" opens the document in the browser (served from this site); the
        // format links download it, as before.
        const viewFmt = formats.find((f) => /pdf/i.test(f)) || formats[0];
        const parts = [];
        if (viewFmt) parts.push(`<a href="${docHref(viewFmt, 'inline')}" style="color:#1a3a6b;font-weight:600;text-decoration:none">View</a>`);
        for (const f of formats) parts.push(`<a href="${docHref(f, 'attachment')}" style="color:#1a3a6b;font-weight:600;text-decoration:none">${esc(f)}</a>`);
        // Explicit " / " separators — many email clients strip margin on inline <a>.
        links = parts.join(' / ');
      } else {
        links = formats.map(esc).join(', ');
      }
      return `<tr>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(d.documentCode || '')}<br><span style="color:#718096">${esc(d.description || '')}</span></td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(fmtDate(d.officialDate))}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.direction || '')}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${links || '&mdash;'}</td>
      </tr>`;
    }).join('');

    const appHref = base
      ? `${base}/uspto-search?app=${encodeURIComponent(appNum)}`
      : `https://patentcenter.uspto.gov/applications/${esc(appNum)}`;
    return `<div style="margin:0 0 22px">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1a3a6b">
        Application
        <a href="${appHref}" style="color:#1a3a6b">${esc(appNum)}</a>
        <span style="color:#718096;font-weight:normal">&middot; ${docs.length} new</span>
      </h3>
      <table style="border-collapse:collapse;width:100%;background:#fff">
        <thead><tr>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Document</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Date</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Dir.</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">View / Download</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO Patent Watch &mdash; ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''}</h2>
    <p style="color:#718096;font-size:14px">New documents detected across your tracked proceedings:</p>
    <p style="color:#718096;font-size:13px"><strong>Note:</strong> Documents with tomorrow's date will not be accessible until tomorrow.</p>
    ${sections}
    ${base ? `<p style="font-size:13px"><a href="${base}" style="color:#1a3a6b">Open the dashboard &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Automated daily digest from your USPTO file-wrapper tracker.${unsubscribeUrl ? `<br><a href="${unsubscribeUrl}" style="color:#718096">Unsubscribe from all tracked-proceeding alerts</a>` : ''}</p>
  </div>`;
}

// Sends a new-filings digest. opts.unsubscribeUrl adds an unsubscribe link +
// RFC 8058 one-click header (used when sending to a single recipient).
export async function sendDigestTo(recipients, newDocs, opts = {}) {
  const { unsubscribeUrl = '' } = opts;
  const subject = `USPTO: ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''} in your tracked proceedings`;
  let headers;
  if (unsubscribeUrl) headers = { 'List-Unsubscribe': `<${unsubscribeUrl}&oneclick=1>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return postEmail({ to: recipients, subject, html: buildHtml(newDocs, unsubscribeUrl), headers });
}

// Parties on a digest row: the patent owner and, for a third-party reexam, who
// requested it. Both are already tracked per proceeding but never used to reach
// the email, so every row read as a bare control number. Mirrors the /reexam
// table's rules, including the "~" marker for a requester name INFERRED from
// co-pending litigation rather than stated in the request document.
const REQUESTER_TYPE_LABEL = { patent_owner: 'Patent owner', director: 'Director' };
function partyLines(e) {
  // NOTE: the strings pushed here are already HTML-escaped (and the third-party
  // branch appends raw markup), so they must not be escaped again downstream.
  const bits = [];
  if (e.patent_owner) bits.push(`Owner: ${esc(titleCaseName(e.patent_owner))}`);
  const t = String(e.requester_type || '').toLowerCase();
  let req = '';
  if (t === 'third_party') {
    if (e.requester_name) {
      req = esc(titleCaseName(e.requester_name));
      if (String(e.requester_confidence || '').toLowerCase() === 'low') req += '<sup title="Inferred from the co-pending litigation, not stated in the request">~</sup>';
    }
  } else if (REQUESTER_TYPE_LABEL[t]) {
    req = REQUESTER_TYPE_LABEL[t];
  }
  if (req) bits.push(`Requester: ${req}`);
  if (!bits.length) return '';
  return `<div style="margin-top:3px;font-size:11px;color:#718096;line-height:1.5">${bits.join('<br>')}</div>`;
}

function eventTable(list) {
  const base = baseUrl();
  const links = (e) => {
    if (!base || !e.document_id) return '&mdash;';
    const u = (disp) => `${base}/api/document?appNum=${encodeURIComponent(e.application_number)}&documentId=${encodeURIComponent(e.document_id)}&format=PDF&disposition=${disp}`;
    return `<a href="${u('inline')}" style="color:#1a3a6b;font-weight:600;text-decoration:none">View</a>`
         + ` / `
         + `<a href="${u('attachment')}" style="color:#1a3a6b;font-weight:600;text-decoration:none">Download</a>`;
  };
  // The control-number column carries the party names now, so it needs a floor —
  // left to auto-layout it collapses to the width of the number and wraps
  // "Netskope, Inc." one word per line.
  return `<table style="border-collapse:collapse;width:100%;background:#fff">
    <thead><tr>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568;width:190px">Control No.</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Document</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">USPTO Date</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">View / Download</th>
    </tr></thead><tbody>${list.map((e) => {
      const appHref = base ? `${base}/uspto-search?app=${encodeURIComponent(e.application_number)}` : `https://patentcenter.uspto.gov/applications/${esc(e.application_number)}`;
      return `<tr>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px"><a href="${appHref}" style="color:#1a3a6b;white-space:nowrap">${esc(e.application_number)}</a>${partyLines(e)}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(e.label || e.doc_code || '')}${e.d325_summary ? `<div style="margin-top:4px;font-size:12px;color:#4a5568;line-height:1.45"><strong>&sect;325(d):</strong> ${esc(e.d325_summary)} <span style="color:#a0aec0">(AI-generated &mdash; verify against the order)</span></div>` : ''}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(String(e.official_date || '').slice(0, 10))}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${links(e)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

// One reexam section per group of doc-event categories. Each builder returns
// { title, count, inner } or null when it has nothing to report — sections used to
// render a "None." block unconditionally, so a day with three determinations
// produced an email of twelve "None."s under seven headings, which is the opposite
// of what a digest is for. The assembler below numbers whatever survives.
const REEXAM_SECTIONS = [
  { title: 'Reexam Determinations', cats: ['determination'] },
  { title: 'Reexam Office Actions', subs: [['Non-final', 'action_nonf'], ['Final', 'action_finl']] },
  // The NIRC states what happened to the claims; the certificate that follows
  // weeks or months later is the formality. It belongs ahead of the certificate.
  { title: 'Notices of Intent to Issue a Certificate', cats: ['nirc'] },
  { title: 'Reexam Certificates', cats: ['certificate'] },
  { title: 'Pre-Order SNQ Submissions', subs: [['Pre-order submissions', 'preorder_submission'], ['Requestor petitions to respond', 'preorder_petition'], ['Petition decisions', 'preorder_decision']] },
  { title: 'Post-Order § 325(d) Petitions', subs: [['Patent owner petitions', 'post_petition'], ['Requester oppositions', 'post_opposition'], ['Petition decisions', 'post_decision']] },
];

function reexamParts(events) {
  const subHead = (title, n) => `<h4 style="margin:14px 0 6px;font-size:13px;color:#4a5568">${esc(title)} (${n})</h4>`;
  const byCat = (cat) => events.filter((e) => e.category === cat);
  const parts = [];
  for (const s of REEXAM_SECTIONS) {
    if (s.cats) {
      const list = s.cats.flatMap(byCat);
      if (list.length) parts.push({ title: s.title, count: list.length, inner: eventTable(list) });
    } else {
      const present = s.subs.map(([t, cat]) => [t, byCat(cat)]).filter(([, l]) => l.length);
      if (!present.length) continue;
      parts.push({
        title: s.title,
        count: present.reduce((n, [, l]) => n + l.length, 0),
        inner: present.map(([t, l]) => subHead(t, l.length) + eventTable(l)).join(''),
      });
    }
  }
  // Anything whose category no section claims. Without this an added category
  // would vanish from the email silently AND make the header total disagree with
  // the sections; here it is at least visible and countable.
  const claimed = new Set(REEXAM_SECTIONS.flatMap((s) => s.cats || s.subs.map(([, c]) => c)));
  const other = events.filter((e) => !claimed.has(e.category));
  if (other.length) parts.push({ title: 'Other Tracked Filings', count: other.length, inner: eventTable(other) });
  return parts;
}

// Numbers the surviving sections and builds a one-line index, so the email can be
// triaged from the top without scrolling for a count that may not be there.
function assembleSections(parts) {
  const live = parts.filter(Boolean);
  const index = live.map((p, i) => `${i + 1}. ${esc(p.title)} (${p.count})`).join(' &middot; ');
  const body = live.map((p, i) => `<div style="margin:0 0 26px">
    <h3 style="margin:0 0 4px;font-size:15px;color:#1a3a6b">${i + 1}. ${esc(p.title)} <span style="color:#718096;font-weight:normal">(${p.count})</span></h3>
    ${p.inner}
  </div>`).join('');
  return { index, body, count: live.reduce((n, p) => n + p.count, 0) };
}

// PTAB Director-discretionary + Board institution decisions issued the prior day.
// items: { trial, type, patent, po, kind ('Discretionary' | 'Institution'),
// decision ('deny'|'refer'|'granted'|'denied'), pdfUrl }. Returns a section part
// or null, like the reexam builders.
function ptabDecisionsPart(items) {
  if (!items || !items.length) return null;
  const base = baseUrl();
  const th = (t) => `<th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">${t}</th>`;
  const cell = (c, nowrap) => `<td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px${nowrap ? ';white-space:nowrap' : ''}">${c}</td>`;
  const label = (kind, d) => kind === 'Discretionary'
    ? (d === 'deny' ? 'Discretionary denial' : d === 'refer' ? 'Referred to Board' : 'Discretionary: ' + d)
    : (d === 'granted' ? 'Instituted' : d === 'denied' ? 'Institution denied' : 'Institution: ' + d);
  const rows = items.map((p) => {
    const trialCell = base ? `<a href="${base}/trial?no=${encodeURIComponent(p.trial)}" style="color:#1a3a6b">${esc(p.trial)}</a>` : esc(p.trial);
    const patNum = String(p.patent || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const patCell = p.patent ? `<a href="https://patents.google.com/patent/US${esc(patNum)}" style="color:#1a3a6b">${esc(p.patent)}</a>` : '&mdash;';
    const viewCell = (base && p.pdfUrl) ? `<a href="${base}/api/ptab?file=${encodeURIComponent(p.pdfUrl)}" style="color:#1a3a6b;font-weight:600;text-decoration:none">View</a>` : '&mdash;';
    return `<tr>${cell(trialCell, true)}${cell(esc(p.type || ''), true)}${cell(patCell, true)}${cell(p.po ? esc(p.po) : '&mdash;')}${cell(esc(label(p.kind, p.decision)), true)}${cell(viewCell, true)}</tr>`;
  }).join('');
  const table = `<table style="border-collapse:collapse;width:100%;background:#fff"><thead><tr>${th('Trial No.')}${th('Type')}${th('Patent')}${th('Patent Owner')}${th('Decision')}${th('Document')}</tr></thead><tbody>${rows}</tbody></table>`;
  return { title: 'PTAB Discretionary & Institution Decisions', count: items.length, inner: table };
}

// PTAB final written decisions issued the prior day. Each row links to its /trial
// page, the challenged patent (Google Patents), and the decision PDF (via the
// site's proxy). ptab items: { trial, type, patent, po, petitioner, pdfUrl }.
function ptabFwdPart(ptab) {
  if (!ptab || !ptab.length) return null;
  const base = baseUrl();
  const th = (t) => `<th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">${t}</th>`;
  const cell = (c, nowrap) => `<td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px${nowrap ? ';white-space:nowrap' : ''}">${c}</td>`;
  const rows = ptab.map((p) => {
    const trialCell = base ? `<a href="${base}/trial?no=${encodeURIComponent(p.trial)}" style="color:#1a3a6b">${esc(p.trial)}</a>` : esc(p.trial);
    const patNum = String(p.patent || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const patCell = p.patent ? `<a href="https://patents.google.com/patent/US${esc(patNum)}" style="color:#1a3a6b">${esc(p.patent)}</a>` : '&mdash;';
    const viewCell = (base && p.pdfUrl) ? `<a href="${base}/api/ptab?file=${encodeURIComponent(p.pdfUrl)}" style="color:#1a3a6b;font-weight:600;text-decoration:none">View decision</a>` : '&mdash;';
    return `<tr>${cell(trialCell, true)}${cell(esc(p.type || ''), true)}${cell(patCell, true)}${cell(p.po ? esc(p.po) : '&mdash;')}${cell(p.petitioner ? esc(p.petitioner) : '&mdash;')}${cell(viewCell, true)}</tr>`;
  }).join('');
  const table = `<table style="border-collapse:collapse;width:100%;background:#fff"><thead><tr>${th('Trial No.')}${th('Type')}${th('Patent')}${th('Patent Owner')}${th('Petitioner')}${th('Decision')}</tr></thead><tbody>${rows}</tbody></table>`;
  const note = '<p style="color:#718096;font-size:12px;margin:0 0 6px">Outcome is not yet classified on the day of issuance — open the trial page for the parsed result.</p>';
  return { title: 'PTAB Final Written Decisions', count: ptab.length, inner: note + table };
}

// Daily comprehensive digest to ONE public subscriber: every relevant document
// (determinations, office actions, certificates, petitions) whose USPTO date was
// the prior day, plus any PTAB final written decisions issued that day, with a
// personal one-click unsubscribe link. opts: { dateLabel, unsubscribeUrl, ptabDecisions }.
export async function sendComprehensiveDigestTo(email, events, opts = {}) {
  const { dateLabel = '', unsubscribeUrl = '', ptabDecisions = [], ptabDecisionEvents = [] } = opts;
  const base = baseUrl();
  const label = dateLabel ? ` (${dateLabel})` : '';
  const { index, body, count } = assembleSections([
    ...reexamParts(events),
    ptabDecisionsPart(ptabDecisionEvents),
    ptabFwdPart(ptabDecisions),
  ]);
  // Count what is actually rendered rather than the raw input lengths, so the
  // headline can never disagree with the sections below it.
  const total = count;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO reexam &amp; PTAB alerts &mdash; ${total} new item${total !== 1 ? 's' : ''}${esc(label)}</h2>
    ${index ? `<p style="color:#4a5568;font-size:13px;line-height:1.6;margin:0 0 12px">${index}</p>` : ''}
    <p style="color:#718096;font-size:13px"><strong>Note:</strong> a document dated tomorrow won't be retrievable until tomorrow. Sections with nothing to report are omitted.</p>
    ${body || '<p>No new filings.</p>'}
    ${base ? `<p style="font-size:13px"><a href="${base}/reexam" style="color:#1a3a6b">Open the site &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">You are receiving this because you subscribed to daily ex parte reexamination alerts.${unsubscribeUrl ? `<br><a href="${unsubscribeUrl}" style="color:#718096">Unsubscribe</a>` : ''}</p>
  </div>`;
  const subject = `USPTO reexam & PTAB alerts: ${total} new item${total !== 1 ? 's' : ''}${label}`;
  let headers;
  if (unsubscribeUrl) headers = { 'List-Unsubscribe': `<${unsubscribeUrl}&action=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return postEmail({ to: email, subject, html, headers });
}


// Daily notification for a single public subscriber: lists the reexam
// determinations issued on a given day, with a personal unsubscribe link.
// opts: { dateLabel, unsubscribeUrl, isTest }
export async function sendReexamSubscriberDigest(email, determinations, opts = {}) {
  const { dateLabel = '', unsubscribeUrl = '', isTest = false } = opts;
  const base = baseUrl();

  const rows = determinations.map((d) => {
    const num = d.application_number || '';
    const type = d.determination_type || '';
    const color = /denied/i.test(type) ? '#c53030' : '#276749';
    const appHref = base ? `${base}/uspto-search?app=${encodeURIComponent(num)}` : `https://patentcenter.uspto.gov/applications/${esc(num)}`;
    return `<tr>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">
        <a href="${appHref}" style="color:#1a3a6b">${esc(num)}</a></td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;font-weight:600;color:${color}">${esc(type)}</td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(fmtDate(d.official_date))}</td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(d.examiner_name || '')}</td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.group_art_unit || '')}</td>
    </tr>`;
  }).join('');

  const n = determinations.length;
  const heading = dateLabel
    ? `Ex parte reexamination determinations issued ${esc(dateLabel)}`
    : `Ex parte reexamination determinations`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    ${isTest ? `<div style="background:#fffbeb;border:1px solid #f6e05e;color:#975a16;font-size:13px;padding:8px 12px;border-radius:6px;margin-bottom:14px">This is a <strong>test email</strong> from the reexamination daily-notification signup. The rows below are the most recent determinations on file.</div>` : ''}
    <h2 style="color:#1a3a6b;margin-bottom:4px">${heading}</h2>
    <p style="color:#718096;font-size:14px;margin-top:0">${n} determination${n !== 1 ? 's' : ''}.</p>
    <table style="border-collapse:collapse;width:100%;background:#fff">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Control No.</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Determination</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Date</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Examiner</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Art Unit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${base ? `<p style="font-size:13px;margin-top:14px"><a href="${base}/reexam" style="color:#1a3a6b">View all reexam determinations &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">
      You are receiving this because you subscribed to daily ex parte reexamination
      determination alerts.
      ${unsubscribeUrl ? `<br><a href="${unsubscribeUrl}" style="color:#718096">Unsubscribe</a>` : ''}
    </p>
  </div>`;

  const subject = isTest
    ? `USPTO reexam alerts — test email`
    : `USPTO: ${n} reexam determination${n !== 1 ? 's' : ''}${dateLabel ? ` (${dateLabel})` : ''}`;

  // RFC 8058 one-click unsubscribe: lets Gmail/Outlook show a native
  // "Unsubscribe" control and improves deliverability.
  let headers;
  if (unsubscribeUrl) {
    headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}&action=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  return postEmail({ to: email, subject, html, headers });
}
