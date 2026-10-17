(function () {
  'use strict';
  if (window.ClasseCalmeTools) return;
  const dock = document.getElementById('dock');
  const settingsButton = document.getElementById('settingsButton');
  if (!dock || !settingsButton) return;

  const storageKey = 'classe-calme.tools.v1';
  const defaultMessage = 'MOINS DE BRUIT, MERCI.';
  const defaults = { silence: 40, binomes: 55, groupes: 70 };
  const bounded = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
  const shortText = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  let selectedProfile = 'binomes';
  const thresholds = { ...defaults };
  let message = defaultMessage;
  let duration = 30;
  let savedProfiles = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === 'object') {
      if (Object.hasOwn(defaults, saved.profile)) selectedProfile = saved.profile;
      for (const name of Object.keys(defaults)) {
        if (Number.isFinite(saved.thresholds?.[name])) thresholds[name] = bounded(saved.thresholds[name], 10, 95);
      }
      savedProfiles = true;
      if (typeof saved.message === 'string') message = shortText(saved.message, 120) || defaultMessage;
      if ([15, 30, 60, 120].includes(saved.duration)) duration = saved.duration;
    }
  } catch { /* Le navigateur peut refuser le stockage. */ }
  // Preserve a threshold already chosen before the profiles existed.
  if (!savedProfiles) {
    const existing = Number(document.getElementById('threshold')?.value);
    if (Number.isFinite(existing)) thresholds[selectedProfile] = bounded(existing, 10, 95);
  }

  const panel = document.createElement('aside');
  panel.id = 'toolsPopup';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'toolsHeading');
  panel.innerHTML = `
    <div class="tools-heading"><h2 id="toolsHeading">Outils</h2><button id="closeTools" type="button" aria-label="Fermer les outils">×</button></div>
    <section class="tool-section" aria-labelledby="profileHeading">
      <h3 id="profileHeading">Bruit</h3>
      <div class="noise-profiles" role="group" aria-label="Mode de travail">
        <button type="button" data-noise-profile="silence" aria-pressed="false">Silence</button>
        <button type="button" data-noise-profile="binomes" aria-pressed="false">Binômes</button>
        <button type="button" data-noise-profile="groupes" aria-pressed="false">Groupes</button>
      </div>
      <label class="tools-range-label" for="profileThreshold">Seuil <output id="profileThresholdValue">55</output></label>
      <input id="profileThreshold" type="range" min="10" max="95" value="55">
    </section>
    <section class="tool-section" aria-labelledby="timerHeading">
      <h3 id="timerHeading">Minuteur</h3>
      <form id="lessonTimerForm" class="timer-controls">
        <label class="timer-minutes" for="timerMinutes"><input id="timerMinutes" type="number" inputmode="numeric" min="1" max="180" step="1" value="5" required> min</label>
        <output id="timerReadout" aria-label="Temps restant">05:00</output>
        <button id="timerStart" type="submit">Démarrer</button>
        <button id="timerReset" type="button" aria-label="Réinitialiser le minuteur" title="Réinitialiser">↺</button>
      </form>
    </section>
    <section class="tool-section" aria-labelledby="noticeHeading">
      <h3 id="noticeHeading">Consigne</h3>
      <div class="notice-presets" role="group" aria-label="Consignes rapides">
        <button type="button" data-class-notice="Écoutez">Écoutez</button>
        <button type="button" data-class-notice="Travail sur papier">Travail sur papier</button>
        <button type="button" data-class-notice="Il reste 2 minutes">Il reste 2 minutes</button>
      </div>
      <form id="classNoticeForm">
        <label class="sr" for="classNoticeInput">Votre consigne</label>
        <input id="classNoticeInput" type="text" maxlength="180" placeholder="Votre consigne…" autocomplete="off" required>
        <div class="tools-actions">
          <label for="classNoticeDuration" class="sr">Durée de la consigne</label>
          <select id="classNoticeDuration" aria-label="Durée de la consigne"><option value="15">15 s</option><option value="30" selected>30 s</option><option value="60">1 min</option><option value="120">2 min</option></select>
          <button id="showClassNotice" type="submit">Afficher</button>
          <button id="clearClassNotice" type="button" disabled>Masquer</button>
        </div>
      </form>
    </section>
    <details class="tool-section alarm-message-tools">
      <summary>Texte de l’alerte</summary>
      <form id="alarmMessageForm">
        <label class="sr" for="alarmMessage">Texte de l’alerte</label>
        <input id="alarmMessage" type="text" maxlength="120" autocomplete="off">
        <div class="tools-actions"><button type="submit">Enregistrer</button><button id="resetAlarmMessage" type="button">Rétablir</button></div>
      </form>
    </details>
    <p id="toolsFeedback" role="status"></p>`;
  document.body.append(panel);
  const byId = id => document.getElementById(id);

  const button = document.createElement('button');
  button.id = 'toolsButton';
  button.type = 'button';
  button.textContent = 'Outils';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', panel.id);
  dock.insertBefore(button, settingsButton);

  const timerBadge = document.createElement('button');
  timerBadge.id = 'lessonTimer';
  timerBadge.type = 'button';
  timerBadge.hidden = true;
  timerBadge.title = 'Minuteur — ouvrir les outils';
  dock.insertBefore(timerBadge, button);
  const timerAnnouncement = document.createElement('span');
  timerAnnouncement.className = 'sr';
  timerAnnouncement.setAttribute('role', 'status');
  document.body.append(timerAnnouncement);

  const notice = document.createElement('div');
  notice.id = 'classNotice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  const noticeText = document.createElement('span');
  noticeText.id = 'classNoticeText';
  const hideNoticeButton = document.createElement('button');
  hideNoticeButton.type = 'button';
  hideNoticeButton.textContent = 'Masquer';
  notice.append(noticeText, hideNoticeButton);
  document.body.append(notice);

  let currentNotice = null;
  let timerState = 'idle';
  let remainingMs = 5 * 60000;
  let deadline = 0;
  let lastTimerLabel = '';

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ profile: selectedProfile, thresholds, message, duration })); }
    catch { /* Les outils fonctionnent aussi sans stockage. */ }
  }
  function broadcastChanged() { document.dispatchEvent(new Event('classe-calme:state')); }
  function feedback(text) { byId('toolsFeedback').textContent = text; }
  function closePanel(returnFocus = false) {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }
  function openPanel() {
    window.settings?.(false);
    window.tabPicker?.(false);
    document.dispatchEvent(new Event('classe-calme:close-connections'));
    const webForm = byId('webForm');
    if (webForm) webForm.hidden = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // A dock moved to another edge can position this popup immediately.
    document.dispatchEvent(new Event('classe-calme:tools-open'));
  }
  button.addEventListener('click', () => { if (panel.hidden) openPanel(); else closePanel(); });
  timerBadge.addEventListener('click', () => { openPanel(); byId('timerStart').focus(); });
  byId('closeTools').addEventListener('click', () => closePanel(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) closePanel(true);
  });

  function renderProfile() {
    for (const profileButton of panel.querySelectorAll('[data-noise-profile]')) {
      profileButton.setAttribute('aria-pressed', String(profileButton.dataset.noiseProfile === selectedProfile));
    }
    byId('profileThreshold').value = thresholds[selectedProfile];
    byId('profileThresholdValue').textContent = thresholds[selectedProfile];
  }
  function chooseProfile(name) {
    selectedProfile = name;
    window.setThreshold?.(thresholds[name]);
    renderProfile();
    save();
  }
  for (const profileButton of panel.querySelectorAll('[data-noise-profile]')) {
    profileButton.addEventListener('click', () => chooseProfile(profileButton.dataset.noiseProfile));
  }
  byId('profileThreshold').addEventListener('input', event => {
    const value = bounded(Number(event.target.value), 10, 95);
    thresholds[selectedProfile] = value;
    window.setThreshold?.(value);
    renderProfile();
    save();
  });
  document.addEventListener('classe-calme:threshold', () => {
    const value = Number(byId('threshold')?.value);
    if (!Number.isFinite(value)) return;
    thresholds[selectedProfile] = bounded(value, 10, 95);
    renderProfile();
    save();
  });

  function renderMessage() {
    const heading = document.querySelector('#alarm h2');
    if (heading) {
      heading.textContent = message;
      heading.classList.toggle('long-message', message.length > 55);
    }
    byId('alarmMessage').value = message;
  }
  function setMessage(value) {
    message = shortText(value, 120) || defaultMessage;
    renderMessage();
    save();
    feedback('Texte enregistré.');
    broadcastChanged();
  }
  byId('alarmMessageForm').addEventListener('submit', event => { event.preventDefault(); setMessage(byId('alarmMessage').value); });
  byId('resetAlarmMessage').addEventListener('click', () => setMessage(defaultMessage));

  function hideClassNotice() {
    if (!currentNotice) return;
    currentNotice = null;
    notice.hidden = true;
    noticeText.textContent = '';
    byId('clearClassNotice').disabled = true;
    broadcastChanged();
  }
  function showClassNotice(value) {
    const text = shortText(value, 180);
    if (!text) { byId('classNoticeInput').focus(); return; }
    duration = bounded(Number(byId('classNoticeDuration').value) || 30, 1, 120);
    currentNotice = { text, until: Date.now() + duration * 1000 };
    noticeText.textContent = text;
    notice.hidden = false;
    byId('clearClassNotice').disabled = false;
    save();
    broadcastChanged();
  }
  byId('classNoticeForm').addEventListener('submit', event => { event.preventDefault(); showClassNotice(byId('classNoticeInput').value); });
  for (const preset of panel.querySelectorAll('[data-class-notice]')) {
    preset.addEventListener('click', () => showClassNotice(preset.dataset.classNotice));
  }
  byId('clearClassNotice').addEventListener('click', hideClassNotice);
  hideNoticeButton.addEventListener('click', hideClassNotice);
  byId('classNoticeDuration').value = String(duration);
  byId('classNoticeDuration').addEventListener('change', () => { duration = Number(byId('classNoticeDuration').value); save(); });

  function formatTime(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }
  function currentRemaining() { return timerState === 'running' ? Math.max(0, deadline - Date.now()) : remainingMs; }
  function renderTimer() {
    const left = currentRemaining();
    if (timerState === 'running' && left <= 0) {
      timerState = 'finished';
      remainingMs = 0;
      timerAnnouncement.textContent = 'Minuteur terminé.';
    }
    const time = formatTime(left);
    const label = timerState === 'finished' ? 'Temps écoulé' : (timerState === 'paused' ? '⏸ ' : '◷ ') + time;
    if (label !== lastTimerLabel) {
      timerBadge.textContent = label;
      timerBadge.setAttribute('aria-label', (timerState === 'finished' ? 'Minuteur terminé' : 'Minuteur ' + time + (timerState === 'paused' ? ', en pause' : '')) + ', ouvrir les outils');
      byId('timerReadout').textContent = time;
      lastTimerLabel = label;
    }
    timerBadge.hidden = timerState === 'idle';
    timerBadge.classList.toggle('timer-finished', timerState === 'finished');
    timerBadge.classList.toggle('timer-paused', timerState === 'paused');
    byId('timerStart').textContent = timerState === 'running' ? 'Pause' : timerState === 'paused' ? 'Reprendre' : 'Démarrer';
    byId('timerMinutes').disabled = timerState === 'running' || timerState === 'paused';
  }
  byId('lessonTimerForm').addEventListener('submit', event => {
    event.preventDefault();
    if (timerState === 'running') {
      remainingMs = currentRemaining();
      timerState = 'paused';
    } else {
      if (timerState !== 'paused') {
        const minutes = bounded(Number(byId('timerMinutes').value) || 5, 1, 180);
        byId('timerMinutes').value = String(minutes);
        remainingMs = minutes * 60000;
      }
      deadline = Date.now() + remainingMs;
      timerState = 'running';
      timerAnnouncement.textContent = '';
    }
    renderTimer();
  });
  byId('timerReset').addEventListener('click', () => {
    timerState = 'idle';
    const minutes = bounded(Number(byId('timerMinutes').value) || 5, 1, 180);
    byId('timerMinutes').value = String(minutes);
    remainingMs = minutes * 60000;
    timerAnnouncement.textContent = '';
    renderTimer();
  });
  byId('timerMinutes').addEventListener('input', () => {
    if (timerState === 'idle' || timerState === 'finished') {
      timerState = 'idle';
      remainingMs = bounded(Number(byId('timerMinutes').value) || 5, 1, 180) * 60000;
      renderTimer();
    }
  });

  window.ClasseCalmeTools = {
    getBroadcastState: () => ({
      message,
      notice: currentNotice && currentNotice.until > Date.now() ? { ...currentNotice } : null
    }),
    openPanel,
    closePanel
  };
  renderProfile();
  renderMessage();
  renderTimer();
  window.setThreshold?.(thresholds[selectedProfile]);
  function updateClock() {
    renderTimer();
    if (currentNotice && currentNotice.until <= Date.now()) hideClassNotice();
  }
  setInterval(updateClock, 250);
  document.addEventListener('visibilitychange', updateClock);
  window.addEventListener('pageshow', updateClock);
})();
