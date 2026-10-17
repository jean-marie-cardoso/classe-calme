import { DurableObject } from 'cloudflare:workers';
const TTL = 35000;
const MESSAGE = 'MOINS DE BRUIT, MERCI.';
const NOTICE_MAX_LIFETIME = 180000;
const TIMER_MAX_LIFETIME = 180 * 60000;
const AUTH_LIFETIME = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 60000;
const FILE_CHUNK = 256 * 1024;
const FILE_MAX = 15 * 1024 * 1024;
const ROOM_FILE_MAX = 60 * 1024 * 1024;
const FILE_GRACE = 15 * 60000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...headers } });

async function readBytes(request, limit) {
  if (!request.body) throw new Error('body');
  const reader = request.body.getReader();
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function readJSON(request) { return JSON.parse(new TextDecoder().decode(await readBytes(request, 2048))); }
function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('base64');
  const input = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(input.padEnd(Math.ceil(input.length / 4) * 4, '=')), char => char.charCodeAt(0));
}
function authConfig(env) {
  const match = /^pbkdf2-sha256:100000:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(env.TEACHER_PASSWORD_HASH || '');
  return match && typeof env.TEACHER_AUTH_SECRET === 'string' && env.TEACHER_AUTH_SECRET.length >= 32 && env.TEACHER_AUTH_SECRET.length <= 256 ? { salt: match[1], hash: match[2] } : null;
}
function hexBytes(value) {
  return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function signingKey(secret, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
async function signedGrant(secret, payload) {
  const message = 'cc2.' + base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret, ['sign']), encoder.encode(message));
  return message + '.' + base64url(signature);
}
async function authorized(token, env, channel) {
  if (typeof token !== 'string' || token.length > 1600 || !token.startsWith('cc2.')) return null;
  let payload;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env.TEACHER_AUTH_SECRET, ['verify']), decodeBase64url(parts[2]), encoder.encode('cc2.' + parts[1]));
    if (!valid) return null;
    payload = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (payload.v !== 2 || payload.aud !== 'classe-calme-github' || payload.scope !== 'publish' || payload.channel !== channel || !UUID.test(payload.nonce || '') ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + 60 || payload.exp <= now || payload.exp <= payload.iat || payload.exp - payload.iat > AUTH_LIFETIME / 1000) return null;
  } catch { return null; }
  // Une panne du stockage reste une erreur temporaire ; elle ne déconnecte pas le professeur.
  return await env.CLASSROOM.getByName('teacher-auth').isSessionActive(payload.nonce, channel, payload.exp * 1000) ? payload : null;
}
async function hashedIP(request, secret) {
  // L'adresse réseau reste seulement en mémoire ; seule son empreinte secrète est conservée.
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret, ['sign']), encoder.encode('teacher-ip:' + (request.headers.get('cf-connecting-ip') || 'unknown')));
  return base64url(signature);
}
function cors(response, origin, allowedOrigin) {
  if (origin !== allowedOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', allowedOrigin);
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  headers.set('access-control-max-age', '3600');
  headers.set('access-control-expose-headers', 'Retry-After');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
function channelName(url) {
  const value = url.searchParams.get('channel') || 'main';
  // Les canaux de vérification restent séparés de la vraie classe.
  if (value !== 'main' && !/^test-[a-z0-9-]{8,70}$/.test(value)) return null;
  return value;
}
function activityName(value) {
  // L'identifiant décrit la page, jamais la personne ni ses réponses.
  return typeof value === 'string' && value.length <= 64 &&
    /^(?:[345]\/\d{2}|bonus\/[345]-\d{2}|accueil|autre|[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){0,2})$/.test(value) ? value : 'autre';
}
function plainText(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}
function defaultRoom(now) {
  return { revision: 0, expiresAt: now + TTL, controller: null, microphone: null,
    display: { documents: [], activeId: null },
    tools: { message: MESSAGE, notice: null, timer: null, preferences: { threshold: 12, delay: 3, mode: 'cover', pulse: true } },
    noise: { level: 0, alarm: false }, noiseAt: 0, testUntil: 0, pauseUntil: 0, linkActivities: true };
}
function cleanTools(input, now) {
  if (!input || !plainText(input.message, 120)) throw new Error('invalid_message');
  const prefs = input.preferences;
  if (!prefs || !Number.isFinite(prefs.threshold) || prefs.threshold < 10 || prefs.threshold > 95 ||
      ![2, 3, 5, 8].includes(Number(prefs.delay)) || !['cover', 'border'].includes(prefs.mode) || typeof prefs.pulse !== 'boolean') throw new Error('invalid_preferences');
  let notice = null;
  if (input.notice != null) {
    if (!plainText(input.notice.text, 180) || !input.notice.text.trim() || !Number.isSafeInteger(input.notice.until) || input.notice.until < 0) throw new Error('invalid_notice');
    if (input.notice.until > now) notice = { text: input.notice.text.trim(), until: Math.min(input.notice.until, now + NOTICE_MAX_LIFETIME) };
  }
  let timer = null;
  if (input.timer != null) {
    const value = input.timer;
    if (!['running', 'paused', 'finished'].includes(value.state)) throw new Error('invalid_timer');
    if (value.state === 'running') {
      if (!Number.isSafeInteger(value.until) || value.until < 0) throw new Error('invalid_timer');
      timer = value.until > now ? { state: 'running', until: Math.min(value.until, now + TIMER_MAX_LIFETIME) } : { state: 'finished', remainingMs: 0 };
    } else {
      if (!Number.isSafeInteger(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > TIMER_MAX_LIFETIME || (value.state === 'finished' && value.remainingMs !== 0)) throw new Error('invalid_timer');
      timer = { state: value.state, remainingMs: value.remainingMs };
    }
  }
  return { message: input.message.trim() || MESSAGE, notice, timer, preferences: { threshold: Math.round(prefs.threshold), delay: Number(prefs.delay), mode: prefs.mode, pulse: prefs.pulse } };
}
function cleanDisplay(input, fileExists) {
  if (!input || !Array.isArray(input.documents) || input.documents.length > 50) throw new Error('invalid_display');
  const ids = new Set();
  const documents = input.documents.map(value => {
    if (!value || !UUID.test(value.id || '') || ids.has(value.id) || !plainText(value.title, 160) || !['pdf', 'web'].includes(value.kind)) throw new Error('invalid_document');
    ids.add(value.id);
    const entry = { id: value.id, kind: value.kind, title: value.title.trim() || (value.kind === 'pdf' ? 'PDF' : 'Page web') };
    if (value.kind === 'web') {
      let url;
      try { url = new URL(value.url); } catch { throw new Error('invalid_url'); }
      if (typeof value.url !== 'string' || value.url.length > 2048 || url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_url');
      entry.url = url.href;
    } else {
      if (!UUID.test(value.fileId || '') || !fileExists(value.fileId)) throw new Error('file_missing');
      const page = value.page ?? 1;
      const zoom = value.zoom ?? 'fit';
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || (zoom !== 'fit' && (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 3))) throw new Error('invalid_pdf_position');
      entry.fileId = value.fileId;
      entry.page = page;
      entry.zoom = zoom;
    }
    return entry;
  });
  if (input.activeId !== null && !ids.has(input.activeId)) throw new Error('invalid_active_document');
  return { documents, activeId: input.activeId };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (!['/live', '/teacher', '/files', '/login', '/logout', '/publish', '/release'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    const origin = request.headers.get('origin');
    const reply = response => cors(response, origin, env.STUDENT_ORIGIN);
    const channel = channelName(url);
    if (!channel) return reply(json({ error: 'channel' }, 400));
    if (url.pathname === '/live' || url.pathname === '/teacher') {
      if (origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    } else {
      if (origin && origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.method === 'OPTIONS') return reply(new Response(null, { status: 204 }));
      if (request.method !== 'POST' && !(url.pathname === '/files' && request.method === 'GET')) return reply(json({ error: 'method' }, 405));
      if (!authConfig(env)) return reply(json({ error: 'auth_unavailable' }, 503));
    }
    try {
      if (url.pathname === '/login') {
        let body;
        try { body = await readJSON(request); } catch { return reply(json({ error: 'invalid_body' }, 400)); }
        const result = await env.CLASSROOM.getByName('teacher-auth').login(body?.password, await hashedIP(request, env.TEACHER_AUTH_SECRET), channel);
        return reply(json(result.body, result.status, result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}));
      }
      let payload;
      if (url.pathname !== '/live') {
        let token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
        if (url.pathname === '/teacher') {
          if (!authConfig(env)) return reply(json({ error: 'auth_unavailable' }, 503));
          const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map(value => value.trim());
          if (!protocols.includes('classe-calme')) return reply(json({ error: 'protocol' }, 400));
          token = protocols.find(value => value.startsWith('cc2.'));
        }
        if (url.pathname === '/release') {
          let body;
          try { body = await readJSON(request); } catch { return reply(json({ error: 'invalid_body' }, 400)); }
          if (!body || body.action !== 'release') return reply(json({ error: 'release_only' }, 400));
          token = body.grant;
          request = new Request(new URL('/publish', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'release', sessionId: body.sessionId }) });
        }
        payload = await authorized(token, env, channel);
        if (!payload) return reply(json({ error: 'unauthorized' }, 401));
        if (url.pathname === '/logout') {
          // Révoquer d'abord l'autorisation globale, puis fermer la projection liée à ce jeton.
          await env.CLASSROOM.getByName('teacher-auth').revokeSession(payload.nonce);
          await env.CLASSROOM.getByName(channel).revokeTeacher(payload.nonce, payload.exp * 1000);
          return reply(json({ ok: true }));
        }
        const headers = new Headers(request.headers);
        headers.delete('authorization');
        if (url.pathname === '/teacher') headers.set('sec-websocket-protocol', 'classe-calme');
        headers.set('x-classroom-auth-nonce', payload.nonce);
        headers.set('x-classroom-auth-expires', String(payload.exp * 1000));
        request = new Request(request, { headers });
      }
      const response = await env.CLASSROOM.getByName(channel).fetch(request);
      return ['/live', '/teacher'].includes(url.pathname) ? response : reply(response);
    } catch {
      return reply(json({ error: 'temporarily_unavailable' }, 503));
    }
  }
};

export class ClassroomRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS closed (sessionId TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS revoked (nonce TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_sessions (nonce TEXT PRIMARY KEY, channel TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_attempts (id TEXT PRIMARY KEY, ipHash TEXT NOT NULL, attemptedAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_room (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_devices (deviceId TEXT PRIMARY KEY, label TEXT NOT NULL, nonce TEXT NOT NULL, authExpires INTEGER NOT NULL, expiresAt INTEGER NOT NULL, connectionId TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_files (id TEXT PRIMARY KEY, parts INTEGER NOT NULL, size INTEGER NOT NULL, complete INTEGER NOT NULL, expiresAt INTEGER NOT NULL, orphanUntil INTEGER)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_chunks (fileId TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(fileId,part))');
  }
  async login(password, ipHash, channel) {
    const config = authConfig(this.env);
    if (!config) return { status: 503, body: { error: 'auth_unavailable' } };
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM auth_attempts WHERE attemptedAt<=?', now - LOGIN_WINDOW);
    this.ctx.storage.sql.exec('DELETE FROM auth_sessions WHERE expiresAt<=?', now);
    const global = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count, MIN(attemptedAt) AS oldest FROM auth_attempts').one();
    const personal = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count, MIN(attemptedAt) AS oldest FROM auth_attempts WHERE ipHash=?', ipHash).one();
    if (global.count >= 100 || personal.count >= 8) {
      const resetAt = Math.max(global.count >= 100 ? global.oldest + LOGIN_WINDOW : 0, personal.count >= 8 ? personal.oldest + LOGIN_WINDOW : 0);
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { status: 429, body: { error: 'too_many_attempts', retryAfter }, retryAfter };
    }
    // Réserver la tentative avant le calcul coûteux ; les requêtes parallèles respectent la limite.
    this.ctx.storage.sql.exec('INSERT INTO auth_attempts(id,ipHash,attemptedAt) VALUES(?,?,?)', crypto.randomUUID(), ipHash, now);
    if (typeof password !== 'string' || !password.length || password.length > 256) return { status: 401, body: { error: 'unauthorized' } };
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const supplied = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: hexBytes(config.salt) }, material, 256);
    if (!crypto.subtle.timingSafeEqual(supplied, hexBytes(config.hash))) return { status: 401, body: { error: 'unauthorized' } };
    const iat = Math.floor(Date.now() / 1000);
    const payload = { v: 2, aud: 'classe-calme-github', scope: 'publish', channel, iat, exp: iat + AUTH_LIFETIME / 1000, nonce: crypto.randomUUID() };
    const grant = await signedGrant(this.env.TEACHER_AUTH_SECRET, payload);
    const expiresAt = payload.exp * 1000;
    this.ctx.storage.sql.exec('INSERT INTO auth_sessions(nonce,channel,expiresAt) VALUES(?,?,?)', payload.nonce, channel, expiresAt);
    return { status: 200, body: { grant, expiresAt } };
  }
  isSessionActive(nonce, channel, expiresAt) {
    if (!UUID.test(nonce || '') || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
    return Boolean(this.ctx.storage.sql.exec('SELECT nonce FROM auth_sessions WHERE nonce=? AND channel=? AND expiresAt=?', nonce, channel, expiresAt).toArray().length);
  }
  revokeSession(nonce) {
    this.ctx.storage.sql.exec('DELETE FROM auth_sessions WHERE nonce=?', nonce);
  }
  async revokeTeacher(nonce, expiresAt) {
    this.ctx.storage.sql.exec('INSERT INTO revoked(nonce,expiresAt) VALUES(?,?) ON CONFLICT(nonce) DO UPDATE SET expiresAt=MAX(expiresAt,excluded.expiresAt)', nonce, expiresAt);
    const current = this.stored();
    if (current?.authNonce === nonce) {
      this.ctx.storage.sql.exec('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', current.sessionId, Date.now() + 120000);
      this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
      this.broadcast(this.stored());
    }
    for (const device of this.ctx.storage.sql.exec('SELECT deviceId,connectionId FROM remote_devices WHERE nonce=?', nonce).toArray()) this.removeDevice(device.deviceId, device.connectionId);
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.authNonce === nonce) try { socket.close(1008, 'Signed out'); } catch {}
    await this.scheduleAlarm();
    this.broadcastRemote();
  }
  stored() {
    const rows = this.ctx.storage.sql.exec('SELECT value FROM state WHERE id=1').toArray();
    return rows.length ? JSON.parse(rows[0].value) : null;
  }
  publicState(state, now = Date.now()) {
    const active = Boolean(state?.expiresAt > now);
    const remainingMs = active ? Math.min(TTL, state.expiresAt - now) : 0;
    const notice = active && state.notice?.until > now ? {
      text: state.notice.text,
      remainingMs: Math.min(remainingMs, state.notice.until - now)
    } : null;
    let timer = active ? state.timer || null : null;
    if (timer?.state === 'running') {
      const timerRemaining = Math.max(0, Math.min(TIMER_MAX_LIFETIME, timer.until - now));
      timer = { state: timerRemaining > 0 ? 'running' : 'finished', remainingMs: timerRemaining };
    }
    return { type: 'state', v: 1, active, alarm: Boolean(active && state.alarm), mode: state?.mode || 'cover', pulse: state?.pulse ?? false, message: state?.message || MESSAGE, notice, timer, remainingMs };
  }
  teacherStats(active) {
    const sockets = this.ctx.getWebSockets().filter(socket => this.attachment(socket)?.role !== 'teacher' && socket.readyState === 1);
    const counts = new Map();
    for (const socket of sockets) {
      let activity = 'autre';
      try { activity = activityName(socket.deserializeAttachment()?.activity); } catch { /* Anciens modules sans pièce jointe. */ }
      counts.set(activity, (counts.get(activity) || 0) + 1);
    }
    return { active, viewers: sockets.length, activities: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count })) };
  }
  broadcast(state) {
    const message = JSON.stringify(this.remotePublicState() || this.publicState(state));
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.role === 'teacher' || socket.readyState !== 1) continue;
      try { socket.send(message); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
    }
  }
  attachment(socket) { try { return socket.deserializeAttachment(); } catch { return null; } }
  remote() {
    const row = this.ctx.storage.sql.exec('SELECT value FROM remote_room WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }
  devices(now = Date.now()) {
    return this.ctx.storage.sql.exec('SELECT * FROM remote_devices WHERE expiresAt>? AND authExpires>? ORDER BY deviceId', now, now).toArray();
  }
  saveRoom(room, increment = true) {
    if (increment) room.revision++;
    const devices = this.devices();
    if (devices.length) room.expiresAt = Math.max(...devices.map(device => device.expiresAt));
    this.ctx.storage.sql.exec('INSERT INTO remote_room(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(room));
  }
  file(id) { return this.ctx.storage.sql.exec('SELECT * FROM remote_files WHERE id=?', id).toArray()[0]; }
  deleteFile(id) {
    this.ctx.storage.sql.exec('DELETE FROM remote_chunks WHERE fileId=?', id);
    this.ctx.storage.sql.exec('DELETE FROM remote_files WHERE id=?', id);
  }
  removeDevice(deviceId, connectionId, now = Date.now()) {
    const row = this.ctx.storage.sql.exec('SELECT * FROM remote_devices WHERE deviceId=?', deviceId).toArray()[0];
    if (!row || (connectionId && row.connectionId !== connectionId)) return false;
    this.ctx.storage.sql.exec('DELETE FROM remote_devices WHERE deviceId=?', deviceId);
    const room = this.remote();
    if (room) {
      if (room.controller?.deviceId === deviceId) room.controller = null;
      if (room.microphone?.deviceId === deviceId) { room.microphone = null; room.noise = { level: 0, alarm: false }; room.noiseAt = 0; }
      if (!this.devices(now).length) room.expiresAt = now + TTL;
      this.saveRoom(room);
    }
    return true;
  }
  cleanupRemote(now = Date.now()) {
    let changed = false;
    for (const row of this.ctx.storage.sql.exec('SELECT * FROM remote_devices WHERE expiresAt<=? OR authExpires<=?', now, now).toArray()) {
      changed = this.removeDevice(row.deviceId, row.connectionId, now) || changed;
      for (const socket of this.ctx.getWebSockets()) {
        const info = this.attachment(socket);
        if (info?.role === 'teacher' && info.connectionId === row.connectionId) try { socket.close(1008, 'Presence expired'); } catch {}
      }
    }
    const room = this.remote();
    if (room && !this.devices(now).length && room.expiresAt <= now) {
      this.ctx.storage.sql.exec('DELETE FROM remote_room');
      this.ctx.storage.sql.exec('DELETE FROM remote_chunks');
      this.ctx.storage.sql.exec('DELETE FROM remote_files');
      return true;
    }
    const expired = this.ctx.storage.sql.exec('SELECT id FROM remote_files WHERE expiresAt<=? OR (orphanUntil IS NOT NULL AND orphanUntil<=?)', now, now).toArray();
    for (const row of expired) this.deleteFile(row.id);
    if (room && expired.length) {
      const removed = new Set(expired.map(row => row.id));
      const documents = room.display.documents.filter(doc => doc.kind !== 'pdf' || !removed.has(doc.fileId));
      if (documents.length !== room.display.documents.length) {
        room.display = { documents, activeId: documents.some(doc => doc.id === room.display.activeId) ? room.display.activeId : documents[0]?.id || null };
        this.saveRoom(room);
        changed = true;
      }
    }
    return changed;
  }
  async scheduleAlarm() {
    const now = Date.now();
    const deadlines = [];
    const legacy = this.stored();
    if (legacy?.expiresAt > now) deadlines.push(legacy.expiresAt);
    const room = this.remote();
    if (room) {
      deadlines.push(room.expiresAt);
      if (room.testUntil > now) deadlines.push(room.testUntil);
      if (room.pauseUntil > now) deadlines.push(room.pauseUntil);
    }
    const device = this.ctx.storage.sql.exec('SELECT MIN(MIN(expiresAt,authExpires)) AS next FROM remote_devices').one().next;
    if (device) deadlines.push(device);
    const file = this.ctx.storage.sql.exec('SELECT MIN(MIN(expiresAt,COALESCE(orphanUntil,expiresAt))) AS next FROM remote_files').one().next;
    if (file) deadlines.push(file);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(now + 1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  remotePublicState(now = Date.now()) {
    const room = this.remote();
    if (!room) return null;
    const devices = this.devices(now);
    const preferences = room.tools.preferences;
    const active = Boolean(room.linkActivities && devices.length);
    return this.publicState({ expiresAt: active ? Math.max(...devices.map(device => device.expiresAt)) : 0,
      alarm: this.effectiveNoise(room, now).alarm, mode: preferences.mode, pulse: preferences.pulse,
      message: room.tools.message, notice: room.tools.notice, timer: room.tools.timer }, now);
  }
  snapshot(now = Date.now()) {
    const room = this.remote();
    if (!room) return null;
    const stats = this.teacherStats(Boolean(room.linkActivities && this.devices(now).length));
    return { type: 'remote', v: 1, revision: room.revision, serverNow: now,
      controller: room.controller, microphone: room.microphone,
      devices: this.devices(now).map(device => ({ deviceId: device.deviceId, label: device.label })),
      display: room.display, tools: room.tools, noise: this.effectiveNoise(room, now), linkActivities: room.linkActivities,
      viewers: stats.viewers, activities: stats.activities };
  }
  effectiveNoise(room, now = Date.now()) {
    return { level: room.noise.level, alarm: Boolean(room.pauseUntil <= now && (room.noise.alarm || room.testUntil > now)), pausedUntil: room.pauseUntil || 0, testUntil: room.testUntil || 0 };
  }
  validTeacher(socket, now = Date.now()) {
    const info = this.attachment(socket);
    if (info?.role !== 'teacher' || info.authExpires <= now) return null;
    const row = this.ctx.storage.sql.exec('SELECT * FROM remote_devices WHERE deviceId=? AND connectionId=? AND nonce=? AND expiresAt>? AND authExpires>?', info.deviceId, info.connectionId, info.authNonce, now, now).toArray()[0];
    if (!row || this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=? AND expiresAt>?', info.authNonce, now).toArray().length) return null;
    return { ...info, row };
  }
  broadcastRemote() {
    const snapshot = this.snapshot();
    if (snapshot) {
      const message = JSON.stringify(snapshot);
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState !== 1 || !this.validTeacher(socket)) continue;
        try { socket.send(message); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
      }
    }
    this.broadcast(this.stored());
  }
  async teacherConnect(request) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    const label = url.searchParams.get('label') || 'Appareil';
    const authNonce = request.headers.get('x-classroom-auth-nonce');
    const authExpires = Number(request.headers.get('x-classroom-auth-expires'));
    if (!UUID.test(authNonce || '') || !Number.isSafeInteger(authExpires) || authExpires <= Date.now() || this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=?', authNonce).toArray().length) return json({ error: 'unauthorized' }, 401);
    if (!UUID.test(deviceId || '') || !plainText(label, 40) || !label.trim()) return json({ error: 'invalid_device' }, 400);
    const now = Date.now();
    this.cleanupRemote(now);
    if (this.devices(now).length >= 16 && !this.devices(now).some(device => device.deviceId === deviceId)) return json({ error: 'full' }, 503);
    const previous = this.ctx.storage.sql.exec('SELECT connectionId FROM remote_devices WHERE deviceId=?', deviceId).toArray()[0];
    if (previous) for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.connectionId === previous.connectionId) try { socket.close(1008, 'Replaced'); } catch {}
    }
    const isNew = !this.remote();
    const room = this.remote() || defaultRoom(now);
    const connectionId = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO remote_devices(deviceId,label,nonce,authExpires,expiresAt,connectionId) VALUES(?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET label=excluded.label,nonce=excluded.nonce,authExpires=excluded.authExpires,expiresAt=excluded.expiresAt,connectionId=excluded.connectionId', deviceId, label.trim(), authNonce, authExpires, Math.min(now + TTL, authExpires), connectionId);
    if (isNew) room.controller = { deviceId, label: label.trim() };
    // Un retour réseau ne rallume jamais un ancien microphone à distance.
    if (previous && room.microphone?.deviceId === deviceId) { room.microphone = null; room.noise = { level: 0, alarm: false }; room.noiseAt = 0; }
    if (room.controller?.deviceId === deviceId) room.controller = { deviceId, label: label.trim() };
    this.saveRoom(room);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['teacher']);
    server.serializeAttachment({ role: 'teacher', deviceId, label: label.trim(), authNonce, authExpires, connectionId });
    await this.scheduleAlarm();
    this.broadcastRemote();
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'classe-calme' } });
  }
  async fileRequest(request) {
    const now = Date.now();
    if (this.cleanupRemote(now)) this.broadcastRemote();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const authNonce = request.headers.get('x-classroom-auth-nonce');
    const authExpires = Number(request.headers.get('x-classroom-auth-expires'));
    if (!UUID.test(authNonce || '') || !Number.isSafeInteger(authExpires) || authExpires <= now || this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=?', authNonce).toArray().length) return json({ error: 'unauthorized' }, 401);
    if (!UUID.test(id || '')) return json({ error: 'invalid_file' }, 400);
    if (request.method === 'GET') {
      const file = this.file(id);
      if (!file?.complete || file.expiresAt <= now) return json({ error: 'not_found' }, 404);
      // Au plus 15 Mio, lus par morceaux SQL ; aucune URL publique n'est créée.
      const chunks = this.ctx.storage.sql.exec('SELECT data FROM remote_chunks WHERE fileId=? ORDER BY part', id).toArray();
      let part = 0;
      const stream = new ReadableStream({ pull(controller) {
        if (part === chunks.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(chunks[part++].data).slice());
      } });
      return new Response(stream, { headers: { 'content-type': 'application/pdf', 'content-length': String(file.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="cours.pdf"' } });
    }
    const deviceId = url.searchParams.get('deviceId');
    const room = this.remote();
    const device = this.ctx.storage.sql.exec('SELECT deviceId FROM remote_devices WHERE deviceId=? AND nonce=? AND expiresAt>? AND authExpires>?', deviceId, authNonce, now, now).toArray()[0];
    if (!device || room?.controller?.deviceId !== deviceId) return json({ error: 'controller_required' }, 409);
    const part = Number(url.searchParams.get('part'));
    const parts = Number(url.searchParams.get('parts'));
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(parts) || parts < 1 || parts > 60 || part < 0 || part >= parts) return json({ error: 'invalid_part' }, 400);
    let bytes;
    try { bytes = await readBytes(request, FILE_CHUNK); } catch { return json({ error: 'file_too_large' }, 413); }
    // Le contrôle a pu changer pendant la lecture réseau du morceau.
    const current = this.remote();
    if (!current || current.controller?.deviceId !== deviceId || !this.ctx.storage.sql.exec('SELECT deviceId FROM remote_devices WHERE deviceId=? AND nonce=? AND expiresAt>? AND authExpires>?', deviceId, authNonce, Date.now(), Date.now()).toArray().length || this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=?', authNonce).toArray().length) return json({ error: 'controller_required' }, 409);
    if (!bytes.length || (part < parts - 1 && bytes.length !== FILE_CHUNK)) return json({ error: 'invalid_chunk' }, 400);
    let file = this.file(id);
    if (!file) {
      if (part !== 0 || bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'invalid_pdf' }, 400);
      if (this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM remote_files').one().count >= 200) return json({ error: 'room_file_limit' }, 413);
    } else if (file.parts !== parts) return json({ error: 'file_conflict' }, 409);
    const old = this.ctx.storage.sql.exec('SELECT data FROM remote_chunks WHERE fileId=? AND part=?', id, part).toArray()[0];
    if (old) {
      const previous = new Uint8Array(old.data);
      if (previous.length !== bytes.length || previous.some((value, index) => value !== bytes[index])) return json({ error: 'file_conflict' }, 409);
      return json({ ok: true, complete: Boolean(file.complete), size: file.size });
    }
    const size = (file?.size || 0) + bytes.length;
    const total = this.ctx.storage.sql.exec('SELECT COALESCE(SUM(size),0) AS size FROM remote_files').one().size;
    if (size > FILE_MAX || total + bytes.length > ROOM_FILE_MAX) return json({ error: 'room_file_limit' }, 413);
    if (!file) {
      this.ctx.storage.sql.exec('INSERT INTO remote_files(id,parts,size,complete,expiresAt,orphanUntil) VALUES(?,?,0,0,?,?)', id, parts, Date.now() + AUTH_LIFETIME, Date.now() + FILE_GRACE);
      file = this.file(id);
    }
    this.ctx.storage.sql.exec('INSERT INTO remote_chunks(fileId,part,data) VALUES(?,?,?)', id, part, bytes.buffer);
    const complete = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM remote_chunks WHERE fileId=?', id).one().count === parts;
    this.ctx.storage.sql.exec('UPDATE remote_files SET size=?,complete=?,orphanUntil=? WHERE id=?', size, complete ? 1 : 0, Date.now() + FILE_GRACE, id);
    await this.scheduleAlarm();
    return json({ ok: true, complete, size });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/teacher') return this.teacherConnect(request);
    if (path === '/files') return this.fileRequest(request);
    return this.legacyFetch(request);
  }
  async legacyFetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/live' && path !== '/publish') return json({ error: 'not_found' }, 404);
    if (path === '/live') {
      if (this.teacherStats(false).viewers >= 500) return json({ error: 'full' }, 503);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['pupil']);
      server.serializeAttachment({ role: 'pupil', activity: activityName(new URL(request.url).searchParams.get('activity')) });
      server.send(JSON.stringify(this.remotePublicState() || this.publicState(this.stored())));
      this.broadcastRemote();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const authNonce = request.headers.get('x-classroom-auth-nonce');
    const authExpires = Number(request.headers.get('x-classroom-auth-expires'));
    if (!UUID.test(authNonce || '') || !Number.isSafeInteger(authExpires) || authExpires <= Date.now()) return json({ error: 'unauthorized' }, 401);
    let body;
    try { body = await readJSON(request); } catch { return json({ error: 'invalid_body' }, 400); }
    if (!body || !['claim', 'heartbeat', 'release'].includes(body.action) || !/^[a-f0-9-]{36}$/.test(body.sessionId || '')) return json({ error: 'invalid_state' }, 400);
    const now = Date.now();
    this.cleanupRemote(now);
    if (this.remote()) return json({ error: 'teacher_remote_active' }, 409);
    const current = this.stored();
    this.ctx.storage.sql.exec('DELETE FROM closed WHERE expiresAt<?', now);
    this.ctx.storage.sql.exec('DELETE FROM revoked WHERE expiresAt<=?', now);
    if (this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=?', authNonce).toArray().length) return json({ error: 'unauthorized' }, 401);
    if (current?.sessionId === body.sessionId && current.authNonce && current.authNonce !== authNonce) return json({ error: 'another_teacher_tab' }, 409);
    if (body.action === 'release') {
      this.ctx.storage.sql.exec('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', body.sessionId, now + 120000);
      if (current?.sessionId === body.sessionId) {
        this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
        await this.scheduleAlarm();
        this.broadcast(this.stored());
      }
      return json(this.teacherStats(false));
    }
    if (this.ctx.storage.sql.exec('SELECT sessionId FROM closed WHERE sessionId=?', body.sessionId).toArray().length) return json({ error: 'session_released' }, 410);
    if (body.action !== 'claim' && current?.expiresAt > now && current.sessionId !== body.sessionId) return json({ error: 'another_teacher_tab' }, 409);
    if (typeof body.alarm !== 'boolean' || !['cover', 'border'].includes(body.mode) || typeof body.pulse !== 'boolean') return json({ error: 'invalid_state' }, 400);
    if (body.message !== undefined && !plainText(body.message, 120)) return json({ error: 'invalid_message' }, 400);
    const message = body.message === undefined ? MESSAGE : body.message.trim() || MESSAGE;
    let notice = current?.sessionId === body.sessionId && current.expiresAt > now && current.notice?.until > now ? current.notice : null;
    if (body.notice !== undefined) {
      if (body.notice === null) notice = null;
      else {
        if (typeof body.notice !== 'object' || !plainText(body.notice.text, 180) || !body.notice.text.trim() ||
            !Number.isSafeInteger(body.notice.until) || body.notice.until < 0 || body.notice.until > now + NOTICE_MAX_LIFETIME) return json({ error: 'invalid_notice' }, 400);
        // Le battement de présence conserve cette date absolue ; il ne prolonge pas la consigne.
        notice = body.notice.until > now ? { text: body.notice.text.trim(), until: body.notice.until } : null;
      }
    }
    let timer = null;
    if (body.timer !== undefined && body.timer !== null) {
      const input = body.timer;
      if (typeof input !== 'object' || !['running', 'paused', 'finished'].includes(input.state)) return json({ error: 'invalid_timer' }, 400);
      if (input.state === 'running') {
        if (!Number.isSafeInteger(input.until) || input.until < 0 || input.until > now + TIMER_MAX_LIFETIME + 60000) return json({ error: 'invalid_timer' }, 400);
        timer = input.until > now ? { state: 'running', until: input.until } : { state: 'finished', remainingMs: 0 };
      } else {
        if (!Number.isSafeInteger(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > TIMER_MAX_LIFETIME || (input.state === 'finished' && input.remainingMs !== 0)) return json({ error: 'invalid_timer' }, 400);
        timer = { state: input.state, remainingMs: input.remainingMs };
      }
    }
    if (body.action === 'claim' && current?.expiresAt > now && current.sessionId !== body.sessionId) {
      this.ctx.storage.sql.exec('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', current.sessionId, now + 120000);
    }
    const state = { sessionId: body.sessionId, authNonce, expiresAt: Math.min(now + TTL, authExpires), alarm: body.alarm, mode: body.mode, pulse: body.pulse, message, notice, timer };
    this.ctx.storage.sql.exec('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(state));
    await this.scheduleAlarm();
    // Une déconnexion arrivée pendant l'écriture de l'alarme garde la priorité.
    this.broadcast(this.stored());
    return json(this.teacherStats(Boolean(this.stored()?.expiresAt > Date.now())));
  }
  async alarm() {
    const now = Date.now();
    this.cleanupRemote(now);
    const state = this.stored();
    if (state && state.expiresAt <= now) this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
    const room = this.remote();
    if (room && ((room.testUntil && room.testUntil <= now) || (room.pauseUntil && room.pauseUntil <= now))) {
      if (room.testUntil <= now) room.testUntil = 0;
      if (room.pauseUntil <= now) room.pauseUntil = 0;
      this.saveRoom(room);
    }
    this.ctx.storage.sql.exec('DELETE FROM revoked WHERE expiresAt<=?', now);
    this.ctx.storage.sql.exec('DELETE FROM closed WHERE expiresAt<=?', now);
    await this.scheduleAlarm();
    this.broadcastRemote();
  }
  async webSocketMessage(socket, message) {
    const now = Date.now();
    if (this.attachment(socket)?.role !== 'teacher') { socket.close(1008, 'Read only'); return; }
    const changed = this.cleanupRemote(now);
    const info = this.validTeacher(socket, now);
    if (!info) { socket.close(1008, 'Session expired'); if (changed) this.broadcastRemote(); return; }
    if (typeof message !== 'string' || encoder.encode(message).length > 131072) { socket.close(1009, 'Message too large'); return; }
    let body;
    try { body = JSON.parse(message); } catch { socket.close(1008, 'Invalid message'); return; }
    if (!body || (body.type !== 'ping' && (body.type !== 'command' || !UUID.test(body.requestId || '')))) { socket.close(1008, 'Invalid message'); return; }
    const rate = info.rate?.start > now - 1000 ? info.rate : { start: now, count: 0 };
    rate.count++;
    if (rate.count > 30) { socket.close(1008, 'Too many commands'); this.removeDevice(info.deviceId, info.connectionId); await this.scheduleAlarm(); this.broadcastRemote(); return; }
    socket.serializeAttachment({ role: 'teacher', deviceId: info.deviceId, label: info.label, authNonce: info.authNonce, authExpires: info.authExpires, connectionId: info.connectionId, rate });
    this.ctx.storage.sql.exec('UPDATE remote_devices SET expiresAt=? WHERE deviceId=? AND connectionId=?', Math.min(now + TTL, info.authExpires), info.deviceId, info.connectionId);
    let room = this.remote();
    if (!room) { socket.close(1008, 'Room expired'); return; }
    if (body.type === 'ping') {
      this.saveRoom(room, false);
      await this.scheduleAlarm();
      this.broadcastRemote();
      return;
    }
    let error = null;
    let broadcast = true;
    try {
      if (['display', 'tools', 'link', 'test-alert', 'pause-alert'].includes(body.action) && room.controller?.deviceId !== info.deviceId) throw new Error('controller_required');
      if (body.action === 'take-control') room.controller = { deviceId: info.deviceId, label: info.label };
      else if (body.action === 'display') {
        room.display = cleanDisplay(body.display, id => Boolean(this.file(id)?.complete && this.file(id).expiresAt > now));
        this.ctx.storage.sql.exec('UPDATE remote_files SET orphanUntil=? WHERE orphanUntil IS NULL', now + FILE_GRACE);
        for (const doc of room.display.documents) if (doc.kind === 'pdf') this.ctx.storage.sql.exec('UPDATE remote_files SET orphanUntil=NULL WHERE id=?', doc.fileId);
      } else if (body.action === 'tools') room.tools = cleanTools(body.tools, now);
      else if (body.action === 'link') {
        if (typeof body.enabled !== 'boolean') throw new Error('invalid_link');
        room.linkActivities = body.enabled;
      } else if (body.action === 'microphone') {
        if (typeof body.enabled !== 'boolean') throw new Error('invalid_microphone');
        if (body.enabled) {
          room.microphone = { deviceId: info.deviceId, label: info.label };
          room.noise = { level: 0, alarm: false };
          room.noiseAt = 0;
        } else if (room.microphone?.deviceId === info.deviceId) {
          room.microphone = null;
          room.noise = { level: 0, alarm: false };
          room.noiseAt = 0;
        }
      } else if (body.action === 'noise') {
        if (room.microphone?.deviceId !== info.deviceId) throw new Error('microphone_required');
        if (!body.noise || !Number.isFinite(body.noise.level) || body.noise.level < 0 || body.noise.level > 100 || typeof body.noise.alarm !== 'boolean') throw new Error('invalid_noise');
        if (now - room.noiseAt < 240 && room.noise.alarm === body.noise.alarm) broadcast = false;
        else {
          room.noise = { level: Math.round(body.noise.level), alarm: body.noise.alarm };
          room.noiseAt = now;
        }
      } else if (body.action === 'test-alert') {
        const duration = body.durationMs === undefined ? 5000 : body.durationMs;
        if (!Number.isSafeInteger(duration) || duration < 0 || duration > 5000) throw new Error('invalid_duration');
        room.pauseUntil = 0;
        room.testUntil = duration ? now + duration : 0;
      } else if (body.action === 'pause-alert') {
        const duration = body.durationMs === undefined ? 30000 : body.durationMs;
        if (!Number.isSafeInteger(duration) || duration < 0 || duration > 30000) throw new Error('invalid_duration');
        room.testUntil = 0;
        room.pauseUntil = duration ? now + duration : 0;
      } else throw new Error('invalid_action');
      this.saveRoom(room, broadcast);
    } catch (failure) {
      error = failure.message;
      // Le battement de présence reste valide même si la commande est refusée.
      room = this.remote();
      if (room) this.saveRoom(room, false);
    }
    await this.scheduleAlarm();
    if (this.validTeacher(socket)) try { socket.send(JSON.stringify({ type: 'ack', requestId: body.requestId, ok: !error, ...(error ? { error } : {}) })); } catch {}
    if (broadcast || changed) this.broadcastRemote();
  }
  async webSocketClose(socket, code, reason) {
    // Sans effet avec la réponse automatique récente ; utile aux relais plus anciens.
    try { socket.close(code, reason); } catch {}
    const info = this.attachment(socket);
    if (info?.role === 'teacher') this.removeDevice(info.deviceId, info.connectionId);
    await this.scheduleAlarm();
    this.broadcastRemote();
  }
  async webSocketError(socket) {
    try { socket.close(1011, 'Reconnect'); } catch {}
    const info = this.attachment(socket);
    if (info?.role === 'teacher') this.removeDevice(info.deviceId, info.connectionId);
    await this.scheduleAlarm();
    this.broadcastRemote();
  }
}
