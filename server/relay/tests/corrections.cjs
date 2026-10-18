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
async function login(ip, targetChannel = channel) {
  const response = await req('/login?channel=' + targetChannel, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ password }) });
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
    await pause(40); // Keep the real command rate below the server limit.
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
  const p = await pupil('5/07'), twin = await pupil('5/07'), q = await pupil('3/01');
  const other = await pupil('5/08'), home = await pupil('accueil');
  const neutral = peer => {
    const state = peer.state();
    assert.equal(state.active, false);
    assert.equal(state.alarm, false);
    assert.equal(state.notice, null);
    assert.equal(state.timer, null);
    assert.equal(state.correction, false);
    assert.equal(state.message, 'MOINS DE BRUIT, MERCI.');
    assert.equal(JSON.stringify(state).includes('PRIVE_5S07'), false);
  };
  assert.equal(a.state().targetActivity, null);
  for (const peer of [p, twin, q, other, home]) neutral(peer);
  assert.equal((await b.command('activity', { activity: '5/07' })).error, 'controller_required');
  for (const activity of ['3/99', 'constructor', '../5/07', '5/07/', '', 507, {}]) {
    assert.equal((await a.command('activity', { activity })).error, 'invalid_activity');
  }
  assert.equal((await a.command('correction', { enabled: true })).error, 'activity_required');
  const attacker = await pupil('5/08');
  attacker.socket.send(JSON.stringify({ type: 'command', requestId: crypto.randomUUID(), action: 'activity', activity: '5/07' }));
  await pause(30);
  assert.equal(a.state().targetActivity, null, 'a pupil cannot choose the activity');
  assert.equal((await a.command('activity', { activity: '5/07' })).ok, true);
  await waitFor(() => p.state().active && twin.state().active && b.state().targetActivity === '5/07', 'selected activity reaches pupils and follower');
  await waitFor(() => a.state().viewers === 2, 'only selected activity contributes to the current viewer count');
  assert.equal(a.state().totalViewers, 5);
  const tools = { ...a.state().tools, message: 'PRIVE_5S07_ALERTE',
    notice: { text: 'PRIVE_5S07_CONSIGNE', until: Date.now() + 60000 },
    timer: { state: 'running', until: Date.now() + 60000 } };
  assert.equal((await a.command('tools', { tools })).ok, true);
  await a.command('microphone', { enabled: true });
  await a.command('noise', { noise: { level: 0, alarm: true } });
  assert.equal((await b.command('correction', { enabled: true })).error, 'controller_required');
  assert.equal((await a.command('correction', { enabled: 'true' })).error, 'invalid_correction');
  assert.equal((await a.command('correction', { enabled: true })).ok, true);
  await waitFor(() => p.state().correction && twin.state().correction && p.state().notice?.text === 'PRIVE_5S07_CONSIGNE' && p.state().timer?.state === 'running', 'tools and correction reach the selected activity');
  assert.equal(p.state().alarm, true);
  for (const peer of [q, other, home]) neutral(peer);
  assert.equal((await req(correctionUrl('5/07'))).status, 200);
  for (const activity of ['3/01', '5/08']) assert.equal((await req(correctionUrl(activity))).status, 403);
  assert.equal((await req('/correction?activity=5/07')).status, 403, 'test channel must not enable real class');
  assert.equal((await a.command('tools', { tools: a.state().tools })).ok, true);
  assert.equal(a.state().correction, true, 'unchanged tools must not close correction');

  // Recheck the exact target after the asynchronous asset read.
  let resume, started;
  heldAsset = { wait: new Promise(resolve => { resume = resolve; }), started: () => started() };
  const fetching = new Promise(resolve => { started = resolve; });
  const delayedTarget = req(correctionUrl('5/07'));
  await fetching;
  assert.equal((await a.command('activity', { activity: '3/01' })).ok, true);
  resume();
  assert.equal((await delayedTarget).status, 403, 'changing target must win over an in-flight PDF read');
  await waitFor(() => !p.state().active && q.state().active, 'target switch immediately deactivates old activity');
  neutral(p); neutral(twin); neutral(other); neutral(home);
  assert.equal(q.state().alarm, true, 'the current alarm follows the selected activity');
  assert.equal(q.state().notice, null);
  assert.equal(q.state().timer, null);
  assert.equal(q.state().correction, false);
  assert.equal(b.state().targetActivity, '3/01');
  assert.equal(b.state().tools.notice, null);
  assert.equal(b.state().tools.timer, null);
  assert.equal((await req(correctionUrl('5/07'))).status, 403);

  await a.command('activity', { activity: null });
  await waitFor(() => !q.state().active, 'no selected activity means no broadcast');
  for (const peer of [p, twin, q, other, home]) neutral(peer);
  assert.equal((await a.command('correction', { enabled: true })).error, 'activity_required');
  for (const id of Object.keys(catalog)) assert.equal((await req(correctionUrl(id))).status, 403);

  // Every correction remains exact, and each release only authorizes one route.
  for (const [id, entry] of Object.entries(catalog)) {
    assert.equal((await a.command('activity', { activity: id })).ok, true);
    assert.equal((await a.command('correction', { enabled: true })).ok, true);
    const response = await req(correctionUrl(id));
    assert.equal(response.status, 200, id);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, entry.size);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    const wrong = id === '5/07' ? '3/01' : '5/07';
    assert.equal((await req(correctionUrl(wrong))).status, 403, 'another activity must remain closed');
  }
  await a.command('activity', { activity: '5/07' });
  await a.command('correction', { enabled: true });
  assetFailure = true;
  assert.equal((await req(correctionUrl('5/07'))).status, 503); assetFailure = false;

  heldAsset = { wait: new Promise(resolve => { resume = resolve; }), started: () => started() };
  const hiding = new Promise(resolve => { started = resolve; });
  const delayedHide = req(correctionUrl('5/07'));
  await hiding;
  await a.command('correction', { enabled: false });
  resume();
  assert.equal((await delayedHide).status, 403, 'hide must win over a pending asset read');
  await waitFor(() => !p.state().correction, 'hide reaches selected pupils');
  await a.command('correction', { enabled: true });
  await a.command('link', { enabled: false });
  assert.equal(a.state().correction, false);
  assert.equal((await req(correctionUrl('5/07'))).status, 403);
  assert.equal((await a.command('correction', { enabled: true })).error, 'activities_disabled');
  await a.command('link', { enabled: true });
  assert.equal(a.state().correction, false, 'relink must not reopen an old correction');
  await a.command('correction', { enabled: true });
  a.socket.close();
  await waitFor(() => b.state().devices.length === 1, 'controller leaves');
  assert.equal(b.state().correction, true, 'the remaining authenticated teacher keeps the selected release');
  await b.command('take-control');
  await b.command('correction', { enabled: false });
  await b.command('correction', { enabled: true });
  b.socket.close();
  await waitFor(() => !p.state().active, 'last teacher leaves');
  assert.equal(p.state().correction, false);

  const c = await teacher(grantB, 'PC reconnected');
  assert.equal(c.state().targetActivity, '5/07', 'authenticated room reconnect preserves the chosen route while keeping correction hidden');
  assert.equal(c.state().correction, false);
  await c.command('take-control'); await c.command('activity', { activity: '5/07' }); await c.command('correction', { enabled: true });
  assert.equal((await req('/__test/expire')).status, 200);
  await waitFor(() => !p.state().active, 'expired teacher');
  assert.equal(p.state().correction, false);
  assert.equal((await req(correctionUrl('5/07'))).status, 403);
  const d = await teacher(grantA, 'Mac returned');
  await d.command('take-control'); await d.command('activity', { activity: '5/07' }); await d.command('correction', { enabled: true });
  assert.equal((await req('/logout?channel=' + channel, { method: 'POST' }, grantA)).status, 200);
  await waitFor(() => !p.state().active, 'logout');
  assert.equal((await req(correctionUrl('5/07'))).status, 403);

  // Old publishing clients have no selected activity and must fail closed.
  const legacyChannel = 'test-legacy-target-isolation';
  const legacyGrant = await login('192.0.2.43', legacyChannel);
  const legacyPupil = await req('/live?channel=' + legacyChannel + '&activity=5%2F07', { headers: { upgrade: 'websocket' } });
  const legacyStates = [];
  legacyPupil.webSocket.addEventListener('message', event => legacyStates.push(JSON.parse(event.data))); legacyPupil.webSocket.accept();
  await req('/publish?channel=' + legacyChannel, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    action: 'claim', sessionId: crypto.randomUUID(), alarm: true, mode: 'cover', pulse: true, message: 'PRIVE_5S07_LEGACY',
    notice: { text: 'PRIVE_5S07_LEGACY', until: Date.now() + 60000 }, timer: { state: 'running', until: Date.now() + 60000 }
  }) }, legacyGrant);
  await pause(30);
  assert.ok(legacyStates.length);
  for (const state of legacyStates) { assert.equal(state.active, false); assert.equal(JSON.stringify(state).includes('PRIVE_5S07'), false); }
  legacyPupil.webSocket.close();
  for (const peer of [p, twin, q, other, home]) {
    for (const state of peer.messages) for (const field of ['display', 'documents', 'controller', 'devices', 'grant', 'authNonce']) assert.equal(field in state, false);
    peer.socket.close();
  }
  console.log('PASS exact activity selection, neutral off-target pupils, 50 gated PDFs, controller authorization, target/hide read races, legacy fail-closed, link reset, reconnect, expiry and logout');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => mf.dispose());
