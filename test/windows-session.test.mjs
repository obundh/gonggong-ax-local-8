import assert from 'node:assert/strict';
import test from 'node:test';
import { listWindowsDevices, WindowsDeviceError, WindowsVolumeSession } from '../engine/windows-device.mjs';

const fixture = [
  { id: 'C:', driveLetter: 'C:', diskIds: ['1'], serial: 'c-fixture', size: 4096, ready: true, fileSystem: 'NTFS' },
  { id: 'E:', driveLetter: 'E:', diskIds: ['2'], serial: 'e-fixture', size: 4096, ready: true, fileSystem: 'NTFS' }
];

async function harness(options = {}) {
  const devices = await listWindowsDevices({ fixture });
  const channels = [], launches = { direct: 0, elevated: 0 }, identities = new Map([['C:', 'native-c'], ['E:', 'native-e']]);
  let inventoryCalls = 0;
  const inventory = async () => {
    inventoryCalls++;
    return listWindowsDevices({ fixture: typeof options.inventoryRows === 'function' ? options.inventoryRows() : fixture });
  };
  function makeChannel(elevated) {
    const channel = {
      elevated, closed: false, opened: null, calls: [],
      destroy() { this.closed = true; this.opened = null; },
      async request(command, fields = {}) {
        if (this.closed) throw new WindowsDeviceError('HELPER_CLOSED', 'disconnected');
        this.calls.push({ command, fields });
        if (command === 'hello') return { protocol: 1, sessionReuse: options.sessionReuse !== false };
        if (command === 'release') { this.opened = null; return { released: true }; }
        if (command === 'close') { this.destroy(); return { closed: true }; }
        if (command === 'open') {
          if (this.opened) throw new Error('ALREADY_OPEN');
          if (!elevated && !(options.directVolumes ?? []).includes(fields.path)) throw new WindowsDeviceError('NEEDS_ADMIN', 'permission required');
          const device = devices.find(row => row.id === fields.path);
          assert.deepEqual(fields.expectedDiskIds, device.diskIds);
          this.opened = { id: fields.path, identity: identities.get(fields.path), size: 4096, sectorSize: 512, diskIds: device.diskIds };
          return { ...this.opened };
        }
        assert.ok(this.opened, 'every device command requires an open handle');
        if (this.opened.identity !== identities.get(this.opened.id)) throw new WindowsDeviceError('DEVICE_CHANGED', 'replaced volume');
        if (command === 'assert') return { unchanged: true, identity: this.opened.identity };
        if (command === 'read') return { data: Buffer.alloc(fields.length, this.opened.id === 'C:' ? 0x43 : 0x45).toString('base64') };
        if (command === 'queryJournal') return {
          journalId: '1', firstUsn: '8', nextUsn: '16', lowestValidUsn: '8', maxUsn: '100', maximumSize: '100', allocationDelta: '8'
        };
        if (command === 'readJournal') {
          const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(16n);
          return { data: bytes.toString('base64'), bytesRead: 8, nextUsn: '16', reasonMask: 0x3200 };
        }
        throw new Error(`Unexpected command ${command}`);
      }
    };
    channels.push(channel);
    return channel;
  }
  const session = new WindowsVolumeSession({
    inventory, helperPath: async () => 'fixture-helper', now: options.now, preparedOpenTtlMs: options.preparedOpenTtlMs,
    directFactory: async () => { launches.direct++; return makeChannel(false); },
    elevatedFactory: async (_helper, startup) => {
      launches.elevated++;
      if (options.onElevated) return options.onElevated(() => makeChannel(true), startup, launches.elevated);
      return makeChannel(true);
    }
  });
  return { session, devices, channels, launches, identities, get inventoryCalls() { return inventoryCalls; } };
}

