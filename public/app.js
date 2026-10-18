'use strict';
const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const documents = [];
const personalDisplay = Boolean(window.ClasseCalmeAuth);
const preferencesKey = 'classe-calme.preferences.v1';
let activeId = null, nextId = 1, projection = false, noticeTimer;
let stream = null, context = null, source = null, analyser = null, samples = null;
let timer = null, starting = false, microphoneSession = 0;
let loudSince = null, quietSince = null, lastTick = 0, pausedUntil = 0;
let testUntil = 0, alarmed = false, level = 0, calibration = null;
let following = false, applyingDisplay = false, remoteNoise = null, lastNoiseEvent = 0;
let sampledAlarm = false, remotePauseUntil = 0, remoteTestUntil = 0;

function canEditDisplay() {
  if (!following || applyingDisplay) return true;
  document.dispatchEvent(new Event('classe-calme:request-control'));
  return false;
}
function displayChanged() {
  if (personalDisplay && !applyingDisplay) document.dispatchEvent(new Event('classe-calme:display'));
}
function emitNoise(force = false) {
  if (!force && performance.now() - lastNoiseEvent < 250) return;
  lastNoiseEvent = performance.now();
  document.dispatchEvent(new CustomEvent('classe-calme:noise', { detail: { level: Math.round(level), alarm: stream ? sampledAlarm : alarmed } }));
}

