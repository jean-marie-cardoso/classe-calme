const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { WebSocket } = require('ws');
const relay = path.resolve(__dirname, '..');
const origin = 'https://jean-marie-cardoso.github.io';
const channel = 'test-corrections-integration';
const password = 'Local integration fixture only';
const salt = crypto.randomBytes(16).toString('hex');
const hash = 'pbkdf2-sha256:100000:' + salt + ':' + crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
const catalogSource = fs.readFileSync(path.join(relay, 'src/corrections-catalog.js'), 'utf8');
const catalog = new Function(catalogSource.replace('export const CORRECTIONS', 'const CORRECTIONS') + '\nreturn CORRECTIONS;')();
let source = fs.readFileSync(path.join(relay, 'src/index.js'), 'utf8')
  .replace("import { CORRECTIONS } from './corrections-catalog.js';", catalogSource.replace('export const CORRECTIONS', 'const CORRECTIONS'))
  .replace('export default {', 'const app = {')
  .replace('  async alarm() {', "  async expireForCorrectionTest() { this.sql('UPDATE remote_devices SET expiresAt=?', Date.now()-1); for (const socket of this.ctx.getWebSockets()) { const info = this.attachment(socket); if (info?.role === 'teacher') socket.serializeAttachment({ ...info, lastSeenAt: Date.now()-35001 }); } await this.alarm(); }\n  async alarm() {");
