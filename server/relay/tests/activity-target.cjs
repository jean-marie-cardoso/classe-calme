const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { WebSocket } = require('ws');

const relayDirectory = path.resolve(__dirname, '..');
const origin = 'https://jean-marie-cardoso.github.io';
const channel = 'test-activity-target-local';
const password = 'Activity targeting local fixture only';
const salt = crypto.randomBytes(16).toString('hex');
const passwordHash = 'pbkdf2-sha256:100000:' + salt + ':'
  + crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
const catalogSource = fs.readFileSync(path.join(relayDirectory, 'src/corrections-catalog.js'), 'utf8');
let script = fs.readFileSync(path.join(relayDirectory, 'src/index.js'), 'utf8')
  .replace("import { CORRECTIONS } from './corrections-catalog.js';", catalogSource.replace('export const CORRECTIONS', 'const CORRECTIONS'))
  .replace('export default {', 'const app = {')
  .replace('  async alarm() {', `  async targetTest(action) {
    if (action === 'drop') {
      const room = this.remote(); delete room.targetActivity; this.saveRoom(room); this.broadcastRemote();
    } else if (action === 'reload') { this.tableCache.clear(); this.broadcastRemote(); }
    else if (action === 'expire') {
      this.sql('UPDATE remote_devices SET expiresAt=?', Date.now()-1);
      for (const socket of this.ctx.getWebSockets()) { const info = this.attachment(socket); if (info?.role === 'teacher') socket.serializeAttachment({ ...info, lastSeenAt: Date.now()-35001 }); }
      await this.alarm();
    }
  }
  async alarm() {`);
script += `\nexport default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/__test') { await env.CLASSROOM.getByName('${channel}').targetTest(url.searchParams.get('action')); return new Response('ok'); }
  return app.fetch(request, env);
} };`;

let assetReads = 0, heldAsset = null;
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'activity-target-test', modules: true, script,
  compatibilityDate: '2026-10-17', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { CLASSROOM: { className: 'ClassroomRelay', useSQLite: true } },
  bindings: { STUDENT_ORIGIN: origin, TEACHER_PASSWORD_HASH: passwordHash, TEACHER_AUTH_SECRET: crypto.randomBytes(32).toString('hex') },
  serviceBindings: { CORRECTIONS: async request => {
    assetReads++;
    const held = heldAsset;
    if (held) { heldAsset = null; held.started(); await held.wait; }
    const filename = path.join(relayDirectory, 'correction-assets', new URL(request.url).pathname);
    return new Response(fs.readFileSync(filename), { headers: { 'content-type': 'application/pdf' } });
  } },
}));
const peers = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, label) {
  const until = Date.now() + 7000;
  while (Date.now() < until) { const value = predicate(); if (value) return value; await pause(10); }
  throw new Error('Timed out: ' + label);
}
function endpoint(pathname, selectedChannel = channel) {
  return pathname + (pathname.includes('?') ? '&' : '?') + 'channel=' + selectedChannel;
}
async function req(pathname, options = {}, grant, selectedChannel = channel) {
  return mf.dispatchFetch('https://relay.example' + endpoint(pathname, selectedChannel), {
    ...options, headers: { origin, ...(grant ? { authorization: 'Bearer ' + grant } : {}), ...options.headers },
  });
}
async function login(selectedChannel = channel) {
  const response = await req('/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.43' }, body: JSON.stringify({ password }) }, null, selectedChannel);
  assert.equal(response.status, 200);
  return (await response.json()).grant;
}
async function teacher(grant, label) {
  const id = crypto.randomUUID();
  const url = new URL(await mf.ready);
  url.protocol = 'ws:'; url.pathname = '/teacher';
  url.search = new URLSearchParams({ channel, deviceId: id, label });
  const socket = new WebSocket(url, ['classe-calme', grant], { headers: { origin } });
  const peer = { id, socket, messages: [] };
  peers.push(peer);
  socket.on('message', bytes => peer.messages.push(JSON.parse(bytes)));
  peer.state = () => peer.messages.findLast(message => message.type === 'remote');
  peer.command = async (action, data = {}) => {
    const requestId = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'command', requestId, action, ...data }));
    return waitFor(() => peer.messages.find(message => message.type === 'ack' && message.requestId === requestId), action);
  };
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await waitFor(peer.state, label + ' initial state');
  return peer;
}
async function pupil(activity, selectedChannel = channel) {
  const response = await req('/live?activity=' + encodeURIComponent(activity), { headers: { upgrade: 'websocket' } }, null, selectedChannel);
  assert.equal(response.status, 101);
  const peer = { socket: response.webSocket, messages: [] };
  peers.push(peer);
  peer.socket.addEventListener('message', event => peer.messages.push(JSON.parse(event.data)));
  peer.socket.accept();
  peer.state = () => peer.messages.at(-1);
  await waitFor(peer.state, activity + ' pupil initial state');
  return peer;
}
function neutral(peer, label) {
  const state = peer.state();
  assert.equal(state.active, false, label);
  assert.equal(state.alarm, false, label);
  assert.equal(state.correction, false, label);
  assert.equal(state.notice, null, label);
  assert.equal(state.timer, null, label);
  assert.equal(state.remainingMs, 0, label);
  assert.notEqual(state.message, 'MESSAGE RÉSERVÉ AU COURS', label);
  for (const key of ['display', 'documents', 'controller', 'devices', 'targetActivity', 'grant']) assert.equal(key in state, false, label);
}
function allNeutral(peer, label) {
  for (const state of peer.messages) neutral({ state: () => state }, label);
}
const correction = activity => req('/correction?activity=' + encodeURIComponent(activity));

