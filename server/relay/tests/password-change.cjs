const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { WebSocket } = require('ws');

// Every credential, namespace and directory in this test is local and disposable.
const origin = 'https://jean-marie-cardoso.github.io';
const channel = 'test-password-local';
const otherChannel = 'test-password-other';
const initialPassword = 'Initial local password only';
const nextPassword = 'New local password only';
const thirdPassword = 'Third local password only';
const salt = crypto.randomBytes(16).toString('hex');
const initialHash = 'pbkdf2-sha256:100000:' + salt + ':' + crypto.pbkdf2Sync(initialPassword, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'classe-calme-password-test-'));
let source = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8')
  .replace("import { CORRECTIONS } from './corrections-catalog.js';", "const CORRECTIONS = { '5/07': { file: '/5/07.pdf' } };")
  .replace('export default {', 'const app = {')
  .replace('if (!this.sameCredential(config)) return', "await this.env.TEST_GATE.fetch('https://gate/login');\n    if (!this.sameCredential(config)) return")
  .replace('const hash = hexString(await passwordBits(newPassword, salt));', "const hash = hexString(await passwordBits(newPassword, salt));\n    await this.env.TEST_GATE.fetch('https://gate/change');")
  .replace('async revokeTeacher(nonce, expiresAt, passwordChanged = false) {', `async revokeTeacher(nonce, expiresAt, passwordChanged = false) {
    if (passwordChanged && !(await this.env.TEST_GATE.fetch('https://gate/revoke')).ok) throw new Error('Local injected revocation failure');`)
  .replace('  async alarm() {', `  async passwordTest(action) {
    if (action === 'clear-attempts') this.sql('DELETE FROM auth_attempts');
    if (action === 'retry') await this.alarm();
    return {
      revision: this.credential()?.revision,
      pending: this.sql('SELECT COUNT(*) AS n FROM auth_revocations').one().n,
      sessions: this.sql('SELECT COUNT(*) AS n FROM auth_sessions').one().n,
      credentialRows: this.sql('SELECT COUNT(*) AS n FROM auth_credentials').one().n,
      storedOnlyHash: this.sql('SELECT salt,hash FROM auth_credentials').toArray().every(row => /^[a-f0-9]{32}$/.test(row.salt) && /^[a-f0-9]{64}$/.test(row.hash))
    };
  }
  async alarm() {`);
source += `\nexport default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/__test') return Response.json(await env.CLASSROOM.getByName('teacher-auth').passwordTest(url.searchParams.get('action')));
  return app.fetch(request, env);
} };`;

