import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import { WorkerVolumeBroker, openWorkerVolume } from '../engine/worker-volume.mjs';

const device = Object.freeze({ id: '\\\\.\\C:', identity: 'volume-c-identity', diskIds: ['1'], ready: true });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function provider(overrides = {}) {
  return {
    info: { size: 4096, sectorSize: 512, identity: device.identity, sourceKind: 'volume' },
    async read(offset, length) { return Buffer.from(Array.from({ length }, (_, index) => (offset + index) % 256)); },
    async assertUnchanged() {},
    async queryJournal() { return { journalId: '99', firstUsn: '100', nextUsn: '200' }; },
    async readJournal() { return { data: Buffer.from([1, 0, 255, 128]), nextUsn: '200', bytesRead: 4 }; },
    async close() {},
    ...overrides
  };
}

function bridge(session) {
  const { port1, port2 } = new MessageChannel();
  const serverErrors = [];
  const broker = new WorkerVolumeBroker({ session, device, elevate: true, onPermission() {}, send: message => port1.postMessage(message) });
  port1.on('message', message => {
    Promise.resolve(broker.handle(message)).catch(error => serverErrors.push(error));
  });
  return {
    broker,
    port: port2,
    async cleanup() { await broker.dispose(); port1.close(); port2.close(); assert.deepEqual(serverErrors, []); }
  };
}

test('volume worker bridge restores binary buffers after actual structured clone and keeps provider operations available', { timeout: 5000 }, async () => {
  const calls = [];
  let closed = 0;
  const native = provider({ async close() { closed++; } });
  const connection = bridge({ async open(selected, options) { calls.push({ selected, options }); return native; } });
  try {
    const reader = await openWorkerVolume(connection.port);
    assert.equal(reader.info.identity, device.identity);
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].selected, device);
    assert.equal(calls[0].options.elevate, true);
    const bytes = await reader.read(253, 6);
    assert.ok(Buffer.isBuffer(bytes), 'worker consumers use Buffer methods, not merely Uint8Array');
    assert.deepEqual([...bytes], [253, 254, 255, 0, 1, 2]);
    await reader.assertUnchanged();
    assert.equal((await reader.queryJournal()).journalId, '99');
    const journal = await reader.readJournal({ startUsn: '100', journalId: '99', maxBytes: 4096 });
    assert.ok(Buffer.isBuffer(journal.data));
    assert.deepEqual([...journal.data], [1, 0, 255, 128]);
    await reader.close();
    await reader.close();
    assert.equal(closed, 1);
    await assert.rejects(reader.read(0, 1));
  } finally { await connection.cleanup(); }
  assert.equal(closed, 1, 'bridge disposal must not release the same lease twice');
});

test('disposing a worker while volume permission is pending releases the eventual provider', { timeout: 5000 }, async () => {
  const opening = deferred(), entered = deferred();
  let closed = 0;
  const broker = new WorkerVolumeBroker({
    device, elevate: true, onPermission() {}, send() {},
    session: { async open() { entered.resolve(); return opening.promise; } }
  });
  const request = Promise.resolve(broker.handle({ type: 'volume-request', requestId: 'pending-open', command: 'open', args: {} }));
  await entered.promise;
  const disposal = Promise.resolve(broker.dispose());
  opening.resolve(provider({ async close() { closed++; } }));
  await Promise.all([request, disposal]);
  await tick();
  assert.equal(closed, 1, 'a late permission success cannot leave an orphaned volume lease');
  await broker.dispose();
  assert.equal(closed, 1);
});

