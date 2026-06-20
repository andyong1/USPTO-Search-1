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

function baseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : '';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function buildHtml(newDocs) {
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
        const viewLink = viewFmt
          ? `<a href="${docHref(viewFmt, 'inline')}" style="color:#1a3a6b;font-weight:600;text-decoration:none;margin-right:12px">View</a>`
          : '';
        const dlLinks = formats.map((f) =>
          `<a href="${docHref(f, 'attachment')}" style="color:#1a3a6b;font-weight:600;text-decoration:none;margin-right:8px">${esc(f)}</a>`
        ).join('');
        links = viewLink + dlLinks;
      } else {
        links = formats.map(esc).join(', ');
      }
      return `<tr>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(d.documentCode || '')}<br><span style="color:#718096">${esc(d.description || '')}</span></td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.officialDate || '')}</td>
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
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Automated daily digest from your USPTO file-wrapper tracker.</p>
  </div>`;
}

// Sends a new-filings digest to a specific recipient set (per-application recipients).
export async function sendDigestTo(recipients, newDocs) {
  const subject = `USPTO: ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''} in your tracked proceedings`;
  return postEmail({ to: recipients, subject, html: buildHtml(newDocs) });
}

// Builds the five-category "relevant filings" body (determinations, office
// actions, certificates, pre-order, post-order petitions) from doc events —
// shared by the daily subscriber digest and the owner digest.
function comprehensiveSections(events) {
  const base = baseUrl();
  const byCat = (cat) => events.filter((e) => e.category === cat);
  const links = (e) => {
    if (!base || !e.document_id) return '&mdash;';
    const u = (disp) => `${base}/api/document?appNum=${encodeURIComponent(e.application_number)}&documentId=${encodeURIComponent(e.document_id)}&format=PDF&disposition=${disp}`;
    return `<a href="${u('inline')}" style="color:#1a3a6b;font-weight:600;text-decoration:none;margin-right:10px">View</a>`
         + `<a href="${u('attachment')}" style="color:#1a3a6b;font-weight:600;text-decoration:none">Download</a>`;
  };
  const table = (list) => `<table style="border-collapse:collapse;width:100%;background:#fff">
    <thead><tr>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Control No.</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Document</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">USPTO Date</th>
      <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">View / Download</th>
    </tr></thead><tbody>${list.map((e) => {
      const appHref = base ? `${base}/uspto-search?app=${encodeURIComponent(e.application_number)}` : `https://patentcenter.uspto.gov/applications/${esc(e.application_number)}`;
      return `<tr>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap"><a href="${appHref}" style="color:#1a3a6b">${esc(e.application_number)}</a></td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(e.label || e.doc_code || '')}${e.doc_code ? ` <span style="color:#718096">(${esc(e.doc_code)})</span>` : ''}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(String(e.official_date || '').slice(0, 10))}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${links(e)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
  const none = `<p style="color:#718096;font-size:13px;margin:4px 0 0">None.</p>`;
  const sub = (title, list) => `<h4 style="margin:14px 0 6px;font-size:13px;color:#4a5568">${esc(title)} (${list.length})</h4>${list.length ? table(list) : none}`;
  const section = (title, inner) => `<div style="margin:0 0 26px"><h3 style="margin:0 0 4px;font-size:15px;color:#1a3a6b">${esc(title)}</h3>${inner}</div>`;

  const det = byCat('determination');
  const nonf = byCat('action_nonf'), finl = byCat('action_finl');
  const cert = byCat('certificate');
  const pre = byCat('preorder_submission'), prePet = byCat('preorder_petition'), preDec = byCat('preorder_decision');
  const pp = byCat('post_petition'), ppOpp = byCat('post_opposition'), ppDec = byCat('post_decision');

  return section('1. Reexam Determinations', det.length ? table(det) : none) +
    section('2. Reexam Office Actions', sub('Non-Final (RXR.NF)', nonf) + sub('Final (RXR.F)', finl)) +
    section('3. Reexam Certificates', cert.length ? table(cert) : none) +
    section('4. Pre-Order SNQ Submissions', sub('Pre-order submissions', pre) + sub('Requestor petitions to respond', prePet) + sub('Petition decisions', preDec)) +
    section('5. Post-Order § 325(d) Petitions', sub('Patent owner petitions', pp) + sub('Requester oppositions', ppOpp) + sub('Petition decisions', ppDec));
}

// Daily comprehensive digest to ONE public subscriber: every relevant document
// (determinations, office actions, certificates, petitions) whose USPTO date was
// the prior day, with a personal one-click unsubscribe link. opts: { dateLabel,
// unsubscribeUrl }.
export async function sendComprehensiveDigestTo(email, events, opts = {}) {
  const { dateLabel = '', unsubscribeUrl = '' } = opts;
  const base = baseUrl();
  const total = events.length;
  const label = dateLabel ? ` (${dateLabel})` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO reexam alerts &mdash; ${total} new filing${total !== 1 ? 's' : ''}${esc(label)}</h2>
    <p style="color:#718096;font-size:14px">Relevant ex parte reexamination filings issued the previous day, by category.</p>
    <p style="color:#718096;font-size:13px"><strong>Note:</strong> a document dated tomorrow won't be retrievable until tomorrow.</p>
    ${comprehensiveSections(events) || '<p>No new filings.</p>'}
    ${base ? `<p style="font-size:13px"><a href="${base}/reexam" style="color:#1a3a6b">Open the site &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">You are receiving this because you subscribed to daily ex parte reexamination alerts.${unsubscribeUrl ? `<br><a href="${unsubscribeUrl}" style="color:#718096">Unsubscribe</a>` : ''}</p>
  </div>`;
  const subject = `USPTO reexam alerts: ${total} new filing${total !== 1 ? 's' : ''}${label}`;
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
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.official_date || '')}</td>
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