test('concurrent searches and later searches on different volumes share one elevation', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  let prompts = 0;
  const options = { elevate: true, onPermission: () => prompts++ };
  const [first, second] = await Promise.all([h.session.open(h.devices[0], options), h.session.open(h.devices[0], options)]);
  assert.equal((await first.read(1, 10)).toString(), 'CCCCCCCCCC');
  await first.close();
  const external = await h.session.open(h.devices[1], options);
  const [fromC, fromE] = await Promise.all([second.read(0, 512), external.read(0, 512)]);
  assert.ok(fromC.every(byte => byte === 0x43));
  assert.ok(fromE.every(byte => byte === 0x45));
  assert.equal((await second.queryJournal()).journalId, '1');
  assert.equal((await external.readJournal({ startUsn: '8', journalId: '1', maxBytes: 8 })).nextUsn, '16');
  await Promise.all([second.close(), external.close()]);
  const later = await h.session.open(h.devices[0], options);
  await later.assertUnchanged();
  assert.deepEqual(h.launches, { direct: 1, elevated: 1 });
  assert.equal(prompts, 1);
  assert.equal(h.channels[1].closed, false, 'closing searches must retain the privileged connection');
  await h.session.dispose();
  assert.ok(h.channels.every(channel => channel.closed));
  await assert.rejects(later.read(0, 512), { code: 'HELPER_CLOSED' });
});

test('one denied approval rejects concurrent opens and only a later open can request again', async t => {
  const h = await harness({ onElevated(make, _startup, attempt) {
    if (attempt === 1) throw new WindowsDeviceError('ELEVATION_CANCELLED', 'denied');
    return make();
  } });
  t.after(() => h.session.dispose());
  const results = await Promise.allSettled(h.devices.map(device => h.session.open(device, { elevate: true })));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'ELEVATION_CANCELLED'));
  assert.deepEqual(h.launches, { direct: 1, elevated: 1 });
  const retry = await h.session.open(h.devices[0], { elevate: true });
  assert.equal((await retry.read(0, 1))[0], 0x43);
  assert.deepEqual(h.launches, { direct: 2, elevated: 2 });
});

test('unapproved opens never trigger elevation and forged selections never launch a helper', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  await assert.rejects(h.session.open({ ...h.devices[0], id: '\\\\.\\PhysicalDrive0' }, { elevate: true }), { code: 'DEVICE_NOT_ENUMERATED' });
  assert.equal(h.launches.direct, 0);
  await assert.rejects(h.session.open(h.devices[0]), { code: 'NEEDS_ADMIN' });
  assert.equal(h.launches.elevated, 0);
});

test('switching back to a replaced volume refuses its old lease before reading any bytes', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const original = await h.session.open(h.devices[0], { elevate: true });
  const external = await h.session.open(h.devices[1], { elevate: true });
  h.identities.set('C:', 'replacement-c');
  const helper = h.channels[1], reads = helper.calls.filter(call => call.command === 'read').length;
  await assert.rejects(original.read(0, 512), { code: 'DEVICE_CHANGED' });
  assert.equal(helper.calls.filter(call => call.command === 'read').length, reads);
  assert.equal((await external.read(0, 1))[0], 0x45);
  assert.equal(h.launches.elevated, 1);
});

test('a disconnected helper never relaunches from reads and old leases stay invalid after a new search', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const original = await h.session.open(h.devices[0], { elevate: true });
  h.channels[1].destroy();
  await assert.rejects(original.read(0, 512), { code: 'HELPER_CLOSED' });
  assert.equal(h.launches.elevated, 1);
  const newer = await h.session.open(h.devices[0], { elevate: true });
  await assert.rejects(original.read(0, 512), { code: 'HELPER_CLOSED' });
  assert.equal((await newer.read(0, 1))[0], 0x43);
  assert.equal(h.launches.elevated, 2);
});

test('native stale-handle errors release the handle so a fresh search can reopen without another elevation', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const original = await h.session.open(h.devices[0], { elevate: true });
  h.identities.set('C:', 'replacement-c');
  await assert.rejects(original.assertUnchanged(), { code: 'DEVICE_CHANGED' });
  const replacement = await h.session.open(h.devices[0], { elevate: true });
  assert.equal(replacement.info.nativeIdentity, 'replacement-c');
  await assert.rejects(original.read(0, 512), { code: 'DEVICE_CHANGED' });
  assert.equal((await replacement.read(0, 1))[0], 0x43);
  assert.equal(h.launches.elevated, 1);
  assert.ok(h.channels[1].calls.filter(call => call.command === 'release').length >= 2);
});

