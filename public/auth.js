(() => {
  'use strict';
  const grantKey = 'classe-calme.github.grant.v1';
  const stateKey = 'classe-calme.github.auth-state';
  const attemptKey = 'classe-calme.github.auth-attempt.v1';
  const callback = new URLSearchParams(location.hash.slice(1));
  const isCallback = callback.has('classe-calme-auth') || callback.has('state');

  // Retirer le jeton de l'adresse avant tout stockage ou affichage.
  if (isCallback) history.replaceState(history.state, '', location.pathname + location.search);

  const requestedChannel = new URLSearchParams(location.search).get('channel');
  const testChannel = /^test-[a-z0-9-]{8,70}$/.test(requestedChannel || '') ? requestedChannel : null;
  let grant = null;
  let claims = null;
  let attempted = isCallback;

  function decode(token) {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'cc1' ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
    try {
      const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')));
      if (!payload || payload.v !== 1 || payload.aud !== 'classe-calme-github' || payload.scope !== 'publish' ||
          !Number.isSafeInteger(payload.exp) || payload.exp <= Date.now() / 1000 ||
          !(payload.channel === 'main' || /^test-[a-z0-9-]{8,70}$/.test(payload.channel)) ||
          (testChannel && payload.channel !== testChannel)) return null;
      return payload;
    } catch { return null; }
  }
  function clearGrant() {
    grant = claims = null;
    try { sessionStorage.removeItem(grantKey); } catch {}
  }
  function accept(token) {
    const payload = decode(token);
    if (!payload) { clearGrant(); return false; }
    grant = token;
    claims = payload;
    try { sessionStorage.setItem(grantKey, token); } catch {}
    return true;
  }
  try {
    attempted = attempted || sessionStorage.getItem(attemptKey) !== null;
    if (isCallback) {
      const expected = sessionStorage.getItem(stateKey);
      sessionStorage.removeItem(stateKey);
      sessionStorage.setItem(attemptKey, String(Date.now()));
      if (!expected || callback.get('state') !== expected) clearGrant();
      else accept(callback.get('classe-calme-auth'));
    } else {
      const saved = sessionStorage.getItem(grantKey);
      if (saved) accept(saved);
    }
  } catch {
    // Sans sessionStorage, la liaison reste facultative.
    if (isCallback) clearGrant();
  }
  function getGrant() {
    if (grant && (!claims || claims.exp <= Date.now() / 1000)) clearGrant();
    return grant;
  }
  function connect() {
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const state = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(stateKey, state);
      sessionStorage.setItem(attemptKey, String(Date.now()));
      attempted = true;
      const url = new URL('https://classe-calme-jmc.greenbread14.chatgpt.site/connect-github');
      url.searchParams.set('state', state);
      if (testChannel) url.searchParams.set('channel', testChannel);
      location.assign(url.href);
      return true;
    } catch { return false; }
  }
  window.ClasseCalmeAuth = Object.freeze({
    getGrant,
    getChannel: () => getGrant() ? claims.channel : null,
    connect,
    clearGrant,
    canAutoConnect: () => !attempted && !getGrant()
  });
})();
