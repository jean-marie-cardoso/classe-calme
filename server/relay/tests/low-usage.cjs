const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

// Exercise the real relay against SQLite while advancing the clock six hours.
// No network, classroom channel, production grant, or real pupil is involved.
const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';", '')
  .replace("import { CORRECTIONS } from './corrections-catalog.js';", '')
  .replace('export default {', 'const app = {')
  .replace('export class ClassroomRelay', 'class ClassroomRelay');
const start = 1800000000000;
const copy = value => structuredClone(value);

function fixture() {
  let clock = start;
  class Clock extends Date { static now() { return clock; } }
  const { ClassroomRelay, defaultRoom } = vm.runInNewContext(source + '\n({ ClassroomRelay, defaultRoom });', {
    DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
    CORRECTIONS: { '3/01': { file: '/3/01.pdf' } }, Date: Clock,
    TextEncoder, TextDecoder, Request, Response, ReadableStream, URL, Headers,
    atob, btoa, crypto: crypto.webcrypto,
  });
  const database = new DatabaseSync(':memory:');
  const counts = { queries: 0, rowsRead: 0, sqlRowsWritten: 0, alarmRowsWritten: 0 };
  let alarmAt = null;
  const sockets = [];
  const ctx = {
    getWebSockets: () => sockets.filter(socket => socket.readyState === 1),
    storage: {
      sql: { exec(statement, ...bindings) {
        counts.queries++;
        const prepared = database.prepare(statement);
        bindings = bindings.map(value => Object.prototype.toString.call(value) === '[object ArrayBuffer]' ? new Uint8Array(value) : value);
        let rows = [];
        if (/^SELECT\b/i.test(statement)) {
          rows = prepared.all(...bindings);
          counts.rowsRead += rows.length;
        } else {
          const result = prepared.run(...bindings);
          if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(statement)) counts.sqlRowsWritten += Number(result.changes);
        }
        return { toArray: () => rows.map(row => ({ ...row })), one() { assert.equal(rows.length, 1); return { ...rows[0] }; } };
      } },
      async getAlarm() { counts.rowsRead++; return alarmAt; },
      async setAlarm(value) { counts.alarmRowsWritten++; alarmAt = value; },
      async deleteAlarm() { counts.alarmRowsWritten++; alarmAt = null; },
    },
  };
  const env = { CORRECTIONS: { async fetch() { return new Response('%PDF-fixture'); } } };
  let relay = new ClassroomRelay(ctx, env);
  function socket(role, metadata = {}) {
    let attachment = { role, ...metadata };
    const peer = { readyState: 1, messages: [],
      deserializeAttachment() { return copy(attachment); },
      serializeAttachment(value) { attachment = copy(value); },
      send(value) { this.messages.push(JSON.parse(value)); },
      close() { this.readyState = 3; },
    };
    sockets.push(peer);
    return peer;
  }
  function teacher(label) {
    const deviceId = crypto.randomUUID(), connectionId = crypto.randomUUID(), authNonce = crypto.randomUUID();
    const authExpires = start + 8 * 3600000;
    relay.sql('INSERT INTO remote_devices(deviceId,label,nonce,authExpires,expiresAt,connectionId) VALUES(?,?,?,?,?,?)', deviceId, label, authNonce, authExpires, clock + 35000, connectionId);
    const peer = socket('teacher', { deviceId, connectionId, authNonce, authExpires, label, lastSeenAt: clock });
    const room = relay.remote() || defaultRoom(clock);
    if (!room.controller) room.controller = { deviceId, label };
    relay.saveRoom(room);
    peer.id = deviceId; peer.nonce = authNonce;
    return peer;
  }
  async function message(peer, body) {
    await relay.webSocketMessage(peer, JSON.stringify(body));
    if (body.type === 'command') {
      const acknowledgement = peer.messages.findLast(value => value.type === 'ack' && value.requestId === body.requestId);
      assert(acknowledgement, 'command must be acknowledged');
      return acknowledgement;
    }
  }
  async function command(peer, action, data = {}) {
    return message(peer, { type: 'command', requestId: crypto.randomUUID(), action, ...data });
  }
  async function advance(value) {
    clock = value;
    if (alarmAt !== null && alarmAt <= clock) { alarmAt = null; await relay.alarm(); }
  }
  return {
    counts, ctx, teacher, command, message, advance, socket,
    get relay() { return relay; },
    get alarmAt() { return alarmAt; },
    setClock(value) { clock = value; },
    wake() { relay = new ClassroomRelay(ctx, env); },
    close() { database.close(); },
  };
}

