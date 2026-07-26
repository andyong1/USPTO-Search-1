// Site theme controller. Load SYNCHRONOUSLY in <head> (before the body paints)
// as <script src="/theme.js"></script> so the stored choice is applied with no
// flash of the wrong theme.
//
// Three states, stored in localStorage under "theme":
//   "dark" | "light"  → explicit user choice (data-theme on <html>)
//   absent            → follow the OS (prefers-color-scheme), the default
//
// On DOMContentLoaded it injects a toggle into the page header. Toggling sets an
// explicit choice; charts and other JS can listen for the "themechange" event
// (detail.dark = boolean) to recolor canvas content that can't read CSS vars.
(function () {
  var root = document.documentElement;
  // Mark this page themable so base.css's dark tokens apply only where a page
  // has been converted (loads theme.js). Unconverted pages stay light.
  root.setAttribute('data-themable', '');
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) { /* private mode */ }
  if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function isDark() {
    var t = root.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return prefersDark();
  }
  function apply(theme) {
    if (theme) { root.setAttribute('data-theme', theme); try { localStorage.setItem('theme', theme); } catch (e) {} }
    else { root.removeAttribute('data-theme'); try { localStorage.removeItem('theme'); } catch (e) {} }
    updateButton();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } }));
  }
  window.setTheme = apply;
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
    btn.addEventListener('click', function () { apply(isDark() ? 'light' : 'dark'); });
    header.appendChild(btn);
    updateButton();
  }
  // Recolor when the OS preference changes while on auto.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(function () {
      if (!root.getAttribute('data-theme')) { updateButton(); window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } })); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
})();