function savePreferences() {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify({
      threshold: +$('threshold').value, delay: $('delay').value,
      mode: $('mode').value, pulse: $('pulse').checked
    }));
  } catch { /* Le stockage peut être bloqué. */ }
}
function setThreshold(value, save = true) {
  const threshold = clamp(Math.round(value), 10, 95);
  for (const id of ['threshold', 'quickThreshold']) $(id).value = threshold;
  for (const id of ['thresholdValue', 'quickThresholdValue']) $(id).textContent = threshold;
  $('mark').style.left = threshold + '%';
  loudSince = quietSince = null;
  if (save) savePreferences();
  document.dispatchEvent(new Event('classe-calme:threshold'));
}
function restorePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey));
    if (!saved || typeof saved !== 'object') return;
    if (Number.isFinite(saved.threshold)) setThreshold(saved.threshold, false);
    if (['2', '3', '5', '8'].includes(saved.delay)) $('delay').value = saved.delay;
    if (['cover', 'border'].includes(saved.mode)) $('mode').value = saved.mode;
    if (typeof saved.pulse === 'boolean') $('pulse').checked = saved.pulse;
  } catch { /* Conserver les valeurs par défaut. */ }
}
function notify(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}
function tabPicker(open) {
  $('tabPicker').hidden = !open;
  $('toggleTabs').setAttribute('aria-expanded', String(open));
  if (open) { settings(false); window.ClasseCalmeTools?.closePanel(); document.dispatchEvent(new Event('classe-calme:close-connections')); $('webForm').hidden = true; }
}
function settings(open) {
  if (open) { tabPicker(false); window.ClasseCalmeTools?.closePanel(); document.dispatchEvent(new Event('classe-calme:close-connections')); $('webForm').hidden = true; }
  $('settings').hidden = !open;
  $('settingsButton').setAttribute('aria-expanded', String(open));
}
function renderTabChoices() {
  const choices = $('tabChoices');
  choices.replaceChildren();
  if (!documents.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Aucun document';
    choices.append(empty);
  }
  for (const doc of documents) {
    const row = document.createElement('div');
    row.className = 'document-row';
    const button = document.createElement('button');
    button.className = 'document-choice';
    button.textContent = (doc.id === activeId ? '✓ ' : '') + (doc.kind === 'pdf' ? '▤ ' : '↗ ') + doc.title;
    button.setAttribute('aria-current', String(doc.id === activeId));
    button.onclick = () => { selectTab(doc.id); tabPicker(false); $('toggleTabs').focus(); };
    const close = document.createElement('button');
    close.className = 'close-choice';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Fermer ' + doc.title);
    close.onclick = () => { closeTab(doc.id); $('toggleTabs').focus(); };
    row.append(button, close);
    choices.append(row);
  }
}
function selectTab(id) {
  if (!canEditDisplay()) return;
  const changed = activeId !== id;
  activeId = id;
  for (const doc of documents) {
    const selected = doc.id === id;
    doc.panel.hidden = !selected;
    doc.tab.classList.toggle('active', selected);
    doc.button.setAttribute('aria-selected', String(selected));
    doc.button.tabIndex = selected ? 0 : -1;
    if (!selected) doc.reader?.deactivate();
  }
  $('empty').hidden = documents.length > 0;
  $('panels').hidden = documents.length === 0;
  const current = documents.find(doc => doc.id === id);
  $('webTools').hidden = current?.kind !== 'web';
  if (current?.kind === 'web') $('externalWeb').href = current.url;
  renderTabChoices();
  current?.reader?.activate();
  if (changed) displayChanged();
}
function closeTab(id) {
  if (!canEditDisplay()) return;
  const index = documents.findIndex(doc => doc.id === id);
  if (index < 0) return;
  const [doc] = documents.splice(index, 1);
  doc.panel.remove();
  doc.tab.remove();
  doc.reader?.destroy();
  if (doc.kind === 'pdf' && doc.url?.startsWith('blob:')) URL.revokeObjectURL(doc.url);
  selectTab(activeId === id ? documents[Math.min(index, documents.length - 1)]?.id ?? null : activeId);
  displayChanged();
}
function addDocument(kind, title, url, options = {}) {
  if (!canEditDisplay()) return null;
  if (personalDisplay && documents.length >= 50) { notify('50 onglets maximum. Fermez un document.'); return null; }
  const id = options.id ?? (personalDisplay ? crypto.randomUUID() : nextId++);
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'panel-' + id;
  panel.setAttribute('role', 'tabpanel');
  let frame = null;
  if (kind === 'web' || !personalDisplay || !window.ClasseCalmePdf) {
    frame = document.createElement('iframe');
    frame.title = title;
    if (kind === 'web') {
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads');
      frame.referrerPolicy = 'no-referrer';
    }
    frame.src = url || 'about:blank';
    panel.append(frame);
  }
  $('panels').append(panel);
  const tab = document.createElement('div');
  tab.className = 'tab';
  const button = document.createElement('button');
  button.textContent = (kind === 'pdf' ? '▤ ' : '↗ ') + title;
  button.title = title;
  button.id = 'tab-' + id;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', panel.id);
  panel.setAttribute('aria-labelledby', button.id);
  button.onclick = () => selectTab(id);
  button.onkeydown = event => {
    const index = documents.findIndex(doc => doc.id === id);
    let target;
    if (event.key === 'ArrowRight') target = documents[(index + 1) % documents.length];
    if (event.key === 'ArrowLeft') target = documents[(index + documents.length - 1) % documents.length];
    if (event.key === 'Home') target = documents[0];
    if (event.key === 'End') target = documents[documents.length - 1];
    if (target) { event.preventDefault(); selectTab(target.id); target.button.focus(); }
  };
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Fermer ' + title);
  close.onclick = () => { closeTab(id); documents.find(doc => doc.id === activeId)?.button.focus(); };
  tab.append(button, close);
  $('tabs').append(tab);
  const doc = { id, kind, title, url, panel, frame, tab, button, fileId: options.fileId ?? (kind === 'pdf' && personalDisplay ? crypto.randomUUID() : undefined), originalBlob: options.blob ?? null, reader: null, loadingFile: null };
  if (kind === 'pdf' && personalDisplay && window.ClasseCalmePdf) {
    doc.reader = window.ClasseCalmePdf.create(panel, { canChange: canEditDisplay, onChange: displayChanged });
    doc.reader.setState({ page: options.page ?? 1, zoom: options.zoom ?? 'fit' });
    if (doc.originalBlob) doc.reader.load(doc.originalBlob);
  }
  documents.push(doc);
  selectTab(id);
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  displayChanged();
  return doc;
}
function addFiles(files) {
  if (!canEditDisplay()) return;
  let skipped = false;
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (personalDisplay && file.size > 15 * 1024 * 1024) { notify('PDF trop volumineux : 15 Mo maximum.'); continue; }
      addDocument('pdf', file.name, personalDisplay ? null : URL.createObjectURL(file), { blob: file });
    } else skipped = true;
  }
  if (skipped) notify('Choisissez des fichiers PDF.');
}
function openWebForm() {
  if (!canEditDisplay()) return;
  settings(false); tabPicker(false); window.ClasseCalmeTools?.closePanel(); document.dispatchEvent(new Event('classe-calme:close-connections'));
  $('webForm').hidden = false;
  $('webError').textContent = '';
  $('webUrl').focus();
}
function parseWebUrl(value) {
  const input = value.trim();
  if (!input || /\s/.test(input)) throw new Error('url');
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[^/:]+:\d+(?:\/|$)/.test(input);
  const url = new URL(hasScheme ? input : 'https://' + input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('https');
  return url;
}
function showAlarm(on, broadcast = true) {
  const className = ($('mode').value === 'border' ? 'border ' : '') + ($('pulse').checked ? 'pulsing' : '');
  const changed = alarmed !== on || $('alarm').className !== className;
  if (alarmed !== on && broadcast) { loudSince = quietSince = null; }
  alarmed = on;
  $('alarm').hidden = !on;
  $('alarm').className = className;
  if (changed && broadcast) document.dispatchEvent(new Event('classe-calme:state'));
}
function updatePause(now) {
  const visibleUntil = Math.max(pausedUntil, remotePauseUntil);
  const paused = now < visibleUntil;
  $('pause').textContent = paused ? 'Reprendre' : 'Pause 30 s';
  $('pause').setAttribute('aria-pressed', String(paused));
  if (paused) $('badgeText').textContent = 'Pause · ' + Math.ceil((visibleUntil - now) / 1000) + ' s';
  return now < pausedUntil;
}
function pause() {
  pausedUntil = performance.now() + 30000;
  testUntil = 0;
  calibration = null;
  $('calibrate').disabled = !stream;
  loudSince = quietSince = null;
  showAlarm(false);
  updatePause(performance.now());
}
function togglePause() {
  if (performance.now() < pausedUntil) {
    pausedUntil = 0;
    loudSince = quietSince = null;
    updatePause(performance.now());
    if (stream) tick();
  } else pause();
}
function sampleNoise() {
  const now = performance.now();
  if (now - lastTick > 700) loudSince = quietSince = null;
  lastTick = now;
  if (!stream) { showAlarm(now < testUntil); return; }
  if (context.state !== 'running' || stream.getAudioTracks().some(track => track.muted)) {
    if (calibration) { calibration = null; $('calibrate').disabled = false; }
    const suspended = context.state !== 'running';
    $('badgeText').textContent = suspended ? 'Micro interrompu' : 'Micro muet';
    $('status').textContent = suspended ? 'Micro interrompu. Cliquez sur Reprendre micro.' : 'Micro muet. Vérifiez le micro.';
    $('mic').textContent = suspended ? 'Reprendre micro' : 'Couper micro';
    level = 0;
    $('level').style.width = '0%';
    document.querySelector('.meter').setAttribute('aria-valuenow', '0');
    loudSince = quietSince = null;
    if (now >= testUntil) showAlarm(false);
    return;
  }
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const db = 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / samples.length)));
  level = .65 * level + .35 * clamp((db + 75) / 65 * 100, 0, 100);
  $('level').style.width = level + '%';
  document.querySelector('.meter').setAttribute('aria-valuenow', Math.round(level));
  const threshold = +$('threshold').value;
  $('level').style.background = level >= threshold ? '#cf3e32' : level >= threshold - 10 ? '#d69c30' : '#73a759';
  if (calibration) {
    calibration.values.push(level);
    const remaining = Math.max(0, Math.ceil((calibration.end - now) / 1000));
    $('status').textContent = $('badgeText').textContent = 'Calibrage · ' + remaining + ' s';
    if (now >= calibration.end) {
      const sorted = calibration.values.sort((a, b) => a - b);
      setThreshold(sorted[Math.floor(sorted.length * .85)] + 12);
      calibration = null;
      $('calibrate').disabled = false;
    }
    loudSince = quietSince = null;
    showAlarm(false);
    return;
  }
  if (now < testUntil) { showAlarm(true); return; }
  if (updatePause(now)) { $('status').textContent = 'Micro actif · alerte en pause'; showAlarm(false); return; }
  $('status').textContent = 'Micro actif';
  $('mic').textContent = 'Couper micro';
  if (!alarmed) {
    if (level >= threshold) {
      loudSince ??= now;
      if (now - loudSince >= +$('delay').value * 1000) showAlarm(true);
    } else loudSince = null;
  } else {
    if (level < threshold - 5) {
      quietSince ??= now;
      if (now - quietSince >= 3000) showAlarm(false);
    } else quietSince = null;
  }
  $('badgeText').textContent = alarmed ? 'Bruit élevé' : loudSince !== null ? 'Bruit élevé…' : 'Micro actif';
}
function applyRemoteOverrides() {
  const now = performance.now();
  if (now < remotePauseUntil) {
    showAlarm(false, false);
    $('badgeText').textContent = 'Pause · ' + Math.ceil((remotePauseUntil - now) / 1000) + ' s';
  } else if (now < remoteTestUntil) showAlarm(true, false);
  else showAlarm(sampledAlarm, false);
}
function tick() {
  if (stream) alarmed = sampledAlarm;
  sampleNoise();
  if (stream) sampledAlarm = alarmed;
  emitNoise();
  if (stream) applyRemoteOverrides();
}
async function stop() {
  const wasActive = Boolean(stream);
  microphoneSession++;
  starting = false;
  if (timer) clearInterval(timer);
  timer = null;
  const tracks = stream?.getTracks() ?? [];
  stream = null;
  for (const track of tracks) { track.onended = null; track.stop(); }
  source?.disconnect(); source = null;
  const oldContext = context; context = null;
  analyser = samples = calibration = null;
  loudSince = quietSince = null;
  pausedUntil = testUntil = 0;
  level = 0;
  sampledAlarm = false;
  showAlarm(false);
  document.body.classList.remove('listening');
  document.querySelector('.meter').hidden = Boolean(remoteNoise);
  $('mic').textContent = 'Activer micro';
  $('mic').setAttribute('aria-pressed', 'false');
  $('status').textContent = $('badgeText').textContent = 'Micro arrêté';
  $('level').style.width = '0%';
  document.querySelector('.meter').setAttribute('aria-valuenow', '0');
  $('calibrate').disabled = $('pause').disabled = true;
  updatePause(performance.now());
  if (wasActive) document.dispatchEvent(new CustomEvent('classe-calme:microphone', { detail: { active: false } }));
  emitNoise(true);
  if (remoteNoise) setRemoteNoise(remoteNoise);
  if (oldContext) await oldContext.close().catch(() => {});
}
async function microphone() {
  if (starting) { await stop(); return; }
  if (stream && context.state !== 'running') {
    try { await context.resume(); tick(); } catch { notify('Impossible de reprendre le micro.'); }
    return;
  }
  if (stream) { await stop(); return; }
  starting = true;
  const session = ++microphoneSession;
  $('mic').textContent = 'Annuler';
  $('status').textContent = $('badgeText').textContent = 'Autorisez le micro…';
  let acquired;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    context = new AudioContext();
    await context.resume();
    if (session !== microphoneSession) return;
    acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false
    });
    if (session !== microphoneSession) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    samples = new Float32Array(analyser.fftSize);
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    for (const track of stream.getTracks()) track.onended = () => {
      if (session !== microphoneSession) return;
      stop();
      $('status').textContent = $('badgeText').textContent = 'Micro déconnecté';
      notify('Micro déconnecté. Rebranchez-le puis réactivez.');
    };
    document.body.classList.add('listening');
    document.querySelector('.meter').hidden = false;
    sampledAlarm = false;
    $('mic').setAttribute('aria-pressed', 'true');
    $('calibrate').disabled = $('pause').disabled = false;
    lastTick = performance.now();
    document.dispatchEvent(new CustomEvent('classe-calme:microphone', { detail: { active: true } }));
    timer = setInterval(tick, 100);
    tick();
  } catch (error) {
    if (session !== microphoneSession) return;
    acquired?.getTracks().forEach(track => track.stop());
    await stop();
    const message = error.name === 'NotAllowedError' ? 'Micro refusé ou bloqué. Autorisez-le dans le navigateur.'
      : error.name === 'NotFoundError' ? 'Aucun micro détecté.'
      : error.message === 'unsupported' ? 'Ouvrez la page dans un navigateur récent en HTTPS.'
      : 'Micro indisponible. Fermez les autres applications qui l’utilisent.';
    $('status').textContent = message;
    $('badgeText').textContent = 'Micro indisponible';
    settings(true);
  } finally { if (session === microphoneSession) starting = false; }
}
function updateProjection(on) {
  projection = on;
  document.body.classList.toggle('tabs-hidden', on);
  tabPicker(false); settings(false); window.ClasseCalmeTools?.closePanel(); document.dispatchEvent(new Event('classe-calme:close-connections'));
  $('webForm').hidden = true;
  $('fullscreen').textContent = on && (!personalDisplay || document.fullscreenElement) ? '⛶ Quitter' : '⛶ Projeter';
}