async function regressions() {
  const f = fixture();
  try {
    const a = f.teacher('Mac'), b = f.teacher('PC');
    const pupil = f.socket('pupil', { activity: '3/01' });
    assert.equal((await f.command(b, 'correction', { enabled: true })).error, 'controller_required');
    assert.equal((await f.command(a, 'correction', { enabled: true })).ok, true);
    const correction = () => f.relay.correctionRequest(new Request('https://example/correction?activity=3/01'));
    assert.equal((await correction()).status, 200);
    await f.command(a, 'microphone', { enabled: true });
    const revision = f.relay.remote().revision;
    const writes = f.counts.sqlRowsWritten;
    const alarmWrites = f.counts.alarmRowsWritten;
    await f.command(a, 'noise', { noise: { level: 87, alarm: false } });
    assert.equal(f.relay.remote().revision, revision, 'old numeric levels must not change shared state');
    assert.equal(f.counts.sqlRowsWritten, writes, 'identical alert must not write SQL');
    await f.relay.scheduleAlarm(); await f.relay.scheduleAlarm();
    assert.equal(f.counts.alarmRowsWritten, alarmWrites, 'same deadline must not be written again');
    f.setClock(start + 1000);
    await f.command(a, 'noise', { noise: { level: 99, alarm: true } });
    assert.equal(f.relay.snapshot().noise.alarm, true);
    assert.equal(f.relay.snapshot().noise.level, 0);
    f.setClock(start + 1001);
    await f.command(a, 'noise', { noise: { level: 1, alarm: false } });
    assert.equal(f.relay.snapshot().noise.alarm, false, 'alarm changes remain immediate');
    f.setClock(start + 7000);
    await f.message(a, { type: 'ping' });
    await f.message(b, { type: 'ping' });
    assert.equal(f.relay.deviceRows()[0].expiresAt, start + 35000, 'SQL presence writes are coalesced');
    f.wake();
    f.setClock(start + 35001);
    f.relay.cleanupRemote();
    assert.equal(f.relay.devices().length, 2, 'WebSocket attachments retain contacts after SQL lease expires and instance wakes');
    assert.equal((await correction()).status, 200);
    const fileId = crypto.randomUUID();
    const fileUrl = `https://example/files?id=${fileId}&deviceId=${a.id}&part=0&parts=1`;
    const fileHeaders = { 'x-classroom-auth-nonce': a.nonce, 'x-classroom-auth-expires': String(start + 8 * 3600000) };
    const upload = () => f.relay.fileRequest(new Request(fileUrl, { method: 'POST', headers: fileHeaders, body: '%PDF-1.7\n%%EOF' }));
    assert.equal((await upload()).status, 200, 'PDF upload remains allowed while the effective attachment lease is alive');
    const download = await f.relay.fileRequest(new Request(fileUrl, { headers: fileHeaders }));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '%PDF-1.7\n%%EOF');
    await f.relay.scheduleAlarm();
    f.setClock(start + 42000);
    await f.relay.alarm();
    assert.equal(f.relay.devices().length, 0, 'real expiry is exactly 35s after last contact');
    assert.equal((await correction()).status, 403);
    assert.equal((await upload()).status, 409, 'PDF upload requires a live controller after the true lease expires');
    assert.equal(pupil.messages.findLast(value => value.type === 'state')?.correction, false);

    const c = f.teacher('Mac reconnected');
    assert.equal(f.relay.remote().correction, false);
    await f.command(c, 'take-control');
    await f.command(c, 'correction', { enabled: true });
    assert.equal((await correction()).status, 200);
    await f.relay.revokeTeacher(c.nonce, start + 8 * 3600000);
    f.wake();
    assert.equal((await correction()).status, 403, 'logout invalidates cached room, devices and grant');
    assert.equal(f.relay.revoked(c.nonce), true);
    assert.equal(f.relay.validTeacher(c), null);
  } finally { f.close(); }
}

async function sixHours(legacyNoise) {
  const f = fixture();
  try {
    const a = f.teacher('Mac'), b = f.teacher('PC');
    for (let index = 0; index < 30; index++) f.socket('pupil', { activity: '3/01' });
    await f.command(a, 'microphone', { enabled: true });
    await f.command(a, 'correction', { enabled: true });
    const step = legacyNoise ? 250 : 5000;
    let lastAlarm = false;
    for (let elapsed = step; elapsed <= 6 * 3600000; elapsed += step) {
      await f.advance(start + elapsed);
      if (elapsed % 600000 === 0) f.wake();
      if (elapsed % 15000 === 0) {
        await f.message(a, { type: 'ping' }); await f.message(b, { type: 'ping' });
      }
      const alarm = elapsed % 120000 < 5000;
      if (legacyNoise || alarm !== lastAlarm) {
        await f.command(a, 'noise', { noise: { level: elapsed % 100, alarm } });
        lastAlarm = alarm;
      }
      // A real client processes snapshots immediately instead of retaining six hours.
      for (const socket of f.ctx.getWebSockets()) socket.messages.length = 0;
    }
    assert.equal(f.relay.devices().length, 2);
    assert.equal(f.relay.remotePublicState().correction, true);
    // Account for a possible extra index row on every changed SQL row, plus alarms.
    const conservativeWrites = f.counts.sqlRowsWritten * 2 + f.counts.alarmRowsWritten;
    assert(conservativeWrites < 20000, JSON.stringify(f.counts));
    assert(f.counts.rowsRead < 1000000, JSON.stringify(f.counts));
    return { scenario: legacyNoise ? 'old-client-4Hz' : 'alert-changes-only', hours: 6, pupils: 30,
      ...f.counts, conservativeWrites };
  } finally { f.close(); }
}

(async () => {
  await regressions();
  const current = await sixHours(false);
  const legacy = await sixHours(true);
  console.log(JSON.stringify({ pass: true, exactTtl: 35000, hibernationRecovery: true, correctionAndLogout: true, current, legacy }));
})().catch(error => { console.error(error); process.exitCode = 1; });