test('explicit upgrade for another drive preserves the earlier read-only lease identity', async t => {
  const h = await harness({ directVolumes: ['C:'] }); t.after(() => h.session.dispose());
  const first = await h.session.open(h.devices[0]);
  const second = await h.session.open(h.devices[1], { elevate: true });
  assert.equal((await first.read(0, 1))[0], 0x43);
  assert.equal((await second.read(0, 1))[0], 0x45);
  assert.equal(h.launches.elevated, 1);
});

test('disposing a session aborts pending elevation promptly and never publishes a provider', async () => {
  let started;
  const startup = new Promise(resolve => { started = resolve; });
  const h = await harness({ onElevated(_make, { signal }) {
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new WindowsDeviceError('CANCELLED', 'disposed')), { once: true }));
  } });
  const pending = h.session.open(h.devices[0], { elevate: true });
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await startup;
  await h.session.dispose();
  await rejected;
  assert.ok(h.channels.every(channel => channel.closed));
  await assert.rejects(h.session.open(h.devices[0], { elevate: true }), { code: 'HELPER_CLOSED' });
});

test('a helper arriving after disposal is immediately destroyed even when a custom factory ignores cancellation', async () => {
  let started, finish;
  const startup = new Promise(resolve => { started = resolve; });
  const h = await harness({ onElevated(make) {
    started();
    return new Promise(resolve => { finish = () => resolve(make()); });
  } });
  const pending = h.session.open(h.devices[0], { elevate: true });
  const rejected = assert.rejects(pending, { code: 'HELPER_CLOSED' });
  await startup;
  const disposed = h.session.dispose();
  finish();
  await Promise.all([disposed, rejected]);
  assert.ok(h.channels.every(channel => channel.closed));
});

test('disposing during the native hello handshake closes the not-yet-published channel', async () => {
  let started, rejectHello;
  const startup = new Promise(resolve => { started = resolve; });
  const h = await harness({ onElevated(make) {
    const channel = make(), destroy = channel.destroy.bind(channel), request = channel.request.bind(channel);
    channel.destroy = () => { destroy(); rejectHello?.(new WindowsDeviceError('HELPER_CLOSED', 'handshake cancelled')); };
    channel.request = (command, fields) => {
      if (command !== 'hello') return request(command, fields);
      started();
      return new Promise((resolve, reject) => { rejectHello = reject; });
    };
    return channel;
  } });
  const pending = h.session.open(h.devices[0], { elevate: true });
  const rejected = assert.rejects(pending, { code: 'HELPER_CLOSED' });
  await startup;
  await Promise.all([h.session.dispose(), rejected]);
  assert.ok(h.channels.every(channel => channel.closed));
});

test('incompatible helpers fail closed and cancellation avoids raw reads', async t => {
  const old = await harness({ sessionReuse: false }); t.after(() => old.session.dispose());
  await assert.rejects(old.session.open(old.devices[0], { elevate: true }), { code: 'HELPER_PROTOCOL' });
  assert.equal(old.launches.elevated, 0);
  assert.ok(old.channels.every(channel => channel.closed));
  const h = await harness(); t.after(() => h.session.dispose());
  const reader = await h.session.open(h.devices[0], { elevate: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.read(0, 512, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(h.channels[1].calls.filter(call => call.command === 'read').length, 0);
});

test('a prepared open uses its one fresh inventory snapshot, while later opens refresh normally', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const owner = '7fc2636d-d3aa-47e8-ae87-01f8a41ab1bf';
  const token = await h.session.prepareOpen(h.devices[0], { owner });
  assert.equal(h.inventoryCalls, 1);
  const prepared = await h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner });
  assert.equal(h.inventoryCalls, 1);
  await prepared.assertUnchanged();
  await prepared.close();
  const later = await h.session.open(h.devices[0], { elevate: true });
  assert.equal(h.inventoryCalls, 2);
  await later.close();
});

