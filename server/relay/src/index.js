import { DurableObject } from 'cloudflare:workers';
const TTL = 35000;
const MESSAGE = 'MOINS DE BRUIT, MERCI.';
const NOTICE_MAX_LIFETIME = 180000;
const TIMER_MAX_LIFETIME = 180 * 60000;
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });

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
async function authorized(token, secret, channel) {
  if (!secret || typeof token !== 'string' || token.length > 1600) return false;
  const encoder = new TextEncoder();
  if (token.startsWith('cc1.')) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify('HMAC', key, decodeBase64url(parts[2]), encoder.encode('cc1.' + parts[1]));
      if (!valid) return false;
      const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
      const now = Math.floor(Date.now() / 1000);
      return payload.v === 1 && payload.aud === 'classe-calme-github' && payload.scope === 'publish' && payload.channel === channel && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) && payload.iat <= now + 60 && payload.exp > now && payload.exp > payload.iat && payload.exp - payload.iat <= 28800;
    } catch { return false; }
  }
  const expectedHash = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  const suppliedHash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return crypto.subtle.timingSafeEqual(expectedHash, suppliedHash);
}
function cors(response, origin, allowedOrigin) {
  if (origin !== allowedOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', allowedOrigin);
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  headers.set('access-control-max-age', '3600');
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
    if (!['/live', '/publish', '/release'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    const origin = request.headers.get('origin');
    const reply = response => cors(response, origin, env.STUDENT_ORIGIN);
    const channel = channelName(url);
    if (!channel) return reply(json({ error: 'channel' }, 400));
    if (url.pathname === '/live') {
      if (origin !== env.STUDENT_ORIGIN && origin !== 'https://classe-calme-jmc.greenbread14.chatgpt.site') return json({ error: 'origin' }, 403);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    } else {
      if (origin && origin !== env.STUDENT_ORIGIN) return json({ error: 'origin' }, 403);
      if (request.method === 'OPTIONS') return reply(new Response(null, { status: 204 }));
      if (request.method !== 'POST') return reply(json({ error: 'method' }, 405));
      let token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
      if (url.pathname === '/release') {
        let body;
        try { body = await readJSON(request); } catch { return reply(json({ error: 'invalid_body' }, 400)); }
        if (!body || body.action !== 'release') return reply(json({ error: 'release_only' }, 400));
        token = body.grant;
        request = new Request(new URL('/publish', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'release', sessionId: body.sessionId }) });
      }
      if (!await authorized(token, env.RELAY_SECRET, channel)) return reply(json({ error: 'unauthorized' }, 401));
    }
    try {
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
    if (new URL(request.url).pathname === '/live') {
      if (this.ctx.getWebSockets().length >= 500) return json({ error: 'full' }, 503);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ activity: activityName(new URL(request.url).searchParams.get('activity')) });
      server.send(JSON.stringify(this.publicState(this.stored())));
      return new Response(null, { status: 101, webSocket: client });
    }
    let body;
    try { body = await readJSON(request); } catch { return json({ error: 'invalid_body' }, 400); }
    if (!body || !['claim', 'heartbeat', 'release'].includes(body.action) || !/^[a-f0-9-]{36}$/.test(body.sessionId || '')) return json({ error: 'invalid_state' }, 400);
    const now = Date.now();
    const current = this.stored();
    this.ctx.storage.sql.exec('DELETE FROM closed WHERE expiresAt<?', now);
    if (body.action === 'release') {
      this.ctx.storage.sql.exec('INSERT INTO closed(sessionId,expiresAt) VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET expiresAt=excluded.expiresAt', body.sessionId, now + 120000);
      if (current?.sessionId === body.sessionId) {
        this.ctx.storage.sql.exec('DELETE FROM state WHERE id=1');
        await this.ctx.storage.deleteAlarm();
        this.broadcast(null);
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
    const state = { sessionId: body.sessionId, expiresAt: now + TTL, alarm: body.alarm, mode: body.mode, pulse: body.pulse, message, notice, timer };
    this.ctx.storage.sql.exec('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(state));
    await this.ctx.storage.setAlarm(state.expiresAt);
    this.broadcast(state);
    return json(this.teacherStats(true));
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