let held = null, rejectRevocation = false;
const options = () => ({ ...convertV4MiniflareOptions({
  name: 'password-change-local', modules: true, script: source,
  compatibilityDate: '2026-10-17', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { CLASSROOM: { className: 'ClassroomRelay', useSQLite: true } },
  bindings: { STUDENT_ORIGIN: origin, TEACHER_PASSWORD_HASH: initialHash, TEACHER_AUTH_SECRET: 'local-signing-secret-never-a-real-password' },
  serviceBindings: { TEST_GATE: async request => {
    const route = new URL(request.url).pathname;
    if (route === '/revoke' && rejectRevocation) return new Response('retry', { status: 503 });
    if (held?.route === route) { const gate = held; held = null; gate.started(); await gate.wait; }
    return new Response('ok');
  } },
}), resourcePersistencePath: persist });
let mf = new Miniflare(options());
const peers = [];
const gates = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await pause(10); }
  throw new Error('Timeout: ' + label);
}
function hold(route) {
  let release, started;
  const wait = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  held = { route, wait, started };
  gates.push(release);
  return { release, began };
}
async function request(route, { grant, selectedChannel = channel, ip = '192.0.2.35', headers = {}, ...options } = {}) {
  return mf.dispatchFetch('https://relay.example' + route + (route.includes('?') ? '&' : '?') + 'channel=' + selectedChannel, {
    ...options, headers: { origin, 'cf-connecting-ip': ip, ...(grant ? { authorization: 'Bearer ' + grant } : {}), ...headers },
  });
}
const post = (route, body, opts = {}) => request(route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...opts.headers }, ...opts });
async function login(password = initialPassword, selectedChannel = channel, ip) {
  const response = await post('/login', { password }, { selectedChannel, ip });
  const body = await response.json();
  return { status: response.status, grant: body.grant, body };
}
async function info(action = '') { return (await mf.dispatchFetch('https://relay.example/__test?action=' + action)).json(); }
async function teacher(grant, selectedChannel = channel) {
  const url = new URL(await mf.ready);
  url.protocol = 'ws:'; url.pathname = '/teacher';
  url.search = new URLSearchParams({ channel: selectedChannel, deviceId: crypto.randomUUID(), label: 'Test' });
  const socket = new WebSocket(url, ['classe-calme', grant], { headers: { origin } });
  const peer = { socket, messages: [], closed: false };
  peers.push(peer);
  socket.on('message', bytes => peer.messages.push(JSON.parse(bytes)));
  socket.on('close', () => { peer.closed = true; });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await until(() => peer.messages.length, 'teacher connected');
  peer.command = async (action, data = {}) => {
    const requestId = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'command', requestId, action, ...data }));
    return until(() => peer.messages.find(message => message.type === 'ack' && message.requestId === requestId), action);
  };
  return peer;
}
async function change(grant, currentPassword = initialPassword, newPassword = nextPassword, opts = {}) {
  const response = await post('/password', { currentPassword, newPassword }, { grant, ...opts });
  const body = await response.json();
  return { status: response.status, body, response };
}
async function expectError(result, status, error) { assert.equal(result.status, status); assert.equal(result.body.error, error); }

