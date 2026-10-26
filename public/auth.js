(() => {
  'use strict';
  const grantKey = 'classe-calme.github.grant.v2';
  const attemptKey = 'classe-calme.github.login-attempt.v2';
  const relayOrigin = 'https://classe-calme-relay.cardosojm.workers.dev';
  const requestedChannel = new URLSearchParams(location.search).get('channel');
  const channel = /^test-[a-z0-9-]{8,70}$/.test(requestedChannel || '') ? requestedChannel : 'main';
  let grant = null, claims = null, attempted = false, expiryTimer = null;
  let dialog, form, passwordInput, feedback, submitButton, closeButton, dockButton;
  let busy = false, operation = null, returnFocus = null, dialogGeneration = 0;
  let passwordDialog, passwordForm, currentPasswordInput, newPasswordInput, confirmPasswordInput, passwordFeedback;
  let passwordSubmitButton, passwordCancelButton, passwordCloseButton, passwordConnectButton, changePasswordButton;
  let passwordBusy = false, passwordReturnFocus = null, changeAfterLogin = false;

  // Les anciennes autorisations et leurs adresses de retour ne servent plus.
  try {
    for (const key of ['classe-calme.github.grant.v1', 'classe-calme.github.auth-state', 'classe-calme.github.auth-attempt.v1']) sessionStorage.removeItem(key);
    attempted = sessionStorage.getItem(attemptKey) !== null;
  } catch {}
  const oldCallback = new URLSearchParams(location.hash.slice(1));
  if (oldCallback.has('classe-calme-auth') || oldCallback.has('state')) history.replaceState(history.state, '', location.pathname + location.search);

  function decode(token) {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'cc2' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
    try {
      const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')));
      const now = Date.now() / 1000;
      if (!payload || payload.v !== 2 || payload.aud !== 'classe-calme-github' || payload.scope !== 'publish' || payload.channel !== channel ||
          !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + 60 || payload.exp <= now ||
          payload.exp <= payload.iat || payload.exp - payload.iat > 28800 ||
          typeof payload.nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.nonce)) return null;
      return payload;
    } catch { return null; }
  }
  function changed() {
    syncButton();
    document.dispatchEvent(new Event('classe-calme:auth-changed'));
  }
  function clearGrant() {
    const hadGrant = Boolean(grant);
    grant = claims = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    try { sessionStorage.removeItem(grantKey); } catch {}
    if (hadGrant) changed(); else syncButton();
  }
  function accept(token, announce = true) {
    const payload = decode(token);
    if (!payload) { clearGrant(); return false; }
    grant = token;
    claims = payload;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(clearGrant, Math.max(1, payload.exp * 1000 - Date.now()));
    try { sessionStorage.setItem(grantKey, token); } catch {}
    if (announce) changed();
    return true;
  }
  function getGrant() {
    if (grant && (!claims || claims.exp <= Date.now() / 1000)) clearGrant();
    return grant;
  }
  function endpoint(path) {
    const url = new URL(path, relayOrigin);
    if (channel !== 'main') url.searchParams.set('channel', channel);
    return url.href;
  }
  function syncButton() {
    if (!dockButton) return;
    const connected = Boolean(grant && claims?.exp > Date.now() / 1000);
    dockButton.textContent = connected ? 'Déconnexion' : 'Connexion prof';
    dockButton.title = connected ? 'Déconnecter cet appareil' : 'Relier mes appareils et mes activités';
    dockButton.classList.toggle('prof-connected', connected);
    dockButton.setAttribute('aria-label', connected ? 'Déconnexion professeur' : 'Connexion professeur');
  }
  function showFeedback(message) { feedback.textContent = message; }
  function setBusy(value) {
    busy = value;
    submitButton.disabled = passwordInput.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }
  function close() {
    dialogGeneration++;
    operation?.abort();
    operation = null;
    setBusy(false);
    passwordInput.value = '';
    changeAfterLogin = false;
    if (dialog.open) dialog.close();
    returnFocus?.focus?.();
  }
  async function request(path, options) {
    const controller = new AbortController();
    operation = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(endpoint(path), { method: 'POST', credentials: 'omit', cache: 'no-store', ...options, signal: controller.signal });
      const result = response.ok ? await response.json() : null;
      return { response, result };
    } finally {
      clearTimeout(timeout);
      if (operation === controller) operation = null;
    }
  }
  function rateLimitMessage(response) {
    const delay = Number(response.headers.get('Retry-After'));
    return Number.isFinite(delay) && delay > 0 && delay <= 3600
      ? 'Trop d’essais. Réessaie dans ' + Math.ceil(delay) + ' s.'
      : 'Trop d’essais. Réessaie dans quelques minutes.';
  }
  async function login(event) {
    event.preventDefault();
    if (busy || !passwordInput.value) return;
    const generation = dialogGeneration;
    setBusy(true);
    showFeedback('Connexion…');
    let secret = passwordInput.value;
    passwordInput.value = '';
    try {
      const pending = request('/login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: secret }) });
      secret = '';
      const { response, result } = await pending;
      if (!dialog.open || generation !== dialogGeneration) return;
      if (response.status === 401) { showFeedback('Mot de passe incorrect.'); return; }
      if (response.status === 429) { showFeedback(rateLimitMessage(response)); return; }
      if (!response.ok) { showFeedback('Connexion indisponible. Réessaie.'); return; }
      if (!accept(result.grant)) { showFeedback('Connexion indisponible. Réessaie.'); return; }
      const continueChange = changeAfterLogin;
      close();
      if (continueChange) openPasswordChange();
    } catch {
      if (dialog.open && generation === dialogGeneration) showFeedback('Connexion impossible. Vérifie Internet puis réessaie.');
    } finally {
      secret = '';
      if (generation === dialogGeneration) {
        setBusy(false);
        if (dialog.open) passwordInput.focus();
      }
    }
  }
  async function logout() {
    if (busy) return;
    const token = getGrant();
    if (!token) { connect(); return; }
    dockButton.disabled = true;
    try {
      const { response, result } = await request('/logout', { headers: { Authorization: 'Bearer ' + token } });
      if (response.status === 401) { clearGrant(); return; }
      if (response.ok && result?.ok === true) { clearGrant(); return; }
      showLogoutError();
    } catch { showLogoutError(); }
    finally { dockButton.disabled = false; }
  }
  function showLogoutError() {
    mount();
    form.hidden = true;
    document.getElementById('profLoginTitle').textContent = 'Déconnexion impossible';
    document.getElementById('retryProfLogout').hidden = false;
    showFeedback('Vérifie Internet puis réessaie. Les activités restent reliées.');
    if (!dialog.open) { returnFocus = dockButton; dialog.showModal(); }
    closeButton.textContent = 'Fermer';
  }
  function emptyPasswordFields() {
    currentPasswordInput.value = newPasswordInput.value = confirmPasswordInput.value = '';
  }
  function setPasswordBusy(value) {
    passwordBusy = value;
    for (const field of [currentPasswordInput, newPasswordInput, confirmPasswordInput, passwordSubmitButton, passwordCancelButton, passwordCloseButton]) field.disabled = value;
    passwordForm.setAttribute('aria-busy', String(value));
  }
  function closePasswordChange() {
    if (passwordBusy) return;
    emptyPasswordFields();
    if (passwordDialog.open) passwordDialog.close();
    passwordReturnFocus?.focus?.();
  }
  function passwordResult(message, success = false) {
    emptyPasswordFields();
    passwordForm.hidden = true;
    passwordFeedback.textContent = message;
    passwordFeedback.classList.toggle('prof-password-success', success);
    passwordConnectButton.hidden = false;
    passwordCancelButton.textContent = 'Fermer';
    passwordConnectButton.focus();
  }
  function openPasswordChange() {
    if (busy || passwordBusy || operation) return false;
    mount();
    if (!getGrant()) {
      changeAfterLogin = true;
      connect();
      return true;
    }
    if (passwordDialog.open) return true;
    window.settings?.(false);
    window.tabPicker?.(false);
    window.ClasseCalmeTools?.closePanel();
    document.dispatchEvent(new Event('classe-calme:close-connections'));
    passwordReturnFocus = document.getElementById('settingsButton') || changePasswordButton;
    emptyPasswordFields();
    setPasswordBusy(false);
    passwordForm.hidden = false;
    passwordFeedback.textContent = '';
    passwordFeedback.classList.remove('prof-password-success');
    passwordConnectButton.hidden = true;
    passwordCancelButton.textContent = 'Annuler';
    passwordDialog.showModal();
    currentPasswordInput.focus();
    return true;
  }
  async function changePassword(event) {
    event.preventDefault();
    if (passwordBusy) return;
    const token = getGrant();
    if (!token) { passwordResult('Session expirée. Reconnecte-toi puis réessaie.'); return; }
    let currentPassword = currentPasswordInput.value;
    let newPassword = newPasswordInput.value;
    if (!currentPassword) { passwordFeedback.textContent = 'Saisis l’ancien mot de passe.'; currentPasswordInput.focus(); return; }
    if (newPassword.length < 12 || newPassword.length > 256) { passwordFeedback.textContent = 'Choisis au moins 12 caractères.'; newPasswordInput.focus(); return; }
    if (newPassword === currentPassword) { passwordFeedback.textContent = 'Choisis un mot de passe différent de l’ancien.'; newPasswordInput.focus(); return; }
    if (newPassword !== confirmPasswordInput.value) { passwordFeedback.textContent = 'Les nouveaux mots de passe ne correspondent pas.'; confirmPasswordInput.focus(); return; }
    setPasswordBusy(true);
    emptyPasswordFields();
    passwordFeedback.textContent = 'Enregistrement…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let reconnect = false;
    try {
      const pending = fetch(endpoint('/password'), {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      currentPassword = newPassword = '';
      const response = await pending;
      let result = null;
      try { result = await response.json(); } catch {}
      if (response.ok && result?.ok === true) {
        clearGrant();
        reconnect = true;
        passwordResult('Mot de passe modifié. Reconnecte tes appareils.', true);
      } else if (response.status === 401) {
        clearGrant();
        reconnect = true;
        passwordResult('Session expirée. Reconnecte-toi puis réessaie.');
      } else if (response.status === 403 && result?.error === 'current_password') {
        passwordFeedback.textContent = 'Ancien mot de passe incorrect. Réessaie.';
      } else if (response.status === 429) {
        passwordFeedback.textContent = rateLimitMessage(response);
      } else if (response.status === 400 && result?.error === 'weak_password') {
        passwordFeedback.textContent = 'Choisis au moins 12 caractères.';
      } else if (response.status === 400 && result?.error === 'same_password') {
        passwordFeedback.textContent = 'Choisis un mot de passe différent de l’ancien.';
      } else if (response.status === 400 || response.status === 403) {
        passwordFeedback.textContent = 'Changement refusé. Réessaie.';
      } else {
        clearGrant();
        reconnect = true;
        passwordResult('Résultat non confirmé. Reconnecte-toi avec le nouveau mot de passe ; sinon essaie l’ancien.');
      }
    } catch {
      clearGrant();
      reconnect = true;
      passwordResult('Résultat non confirmé. Vérifie Internet puis reconnecte-toi avec le nouveau mot de passe ; sinon essaie l’ancien.');
    } finally {
      currentPassword = newPassword = '';
      clearTimeout(timeout);
      setPasswordBusy(false);
      emptyPasswordFields();
      if (passwordDialog.open) (reconnect ? passwordConnectButton : currentPasswordInput).focus();
    }
  }
  function mountPasswordChange() {
    changePasswordButton = document.getElementById('changeProfPassword');
    if (!changePasswordButton) return;
    passwordDialog = document.createElement('dialog');
    passwordDialog.id = 'profPasswordChange';
    passwordDialog.setAttribute('aria-labelledby', 'profPasswordChangeTitle');
    passwordDialog.innerHTML = '<div class="prof-login-heading"><h2 id="profPasswordChangeTitle">Changer mon mot de passe</h2><button id="closeProfPasswordChange" type="button" aria-label="Fermer">×</button></div><form id="profPasswordChangeForm"><label for="profCurrentPassword">Ancien mot de passe</label><input id="profCurrentPassword" type="password" name="currentPassword" autocomplete="current-password" required maxlength="256"><label for="profNewPassword">Nouveau mot de passe</label><input id="profNewPassword" type="password" name="newPassword" autocomplete="new-password" required minlength="12" maxlength="256" aria-describedby="profPasswordHint"><p id="profPasswordHint">12 caractères minimum.</p><label for="profConfirmPassword">Confirmer le nouveau mot de passe</label><input id="profConfirmPassword" type="password" name="confirmPassword" autocomplete="new-password" required minlength="12" maxlength="256"><button id="submitProfPasswordChange" type="submit">Enregistrer</button></form><p id="profPasswordChangeFeedback" role="status" aria-live="polite"></p><button id="connectAfterPasswordChange" type="button" hidden>Se connecter</button><button id="cancelProfPasswordChange" type="button">Annuler</button>';
    document.body.append(passwordDialog);
    passwordForm = document.getElementById('profPasswordChangeForm');
    currentPasswordInput = document.getElementById('profCurrentPassword');
    newPasswordInput = document.getElementById('profNewPassword');
    confirmPasswordInput = document.getElementById('profConfirmPassword');
    passwordFeedback = document.getElementById('profPasswordChangeFeedback');
    passwordSubmitButton = document.getElementById('submitProfPasswordChange');
    passwordCancelButton = document.getElementById('cancelProfPasswordChange');
    passwordCloseButton = document.getElementById('closeProfPasswordChange');
    passwordConnectButton = document.getElementById('connectAfterPasswordChange');
    passwordForm.addEventListener('submit', changePassword);
    passwordCancelButton.addEventListener('click', closePasswordChange);
    passwordCloseButton.addEventListener('click', closePasswordChange);
    passwordConnectButton.addEventListener('click', () => { closePasswordChange(); connect(); });
    passwordDialog.addEventListener('cancel', event => { event.preventDefault(); closePasswordChange(); });
    passwordDialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePasswordChange(); } });
    passwordDialog.addEventListener('close', emptyPasswordFields);
    changePasswordButton.addEventListener('click', openPasswordChange);
  }
  function mount() {
    if (dialog) return;
    dockButton = document.getElementById('profAuthButton');
    dialog = document.createElement('dialog');
    dialog.id = 'profLogin';
    dialog.setAttribute('aria-labelledby', 'profLoginTitle');
    dialog.innerHTML = '<div class="prof-login-heading"><h2 id="profLoginTitle">Connexion prof</h2><button id="closeProfLogin" type="button" aria-label="Fermer">×</button></div><form id="profLoginForm"><label for="profPassword">Mot de passe professeur</label><input id="profPassword" type="password" name="password" autocomplete="current-password" required maxlength="256"><button id="submitProfLogin" type="submit">Se connecter</button></form><p id="profLoginFeedback" role="status" aria-live="polite"></p><button id="retryProfLogout" type="button" hidden>Réessayer</button><button id="skipProfLogin" type="button">Plus tard</button>';
    document.body.append(dialog);
    form = document.getElementById('profLoginForm');
    passwordInput = document.getElementById('profPassword');
    feedback = document.getElementById('profLoginFeedback');
    submitButton = document.getElementById('submitProfLogin');
    closeButton = document.getElementById('skipProfLogin');
    form.addEventListener('submit', login);
    closeButton.addEventListener('click', close);
    document.getElementById('closeProfLogin').addEventListener('click', close);
    document.getElementById('retryProfLogout').addEventListener('click', async () => { close(); await logout(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    dialog.addEventListener('close', () => { passwordInput.value = ''; });
    dockButton?.addEventListener('click', () => getGrant() ? void logout() : connect());
    mountPasswordChange();
    syncButton();
  }
  function connect() {
    attempted = true;
    try { sessionStorage.setItem(attemptKey, '1'); } catch {}
    if (!document.body || typeof HTMLDialogElement === 'undefined') return false;
    mount();
    if (dialog.open) return true;
    dialogGeneration++;
    window.settings?.(false);
    window.tabPicker?.(false);
    window.ClasseCalmeTools?.closePanel();
    document.dispatchEvent(new Event('classe-calme:close-connections'));
    returnFocus = document.activeElement;
    form.hidden = false;
    document.getElementById('profLoginTitle').textContent = 'Connexion prof';
    document.getElementById('retryProfLogout').hidden = true;
    closeButton.textContent = 'Plus tard';
    showFeedback('');
    passwordInput.value = '';
    dialog.showModal();
    passwordInput.focus();
    return true;
  }
  try {
    const saved = sessionStorage.getItem(grantKey);
    if (saved) accept(saved, false);
  } catch {}
  window.ClasseCalmeAuth = Object.freeze({
    getGrant,
    getChannel: () => getGrant() ? channel : null,
    connect,
    clearGrant,
    canAutoConnect: () => !attempted && !getGrant()
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