test('aborting a worker read cancels its provider request without affecting later independent reads', { timeout: 5000 }, async () => {
  const entered = deferred(), cancelled = deferred();
  let readCount = 0;
  const connection = bridge({ async open() { return provider({
    async read(offset, length, { signal } = {}) {
      readCount++;
      if (readCount > 1) return Buffer.alloc(length, 7);
      entered.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => { cancelled.resolve(); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }); } });
  try {
    const reader = await openWorkerVolume(connection.port);
    const controller = new AbortController();
    const pending = reader.read(0, 3, { signal: controller.signal });
    const rejection = assert.rejects(pending, error => error.code === 'CANCELLED' || error.name === 'AbortError');
    await entered.promise;
    controller.abort();
    await Promise.all([rejection, cancelled.promise]);
    assert.deepEqual([...(await reader.read(0, 2))], [7, 7]);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await assert.rejects(reader.read(0, 2, { signal: alreadyAborted.signal }));
    assert.equal(readCount, 2, 'already-cancelled requests must not reach the native provider');
    await reader.close();
  } finally { await connection.cleanup(); }
});

test('the worker cannot change the bound volume or dispatch arbitrary provider methods', { timeout: 5000 }, async () => {
  const opened = [], touched = [];
  const connection = bridge({ async open(selected) {
    opened.push(selected);
    return provider({ async write() { touched.push('write'); }, async read() { touched.push('read'); return Buffer.alloc(1); } });
  } });
  const request = async message => {
    const reply = once(connection.port, 'message');
    connection.port.postMessage({ type: 'volume-request', requestId: 'raw-' + Math.random(), args: {}, ...message });
    return (await reply)[0];
  };
  try {
    const forged = await request({ command: 'open', args: { path: '\\\\.\\PhysicalDrive0', device: { id: '\\\\.\\D:' } } });
    assert.ok(forged.error || opened.every(selected => selected === device), 'only the parent-selected volume may be opened');
    if (!opened.length) assert.equal((await request({ command: 'open' })).error, undefined);
    for (const command of ['write', 'constructor', '__proto__', 'destroy', 'openWindowsVolume']) {
      assert.ok((await request({ command })).error, `${command} must be rejected`);
    }
    assert.deepEqual(touched, []);
    assert.ok(opened.length <= 1);
    assert.ok(opened.every(selected => selected === device));
  } finally { await connection.cleanup(); }
});

test('provider identity failures retain their code across the worker boundary', { timeout: 5000 }, async () => {
  const connection = bridge({ async open() { return provider({
    async assertUnchanged() { throw Object.assign(new Error('selected disk changed'), { code: 'DEVICE_CHANGED', details: { identity: 'changed' } }); }
  }); } });
  try {
    const reader = await openWorkerVolume(connection.port);
    await assert.rejects(reader.assertUnchanged(), { code: 'DEVICE_CHANGED', message: 'selected disk changed' });
    await reader.close();
  } finally { await connection.cleanup(); }
});

test('invalid raw-read sizes and offsets are rejected before reaching the privileged provider', { timeout: 5000 }, async () => {
  let reads = 0;
  const connection = bridge({ async open() { return provider({ async read(offset, length) { reads++; return Buffer.alloc(length); } }); } });
  try {
    const reader = await openWorkerVolume(connection.port);
    for (const [offset, length] of [[-1, 1], [0.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [0, 0], [0, -1], [0, 0.5], [0, 1024 * 1024 + 1]]) {
      await assert.rejects(reader.read(offset, length), { code: 'INVALID_READ' });
    }
    assert.equal(reads, 0);
    assert.equal((await reader.read(0, 512)).length, 512);
    assert.equal(reads, 1, 'malformed worker requests must not poison later valid reads');
    await reader.close();
  } finally { await connection.cleanup(); }
});

test('a client close racing with broker disposal gets a prompt terminal reply', { timeout: 3000 }, async () => {
  let closes = 0;
  const connection = bridge({ async open() { return provider({ async close() { closes++; } }); } });
  try {
    const reader = await openWorkerVolume(connection.port);
    await connection.broker.dispose();
    const closed = reader.close();
    let forcedDisconnect = false;
    const deadline = setTimeout(() => { forcedDisconnect = true; connection.port.close(); }, 1000);
    try {
      await assert.rejects(closed, { code: 'HELPER_CLOSED' });
      assert.equal(forcedDisconnect, false, 'the broker should respond before the deadline forcibly disconnects the port');
    } finally { clearTimeout(deadline); }
    assert.equal(closes, 1);
  } finally { await connection.cleanup(); }
});
