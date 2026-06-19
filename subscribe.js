// Shared "Subscribe to Daily Email Alerts" widget. Included on every page
// (<script src="/subscribe.js" defer></script>) so the signup is consistent
// site-wide. Self-contained — injects its own card + styles and posts to
// /api/reexam-subscribe; depends on nothing in the host page.
(function () {
  var RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function inject() {
    var container = document.querySelector('.container');
    if (!container || document.getElementById('subscribe-card')) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'subscribe-card';
    card.style.marginBottom = '24px';
    card.innerHTML =
      '<h2 style="font-size:1.15rem;color:#1a3a6b;margin:0 0 6px">Subscribe to Daily Email Alerts</h2>' +
      '<div style="color:#718096;font-size:0.85rem;margin-bottom:14px">Get a once-daily email (8:00&nbsp;AM Pacific) listing relevant filings (determinations, office actions, certificates, petitions) issued the previous day. Every email has a one-click unsubscribe link.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input type="email" id="sub-email" placeholder="you@example.com" autocomplete="email" aria-label="Email address for daily alerts" style="flex:1;min-width:220px;max-width:340px;padding:9px 12px;border:1.5px solid #cbd5e0;border-radius:8px;font-size:0.95rem" />' +
        '<button id="sub-btn" type="button" style="cursor:pointer;background:#1a3a6b;color:#fff;border:none;font-weight:600;font-size:0.95rem;padding:10px 18px;border-radius:8px">Subscribe</button>' +
      '</div>' +
      '<div id="sub-status" role="status" aria-live="polite" style="font-size:0.85rem;margin-top:8px;font-weight:600"></div>' +
      '<div style="color:#718096;font-size:0.85rem;margin-top:8px">We use your email only to send these alerts — see our <a href="/privacy" style="color:#1a3a6b">Privacy Policy</a>. Unsubscribe anytime via the link in every email.</div>';
    var nav = container.querySelector('.site-nav');
    if (nav) nav.insertAdjacentElement('afterend', card);
    else container.insertBefore(card, container.firstChild);

    var input = card.querySelector('#sub-email');
    var btn = card.querySelector('#sub-btn');
    var status = card.querySelector('#sub-status');
    function setStatus(msg, ok) { status.textContent = msg; status.style.color = ok ? '#276749' : '#c53030'; }
    async function submit() {
      var email = (input.value || '').trim();
      if (!RE.test(email)) { setStatus('Please enter a valid email address.', false); return; }
      var old = btn.textContent; btn.disabled = true; btn.textContent = 'Subscribing…'; status.textContent = '';
      try {
        var res = await fetch('/api/reexam-subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) setStatus(data.message || 'Subscribed.', true);
        else setStatus(data.error || 'Could not subscribe.', false);
      } catch (e) { setStatus('Network error. Please try again.', false); }
      finally { btn.disabled = false; btn.textContent = old; }
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();
