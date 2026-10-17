const ASSETS = __EMBEDDED_ASSETS__;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
async function boundedBody(request) {
  if (!request.body) throw new Error('body');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function githubConnection(url, env) {
  const state = url.searchParams.get('state') || '';
  const channel = url.searchParams.get('channel') || 'main';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) return json({ error: 'state' }, 400);
  if (channel !== 'main' && !/^test-[a-z0-9-]{8,70}$/.test(channel)) return json({ error: 'channel' }, 400);
  if (!env.RELAY_SECRET) return json({ error: 'unconfigured' }, 503);
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, aud: 'classe-calme-github', scope: 'publish', channel, iat: now, exp: now + 28800, nonce: crypto.randomUUID() };
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RELAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('cc1.' + encoded));
  const token = 'cc1.' + encoded + '.' + base64url(signature);
  const destination = new URL('https://jean-marie-cardoso.github.io/classe-calme/');
  destination.hash = new URLSearchParams({ 'classe-calme-auth': token, state }).toString();
  return new Response(null, { status: 302, headers: { location: destination.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/connect-github') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      return githubConnection(url, env);
    }
    if (url.pathname === '/api/relay') {
      // Le contrôle d'accès propriétaire du Site protège également cette route.
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'origin' }, 403);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'json_required' }, 415);
      let body;
      try { body = await boundedBody(request); } catch { return json({ error: 'invalid_body' }, 400); }
      if (!body || !['claim', 'heartbeat', 'release'].includes(body.action) || !/^[a-f0-9-]{36}$/.test(body.sessionId || '')) return json({ error: 'invalid_state' }, 400);
      const payload = { action: body.action, sessionId: body.sessionId };
      if (body.action !== 'release') {
        if (typeof body.alarm !== 'boolean' || !['cover', 'border'].includes(body.mode) || typeof body.pulse !== 'boolean') return json({ error: 'invalid_state' }, 400);
        Object.assign(payload, { alarm: body.alarm, mode: body.mode, pulse: body.pulse });
      }
      if (!env.RELAY_SECRET || !env.RELAY_URL) return json({ error: 'relay_unconfigured' }, 503);
      const target = new URL('/publish', env.RELAY_URL);
      const channel = url.searchParams.get('channel');
      if (channel) {
        if (!/^test-[a-z0-9-]{8,70}$/.test(channel)) return json({ error: 'channel' }, 400);
        target.searchParams.set('channel', channel);
      }
      try {
        const response = await fetch(target, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RELAY_SECRET },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) return json({ error: response.status === 409 ? 'another_teacher_tab' : response.status === 410 ? 'session_released' : 'relay_unavailable' }, [409, 410, 400].includes(response.status) ? response.status : 503);
        const result = await response.json();
        return json({ active: Boolean(result.active), viewers: Number.isFinite(result.viewers) ? Math.max(0, Math.floor(result.viewers)) : 0 });
      } catch { return json({ error: 'relay_unavailable' }, 503); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method' }, 405);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(ASSETS, path)) return new Response('Not found', { status: 404 });
    const extension = path.slice(path.lastIndexOf('.'));
    return new Response(request.method === 'HEAD' ? null : ASSETS[path], {
      headers: { 'content-type': TYPES[extension] || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' }
    });
  }
};
