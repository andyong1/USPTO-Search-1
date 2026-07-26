// Site theme controller. Load SYNCHRONOUSLY in <head> (before the body paints)
// as <script src="/theme.js"></script> so the resolved theme is applied with no
// flash.
//
// localStorage "theme": "dark" | "light" (explicit) | absent (follow the OS).
// We always resolve to an explicit data-theme="dark"|"light" on <html>, so all
// dark CSS (including SVG-chart attribute overrides) can key off
// [data-theme="dark"] and cover the auto-OS case too. base.css also keeps a
// prefers-color-scheme fallback for the (rare) no-JS case.
//
// On DOMContentLoaded a header toggle is injected. Charts and other JS listen
// for the "themechange" event (detail.dark) to recolor canvas/SVG content.
(function () {
  var root = document.documentElement;
  root.setAttribute('data-themable', '');

  function getStored() { try { return localStorage.getItem('theme'); } catch (e) { return null; } }
  function prefersDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function resolved() { var s = getStored(); return (s === 'dark' || s === 'light') ? s : (prefersDark() ? 'dark' : 'light'); }
  function isDark() { return resolved() === 'dark'; }
  function applyResolved() { root.setAttribute('data-theme', resolved()); }
  applyResolved(); // synchronous, pre-paint

  function setTheme(theme) {
    try { if (theme) localStorage.setItem('theme', theme); else localStorage.removeItem('theme'); } catch (e) {}
    applyResolved(); updateButton();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } }));
  }
  window.setTheme = setTheme;
  window.isDarkTheme = isDark;

  var SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>';
  var MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var btn;
  function updateButton() {
    if (!btn) return;
    var dark = isDark();
    btn.innerHTML = (dark ? SUN : MOON) + '<span>' + (dark ? 'Light' : 'Dark') + '</span>';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  function inject() {
    var header = document.querySelector('header');
    if (!header || document.querySelector('.theme-toggle')) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', function () { setTheme(isDark() ? 'light' : 'dark'); });
    header.appendChild(btn);
    updateButton();
  }
  // Follow OS changes while on auto (no explicit choice stored).
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      var s = getStored();
      if (s !== 'dark' && s !== 'light') { applyResolved(); updateButton(); window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } })); }
    };
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(onChange);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();