(async () => {
  const a = await login(), b = await login(initialPassword, otherChannel);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const first = await teacher(a.grant), second = await teacher(b.grant, otherChannel);
  assert.equal((await first.command('activity', { activity: '5/07' })).ok, true);
  assert.equal((await first.command('tools', { tools: { message: 'LOCAL PRIVATE', preferences: { threshold: 12, delay: 3, mode: 'cover', pulse: true }, notice: { text: 'LOCAL NOTICE', until: Date.now() + 60000 }, timer: { state: 'running', until: Date.now() + 60000 } } })).ok, true);
  const pupilResponse = await request('/live?activity=5%2F07', { headers: { upgrade: 'websocket' } });
  const pupil = pupilResponse.webSocket;
  const pupilMessages = []; pupil.addEventListener('message', event => pupilMessages.push(JSON.parse(event.data)));
  pupil.accept();
  await until(() => pupilMessages.some(message => message.active === true), 'pupil starts active');

  await expectError(await change(null), 401, 'unauthorized');
  await expectError(await change(a.grant, initialPassword, nextPassword, { headers: { origin: 'https://elsewhere.example' } }), 403, 'origin');
  const noOrigin = await mf.dispatchFetch('https://relay.example/password?channel=' + channel, { method: 'POST', headers: { authorization: 'Bearer ' + a.grant, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: initialPassword, newPassword: nextPassword }) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await request('/password', { method: 'OPTIONS' })).status, 204);
  assert.equal((await request('/password', { method: 'GET' })).status, 405);
  assert.equal((await post('/password', { newPassword: nextPassword }, { grant: a.grant })).status, 400);
  assert.equal((await request('/password', { method: 'POST', grant: a.grant, body: '{' })).status, 400);
  await expectError(await change(a.grant, initialPassword, 'short'), 400, 'weak_password');
  await expectError(await change(a.grant, initialPassword, 'x'.repeat(257)), 400, 'weak_password');
  await expectError(await change(a.grant, 'wrong password'), 403, 'current_password');
  await expectError(await change(a.grant, initialPassword, initialPassword), 400, 'same_password');
  assert.equal((await info()).revision, 0);
  assert.equal(first.closed, false, 'failed changes leave devices connected');

  await info('clear-attempts');
  const stale = hold('/login');
  const staleLogin = login(initialPassword, channel, '192.0.2.36');
  await stale.began;
  const rotated = await change(a.grant);
  assert.equal(rotated.status, 200); assert.deepEqual(rotated.body, { ok: true });
  stale.release();
  assert.equal((await staleLogin).status, 401, 'login begun with old password cannot mint a post-rotation session');
  await until(() => first.socket.readyState >= 2 && second.socket.readyState >= 2, 'all channels closing');
  await until(() => pupilMessages.some(message => message.active === false), 'pupil effects cleared');
  const metadata = await info();
  assert.equal(metadata.revision, 1); assert.equal(metadata.sessions, 0); assert.equal(metadata.pending, 0); assert.equal(metadata.credentialRows, 1); assert.equal(metadata.storedOnlyHash, true);
  await expectError(await change(a.grant), 401, 'unauthorized');
  assert.equal((await request('/files', { grant: b.grant, selectedChannel: otherChannel })).status, 401);
  assert.equal((await login()).status, 401, 'old password rejected');
  assert.equal((await login(nextPassword)).status, 200, 'new password accepted');
  pupil.close();

  // Recreate the worker using its same SQLite directory: no in-memory password.
  await mf.dispose();
  mf = new Miniflare(options());
  assert.equal((await info()).revision, 1);
  assert.equal((await login()).status, 401);
  const afterRestart = await login(nextPassword);
  assert.equal(afterRestart.status, 200);
  await info('clear-attempts');

  // A logout while PBKDF2 is running wins over a pending password change.
  const waiting = hold('/change');
  const cancelled = change(afterRestart.grant, nextPassword, thirdPassword);
  await waiting.began;
  assert.equal((await post('/logout', {}, { grant: afterRestart.grant })).status, 200);
  waiting.release();
  await expectError(await cancelled, 401, 'unauthorized');
  assert.equal((await info()).revision, 1);

  // Two simultaneous changes based on the same old credential cannot both win.
  const c = await login(nextPassword), d = await login(nextPassword, otherChannel);
  const results = await Promise.all([change(c.grant, nextPassword, thirdPassword), change(d.grant, nextPassword, 'Concurrent different password only', { selectedChannel: otherChannel })]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 401]);
  const winner = results[0].status === 200 ? thirdPassword : 'Concurrent different password only';
  assert.equal((await info()).revision, 2);
  await info('clear-attempts');
  const e = await login(winner);
  const heldTeacher = await teacher(e.grant);

  // Persist revocations before their RPC. An interrupted room is retried.
  rejectRevocation = true;
  assert.equal((await change(e.grant, winner, 'Final local password only')).status, 200);
  assert((await info()).pending > 0);
  assert.equal((await request('/files', { grant: e.grant })).status, 401, 'grant globally invalid even if a room RPC failed');
  rejectRevocation = false;
  await info('retry');
  await until(() => heldTeacher.socket.readyState >= 2, 'retried room revocation');
  assert.equal((await info()).pending, 0);
  await info('clear-attempts');
  const f = await login('Final local password only');
  assert.equal(f.status, 200);
  for (let index = 0; index < 7; index++) await expectError(await change(f.grant, 'wrong current password'), 403, 'current_password');
  const limited = await change(f.grant, 'wrong current password');
  await expectError(limited, 429, 'too_many_attempts');
  assert(Number(limited.response.headers.get('retry-after')) > 0);
  console.log('PASS password-change: validation, persistence, all-device revocation, rate limits, concurrency and retry');
})().catch(async error => { console.error(error); console.error('Local fixture status', await info(), peers.map(peer => ({ closed: peer.closed, readyState: peer.socket.readyState }))); process.exitCode = 1; }).finally(async () => {
  for (const release of gates) release();
  for (const peer of peers) try { peer.socket.terminate(); } catch {}
  await mf.dispose();
  fs.rmSync(persist, { recursive: true, force: true });
});
