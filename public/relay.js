(() => {
  'use strict';
  const checkbox = document.getElementById('linkActivities');
  const status = document.getElementById('relayStatus');
  const connections = document.getElementById('activityConnections');
  const connectButton = document.getElementById('connectActivities');
  const auth = window.ClasseCalmeAuth;
  const storageKey = 'classe-calme.link-activities.v1';
  const relayOrigin = 'https://classe-calme-relay.cardosojm.workers.dev';
  const releases = [];
  let session = null;
  let inFlight = false;
  let retryTimer = null;
  let heartbeatTimer = null;
  let requestController = null;
  let hidden = false;

  function endpoint(path, channel) {
    const url = new URL(path, relayOrigin);
    if (channel && channel !== 'main') url.searchParams.set('channel', channel);
    return url.href;
  }
  function syncAuthUI() {
    connectButton.hidden = Boolean(auth?.getGrant());
  }
  function setStatus(message, viewers) {
    const counted = message === 'Activités : reliées' && Number.isInteger(viewers) && viewers >= 0;
    const description = counted ? viewers + (viewers === 1 ? ' page d’activité connectée' : ' pages d’activité connectées') : '';
    const text = counted ? 'Activités : ' + description : message;
    if (status.textContent !== text) status.textContent = text;
    status.title = counted ? 'Actualisé toutes les 10 secondes. Un élève peut ouvrir plusieurs pages.' : '';
    if (connections) {
      connections.hidden = !counted;
      const label = counted ? viewers + (viewers === 1 ? ' connexion' : ' connexions') : '';
      if (connections.textContent !== label) connections.textContent = label;
      connections.setAttribute('aria-label', description);
    }
    syncAuthUI();
  }
  function readState() {
    return {
      alarm: !document.getElementById('alarm').hidden,
      mode: document.getElementById('mode').value === 'border' ? 'border' : 'cover',
      pulse: document.getElementById('pulse').checked
    };
  }
  function clearTimers() {
    clearTimeout(retryTimer);
    clearTimeout(heartbeatTimer);
    retryTimer = heartbeatTimer = null;
  }
  function needConnection() {
    clearTimers();
    session = null;
    setStatus(checkbox.checked ? 'Connecter les activités' : 'Activités : désactivées');
  }
  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function begin() {
    clearTimers();
    if (!auth?.getGrant()) { needConnection(); return; }
    session = { id: newId(), claimed: false, dirty: true, conflict: false, retryDelay: 1000 };
    setStatus('Activités : connexion…');
    void pump();
  }
  function queueState() {
    if (checkbox.checked && !auth?.getGrant()) { needConnection(); return; }
    if (!session || session.conflict || hidden) return;
    session.dirty = true;
    if (!retryTimer) void pump();
  }
  function retry(current) {
    if (session !== current || current.conflict || hidden || !checkbox.checked) return;
    if (!auth?.getGrant()) { needConnection(); return; }
    current.dirty = true;
    setStatus('Activités : hors ligne');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pump();
    }, current.retryDelay);
    current.retryDelay = Math.min(15000, current.retryDelay * 2);
  }
  async function pump() {
    if (inFlight || hidden || retryTimer) return;
    const release = releases.shift();
    const current = session;
    if (!release && (!current || current.conflict || !current.dirty || !checkbox.checked)) return;
    const grant = release ? release.grant : auth?.getGrant();
    const channel = release ? release.channel : auth?.getChannel();
    if (!grant) { if (!release) needConnection(); return; }
    inFlight = true;
    if (!release) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      current.dirty = false;
    }
    const body = release ? release.body : {
      action: current.claimed ? 'heartbeat' : 'claim',
      sessionId: current.id,
      ...readState()
    };
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(endpoint('/publish', channel), {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + grant },
        body: JSON.stringify(body), signal: controller.signal
      });
      if (response.status === 401) {
        if (!release && session === current) { auth.clearGrant(); needConnection(); }
        return;
      }
      if (release || session !== current || hidden || !checkbox.checked) return;
      if (response.status === 409 || response.status === 410) {
        current.conflict = true;
        current.dirty = false;
        clearTimers();
        setStatus(response.status === 409 ? 'Autre page Classe calme active' : 'Activités : hors ligne');
        return;
      }
      if (!response.ok) throw new Error('relay');
      const result = await response.json();
      if (session !== current || hidden || !checkbox.checked) return;
      if (typeof result.active !== 'boolean') throw new Error('relay');
      current.claimed = true;
      current.retryDelay = 1000;
      setStatus(result.active ? 'Activités : reliées' : 'Activités : hors ligne', result.viewers);
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        queueState();
      }, 10000);
    } catch {
      if (!release) retry(current);
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = null;
      inFlight = false;
      if (releases.length || (session?.dirty && !retryTimer)) void pump();
    }
  }
  function queueRelease(current) {
    const grant = auth?.getGrant();
    if (current && !current.conflict && grant) releases.push({
      body: { action: 'release', sessionId: current.id, ...readState(), alarm: false },
      grant, channel: auth.getChannel()
    });
  }
  function disable() {
    clearTimers();
    queueRelease(session);
    session = null;
    setStatus('Activités : désactivées');
    void pump();
  }

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) checkbox.checked = stored !== 'false';
  } catch { /* Le lien fonctionne aussi sans stockage local. */ }
  checkbox.addEventListener('change', () => {
    try { localStorage.setItem(storageKey, String(checkbox.checked)); } catch {}
    if (checkbox.checked) begin(); else disable();
  });
  connectButton.addEventListener('click', () => {
    if (!auth?.connect()) setStatus('Connexion indisponible dans ce navigateur');
  });
  document.addEventListener('classe-calme:state', queueState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && !session.conflict) queueState();
  });
  window.addEventListener('pagehide', () => {
    hidden = true;
    clearTimers();
    requestController?.abort();
    queueRelease(session);
    session = null;
    for (const release of releases.splice(0)) {
      const json = JSON.stringify({ action: 'release', sessionId: release.body.sessionId, grant: release.grant });
      const url = endpoint('/release', release.channel);
      let sent = false;
      try { sent = navigator.sendBeacon?.(url, new Blob([json], { type: 'text/plain' })); } catch {}
      if (!sent) fetch(url, {
        method: 'POST', credentials: 'omit', keepalive: true,
        headers: { 'Content-Type': 'text/plain' }, body: json
      }).catch(() => {});
    }
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    hidden = false;
    if (checkbox.checked) begin(); else setStatus('Activités : désactivées');
  });
  if (checkbox.checked) begin(); else setStatus('Activités : désactivées');

  // Une seule tentative automatique, avant l'ouverture des documents.
  if (checkbox.checked && auth?.canAutoConnect() && !document.querySelector('#panels .panel')) {
    if (!auth.connect()) setStatus('Connecter les activités');
  }
})();