function getDisplayState() {
  return {
    documents: documents.map(doc => doc.kind === 'pdf'
      ? { id: doc.id, kind: 'pdf', title: doc.title, fileId: doc.fileId, ...(doc.reader?.getState() ?? { page: 1, zoom: 'fit' }) }
      : { id: doc.id, kind: 'web', title: doc.title, url: doc.url }),
    activeId
  };
}
async function applyDisplayState(state, loadFile) {
  if (!personalDisplay || !state || !Array.isArray(state.documents)) return;
  const desired = state.documents.slice(0, 50), desiredIds = new Set(desired.map(doc => doc.id));
  const fileTasks = [];
  applyingDisplay = true;
  try {
    for (const doc of [...documents]) if (!desiredIds.has(doc.id)) closeTab(doc.id);
    const ordered = [];
    for (const descriptor of desired) {
      let doc = documents.find(item => item.id === descriptor.id);
      if (doc && (doc.kind !== descriptor.kind || (doc.kind === 'pdf' ? doc.fileId !== descriptor.fileId : doc.url !== descriptor.url))) {
        closeTab(doc.id); doc = null;
      }
      if (!doc) doc = addDocument(descriptor.kind, descriptor.title, descriptor.url ?? null, descriptor);
      if (!doc) continue;
      doc.title = descriptor.title;
      doc.button.textContent = (doc.kind === 'pdf' ? '▤ ' : '↗ ') + doc.title;
      doc.button.title = doc.title;
      doc.reader?.setState({ page: descriptor.page ?? 1, zoom: descriptor.zoom ?? 'fit' });
      ordered.push(doc);
      if (doc.kind === 'pdf' && !doc.originalBlob && typeof loadFile === 'function') {
        if (!doc.loadingFile) {
          doc.loadingFile = Promise.resolve().then(() => loadFile(doc.fileId)).then(blob => {
            if (!documents.includes(doc) || !(blob instanceof Blob)) return;
            doc.originalBlob = blob;
            return doc.reader?.load(blob);
          }).catch(() => { if (documents.includes(doc)) doc.reader?.error(); }).finally(() => { doc.loadingFile = null; });
        }
        fileTasks.push(doc.loadingFile);
      }
    }
    documents.splice(0, documents.length, ...ordered);
    // Ne pas déplacer les iframes : cela rechargerait le site déjà ouvert.
    for (let index = 0; index < documents.length; index++) {
      const tab = documents[index].tab;
      if ($('tabs').children[index] !== tab) $('tabs').insertBefore(tab, $('tabs').children[index] ?? null);
    }
    selectTab(documents.some(doc => doc.id === state.activeId) ? state.activeId : documents[0]?.id ?? null);
  } finally { applyingDisplay = false; }
  await Promise.allSettled(fileTasks);
}
function setRemoteNoise(noise, preferences, options = {}) {
  if (preferences) {
    const threshold = clamp(Math.round(Number(preferences.threshold) || 12), 10, 95);
    for (const id of ['threshold', 'quickThreshold']) $(id).value = threshold;
    for (const id of ['thresholdValue', 'quickThresholdValue']) $(id).textContent = threshold;
    $('mark').style.left = threshold + '%';
    if (['2', '3', '5', '8'].includes(String(preferences.delay))) $('delay').value = String(preferences.delay);
    if (['cover', 'border'].includes(preferences.mode)) $('mode').value = preferences.mode;
    if (typeof preferences.pulse === 'boolean') $('pulse').checked = preferences.pulse;
  }
  remoteNoise = noise && { ...noise, alarm: noise.alarm === true };
  document.querySelector('.meter').hidden = Boolean(remoteNoise && !stream);
  const serverNow = Number.isFinite(options.serverNow) ? options.serverNow : Date.now();
  remotePauseUntil = remoteNoise?.pausedUntil > serverNow ? performance.now() + Math.min(60000, remoteNoise.pausedUntil - serverNow) : 0;
  remoteTestUntil = remoteNoise?.testUntil > serverNow ? performance.now() + Math.min(10000, remoteNoise.testUntil - serverNow) : 0;
  if (stream) { applyRemoteOverrides(); return; }
  level = 0;
  $('level').style.width = level + '%';
  document.querySelector('.meter').setAttribute('aria-valuenow', Math.round(level));
  $('badgeText').textContent = remoteNoise ? (remoteNoise.alarm ? 'Bruit élevé' : 'Micro connecté') : 'Micro arrêté';
  showAlarm(remoteNoise?.alarm ?? false, false);
}
window.ClasseCalmeDisplay = {
  getState: getDisplayState,
  getFile: fileId => documents.find(doc => doc.fileId === fileId)?.originalBlob ?? null,
  applyState: applyDisplayState,
  setFollowing(value) { following = Boolean(value); document.body.classList.toggle('remote-following', following); },
  setRemoteNoise,
  stopMicrophone: stop,
  getMicrophoneState: () => Boolean(stream)
};

