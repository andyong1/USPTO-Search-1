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
async function postEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!apiKey || !from) return { skipped: true, reason: 'Email not configured (RESEND_API_KEY / DIGEST_FROM).' };

  const recipients = (Array.isArray(to) ? to : parseRecipients(to));
  if (!recipients.length) return { skipped: true, reason: 'No recipients.' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: recipients, subject, html }),
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
      const links = base
        ? formats.map((f) =>
            `<a href="${base}/api/document?appNum=${encodeURIComponent(appNum)}&documentId=${encodeURIComponent(d.documentIdentifier)}&format=${encodeURIComponent(f)}" style="color:#1a3a6b;font-weight:600;text-decoration:none;margin-right:8px">${esc(f)}</a>`
          ).join('')
        : formats.map(esc).join(', ');
      return `<tr>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${esc(d.documentCode || '')}<br><span style="color:#718096">${esc(d.description || '')}</span></td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.officialDate || '')}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.direction || '')}</td>
        <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">${links || '&mdash;'}</td>
      </tr>`;
    }).join('');

    return `<div style="margin:0 0 22px">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1a3a6b">
        Application
        <a href="https://patentcenter.uspto.gov/applications/${esc(appNum)}" style="color:#1a3a6b">${esc(appNum)}</a>
        <span style="color:#718096;font-weight:normal">&middot; ${docs.length} new</span>
      </h3>
      <table style="border-collapse:collapse;width:100%;background:#fff">
        <thead><tr>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Document</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Date</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Dir.</th>
          <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Download</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO Patent Watch &mdash; ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''}</h2>
    <p style="color:#718096;font-size:14px">New documents detected across your tracked proceedings:</p>
    ${sections}
    ${base ? `<p style="font-size:13px"><a href="${base}" style="color:#1a3a6b">Open the dashboard &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Automated daily digest from your USPTO file-wrapper tracker.</p>
  </div>`;
}

// Sends a clearly-labeled test message to DIGEST_TO to verify Resend end-to-end.
export async function sendTest() {
  const to = process.env.DIGEST_TO;
  if (!to) return { ok: false, reason: 'DIGEST_TO is not set.' };

  const base = baseUrl();
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO Patent Watch &mdash; test email</h2>
    <p style="font-size:14px">If you're reading this, your Resend configuration works. Daily
    new-filing alerts go to each application's own recipients; this daily summary address
    receives the "no new filings today" report.</p>
    ${base ? `<p style="font-size:13px"><a href="${base}" style="color:#1a3a6b">Open the dashboard &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Sent manually from the "Send test email" button.</p>
  </div>`;

  const r = await postEmail({ to, subject: 'USPTO Patent Watch — test email', html });
  if (r.error) return { ok: false, reason: r.error };
  if (r.skipped) return { ok: false, reason: r.reason };
  return { ok: true, to: r.to, id: r.id };
}

// Sends a new-filings digest to a specific recipient set (per-application recipients).
export async function sendDigestTo(recipients, newDocs) {
  const subject = `USPTO: ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''} in your tracked proceedings`;
  return postEmail({ to: recipients, subject, html: buildHtml(newDocs) });
}

// Daily digest of reexamination determinations (orders granting/denying reexam).
// Sent to REEXAM_DIGEST_TO (falling back to DIGEST_TO).
export async function sendReexamDigest(determinations) {
  const to = process.env.REEXAM_DIGEST_TO || process.env.DIGEST_TO;
  if (!to) return { skipped: true, reason: 'REEXAM_DIGEST_TO/DIGEST_TO not set.' };
  if (!determinations.length) return { skipped: true, reason: 'Nothing to report.' };

  const base = baseUrl();
  const rows = determinations.map((d) => {
    const num = d.application_number || '';
    const type = d.determination_type || '';
    const color = /denied/i.test(type) ? '#c53030' : '#276749';
    return `<tr>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">
        <a href="https://patentcenter.uspto.gov/applications/${esc(num)}" style="color:#1a3a6b">${esc(num)}</a></td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;font-weight:600;color:${color}">${esc(type)}</td>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px;white-space:nowrap">${esc(d.official_date || '')}</td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO reexamination determinations — ${determinations.length} new</h2>
    <p style="font-size:14px">Reexamination orders/denials newly detected:</p>
    <table style="border-collapse:collapse;width:100%;background:#fff">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Control No.</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Determination</th>
        <th style="text-align:left;padding:6px 10px;background:#edf2f7;font-size:12px;color:#4a5568">Date</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${base ? `<p style="font-size:13px;margin-top:14px"><a href="${base}/reexam" style="color:#1a3a6b">View all reexam determinations &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Automated daily reexamination-determinations digest.</p>
  </div>`;

  const subject = `USPTO: ${determinations.length} reexam determination${determinations.length !== 1 ? 's' : ''}`;
  return postEmail({ to, subject, html });
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
    return `<tr>
      <td style="padding:6px 10px;border-top:1px solid #e2e8f0;font-size:13px">
        <a href="https://patentcenter.uspto.gov/applications/${esc(num)}" style="color:#1a3a6b">${esc(num)}</a></td>
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

  return postEmail({ to: email, subject, html });
}