source += "\nexport default { async fetch(request, env) { if (new URL(request.url).pathname === '/__test/expire') { await env.CLASSROOM.getByName('" + channel + "').expireForCorrectionTest(); return new Response('ok'); } return app.fetch(request, env); } };";
let assetReads = 0, assetFailure = false, heldAsset = null;
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'corrections-test', modules: true, script: source,
  compatibilityDate: '2026-10-17', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { CLASSROOM: { className: 'ClassroomRelay', useSQLite: true } },
  bindings: { STUDENT_ORIGIN: origin, TEACHER_PASSWORD_HASH: hash, TEACHER_AUTH_SECRET: crypto.randomBytes(32).toString('hex') },
  serviceBindings: { CORRECTIONS: async request => {
    assetReads++;
    if (heldAsset) { heldAsset.started(); await heldAsset.wait; heldAsset = null; }
    if (assetFailure) return new Response('unavailable', { status: 503 });
    const file = path.join(relay, 'correction-assets', new URL(request.url).pathname);
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'application/pdf' } });
  } }
}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = fn(); if (value) return value; await pause(10); }
  throw new Error('Timed out: ' + label);
}
async function req(url, options = {}, grant) {
  return mf.dispatchFetch('https://relay.example' + url, { ...options, headers: { origin, ...(grant ? { authorization: 'Bearer ' + grant } : {}), ...options.headers } });
}
async function login(ip) {
  const response = await req('/login?channel=' + channel, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  return (await response.json()).grant;
}
async function teacher(grant, label) {
  const id = crypto.randomUUID(), endpoint = new URL(await mf.ready);
  endpoint.protocol = 'ws:'; endpoint.pathname = '/teacher';
  endpoint.search = new URLSearchParams({ channel, deviceId: id, label }).toString();
  const socket = new WebSocket(endpoint, ['classe-calme', grant], { headers: { origin } });
  const peer = { id, socket, messages: [] };
  socket.on('message', data => peer.messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  peer.state = () => peer.messages.filter(m => m.type === 'remote').at(-1);
  peer.command = async (action, data = {}) => {
    const requestId = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'command', requestId, action, ...data }));
    return waitFor(() => peer.messages.find(m => m.type === 'ack' && m.requestId === requestId), action);
  };
  await waitFor(peer.state, 'teacher initial snapshot'); return peer;
}
async function pupil(activity) {
  const response = await req('/live?channel=' + channel + '&activity=' + encodeURIComponent(activity), { headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const socket = response.webSocket, messages = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data))); socket.accept();
  await waitFor(() => messages.length, 'pupil snapshot');
  return { socket, messages, state: () => messages.at(-1) };
}
const correctionUrl = activity => '/correction?channel=' + channel + '&activity=' + encodeURIComponent(activity);
(async () => {
  assert.equal(Object.keys(catalog).length, 50);
  for (const id of Object.keys(catalog)) assert.equal((await req(correctionUrl(id))).status, 403, id + ' must remain hidden');
  assert.equal(assetReads, 0);
  for (const id of ['constructor', '__proto__', '../3/01', '3/99', '3/01/']) assert.equal((await req(correctionUrl(id))).status, 404);
  assert.equal((await req(correctionUrl('3/01'), { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await req(correctionUrl('3/01'), { method: 'POST' })).status, 405);
  assert.equal((await req('/3/01.pdf')).status, 404);
  assert.equal((await req('/bonus/3-01.pdf', { headers: { 'sec-fetch-mode': 'navigate' } })).status, 404);
  assert.equal((await req('/correction?channel=invalid&activity=3/01')).status, 400);
  const grantA = await login('192.0.2.41'), grantB = await login('192.0.2.42');
  const a = await teacher(grantA, 'Mac'), b = await teacher(grantB, 'PC');
  const p = await pupil('3/01'), q = await pupil('5/01');
  assert.equal(a.state().correction, false);
  assert.equal((await b.command('correction', { enabled: true })).error, 'controller_required');
  assert.equal((await a.command('correction', { enabled: 'true' })).error, 'invalid_correction');
  p.socket.send(JSON.stringify({ type: 'command', requestId: crypto.randomUUID(), action: 'correction', enabled: true }));
  await pause(30);
  assert.equal(a.state().correction, false);
  assert.equal((await a.command('correction', { enabled: true })).ok, true);
  await waitFor(() => q.state().correction === true && b.state().correction === true, 'show reaches pupils and follower');
  assert.equal((await req('/correction?activity=3/01')).status, 403, 'test channel must not enable real class');
  for (const [id, entry] of Object.entries(catalog)) {
    const response = await req(correctionUrl(id));
    assert.equal(response.status, 200, id);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, entry.size);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  assetFailure = true;
  assert.equal((await req(correctionUrl('3/01'))).status, 503); assetFailure = false;
  const tools = a.state().tools;
  assert.equal((await a.command('tools', { tools })).ok, true);
  assert.equal(a.state().correction, true, 'older tools messages must not close correction');
  let resume, started;
  heldAsset = { wait: new Promise(resolve => { resume = resolve; }), started: () => started() };
  const fetching = new Promise(resolve => { started = resolve; });
  const delayed = req(correctionUrl('3/01'));
  await fetching;
  assert.equal((await a.command('correction', { enabled: false })).ok, true);
  resume();
  assert.equal((await delayed).status, 403, 'hide must win over a pending asset read');
  await waitFor(() => q.state().correction === false, 'hide reaches pupil');
  assert.equal((await req(correctionUrl('3/01'))).status, 403);
  await a.command('correction', { enabled: true });
  await a.command('link', { enabled: false });
  assert.equal(a.state().correction, false);
  assert.equal((await req(correctionUrl('3/01'))).status, 403);
  assert.equal((await a.command('correction', { enabled: true })).error, 'activities_disabled');
  await a.command('link', { enabled: true });
  assert.equal(a.state().correction, false, 'relink must not reopen an old correction');
  await a.command('correction', { enabled: true });
  a.socket.close();
  await waitFor(() => b.state().devices.length === 1, 'controller leaves');
  assert.equal(b.state().correction, true, 'an active teacher remains');
  await b.command('take-control');
  assert.equal((await b.command('correction', { enabled: false })).ok, true);
  await b.command('correction', { enabled: true });
  b.socket.close();
  await waitFor(() => q.state().active === false, 'last teacher leaves');
  assert.equal(q.state().correction, false);
  const c = await teacher(grantB, 'PC reconnected');
  assert.equal(c.state().correction, false, 'reconnect within lease grace must start hidden');
  await c.command('take-control'); await c.command('correction', { enabled: true });
  assert.equal((await req('/__test/expire')).status, 200);
  await waitFor(() => q.state().active === false, 'expired teacher');
  assert.equal(q.state().correction, false);
  assert.equal((await req(correctionUrl('3/01'))).status, 403);
  const d = await teacher(grantA, 'Mac returned');
  await d.command('take-control'); await d.command('correction', { enabled: true });
  assert.equal((await req('/logout?channel=' + channel, { method: 'POST' }, grantA)).status, 200);
  await waitFor(() => q.state().active === false, 'logout');
  assert.equal(q.state().correction, false);
  assert.equal((await req(correctionUrl('3/01'))).status, 403);
  for (const state of q.messages) for (const field of ['display', 'documents', 'controller', 'devices', 'grant', 'authNonce']) assert.equal(field in state, false);
  q.socket.close(); p.socket.close();
  console.log('PASS 50 private correction PDFs, controller authorization, per-channel isolation, hide/read race, tools compatibility, link reset, reconnect, expiry and logout');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => mf.dispose());