$('threshold').oninput = () => setThreshold(+$('threshold').value);
$('quickThreshold').oninput = () => setThreshold(+$('quickThreshold').value);
$('mode').onchange = $('pulse').onchange = () => { showAlarm(alarmed); savePreferences(); };
$('delay').onchange = () => { loudSince = null; savePreferences(); };
$('openPdf').onclick = $('topPdf').onclick = () => { if (canEditDisplay()) $('pdf').click(); };
$('pdf').onchange = () => { addFiles($('pdf').files); $('pdf').value = ''; };
$('addWeb').onclick = $('emptyWeb').onclick = openWebForm;
$('cancelWeb').onclick = () => { $('webForm').hidden = true; };
$('webForm').onsubmit = event => {
  event.preventDefault();
  try {
    const url = parseWebUrl($('webUrl').value);
    if (!canEditDisplay()) return;
    addDocument('web', url.hostname, url.href);
    $('webForm').hidden = true;
    $('webUrl').value = '';
  } catch { $('webError').textContent = 'Adresse HTTPS valide attendue.'; }
};
$('reloadWeb').onclick = () => { const doc = documents.find(doc => doc.id === activeId); if (doc) doc.frame.src = doc.url; };
$('toggleTabs').onclick = () => { renderTabChoices(); tabPicker($('tabPicker').hidden); };
$('closePicker').onclick = () => { tabPicker(false); $('toggleTabs').focus(); };
$('pickerPdf').onclick = () => { if (canEditDisplay()) { tabPicker(false); $('pdf').click(); } };
$('pickerWeb').onclick = openWebForm;
$('settingsButton').onclick = () => settings($('settings').hidden);
$('closeSettings').onclick = () => { settings(false); $('settingsButton').focus(); };
$('pause').onclick = togglePause;
$('dismiss').onclick = pause;
$('test').onclick = () => { calibration = null; $('calibrate').disabled = !stream; testUntil = performance.now() + 5000; showAlarm(true); };
$('mic').onclick = microphone;
$('calibrate').onclick = () => {
  if (!stream) return;
  pausedUntil = testUntil = 0;
  calibration = { end: performance.now() + 3000, values: [] };
  $('calibrate').disabled = true;
  updatePause(performance.now());
  showAlarm(false);
};
$('fullscreen').onclick = async () => {
  if (projection && (!personalDisplay || document.fullscreenElement)) {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
    updateProjection(false);
  } else {
    updateProjection(true);
    try { await document.documentElement.requestFullscreen(); } catch { /* Projection dans la fenêtre. */ }
  }
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && projection) updateProjection(false);
  else if (document.fullscreenElement && projection) $('fullscreen').textContent = '⛶ Quitter';
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    tabPicker(false); settings(false); $('webForm').hidden = true;
    if (alarmed) pause();
    if (projection && !document.fullscreenElement) updateProjection(false);
  }
});
setInterval(() => { if (!stream && !remoteNoise && alarmed && performance.now() >= testUntil) showAlarm(false); }, 100);
// Arrêter le micro en quittant la page. Les PDF restent valides si le navigateur restaure la page.
window.addEventListener('pagehide', () => { stop(); });
restorePreferences();
