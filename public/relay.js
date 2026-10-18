(() => {
  'use strict';
  const auth = window.ClasseCalmeAuth;
  const display = window.ClasseCalmeDisplay;
  const tools = window.ClasseCalmeTools;
  if (!auth || !display) return;
  const byId = id => document.getElementById(id);
  const checkbox = byId('linkActivities');
  const status = byId('relayStatus');
  const connections = byId('activityConnections');
  const connectButton = byId('connectActivities');
  const relayOrigin = 'https://classe-calme-relay.cardosojm.workers.dev';
  const storageKey = 'classe-calme.link-activities.v1';
  const deviceId = crypto.randomUUID();
  const deviceLabel = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Mac' : /Win/.test(navigator.platform || navigator.userAgent) ? 'PC' : 'Appareil';
  const chunkSize = 256 * 1024;
  const maxFileSize = 15 * 1024 * 1024;
  const pending = new Map(), uploading = new Map(), knownFiles = new Set(), downloaded = new Map();
  const roomWaiters = new Set();
  let socket = null, generation = 0, reconnectTimer = null, pingTimer = null;
  let retryDelay = 1000, hidden = false, received = false, initialized = false;
  let room = null, highestRevision = -1, applyingTools = false, activityStats = [];
  let displayVersion = 0, displaySent = 0, displayBusy = false, displayApplyBusy = false, appliedDisplay = '';
  let toolsVersion = 0, toolsSent = 0, toolsBusy = false, appliedTools = '', toolTimer = null;
  let transferController = new AbortController(), clockOffset = 0;
  let micAttempt = 0, micClaimPending = false, localMicIntent = false, latestNoise = { level: 0, alarm: false };
  let noiseTimer = null, lastNoiseSent = 0, micOwned = false;
  let takingControl = false, errorMessage = '';
  let controllerLocalDisplay = false, controllerLocalTools = false;
  let correctionBusy = false, correctionAttempt = 0, correctionError = '';

  const control = document.createElement('button');
  control.id = 'remoteControl';
  control.type = 'button';
  control.textContent = 'Prendre la main';
  byId('dock').insertBefore(control, byId('mic'));
  const remoteStatus = document.createElement('p');
  remoteStatus.id = 'remoteStatus';
  remoteStatus.setAttribute('role', 'status');
  const microphoneSource = document.createElement('p');
  microphoneSource.id = 'microphoneSource';
  microphoneSource.setAttribute('role', 'status');
  status.before(remoteStatus, microphoneSource);
  let correctionButton = null, correctionFeedback = null;
  const toolsPanel = byId('toolsPopup');
  if (checkbox && toolsPanel) {
    const section = document.createElement('section');
    section.className = 'tool-section';
    section.setAttribute('aria-labelledby', 'correctionHeading');
    const heading = document.createElement('h3');
    heading.id = 'correctionHeading';
    heading.textContent = 'Correction';
    correctionButton = document.createElement('button');
    correctionButton.id = 'toggleCorrection';
    correctionButton.type = 'button';
    correctionButton.setAttribute('aria-pressed', 'false');
    correctionButton.setAttribute('aria-describedby', 'correctionFeedback');
    correctionFeedback = document.createElement('p');
    correctionFeedback.id = 'correctionFeedback';
    correctionFeedback.className = 'hint';
    correctionFeedback.setAttribute('role', 'status');
    correctionFeedback.hidden = true;
    section.append(heading, correctionButton, correctionFeedback);
    toolsPanel.insertBefore(section, toolsPanel.querySelector('.alarm-message-tools'));
    correctionButton.addEventListener('click', () => { void toggleCorrection(); });
  }

  function endpoint(path, extra = {}) {
    const url = new URL(path, relayOrigin);
    const channel = auth.getChannel();
    if (channel && channel !== 'main') url.searchParams.set('channel', channel);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
    return url;
  }
  function isReady() { return received && socket?.readyState === WebSocket.OPEN && Boolean(auth.getGrant()); }
  function isController() { return isReady() && room?.controller?.deviceId === deviceId; }
  function activityName(id) {
    if (id === 'accueil') return 'Accueil du labo';
    const sequence = /^([345])\/(\d{2})$/.exec(id);
    if (sequence) return sequence[1] + 'e · Activité ' + sequence[2];
    const bonus = /^bonus\/([345])-(\d{2})$/.exec(id);
    return bonus ? 'Bonus ' + bonus[1] + 'e · ' + bonus[2] : 'Autres pages';
  }
  function renderConnections() {
    const container = byId('activityBreakdown');
    if (!container) return;
    container.replaceChildren();
    if (!activityStats.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Aucune page connectée.';
      container.append(empty);
    }
    for (const item of [...activityStats].sort((a, b) => a.id.localeCompare(b.id))) {
      const row = document.createElement('div');
      row.className = 'activity-row';
      const name = document.createElement('span');
      name.textContent = activityName(item.id);
      const count = document.createElement('strong');
      count.textContent = item.count;
      row.append(name, count);
      container.append(row);
    }
  }
  function showConnections(open) {
    const panel = byId('activitySummary');
    if (!panel) return;
    if (open) { window.settings?.(false); window.tabPicker?.(false); tools?.closePanel(); }
    panel.hidden = !open;
    connections?.setAttribute('aria-expanded', String(open));
  }
  connections?.addEventListener('click', () => { renderConnections(); showConnections(byId('activitySummary').hidden); });
  byId('closeActivities')?.addEventListener('click', () => { showConnections(false); connections?.focus(); });
  document.addEventListener('classe-calme:close-connections', () => showConnections(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') showConnections(false); });

  function setError(text) { errorMessage = text; renderStatus(); }
  function renderCorrection() {
    if (!correctionButton) return;
    const ready = isReady();
    const enabled = ready && room.correction === true;
    correctionButton.textContent = enabled ? 'Masquer la correction' : 'Afficher la correction';
    correctionButton.setAttribute('aria-pressed', String(enabled));
    correctionButton.disabled = correctionBusy || takingControl || (ready ? !room.linkActivities : !checkbox.checked);
    correctionButton.title = (ready ? room.linkActivities : checkbox.checked) ? '' : 'Active « Lier mes activités ».';
    correctionFeedback.textContent = correctionError || (correctionBusy ? 'Envoi…' : auth.getGrant() && !ready ? 'Connexion…' : '');
    correctionFeedback.hidden = !correctionFeedback.textContent;
  }
  function renderStatus() {
    const ready = isReady(), controlling = isController();
    control.textContent = controlling ? 'Télécommande' : 'Prendre la main';
    control.dataset.role = controlling ? 'controller' : ready ? 'follower' : 'local';
    control.setAttribute('aria-pressed', String(controlling));
    control.disabled = takingControl;
    control.title = controlling ? 'Cet appareil pilote les écrans reliés' : 'Piloter les écrans depuis cet appareil';
    connectButton.hidden = Boolean(auth.getGrant());
    remoteStatus.textContent = errorMessage || (!auth.getGrant() ? 'Connexion prof pour relier les écrans.' : !ready ? 'Écrans : connexion…' : controlling ? 'Je pilote · ' + room.devices.length + (room.devices.length > 1 ? ' écrans' : ' écran') : room.controller ? 'Écran miroir · ' + room.controller.label + ' pilote' : 'Écran miroir · prends la main');
    microphoneSource.textContent = ready && room.microphone ? 'Micro : ' + room.microphone.label + (room.microphone.deviceId === deviceId ? ' (ici)' : '') : display.getMicrophoneState() ? 'Micro : ici' : 'Micro : arrêté';
    const globallyPaused = ready && room.noise?.pausedUntil > Date.now() - clockOffset;
    if (ready && controlling) {
      byId('pause').disabled = !display.getMicrophoneState() && !room.microphone && !room.noise?.alarm && !globallyPaused;
      byId('pause').textContent = globallyPaused ? 'Reprendre' : 'Pause 30 s';
      byId('pause').setAttribute('aria-pressed', String(globallyPaused));
    } else if (ready) byId('pause').disabled = globallyPaused || !display.getMicrophoneState();
    const counted = ready && room.linkActivities;
    checkbox.disabled = ready && !controlling;
    status.textContent = !counted ? ready ? 'Activités : désactivées' : checkbox.checked ? 'Connexion prof requise' : 'Activités : désactivées' : 'Activités : ' + room.viewers + (room.viewers === 1 ? ' page connectée' : ' pages connectées');
    connections.hidden = !counted;
    if (counted) {
      connections.textContent = room.viewers + (room.viewers === 1 ? ' connexion' : ' connexions');
      connections.setAttribute('aria-label', status.textContent);
    } else showConnections(false);
    activityStats = counted && Array.isArray(room.activities) ? room.activities.filter(item => item && typeof item.id === 'string' && item.id.length <= 40 && Number.isInteger(item.count) && item.count > 0).slice(0, 100) : [];
    if (!byId('activitySummary')?.hidden) renderConnections();
    renderCorrection();
  }
  function setFollowing(value) {
    display.setFollowing(value);
    tools?.setFollowing(value);
    document.body.classList.toggle('remote-following', value);
    for (const id of ['threshold', 'quickThreshold', 'delay', 'mode', 'pulse', 'test']) if (byId(id)) byId(id).disabled = value;
    if (value) byId('calibrate').disabled = true;
    else byId('calibrate').disabled = !display.getMicrophoneState();
  }
  function requestControl() {
    if (document.activeElement === correctionButton) correctionError = 'Clique sur « Prendre la main ».';
    setError('Clique sur « Prendre la main ».');
    control.focus();
  }
  document.addEventListener('classe-calme:request-control', requestControl);

  function command(action, values = {}) {
    if (!isReady()) return Promise.reject(new Error('offline'));
    const requestId = crypto.randomUUID();
    const current = socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('timeout')); }, 10000);
      pending.set(requestId, { resolve, reject, timer, socket: current });
      try { current.send(JSON.stringify({ type: 'command', requestId, action, ...values })); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  }
  function rejectPending() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('offline')); }
    pending.clear();
    for (const waiter of roomWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error('offline')); }
    roomWaiters.clear();
  }
  function waitForRoom(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { roomWaiters.delete(waiter); reject(new Error('timeout')); }, 4000);
      roomWaiters.add(waiter);
    });
  }
  async function toggleCorrection() {
    if (correctionBusy) return;
    correctionError = '';
    if (!auth.getGrant()) { auth.connect(); return; }
    if (!isReady()) { connect(); renderCorrection(); return; }
    if (!isController()) {
      correctionError = 'Clique sur « Prendre la main ».';
      requestControl();
      return;
    }
    if (!room.linkActivities) { renderCorrection(); return; }
    const enabled = room.correction !== true;
    const currentGeneration = generation;
    const attempt = ++correctionAttempt;
    correctionBusy = true;
    renderCorrection();
    try {
      await command('correction', { enabled });
      if (generation !== currentGeneration || attempt !== correctionAttempt) return;
      await waitForRoom(() => isReady() && room.correction === enabled);
    } catch {
      if (generation === currentGeneration && attempt === correctionAttempt) correctionError = 'Correction non envoyée. Réessaie.';
    } finally {
      if (generation === currentGeneration && attempt === correctionAttempt) {
        correctionBusy = false;
        renderCorrection();
      }
    }
  }
  async function authorizedFetch(path, options = {}, extra = {}, bodyType = 'json') {
    const grant = auth.getGrant();
    if (!grant) throw new Error('auth');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.method === 'POST' ? 30000 : 60000);
    try {
      const response = await fetch(endpoint(path, extra), { credentials: 'omit', cache: 'no-store', ...options, signal: controller.signal, headers: { ...options.headers, Authorization: 'Bearer ' + grant } });
      if (response.status === 401) { auth.clearGrant(); throw new Error('auth'); }
      if (!response.ok) {
        if (response.status === 413) throw new Error('size');
        if (response.status === 409 || response.status === 403) throw new Error('control');
        throw new Error('transfer');
      }
      return await (bodyType === 'blob' ? response.blob() : response.json());
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
  async function uploadFile(fileId) {
    if (knownFiles.has(fileId)) return;
    if (uploading.has(fileId)) return uploading.get(fileId);
    const currentGeneration = generation;
    const signal = transferController.signal;
    const promise = (async () => {
      const file = display.getFile(fileId);
      if (!file) throw new Error('file');
      if (file.size <= 0 || file.size > maxFileSize) throw new Error('size');
      const parts = Math.ceil(file.size / chunkSize);
      for (let part = 0; part < parts; part++) {
        if (!isController() || currentGeneration !== generation || signal.aborted) throw new Error('control');
        const result = await authorizedFetch('/files', {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(part * chunkSize, Math.min(file.size, (part + 1) * chunkSize)), signal
        }, { id: fileId, part, parts, deviceId });
        if (!result?.ok || (part === parts - 1 && !result.complete)) throw new Error('transfer');
      }
      if (generation === currentGeneration && !signal.aborted) knownFiles.add(fileId);
    })();
    uploading.set(fileId, promise);
    try { await promise; }
    finally { if (uploading.get(fileId) === promise) uploading.delete(fileId); }
  }
  async function loadFile(fileId) {
    const local = display.getFile(fileId);
    if (local) return local;
    if (downloaded.has(fileId)) return downloaded.get(fileId);
    const currentGeneration = generation;
    const promise = authorizedFetch('/files', { signal: transferController.signal }, { id: fileId }, 'blob');
    downloaded.set(fileId, promise);
    try {
      const blob = await promise;
      if (generation !== currentGeneration) throw new Error('offline');
      return blob;
    } catch (error) { if (downloaded.get(fileId) === promise) downloaded.delete(fileId); throw error; }
  }
  function localTools() {
    const value = tools?.getBroadcastState() || { message: 'MOINS DE BRUIT, MERCI.', notice: null, timer: null };
    if (value.notice) value.notice = { ...value.notice, until: value.notice.until - clockOffset };
    if (value.timer?.state === 'running') value.timer = { ...value.timer, until: value.timer.until - clockOffset };
    return value;
  }
  function queueDisplay() {
    if (!isController()) return;
    controllerLocalDisplay = true;
    displayVersion++;
    void flushDisplay();
  }
  async function flushDisplay() {
    if (displayBusy || !isController() || displaySent === displayVersion) return;
    displayBusy = true;
    const currentGeneration = generation;
    try {
      while (isController() && generation === currentGeneration && displaySent !== displayVersion) {
        const version = displayVersion;
        const state = display.getState();
        const files = state.documents.filter(item => item.kind === 'pdf' && !knownFiles.has(item.fileId));
        if (files.length) setError('Envoi du PDF…');
        for (const item of files) await uploadFile(item.fileId);
        if (!isController() || generation !== currentGeneration) return;
        if (version !== displayVersion) continue;
        await command('display', { display: state });
        if (generation !== currentGeneration) return;
        displaySent = version;
        errorMessage = '';
        renderStatus();
      }
    } catch (error) {
      if (generation !== currentGeneration || !isController()) return;
      displaySent = displayVersion;
      setError(error.message === 'size' ? 'PDF trop volumineux : 15 Mo maximum.' : 'Envoi impossible. Réessaie en ouvrant le PDF.');
    } finally {
      displayBusy = false;
      if (displaySent !== displayVersion) void flushDisplay();
    }
  }
  function queueTools() {
    if (applyingTools || !isController()) return;
    controllerLocalTools = true;
    toolsVersion++;
    clearTimeout(toolTimer);
    toolTimer = setTimeout(() => { toolTimer = null; void flushTools(); }, 100);
  }
  async function flushTools() {
    if (toolsBusy || !isController() || toolsSent === toolsVersion) return;
    toolsBusy = true;
    const currentGeneration = generation;
    try {
      while (isController() && currentGeneration === generation && toolsSent !== toolsVersion) {
        const version = toolsVersion;
        await command('tools', { tools: localTools() });
        if (generation !== currentGeneration) return;
        toolsSent = version;
      }
    } catch {
      if (currentGeneration === generation && isController()) { toolsSent = toolsVersion; setError('Modification non envoyée. Réessaie.'); }
    } finally {
      toolsBusy = false;
      if (toolsSent !== toolsVersion) void flushTools();
    }
  }
  function applyRemoteTools() {
    if (!room || (isController() && (controllerLocalTools || toolsBusy || toolsVersion !== toolsSent))) return;
    const signature = JSON.stringify(room.tools);
    if (appliedTools === signature) return;
    applyingTools = true;
    try { tools?.applyBroadcastState(room.tools, { serverNow: room.serverNow }); appliedTools = signature; }
    finally { applyingTools = false; }
  }
  async function applyRemoteDisplay() {
    if (displayApplyBusy || !isReady()) return;
    displayApplyBusy = true;
    const currentGeneration = generation;
    try {
      while (isReady() && generation === currentGeneration) {
        if (isController() && (controllerLocalDisplay || displayBusy || displayVersion !== displaySent)) return;
        const state = room.display;
        const signature = JSON.stringify(state);
        if (signature === appliedDisplay) return;
        await display.applyState(state, loadFile);
        if (generation !== currentGeneration) return;
        appliedDisplay = signature;
      }
    } catch {
      if (generation === currentGeneration) setError('PDF indisponible. Vérifie la connexion.');
    } finally {
      displayApplyBusy = false;
      if (generation !== currentGeneration && isReady()) void applyRemoteDisplay();
    }
  }
  function applyNoise() {
    if (!room || !isReady()) return;
    const mine = room.microphone?.deviceId === deviceId;
    if (!micClaimPending && !mine && micOwned && display.getMicrophoneState()) display.stopMicrophone();
    micOwned = mine;
    const locallyMeasuring = mine && display.getMicrophoneState();
    const preferences = isController() && controllerLocalTools ? undefined : room.tools?.preferences;
    display.setRemoteNoise(room.microphone || room.noise?.alarm || room.noise?.pausedUntil > room.serverNow ? room.noise : null, preferences, { sourceLocal: locallyMeasuring, serverNow: room.serverNow });
    if (!locallyMeasuring && room.microphone) byId('badgeText').textContent = 'Micro · ' + room.microphone.label;
  }
  function acceptRoom(value) {
    if (!value || value.type !== 'remote' || value.v !== 1 || !Number.isFinite(value.revision) || value.revision < highestRevision || !value.display || !value.tools || !Array.isArray(value.devices)) return;
    const wasController = isController();
    const correctionChanged = room?.correction !== value.correction;
    const firstSnapshot = !received;
    highestRevision = value.revision;
    room = value;
    received = true;
    retryDelay = 1000;
    clockOffset = Date.now() - value.serverNow;
    for (const item of value.display.documents || []) if (item.kind === 'pdf') knownFiles.add(item.fileId);
    const referencedFiles = new Set([...value.display.documents, ...display.getState().documents].filter(item => item.kind === 'pdf').map(item => item.fileId));
    for (const fileId of downloaded.keys()) if (!referencedFiles.has(fileId)) downloaded.delete(fileId);
    const controlling = isController();
    if (wasController && !controlling) {
      correctionAttempt++;
      correctionBusy = false;
      correctionError = '';
      transferController.abort();
      transferController = new AbortController();
      displaySent = displayVersion;
      toolsSent = toolsVersion;
      controllerLocalDisplay = controllerLocalTools = false;
      errorMessage = '';
    }
    if (correctionChanged || (!wasController && controlling)) correctionError = '';
    setFollowing(!controlling);
    if (!controlling && (firstSnapshot || wasController)) window.updateProjection?.(true);
    const localState = display.getState();
    const initializeLocal = firstSnapshot && controlling && value.display.documents.length === 0;
    initialized = true;
    if (initializeLocal) {
      if (localState.documents.length) queueDisplay();
      else appliedDisplay = JSON.stringify(value.display);
      queueTools();
      void command('link', { enabled: checkbox.checked }).catch(() => {});
    } else {
      checkbox.checked = Boolean(value.linkActivities);
      applyRemoteTools();
      void applyRemoteDisplay();
    }
    applyNoise();
    for (const waiter of roomWaiters) if (waiter.predicate()) { clearTimeout(waiter.timer); roomWaiters.delete(waiter); waiter.resolve(); }
    if (localMicIntent && display.getMicrophoneState() && !micClaimPending && room.microphone?.deviceId !== deviceId) void claimMicrophone();
    renderStatus();
  }
  function resetConnection() {
    const hadRemoteMic = micOwned || micClaimPending || room?.microphone?.deviceId === deviceId;
    received = false;
    correctionAttempt++;
    correctionBusy = false;
    correctionError = '';
    clearInterval(pingTimer); pingTimer = null;
    clearTimeout(toolTimer); toolTimer = null;
    clearTimeout(noiseTimer); noiseTimer = null;
    rejectPending();
    transferController.abort(); transferController = new AbortController();
    uploading.clear(); downloaded.clear(); knownFiles.clear();
    micAttempt++; micClaimPending = false; localMicIntent = false;
    if (display.getMicrophoneState() && hadRemoteMic) display.stopMicrophone();
    micOwned = false;
    display.setRemoteNoise(null);
    setFollowing(false);
    displaySent = displayVersion;
    toolsSent = toolsVersion;
    appliedDisplay = appliedTools = '';
    controllerLocalDisplay = controllerLocalTools = false;
  }
  function disconnect() {
    generation++;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const oldSocket = socket;
    socket = null;
    resetConnection();
    room = null; highestRevision = -1;
    oldSocket?.close(1000, 'Page fermée');
    renderStatus();
  }
  async function probeAuthorization(currentGeneration) {
    try {
      const response = await fetch(endpoint('/files', { id: crypto.randomUUID() }), { credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer ' + auth.getGrant() } });
      if (currentGeneration === generation && response.status === 401) auth.clearGrant();
    } catch {}
  }
  function scheduleReconnect(currentGeneration) {
    if (hidden || !auth.getGrant() || generation !== currentGeneration || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryDelay);
    retryDelay = Math.min(15000, retryDelay * 2);
  }
  function connect() {
    if (hidden || !auth.getGrant()) { renderStatus(); return; }
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const initialLocalMic = !initialized && display.getMicrophoneState();
    generation++;
    const currentGeneration = generation;
    resetConnection();
    localMicIntent = initialLocalMic;
    room = null; highestRevision = -1;
    errorMessage = '';
    const url = endpoint('/teacher', { deviceId, label: deviceLabel });
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let current;
    try { current = new WebSocket(url.href, ['classe-calme', auth.getGrant()]); }
    catch { setError('Connexion impossible.'); scheduleReconnect(currentGeneration); return; }
    socket = current;
    renderStatus();
    current.addEventListener('open', () => {
      if (socket !== current || generation !== currentGeneration) { current.close(); return; }
      pingTimer = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping' })); }, 10000);
    });
    current.addEventListener('message', event => {
      if (socket !== current || generation !== currentGeneration) return;
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value?.type === 'ack') {
        const request = pending.get(value.requestId);
        if (!request || request.socket !== current) return;
        clearTimeout(request.timer); pending.delete(value.requestId);
        if (value.ok) request.resolve(value);
        else request.reject(new Error(value.error || 'command'));
      } else acceptRoom(value);
    });
    current.addEventListener('close', () => {
      if (socket !== current || generation !== currentGeneration) return;
      socket = null;
      resetConnection();
      setError(auth.getGrant() ? 'Écrans : hors ligne. Reconnexion…' : 'Connexion prof requise.');
      void probeAuthorization(currentGeneration);
      scheduleReconnect(currentGeneration);
    });
    current.addEventListener('error', () => { if (socket === current) setError('Écrans : connexion impossible.'); });
  }
  async function takeControl() {
    if (!auth.getGrant()) { auth.connect(); return false; }
    if (!isReady()) { setError('Connexion en cours.'); connect(); return false; }
    if (isController()) { setError('Cet appareil pilote les écrans reliés.'); return true; }
    if (takingControl) return false;
    takingControl = true; renderStatus();
    try {
      await command('take-control');
      await waitForRoom(() => room?.controller?.deviceId === deviceId);
      errorMessage = '';
      return true;
    } catch { setError('Prise de main impossible. Réessaie.'); return false; }
    finally { takingControl = false; renderStatus(); }
  }
  control.addEventListener('click', () => { void takeControl(); });
  window.ClasseCalmeRemote = Object.freeze({ takeControl, isController, isConnected: isReady });

  async function claimMicrophone() {
    if (!isReady() || !display.getMicrophoneState() || micClaimPending) return;
    const attempt = ++micAttempt;
    const currentGeneration = generation;
    localMicIntent = false;
    micClaimPending = true;
    try {
      await command('microphone', { enabled: true });
      if (generation !== currentGeneration) return;
      if (attempt !== micAttempt || !display.getMicrophoneState()) {
        if (!display.getMicrophoneState()) void command('microphone', { enabled: false }).catch(() => {});
        return;
      }
      await waitForRoom(() => room?.microphone?.deviceId === deviceId);
      if (generation !== currentGeneration || attempt !== micAttempt || !display.getMicrophoneState()) return;
      micOwned = true;
      void sendNoise();
    } catch {
      if (generation === currentGeneration && attempt === micAttempt) { display.stopMicrophone(); setError('Micro non relié. Réessaie.'); }
    } finally {
      if (generation === currentGeneration && attempt === micAttempt) { micClaimPending = false; applyNoise(); renderStatus(); }
    }
  }
  document.addEventListener('classe-calme:microphone', event => {
    const active = event.detail?.active === true;
    if (active) { localMicIntent = true; if (isReady()) void claimMicrophone(); }
    else {
      micAttempt++; micClaimPending = false; localMicIntent = false;
      if (isReady()) void command('microphone', { enabled: false }).catch(() => {});
    }
    renderStatus();
  });
  async function sendNoise() {
    clearTimeout(noiseTimer); noiseTimer = null;
    if (!isReady() || room?.microphone?.deviceId !== deviceId || !display.getMicrophoneState()) return;
    const delay = 250 - (performance.now() - lastNoiseSent);
    if (delay > 0) { noiseTimer = setTimeout(() => { noiseTimer = null; void sendNoise(); }, delay); return; }
    lastNoiseSent = performance.now();
    try { await command('noise', { noise: latestNoise }); }
    catch {}
  }
  document.addEventListener('classe-calme:noise', event => {
    if (!Number.isFinite(event.detail?.level)) return;
    latestNoise = { level: Math.max(0, Math.min(100, event.detail.level)), alarm: event.detail.alarm === true };
    void sendNoise();
  });
  document.addEventListener('classe-calme:display', queueDisplay);
  document.addEventListener('classe-calme:state', queueTools);
  document.addEventListener('classe-calme:threshold', queueTools);
  for (const id of ['delay', 'mode', 'pulse']) byId(id)?.addEventListener('change', queueTools);
  byId('test')?.addEventListener('click', event => {
    if (!isController()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void command('test-alert', { durationMs: 5000 }).catch(() => setError('Alerte non envoyée.'));
  }, true);
  for (const id of ['dismiss', 'pause']) byId(id)?.addEventListener('click', event => {
    if (!isController()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const durationMs = id === 'pause' && room.noise?.pausedUntil > Date.now() - clockOffset ? 0 : 30000;
    void command('pause-alert', { durationMs }).catch(() => {});
  }, true);
  try { const stored = localStorage.getItem(storageKey); if (stored !== null) checkbox.checked = stored !== 'false'; } catch {}
  checkbox.addEventListener('change', () => {
    try { localStorage.setItem(storageKey, String(checkbox.checked)); } catch {}
    if (isController()) void command('link', { enabled: checkbox.checked }).catch(() => setError('Modification non envoyée.'));
    correctionError = '';
    renderCorrection();
  });
  connectButton.addEventListener('click', () => { auth.connect(); });
  document.addEventListener('classe-calme:auth-changed', () => {
    if (auth.getGrant()) connect();
    else { errorMessage = ''; disconnect(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || hidden) return;
    if (!socket || socket.readyState > WebSocket.OPEN) connect();
    else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
  });
  window.addEventListener('pagehide', () => { hidden = true; disconnect(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { hidden = false; connect(); } });
  renderStatus();
  if (auth.getGrant()) connect();
  else if (auth.canAutoConnect() && !byId('panels')?.querySelector('.panel')) auth.connect();
})();