(async () => {
  const p = await pupil('5/07'), q = await pupil('5/08'), r = await pupil('3/01'), unknown = await pupil('autre');
  for (const peer of [p, q, r, unknown]) neutral(peer, 'no teacher');
  const grant = await login();
  const a = await teacher(grant, 'Mac'), b = await teacher(grant, 'PC');
  assert.equal(a.state().targetActivity, null);
  assert.equal(a.state().viewers, 0);
  assert.equal(a.state().totalViewers, 4);
  assert.equal(a.state().activities.length, 4);
  assert.equal((await a.command('correction', { enabled: true })).error, 'activity_required');
  assert.equal((await b.command('activity', { activity: '5/07' })).error, 'controller_required');
  for (const invalid of ['5', '5/99', '5/07/', '__proto__', 'constructor', 'bonus/5-99', [], false]) {
    assert.equal((await a.command('activity', { activity: invalid })).error, 'invalid_activity');
  }
  assert.equal(a.state().targetActivity, null);
  for (const id of ['projets/5','projets/4','projets/3','exposes/5','exposes/4','exposes/3']) {
    const guide = await pupil(id);
    assert.equal((await a.command('activity', {activity:id})).ok, true);
    await waitFor(() => guide.state().active === true, 'guide active ' + id);
    for (const other of [p,q,r,unknown]) neutral(other, 'guide excludes other activities');
    assert.equal((await a.command('correction', {enabled:true})).error, 'correction_unavailable');
    assert.equal((await correction(id)).status,404);
    assert.equal((await a.command('activity', {activity:null})).ok,true);
    await waitFor(() => guide.state().active === false, 'guide stopped');
    guide.socket.close();
    await pause(250); // Stay below the real command rate limit.
  }
  await waitFor(() => a.state().totalViewers === 4, 'guide test cleanup');
  const tools = { ...a.state().tools, message: 'MESSAGE RÉSERVÉ AU COURS',
    notice: { text: 'CONSIGNE PRIVÉE', until: Date.now() + 60000 }, timer: { state: 'running', until: Date.now() + 120000 } };
  await a.command('tools', { tools });
  await a.command('microphone', { enabled: true });
  await a.command('noise', { noise: { level: 0, alarm: true } });
  for (const peer of [p, q, r, unknown]) neutral(peer, 'no selected activity');
  assert.equal((await correction('5/07')).status, 403);
  assert.equal(assetReads, 0);

  assert.equal((await a.command('activity', { activity: '5/07' })).ok, true);
  await waitFor(() => p.state().active === true && b.state().targetActivity === '5/07', 'activity mirrored');
  assert.equal(a.state().viewers, 1);
  assert.equal(a.state().totalViewers, 4);
  assert.equal(a.state().tools.notice, null);
  assert.equal(a.state().tools.timer, null);
  assert.equal(a.state().correction, false);
  assert.equal(a.state().noise.alarm, true, 'teacher projection alert remains active');
  assert.equal(p.state().alarm, true);
  for (const peer of [q, r, unknown]) neutral(peer, 'other activity');
  assert.equal((await correction('5/08')).status, 403, 'same grade is insufficient');
  assert.equal((await correction('3/01')).status, 403);
  await a.command('tools', { tools });
  await a.command('correction', { enabled: true });
  await waitFor(() => p.state().correction && p.state().timer && p.state().notice, 'target receives course tools');
  for (const peer of [q, r, unknown]) neutral(peer, 'tools only reach target');
  assert.equal((await correction('5/07')).status, 200);
  assert.equal((await correction('5/08')).status, 403);
  const lateSelected = await pupil('5/07'), lateOther = await pupil('5/08');
  assert.equal(lateSelected.messages[0].active, true);
  assert.equal(lateSelected.messages[0].correction, true);
  neutral(lateOther, 'late other activity');
  assert.equal(a.state().viewers, 2);
  for (const peer of [q, lateOther, r, unknown]) allNeutral(peer, 'every outbound frame outside the current activity is neutral');

  // Re-selecting the same activity preserves its timer and active correction.
  await a.command('activity', { activity: '5/07' });
  assert.equal(a.state().correction, true);
  assert(a.state().tools.timer);

  let resume, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  heldAsset = { started: notifyStarted, wait: new Promise(resolve => { resume = resolve; }) };
  const pendingPdf = correction('5/07');
  await started;
  await a.command('activity', { activity: '5/08' });
  await waitFor(() => p.state().active === false && q.state().active === true, 'switch target exactly');
  resume();
  assert.equal((await pendingPdf).status, 403, 'target switch wins over in-flight PDF read');
  assert.equal(q.state().correction, false);
  assert.equal(q.state().notice, null);
  assert.equal(q.state().timer, null);
  assert.equal(q.state().alarm, true, 'current microphone alert reaches new target');
  assert.equal(b.state().targetActivity, '5/08');
  assert.equal(a.state().viewers, 2);
  assert.equal(a.state().totalViewers, 6);
  for (const peer of [p, lateSelected, r, unknown]) neutral(peer, 'former target reset');
  assert.equal((await correction('5/07')).status, 403);
  assert.equal((await correction('5/08')).status, 403, 'new target correction starts hidden');
  await a.command('correction', { enabled: true });
  assert.equal((await correction('5/08')).status, 200);
  await req('/__test?action=reload');
  assert.equal(b.state().targetActivity, '5/08', 'selection is recovered from persistent storage');
  assert.equal((await correction('5/08')).status, 200);

  await req('/__test?action=drop');
  await waitFor(() => q.state().active === false && b.state().targetActivity === null, 'old room without target fails closed');
  assert.equal(b.state().correction, false);
  assert.equal((await correction('5/08')).status, 403);
  await a.command('activity', { activity: 'bonus/4-01' });
  const bonus = await pupil('bonus/4-01');
  assert.equal(bonus.state().active, true);
  await a.command('correction', { enabled: true });
  assert.equal((await correction('bonus/4-01')).status, 200);
  await a.command('activity', { activity: null });
  await waitFor(() => bonus.state().active === false, 'deselect stops all activities');
  for (const peer of [p, q, r, unknown, bonus]) neutral(peer, 'no target');
  assert.equal(a.state().viewers, 0);
  await a.command('activity', { activity: '3/01' });
  await a.command('correction', { enabled: true });
  assert.equal((await correction('3/01')).status, 200);
  await req('/__test?action=expire');
  await waitFor(() => r.state().active === false, 'lease expiry clears target activity display');
  assert.equal((await correction('3/01')).status, 403);

  const legacyChannel = 'test-activity-legacy-local';
  const legacyPupil = await pupil('5/07', legacyChannel);
  const legacyGrant = await login(legacyChannel);
  const claimed = await req('/publish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'claim', sessionId: crypto.randomUUID(), alarm: true, mode: 'cover', pulse: true, message: 'MESSAGE RÉSERVÉ AU COURS',
      targetActivity: '5/07', correction: true, notice: { text: 'CONSIGNE PRIVÉE', until: Date.now() + 60000 }, timer: { state: 'running', until: Date.now() + 120000 } }) }, legacyGrant, legacyChannel);
  assert.equal(claimed.status, 200);
  await pause(30);
  neutral(legacyPupil, 'legacy publisher cannot broadcast to all activities');
  const legacyLate = await pupil('5/07', legacyChannel);
  neutral(legacyLate, 'legacy initial state also remains neutral');
  for (const peer of [p, q, r, unknown, lateSelected, lateOther, bonus, legacyPupil, legacyLate]) {
    for (const state of peer.messages) if (!state.active) neutral({ state: () => state }, 'inactive outbound payload never contains course tools');
  }
  console.log('PASS exact activity targeting, neutral other activities, controllers, counts, initial connections, private corrections, PDF switch race, persisted selection, legacy fail-closed and TTL');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const peer of peers) try { peer.socket.close(); } catch {}
  await mf.dispose();
});
