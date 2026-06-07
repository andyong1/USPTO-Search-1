// One-click unsubscribe from daily reexam determination alerts.
//   GET /api/reexam-unsubscribe?token=<token>
// Returns a small HTML confirmation page so it works directly from an email link.
import { removeReexamSubscriberByToken } from '../lib/db.js';

function page(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f4f8; color: #2d3748; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; }
  .box { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); padding: 32px 28px; max-width: 460px; text-align: center; }
  h1 { font-size: 1.25rem; color: #1a3a6b; margin: 0 0 10px; }
  p { font-size: 0.95rem; line-height: 1.5; margin: 0 0 18px; }
  a { display: inline-block; background: #1a3a6b; color: #fff; text-decoration: none; font-weight: 600; padding: 10px 18px; border-radius: 8px; }
  a:hover { background: #15305a; }
</style></head><body>
  <div class="box">
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/reexam">Back to Reexam Determinations</a>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  const token = String((req.query && req.query.token) || '').trim();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    if (!token) {
      res.status(400).send(page('Invalid link', 'This unsubscribe link is missing its token.'));
      return;
    }
    const email = await removeReexamSubscriberByToken(token);
    if (email) {
      res.status(200).send(page('Unsubscribed', `<strong>${email}</strong> has been removed from the daily reexamination determination alerts. You will not receive any further emails.`));
    } else {
      res.status(200).send(page('Already unsubscribed', 'This address is not on the list (it may have already been removed).'));
    }
  } catch (err) {
    res.status(500).send(page('Something went wrong', 'We could not process your unsubscribe request. Please try again later.'));
  }
}
