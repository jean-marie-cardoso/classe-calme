import { DurableObject } from 'cloudflare:workers';
const TTL = 35000;
const MESSAGE = 'MOINS DE BRUIT, MERCI.';
const NOTICE_MAX_LIFETIME = 180000;
const TIMER_MAX_LIFETIME = 180 * 60000;
const AUTH_LIFETIME = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 60000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...headers } });

async function readJSON(request) {
  if (!request.body) throw new Error('body');
  const reader = request.body.getReader();
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 2048) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
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
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (!['/live', '/login', '/logout', '/publish', '/release'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    const origin = request.headers.get('origin');
    const reply = response => cors(response, origin, env.STUDENT_ORIGIN);
    const channel = channelName(url);
    if (!channel) return reply(json({ error: 'channel' }, 400));
    if (url.pathname === '/live') {
      if (origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    } else {
      if (origin && origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.method === 'OPTIONS') return reply(new Response(null, { status: 204 }));
      if (request.method !== 'POST') return reply(json({ error: 'method' }, 405));
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
        headers.set('x-classroom-auth-nonce', payload.nonce);
        headers.set('x-classroom-auth-expires', String(payload.exp * 1000));
        request = new Request(request, { headers });
      }
      const response = await env.CLASSROOM.getByName(channel).fetch(request);
      return url.pathname === '/live' ? response : reply(response);
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
      await this.ctx.storage.deleteAlarm();
      this.broadcast(this.stored());
    }
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
    const sockets = this.ctx.getWebSockets();
    const counts = new Map();
    for (const socket of sockets) {
      let activity = 'autre';
      try { activity = activityName(socket.deserializeAttachment()?.activity); } catch { /* Anciens modules sans pièce jointe. */ }
      counts.set(activity, (counts.get(activity) || 0) + 1);
    }
    return { active, viewers: sockets.length, activities: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count })) };
  }
  broadcast(state) {
    const message = JSON.stringify(this.publicState(state));
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
    }
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/live' && path !== '/publish') return json({ error: 'not_found' }, 404);
    if (path === '/live') {
      if (this.ctx.getWebSockets().length >= 500) return json({ error: 'full' }, 503);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ activity: activityName(new URL(request.url).searchParams.get('activity')) });
      server.send(JSON.stringify(this.publicState(this.stored())));
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
    const current = this.stored();
    this.ctx.storage.sql.exec('DELETE FROM closed WHERE expiresAt<?', now);
    this.ctx.storage.sql.exec('DELETE FROM revoked WHERE expiresAt<=?', now);
    if (this.ctx.storage.sql.exec('SELECT nonce FROM revoked WHERE nonce=?', authNonce).toArray().length) return json({ error: 'unauthorized' }, 401);
    if (current?.sessionId === body.sessionId && current.authNonce && current.authNonce !== authNonce) return json({ error: 'another_teacher_tab' }, 409);
    if (body.action === 'release') {
      this.ctx.storage.sql.exec('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', body.sessionId, now + 120000);
      if (current?.sessionId === body.sessionId) {
        this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
        await this.ctx.storage.deleteAlarm();
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
    await this.ctx.storage.setAlarm(state.expiresAt);
    // Une déconnexion arrivée pendant l'écriture de l'alarme garde la priorité.
    this.broadcast(this.stored());
    return json(this.teacherStats(Boolean(this.stored()?.expiresAt > Date.now())));
  }
  async alarm() {
    const state = this.stored();
    if (state?.expiresAt > Date.now()) { await this.ctx.storage.setAlarm(state.expiresAt); return; }
    this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
    this.broadcast(null);
  }
  webSocketMessage(socket) {
    // Les pages élèves peuvent seulement recevoir, jamais publier.
    socket.close(1008, 'Read only');
  }
  webSocketClose() { /* Réponse Close automatique depuis la date de compatibilité 2026-04-07. */ }
  webSocketError(socket) { try { socket.close(1011, 'Reconnect'); } catch {} }
}