test('a fresh prepared search reconnects an already disconnected helper on its first attempt', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const original = await h.session.open(h.devices[0], { elevate: true });
  h.channels.at(-1).destroy();
  const owner = 'reconnect-job';
  const token = await h.session.prepareOpen(h.devices[0], { owner });
  const replacement = await h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner });
  assert.equal((await replacement.read(0, 1))[0], 0x43);
  await assert.rejects(original.read(0, 1), { code: 'HELPER_CLOSED' });
  assert.equal(h.inventoryCalls, 2);
  await replacement.close();
});

test('prepared opens are one-shot and reject forged, wrong-owner, source, and disk-id substitutions before helper startup', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const owner = 'b67f315a-8a68-4e84-bb73-5299c8655659';
  await assert.rejects(h.session.prepareOpen(h.devices[0], { owner: '' }), { code: 'PREPARED_OPEN_OWNER' });
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: Object.freeze({}), owner }), { code: 'PREPARED_OPEN_INVALID' });
  let token = await h.session.prepareOpen(h.devices[0], { owner });
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner: 'd205bd0d-a68f-4520-b6cc-7fb7056d343b' }), { code: 'PREPARED_OPEN_OWNER' });
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner }), { code: 'PREPARED_OPEN_INVALID' });
  token = await h.session.prepareOpen(h.devices[0], { owner });
  await assert.rejects(h.session.open(h.devices[1], { elevate: true, preparedOpen: token, owner }), { code: 'PREPARED_OPEN_SOURCE' });
  token = await h.session.prepareOpen(h.devices[0], { owner });
  await assert.rejects(h.session.open({ ...h.devices[0], diskIds: ['999'] }, { elevate: true, preparedOpen: token, owner }), { code: 'PREPARED_OPEN_SOURCE' });
  token = await h.session.prepareOpen(h.devices[0], { owner });
  h.session.revokePreparedOpen(token);
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner }), { code: 'PREPARED_OPEN_INVALID' });
  assert.deepEqual(h.launches, { direct: 0, elevated: 0 });
});

test('an expired prepared open refreshes inventory and refuses a changed source before startup', async t => {
  let now = 0, rows = fixture;
  const h = await harness({ now: () => now, preparedOpenTtlMs: 5000, inventoryRows: () => rows });
  t.after(() => h.session.dispose());
  const owner = '7ad87cd6-6a6a-4e30-8ab8-6e5ee8a14687';
  const token = await h.session.prepareOpen(h.devices[0], { owner });
  rows = fixture.map(row => row.id === 'C:' ? { ...row, diskIds: ['99'] } : row);
  now = 5000;
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner }), { code: 'DEVICE_CHANGED' });
  assert.equal(h.inventoryCalls, 2);
  assert.deepEqual(h.launches, { direct: 0, elevated: 0 });
});

test('a prepared open expiring while queued refreshes before native selection', async t => {
  let now = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = await harness({ now: () => now, preparedOpenTtlMs: 5000 });
  t.after(() => h.session.dispose());
  const owner = '7292269b-0d97-48e2-a7a5-048f513fe9c7';
  const token = await h.session.prepareOpen(h.devices[0], { owner });
  const queueBlock = h.session.serialize(async () => { await blocked; });
  const pending = h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner });
  now = 5000; release();
  await queueBlock;
  const reader = await pending;
  assert.equal(h.inventoryCalls, 2);
  await reader.close();
});

test('a prepared open is invalidated by a new session generation and native assertions still precede prepared-reader bytes', async t => {
  const h = await harness(); t.after(() => h.session.dispose());
  const owner = 'a249b033-a8bc-48de-8493-664d87548584';
  const stale = await h.session.prepareOpen(h.devices[0], { owner });
  h.session.retire(true);
  await assert.rejects(h.session.open(h.devices[0], { elevate: true, preparedOpen: stale, owner }), { code: 'PREPARED_OPEN_INVALID' });
  const token = await h.session.prepareOpen(h.devices[0], { owner });
  const reader = await h.session.open(h.devices[0], { elevate: true, preparedOpen: token, owner });
  h.identities.set('C:', 'replacement-c');
  const helper = h.channels.at(-1), reads = helper.calls.filter(call => call.command === 'read').length;
  await assert.rejects(reader.read(0, 512), { code: 'DEVICE_CHANGED' });
  assert.equal(helper.calls.filter(call => call.command === 'read').length, reads);
});
