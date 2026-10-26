import { DurableObject } from 'cloudflare:workers';
import { CORRECTIONS } from './corrections-catalog.js';
const GUIDE_ACTIVITIES = Object.freeze({"projets/5": "5e · Projet maison 3D et réseau", "projets/4": "4e · Projet Pong à deux et réseau", "projets/3": "3e · Projet objet 3D", "exposes/5": "5e · Exposé : un objet du quotidien", "exposes/4": "4e · Exposé : une technologie du téléphone", "exposes/3": "3e · Exposé : fabriquer ou réparer"});
function knownActivity(id) { return typeof id === "string" && (Object.hasOwn(CORRECTIONS, id) || Object.hasOwn(GUIDE_ACTIVITIES, id)); }

const TTL = 35000;
const PRESENCE_WRITE_INTERVAL = 10000;
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
function hexString(value) { return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function passwordBits(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: hexBytes(salt) }, material, 256);
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
    noise: { level: 0, alarm: false }, noiseAt: 0, testUntil: 0, pauseUntil: 0, linkActivities: true, targetActivity: null, correction: false };
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
    if (!['/live', '/teacher', '/files', '/correction', '/login', '/logout', '/password', '/publish', '/release'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    const origin = request.headers.get('origin');
    const reply = response => cors(response, origin, env.STUDENT_ORIGIN);
    const channel = channelName(url);
    if (!channel) return reply(json({ error: 'channel' }, 400));
    if (url.pathname === '/live' || url.pathname === '/teacher') {
      if (origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    } else {
      if ((origin && origin !== env.STUDENT_ORIGIN) || (url.pathname === '/password' && origin !== env.STUDENT_ORIGIN)) return json({ error: 'origin' }, 403);
      if (request.method === 'OPTIONS') return reply(new Response(null, { status: 204 }));
      if (url.pathname === '/correction' ? request.method !== 'GET' : request.method !== 'POST' && !(url.pathname === '/files' && request.method === 'GET')) return reply(json({ error: 'method' }, 405));
      if (url.pathname !== '/correction' && !authConfig(env)) return reply(json({ error: 'auth_unavailable' }, 503));
    }
    try {
      if (url.pathname === '/login') {
        let body;
        try { body = await readJSON(request); } catch { return reply(json({ error: 'invalid_body' }, 400)); }
        const result = await env.CLASSROOM.getByName('teacher-auth').login(body?.password, await hashedIP(request, env.TEACHER_AUTH_SECRET), channel);
        return reply(json(result.body, result.status, result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}));
      }
      let payload;
      if (url.pathname !== '/live' && url.pathname !== '/correction') {
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
        if (url.pathname === '/password') {
          let body;
          try { body = await readJSON(request); } catch { return reply(json({ error: 'invalid_body' }, 400)); }
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') return reply(json({ error: 'invalid_body' }, 400));
          const result = await env.CLASSROOM.getByName('teacher-auth').changePassword(body.currentPassword, body.newPassword, await hashedIP(request, env.TEACHER_AUTH_SECRET), payload.nonce, channel, payload.exp * 1000);
          return reply(json(result.body, result.status, result.retryAfter ? { 'retry-after': String(result.retryAfter) } : {}));
        }
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
    this.tableCache = new Map();
    this.alarmUpdate = Promise.resolve();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS closed (sessionId TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS revoked (nonce TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_sessions (nonce TEXT PRIMARY KEY, channel TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_attempts (id TEXT PRIMARY KEY, ipHash TEXT NOT NULL, attemptedAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS auth_revocations (nonce TEXT PRIMARY KEY, channel TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_room (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_devices (deviceId TEXT PRIMARY KEY, label TEXT NOT NULL, nonce TEXT NOT NULL, authExpires INTEGER NOT NULL, expiresAt INTEGER NOT NULL, connectionId TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_files (id TEXT PRIMARY KEY, parts INTEGER NOT NULL, size INTEGER NOT NULL, complete INTEGER NOT NULL, expiresAt INTEGER NOT NULL, orphanUntil INTEGER)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS remote_chunks (fileId TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(fileId,part))');
  }
  sql(statement, ...bindings) {
    const result = this.ctx.storage.sql.exec(statement, ...bindings);
    const mutation = /^(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM) ([a-z_]+)/i.exec(statement);
    if (mutation) this.tableCache.delete(mutation[1]);
    return result;
  }
  tableRows(table) {
    if (!['state', 'remote_room', 'remote_devices', 'remote_files', 'revoked'].includes(table)) throw new Error('invalid_table');
    if (!this.tableCache.has(table)) this.tableCache.set(table, this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
    return this.tableCache.get(table);
  }
  revoked(nonce, now = Date.now()) {
    return this.tableRows('revoked').some(row => row.nonce === nonce && row.expiresAt > now);
  }
  deviceRows() { return this.tableRows('remote_devices'); }
  deviceExpiry(row) {
    let expiresAt = row.expiresAt;
    for (const socket of this.ctx.getWebSockets()) {
      const info = this.attachment(socket);
      if (info?.role === 'teacher' && info.deviceId === row.deviceId && info.connectionId === row.connectionId && info.authNonce === row.nonce && Number.isSafeInteger(info.lastSeenAt)) {
        expiresAt = Math.max(expiresAt, info.lastSeenAt + TTL);
      }
    }
    return Math.min(expiresAt, row.authExpires);
  }
  credential() {
    const stored = this.sql('SELECT salt,hash,revision FROM auth_credentials WHERE id=1').toArray()[0];
    // Un enregistrement présent mais invalide ne réactive jamais le mot de passe initial.
    if (stored) return /^[a-f0-9]{32}$/.test(stored.salt) && /^[a-f0-9]{64}$/.test(stored.hash) && Number.isSafeInteger(stored.revision) && stored.revision > 0 ? stored : null;
    const initial = authConfig(this.env);
    return initial ? { ...initial, revision: 0 } : null;
  }
  sameCredential(config) {
    const current = this.credential();
    return Boolean(current && config && current.revision === config.revision && current.salt === config.salt && current.hash === config.hash);
  }
  reserveAuthAttempt(ipHash) {
    const now = Date.now();
    this.sql('DELETE FROM auth_attempts WHERE attemptedAt<=?', now - LOGIN_WINDOW);
    this.sql('DELETE FROM auth_sessions WHERE expiresAt<=?', now);
    const global = this.sql('SELECT COUNT(*) AS count, MIN(attemptedAt) AS oldest FROM auth_attempts').one();
    const personal = this.sql('SELECT COUNT(*) AS count, MIN(attemptedAt) AS oldest FROM auth_attempts WHERE ipHash=?', ipHash).one();
    if (global.count >= 100 || personal.count >= 8) {
      const resetAt = Math.max(global.count >= 100 ? global.oldest + LOGIN_WINDOW : 0, personal.count >= 8 ? personal.oldest + LOGIN_WINDOW : 0);
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      return { status: 429, body: { error: 'too_many_attempts', retryAfter }, retryAfter };
    }
    // Réserver la tentative avant le calcul coûteux ; les requêtes parallèles respectent la limite.
    this.sql('INSERT INTO auth_attempts(id,ipHash,attemptedAt) VALUES(?,?,?)', crypto.randomUUID(), ipHash, now);
    return null;
  }
  async login(password, ipHash, channel) {
    const config = this.credential();
    if (!config) return { status: 503, body: { error: 'auth_unavailable' } };
    const limited = this.reserveAuthAttempt(ipHash);
    if (limited) return limited;
    if (typeof password !== 'string' || !password.length || password.length > 256) return { status: 401, body: { error: 'unauthorized' } };
    const supplied = await passwordBits(password, config.salt);
    if (!crypto.subtle.timingSafeEqual(supplied, hexBytes(config.hash))) return { status: 401, body: { error: 'unauthorized' } };
    const iat = Math.floor(Date.now() / 1000);
    const payload = { v: 2, aud: 'classe-calme-github', scope: 'publish', channel, iat, exp: iat + AUTH_LIFETIME / 1000, nonce: crypto.randomUUID() };
    const grant = await signedGrant(this.env.TEACHER_AUTH_SECRET, payload);
    const expiresAt = payload.exp * 1000;
    // Un changement arrivé pendant PBKDF2 ou la signature rend ce résultat caduc.
    if (!this.sameCredential(config)) return { status: 401, body: { error: 'unauthorized' } };
    this.sql('INSERT INTO auth_sessions(nonce,channel,expiresAt) VALUES(?,?,?)', payload.nonce, channel, expiresAt);
    return { status: 200, body: { grant, expiresAt } };
  }
  async changePassword(currentPassword, newPassword, ipHash, nonce, channel, expiresAt) {
    if (!this.isSessionActive(nonce, channel, expiresAt)) return { status: 401, body: { error: 'unauthorized' } };
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 256) return { status: 400, body: { error: 'weak_password' } };
    const config = this.credential();
    if (!config) return { status: 503, body: { error: 'auth_unavailable' } };
    const limited = this.reserveAuthAttempt(ipHash);
    if (limited) return limited;
    if (typeof currentPassword !== 'string' || !currentPassword.length || currentPassword.length > 256) return { status: 403, body: { error: 'current_password' } };
    const supplied = await passwordBits(currentPassword, config.salt);
    if (!this.isSessionActive(nonce, channel, expiresAt) || !this.sameCredential(config)) return { status: 401, body: { error: 'unauthorized' } };
    if (!crypto.subtle.timingSafeEqual(supplied, hexBytes(config.hash))) return { status: 403, body: { error: 'current_password' } };
    if (currentPassword === newPassword) return { status: 400, body: { error: 'same_password' } };
    const salt = hexString(crypto.getRandomValues(new Uint8Array(16)));
    const hash = hexString(await passwordBits(newPassword, salt));
    // L'alarme est durable avant la transaction : même une interruption après la
    // rotation reprend la fermeture des anciens écrans, sans requête périodique.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    const changed = this.ctx.storage.transactionSync(() => {
      if (!this.isSessionActive(nonce, channel, expiresAt) || !this.sameCredential(config)) return false;
      this.sql('INSERT INTO auth_credentials(id,salt,hash,revision) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,revision=excluded.revision', salt, hash, config.revision + 1);
      this.sql('INSERT OR IGNORE INTO auth_revocations(nonce,channel,expiresAt) SELECT nonce,channel,expiresAt FROM auth_sessions WHERE expiresAt>?', Date.now());
      this.sql('DELETE FROM auth_sessions');
      return true;
    });
    if (!changed) return { status: 401, body: { error: 'unauthorized' } };
    await this.drainAuthRevocations();
    return { status: 200, body: { ok: true } };
  }
  async drainAuthRevocations() {
    for (const row of this.sql('SELECT nonce,channel,expiresAt FROM auth_revocations').toArray()) {
      try {
        if (row.expiresAt > Date.now()) await this.env.CLASSROOM.getByName(row.channel).revokeTeacher(row.nonce, row.expiresAt, true);
        this.sql('DELETE FROM auth_revocations WHERE nonce=?', row.nonce);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
    }
    // L'alarme déjà réservée fera un dernier contrôle, puis s'arrêtera. Ne pas
    // l'annuler ici : une autre rotation peut ajouter du travail pendant un RPC.
  }
  isSessionActive(nonce, channel, expiresAt) {
    if (!UUID.test(nonce || '') || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
    return Boolean(this.sql('SELECT nonce FROM auth_sessions WHERE nonce=? AND channel=? AND expiresAt=?', nonce, channel, expiresAt).toArray().length);
  }
  revokeSession(nonce) {
    this.sql('DELETE FROM auth_sessions WHERE nonce=?', nonce);
  }
  async revokeTeacher(nonce, expiresAt, passwordChanged = false) {
    this.sql('INSERT INTO revoked(nonce,expiresAt) VALUES(?,?) ON CONFLICT(nonce) DO UPDATE SET expiresAt=MAX(expiresAt,excluded.expiresAt)', nonce, expiresAt);
    const current = this.stored();
    if (current?.authNonce === nonce) {
      this.sql('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', current.sessionId, Date.now() + 120000);
      this.sql('DELETE FROM state WHERE id=1');
      this.broadcast();
    }
    for (const device of this.deviceRows().filter(device => device.nonce === nonce)) this.removeDevice(device.deviceId, device.connectionId);
    if (passwordChanged && !this.devices().length) {
      const room = this.remote();
      if (room) {
        room.tools.notice = null;
        room.tools.timer = null;
        room.noise = { level: 0, alarm: false };
        room.testUntil = room.pauseUntil = 0;
        room.correction = false;
        this.saveRoom(room);
      }
    }
    for (const socket of this.ctx.getWebSockets()) if (this.attachment(socket)?.authNonce === nonce) try { socket.close(1008, 'Signed out'); } catch {}
    await this.scheduleAlarm();
    this.broadcastRemote();
  }
  stored() {
    const rows = this.tableRows('state');
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
    return { type: 'state', v: 1, active, alarm: Boolean(active && state.alarm), mode: state?.mode || 'cover', pulse: state?.pulse ?? false, message: state?.message || MESSAGE, notice, timer, correction: Boolean(active && state.correction), remainingMs };
  }
  teacherStats(active) {
    const sockets = this.ctx.getWebSockets().filter(socket => this.attachment(socket)?.role !== 'teacher' && socket.readyState === 1);
    const counts = new Map();
    for (const socket of sockets) {
      let activity = 'autre';
      try { activity = activityName(socket.deserializeAttachment()?.activity); } catch { /* Anciens modules sans pièce jointe. */ }
      counts.set(activity, (counts.get(activity) || 0) + 1);
    }
    const target = this.targetActivity();
    return { active: Boolean(active && target), viewers: target ? counts.get(target) || 0 : 0, totalViewers: sockets.length,
      activities: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count })) };
  }
  broadcast() {
    const room = this.remote();
    const target = this.targetActivity(room);
    const neutral = JSON.stringify(this.publicState(null));
    const message = target ? JSON.stringify(this.remotePublicState(Date.now(), room)) : neutral;
    for (const socket of this.ctx.getWebSockets()) {
      const info = this.attachment(socket);
      if (info?.role === 'teacher' || socket.readyState !== 1) continue;
      try { socket.send(target && info?.activity === target ? message : neutral); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
    }
  }
  attachment(socket) { try { return socket.deserializeAttachment(); } catch { return null; } }
  remote() {
    const row = this.tableRows('remote_room')[0];
    return row ? JSON.parse(row.value) : null;
  }
  targetActivity(room = this.remote()) {
    return knownActivity(room?.targetActivity) ? room.targetActivity : null;
  }
  pupilState(activity, now = Date.now()) {
    const room = this.remote();
    const target = this.targetActivity(room);
    return target && activity === target ? this.remotePublicState(now, room) : this.publicState(null, now);
  }
  devices(now = Date.now()) {
    return this.deviceRows().map(row => ({ ...row, expiresAt: this.deviceExpiry(row) }))
      .filter(row => row.expiresAt > now && row.authExpires > now).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
  saveRoom(room, increment = true) {
    const devices = this.deviceRows().filter(device => this.deviceExpiry(device) > Date.now());
    if (devices.length) room.expiresAt = Math.max(...devices.map(device => device.expiresAt));
    if (JSON.stringify(room) === this.tableRows('remote_room')[0]?.value) return;
    if (increment) room.revision++;
    this.sql('INSERT INTO remote_room(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(room));
  }
  file(id) { return this.tableRows('remote_files').find(file => file.id === id); }
  deleteFile(id) {
    this.sql('DELETE FROM remote_chunks WHERE fileId=?', id);
    this.sql('DELETE FROM remote_files WHERE id=?', id);
  }
  removeDevice(deviceId, connectionId, now = Date.now()) {
    const row = this.deviceRows().find(device => device.deviceId === deviceId);
    if (!row || (connectionId && row.connectionId !== connectionId)) return false;
    this.sql('DELETE FROM remote_devices WHERE deviceId=?', deviceId);
    const room = this.remote();
    if (room) {
      if (room.controller?.deviceId === deviceId) room.controller = null;
      if (room.microphone?.deviceId === deviceId) { room.microphone = null; room.noise = { level: 0, alarm: false }; room.noiseAt = 0; }
      if (!this.devices(now).length) { room.expiresAt = now + TTL; room.correction = false; }
      this.saveRoom(room);
    }
    return true;
  }
  cleanupRemote(now = Date.now()) {
    let changed = false;
    for (const row of this.deviceRows().filter(device => this.deviceExpiry(device) <= now)) {
      changed = this.removeDevice(row.deviceId, row.connectionId, now) || changed;
      for (const socket of this.ctx.getWebSockets()) {
        const info = this.attachment(socket);
        if (info?.role === 'teacher' && info.connectionId === row.connectionId) try { socket.close(1008, 'Presence expired'); } catch {}
      }
    }
    const room = this.remote();
    if (room && !this.devices(now).length && room.expiresAt <= now) {
      this.sql('DELETE FROM remote_room');
      this.sql('DELETE FROM remote_chunks');
      this.sql('DELETE FROM remote_files');
      return true;
    }
    const expired = this.tableRows('remote_files').filter(file => file.expiresAt <= now || (file.orphanUntil !== null && file.orphanUntil <= now));
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
    const update = async () => {
      // getAlarm() also recovers the existing deadline after hibernation.
      const current = await this.ctx.storage.getAlarm();
      const now = Date.now();
      const deadlines = [];
      const legacy = this.stored();
      if (legacy?.expiresAt > now) deadlines.push(legacy.expiresAt);
      const devices = this.deviceRows().map(device => this.deviceExpiry(device));
      const room = this.remote();
      if (room) {
        deadlines.push(devices.length ? Math.max(...devices) : room.expiresAt);
        if (room.testUntil > now) deadlines.push(room.testUntil);
        if (room.pauseUntil > now) deadlines.push(room.pauseUntil);
      }
      deadlines.push(...devices);
      for (const file of this.tableRows('remote_files')) deadlines.push(Math.min(file.expiresAt, file.orphanUntil ?? file.expiresAt));
      const next = deadlines.length ? Math.max(now + 1, Math.min(...deadlines)) : null;
      // An already scheduled earlier wake-up is safe; postponing every heartbeat
      // would add a storage write while providing no additional reliability.
      if (next === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
      else if (current === null || current <= now || current > next) await this.ctx.storage.setAlarm(next);
    };
    this.alarmUpdate = this.alarmUpdate.catch(() => {}).then(update);
    return this.alarmUpdate;
  }
  remotePublicState(now = Date.now(), room = this.remote()) {
    if (!room) return null;
    const devices = this.devices(now);
    const preferences = room.tools.preferences;
    const active = Boolean(room.linkActivities && this.targetActivity(room) && devices.length);
    if (!active) return this.publicState(null, now);
    return this.publicState({ expiresAt: active ? Math.max(...devices.map(device => device.expiresAt)) : 0,
      alarm: this.effectiveNoise(room, now).alarm, mode: preferences.mode, pulse: preferences.pulse,
      message: room.tools.message, notice: room.tools.notice, timer: room.tools.timer, correction: room.correction }, now);
  }
  snapshot(now = Date.now()) {
    const room = this.remote();
    if (!room) return null;
    const stats = this.teacherStats(Boolean(room.linkActivities && this.devices(now).length));
    return { type: 'remote', v: 1, revision: room.revision, serverNow: now,
      controller: room.controller, microphone: room.microphone,
      devices: this.devices(now).map(device => ({ deviceId: device.deviceId, label: device.label })),
      display: room.display, tools: room.tools, noise: this.effectiveNoise(room, now), linkActivities: room.linkActivities, targetActivity: this.targetActivity(room), correction: Boolean(room.correction && this.targetActivity(room)),
      viewers: stats.viewers, totalViewers: stats.totalViewers, activities: stats.activities };
  }
  effectiveNoise(room, now = Date.now()) {
    return { level: 0, alarm: Boolean(room.pauseUntil <= now && (room.noise.alarm || room.testUntil > now)), pausedUntil: room.pauseUntil || 0, testUntil: room.testUntil || 0 };
  }
  validTeacher(socket, now = Date.now()) {
    const info = this.attachment(socket);
    if (info?.role !== 'teacher' || info.authExpires <= now) return null;
    const row = this.deviceRows().find(device => device.deviceId === info.deviceId && device.connectionId === info.connectionId && device.nonce === info.authNonce && this.deviceExpiry(device) > now);
    if (!row || this.revoked(info.authNonce, now)) return null;
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
    this.broadcast();
  }
  async teacherConnect(request) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    const label = url.searchParams.get('label') || 'Appareil';
    const authNonce = request.headers.get('x-classroom-auth-nonce');
    const authExpires = Number(request.headers.get('x-classroom-auth-expires'));
    if (!UUID.test(authNonce || '') || !Number.isSafeInteger(authExpires) || authExpires <= Date.now() || this.revoked(authNonce)) return json({ error: 'unauthorized' }, 401);
    if (!UUID.test(deviceId || '') || !plainText(label, 40) || !label.trim()) return json({ error: 'invalid_device' }, 400);
    const now = Date.now();
    this.cleanupRemote(now);
    if (this.devices(now).length >= 16 && !this.devices(now).some(device => device.deviceId === deviceId)) return json({ error: 'full' }, 503);
    const previous = this.deviceRows().find(device => device.deviceId === deviceId);
    if (previous) for (const socket of this.ctx.getWebSockets()) {
      if (this.attachment(socket)?.connectionId === previous.connectionId) try { socket.close(1008, 'Replaced'); } catch {}
    }
    const isNew = !this.remote();
    const room = this.remote() || defaultRoom(now);
    const connectionId = crypto.randomUUID();
    this.sql('INSERT INTO remote_devices(deviceId,label,nonce,authExpires,expiresAt,connectionId) VALUES(?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET label=excluded.label,nonce=excluded.nonce,authExpires=excluded.authExpires,expiresAt=excluded.expiresAt,connectionId=excluded.connectionId', deviceId, label.trim(), authNonce, authExpires, Math.min(now + TTL, authExpires), connectionId);
    if (isNew) room.controller = { deviceId, label: label.trim() };
    // Un retour réseau ne rallume jamais un ancien microphone à distance.
    if (previous && room.microphone?.deviceId === deviceId) { room.microphone = null; room.noise = { level: 0, alarm: false }; room.noiseAt = 0; }
    if (room.controller?.deviceId === deviceId) room.controller = { deviceId, label: label.trim() };
    this.saveRoom(room);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['teacher']);
    server.serializeAttachment({ role: 'teacher', deviceId, label: label.trim(), authNonce, authExpires, connectionId, lastSeenAt: now });
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
    if (!UUID.test(authNonce || '') || !Number.isSafeInteger(authExpires) || authExpires <= now || this.revoked(authNonce, now)) return json({ error: 'unauthorized' }, 401);
    if (!UUID.test(id || '')) return json({ error: 'invalid_file' }, 400);
    if (request.method === 'GET') {
      const file = this.file(id);
      if (!file?.complete || file.expiresAt <= now) return json({ error: 'not_found' }, 404);
      // Au plus 15 Mio, lus par morceaux SQL ; aucune URL publique n'est créée.
      const chunks = this.sql('SELECT data FROM remote_chunks WHERE fileId=? ORDER BY part', id).toArray();
      let part = 0;
      const stream = new ReadableStream({ pull(controller) {
        if (part === chunks.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(chunks[part++].data).slice());
      } });
      return new Response(stream, { headers: { 'content-type': 'application/pdf', 'content-length': String(file.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="cours.pdf"' } });
    }
    const deviceId = url.searchParams.get('deviceId');
    const room = this.remote();
    const device = this.devices(now).find(device => device.deviceId === deviceId && device.nonce === authNonce);
    if (!device || room?.controller?.deviceId !== deviceId) return json({ error: 'controller_required' }, 409);
    const part = Number(url.searchParams.get('part'));
    const parts = Number(url.searchParams.get('parts'));
    if (!Number.isSafeInteger(part) || !Number.isSafeInteger(parts) || parts < 1 || parts > 60 || part < 0 || part >= parts) return json({ error: 'invalid_part' }, 400);
    let bytes;
    try { bytes = await readBytes(request, FILE_CHUNK); } catch { return json({ error: 'file_too_large' }, 413); }
    // Le contrôle a pu changer pendant la lecture réseau du morceau.
    const current = this.remote();
    if (!current || current.controller?.deviceId !== deviceId || !this.devices().some(device => device.deviceId === deviceId && device.nonce === authNonce) || this.revoked(authNonce)) return json({ error: 'controller_required' }, 409);
    if (!bytes.length || (part < parts - 1 && bytes.length !== FILE_CHUNK)) return json({ error: 'invalid_chunk' }, 400);
    let file = this.file(id);
    if (!file) {
      if (part !== 0 || bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'invalid_pdf' }, 400);
      if (this.sql('SELECT COUNT(*) AS count FROM remote_files').one().count >= 200) return json({ error: 'room_file_limit' }, 413);
    } else if (file.parts !== parts) return json({ error: 'file_conflict' }, 409);
    const old = this.sql('SELECT data FROM remote_chunks WHERE fileId=? AND part=?', id, part).toArray()[0];
    if (old) {
      const previous = new Uint8Array(old.data);
      if (previous.length !== bytes.length || previous.some((value, index) => value !== bytes[index])) return json({ error: 'file_conflict' }, 409);
      return json({ ok: true, complete: Boolean(file.complete), size: file.size });
    }
    const size = (file?.size || 0) + bytes.length;
    const total = this.sql('SELECT COALESCE(SUM(size),0) AS size FROM remote_files').one().size;
    if (size > FILE_MAX || total + bytes.length > ROOM_FILE_MAX) return json({ error: 'room_file_limit' }, 413);
    if (!file) {
      this.sql('INSERT INTO remote_files(id,parts,size,complete,expiresAt,orphanUntil) VALUES(?,?,0,0,?,?)', id, parts, Date.now() + AUTH_LIFETIME, Date.now() + FILE_GRACE);
      file = this.file(id);
    }
    this.sql('INSERT INTO remote_chunks(fileId,part,data) VALUES(?,?,?)', id, part, bytes.buffer);
    const complete = this.sql('SELECT COUNT(*) AS count FROM remote_chunks WHERE fileId=?', id).one().count === parts;
    this.sql('UPDATE remote_files SET size=?,complete=?,orphanUntil=? WHERE id=?', size, complete ? 1 : 0, Date.now() + FILE_GRACE, id);
    await this.scheduleAlarm();
    return json({ ok: true, complete, size });
  }
  async correctionRequest(request) {
    const now = Date.now();
    if (this.cleanupRemote(now)) this.broadcastRemote();
    const activity = new URL(request.url).searchParams.get('activity');
    if (!activity || !Object.hasOwn(CORRECTIONS, activity)) return json({ error: 'not_found' }, 404);
    const allowed = () => this.targetActivity() === activity && this.remotePublicState()?.correction === true;
    if (!allowed()) return json({ error: 'correction_hidden' }, 403);
    if (!this.env.CORRECTIONS) return json({ error: 'temporarily_unavailable' }, 503);
    const entry = CORRECTIONS[activity];
    // Les fichiers restent dans le binding interne, jamais dans GitHub Pages.
    const asset = await this.env.CORRECTIONS.fetch(new Request(new URL(entry.file, 'https://corrections.internal/')));
    if (asset.status !== 200) {
      if (asset.body) await asset.body.cancel();
      return json({ error: 'temporarily_unavailable' }, 503);
    }
    // Une fermeture arrivée pendant la lecture du fichier garde la priorité.
    if (!allowed()) {
      if (asset.body) await asset.body.cancel();
      return json({ error: 'correction_hidden' }, 403);
    }
    return new Response(asset.body, { headers: {
      'content-type': 'application/pdf', 'content-disposition': 'inline',
      'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff'
    } });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/teacher') return this.teacherConnect(request);
    if (path === '/files') return this.fileRequest(request);
    if (path === '/correction') return this.correctionRequest(request);
    return this.legacyFetch(request);
  }
  async legacyFetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/live' && path !== '/publish') return json({ error: 'not_found' }, 404);
    if (path === '/live') {
      if (this.teacherStats(false).totalViewers >= 500) return json({ error: 'full' }, 503);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['pupil']);
      server.serializeAttachment({ role: 'pupil', activity: activityName(new URL(request.url).searchParams.get('activity')) });
      server.send(JSON.stringify(this.pupilState(this.attachment(server)?.activity)));
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
    this.sql('DELETE FROM closed WHERE expiresAt<?', now);
    this.sql('DELETE FROM revoked WHERE expiresAt<=?', now);
    if (this.revoked(authNonce, now)) return json({ error: 'unauthorized' }, 401);
    if (current?.sessionId === body.sessionId && current.authNonce && current.authNonce !== authNonce) return json({ error: 'another_teacher_tab' }, 409);
    if (body.action === 'release') {
      this.sql('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', body.sessionId, now + 120000);
      if (current?.sessionId === body.sessionId) {
        this.sql('DELETE FROM state WHERE id=1');
        await this.scheduleAlarm();
        this.broadcast();
      }
      return json(this.teacherStats(false));
    }
    if (this.sql('SELECT sessionId FROM closed WHERE sessionId=?', body.sessionId).toArray().length) return json({ error: 'session_released' }, 410);
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
      this.sql('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', current.sessionId, now + 120000);
    }
    const state = { sessionId: body.sessionId, authNonce, expiresAt: Math.min(now + TTL, authExpires), alarm: body.alarm, mode: body.mode, pulse: body.pulse, message, notice, timer };
    this.sql('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(state));
    await this.scheduleAlarm();
    // Une déconnexion arrivée pendant l'écriture de l'alarme garde la priorité.
    this.broadcast();
    return json(this.teacherStats(Boolean(this.stored()?.expiresAt > Date.now())));
  }
  async alarm() {
    if (this.sql('SELECT nonce FROM auth_revocations LIMIT 1').toArray().length) {
      await this.drainAuthRevocations();
      return;
    }
    const now = Date.now();
    this.cleanupRemote(now);
    const state = this.stored();
    if (state && state.expiresAt <= now) this.sql('DELETE FROM state WHERE id=1');
    const room = this.remote();
    if (room && ((room.testUntil && room.testUntil <= now) || (room.pauseUntil && room.pauseUntil <= now))) {
      if (room.testUntil <= now) room.testUntil = 0;
      if (room.pauseUntil <= now) room.pauseUntil = 0;
      this.saveRoom(room);
    }
    this.sql('DELETE FROM revoked WHERE expiresAt<=?', now);
    this.sql('DELETE FROM closed WHERE expiresAt<=?', now);
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
    // WebSocket attachments survive hibernation. Retaining the latest contact
    // there preserves the full 35-second timeout without a SQL write per sample.
    socket.serializeAttachment({ role: 'teacher', deviceId: info.deviceId, label: info.label, authNonce: info.authNonce, authExpires: info.authExpires, connectionId: info.connectionId, lastSeenAt: now, rate });
    const expiresAt = Math.min(now + TTL, info.authExpires);
    if (expiresAt - info.row.expiresAt >= PRESENCE_WRITE_INTERVAL) {
      this.sql('UPDATE remote_devices SET expiresAt=? WHERE deviceId=? AND connectionId=?', expiresAt, info.deviceId, info.connectionId);
    }
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
      if (['display', 'tools', 'link', 'activity', 'correction', 'test-alert', 'pause-alert'].includes(body.action) && room.controller?.deviceId !== info.deviceId) throw new Error('controller_required');
      if (body.action === 'take-control') room.controller = { deviceId: info.deviceId, label: info.label };
      else if (body.action === 'display') {
        room.display = cleanDisplay(body.display, id => Boolean(this.file(id)?.complete && this.file(id).expiresAt > now));
        this.sql('UPDATE remote_files SET orphanUntil=? WHERE orphanUntil IS NULL', now + FILE_GRACE);
        for (const doc of room.display.documents) if (doc.kind === 'pdf') this.sql('UPDATE remote_files SET orphanUntil=NULL WHERE id=?', doc.fileId);
      } else if (body.action === 'tools') room.tools = cleanTools(body.tools, now);
      else if (body.action === 'link') {
        if (typeof body.enabled !== 'boolean') throw new Error('invalid_link');
        room.linkActivities = body.enabled;
        if (!body.enabled) room.correction = false;
      } else if (body.action === 'activity') {
        if (body.activity !== null && !knownActivity(body.activity)) throw new Error('invalid_activity');
        if (body.activity !== this.targetActivity(room)) {
          room.correction = false;
          room.tools.notice = null;
          room.tools.timer = null;
        }
        room.targetActivity = body.activity;
      } else if (body.action === 'correction') {
        if (typeof body.enabled !== 'boolean') throw new Error('invalid_correction');
        if (body.enabled && !room.linkActivities) throw new Error('activities_disabled');
        if (body.enabled && !this.targetActivity(room)) throw new Error('activity_required');
        if (body.enabled && !Object.hasOwn(CORRECTIONS, this.targetActivity(room))) throw new Error('correction_unavailable');
        room.correction = body.enabled;
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
        else if (room.noise.level === 0 && room.noise.alarm === body.noise.alarm) broadcast = false;
        else {
          // Only the alert is shared. Ignore numeric levels from older clients.
          room.noise = { level: 0, alarm: body.noise.alarm };
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
