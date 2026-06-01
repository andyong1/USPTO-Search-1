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
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  const to = process.env.DIGEST_TO;

  if (!apiKey || !from || !to) {
    return { ok: false, reason: 'Email not configured (RESEND_API_KEY / DIGEST_FROM / DIGEST_TO).' };
  }

  const base = baseUrl();
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO Patent Watch &mdash; test email</h2>
    <p style="font-size:14px">If you're reading this, your Resend configuration works. The daily
    digest will arrive at this address whenever new documents are filed in your tracked proceedings.</p>
    ${base ? `<p style="font-size:13px"><a href="${base}" style="color:#1a3a6b">Open the dashboard &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Sent manually from the "Send test email" button.</p>
  </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      subject: 'USPTO Patent Watch — test email',
      html,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, reason: `Resend HTTP ${res.status}: ${t.slice(0, 200)}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, to, id: data.id };
}

function buildEmptyHtml(checked) {
  const base = baseUrl();
  const scope = checked != null
    ? `Checked ${checked} tracked application${checked !== 1 ? 's' : ''}.`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:0 auto;color:#2d3748">
    <h2 style="color:#1a3a6b">USPTO Patent Watch — no new filings today</h2>
    <p style="font-size:14px">No new documents were detected in your tracked proceedings today. ${esc(scope)}</p>
    ${base ? `<p style="font-size:13px"><a href="${base}" style="color:#1a3a6b">Open the dashboard &rarr;</a></p>` : ''}
    <p style="color:#a0aec0;font-size:12px;margin-top:24px">Automated daily digest from your USPTO file-wrapper tracker.</p>
  </div>`;
}

// Always sends when email is configured. With new documents it sends the digest;
// with none it sends a "no new filings today" note so you know the job ran.
export async function sendDigest(newDocs, opts = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  const to = process.env.DIGEST_TO;

  if (!apiKey || !from || !to) {
    return { skipped: true, reason: 'Email not configured (RESEND_API_KEY / DIGEST_FROM / DIGEST_TO).' };
  }

  const hasNew = newDocs.length > 0;
  const subject = hasNew
    ? `USPTO: ${newDocs.length} new filing${newDocs.length !== 1 ? 's' : ''} in your tracked proceedings`
    : 'USPTO Patent Watch — no new filings today';
  const html = hasNew ? buildHtml(newDocs) : buildEmptyHtml(opts.checked);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { sent: true, count: newDocs.length, id: data.id };
}
