import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildElevationSpec, JsonChannel } from '../engine/windows-device.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function verifyPipe(elevated) {
  const helper = process.env.RECOVERY_HELPER_EXE || path.join(root, 'native/bin/RecoveryChat.VolumeReader.exe');
  const sidResult = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(sidResult.status, 0, sidResult.stderr);
  const owner = sidResult.stdout.trim(), name = `RecoveryChat.${randomBytes(16).toString('hex')}`;
  let child, socket, channel, stderr = '', childError;
  if (elevated) {
    const spec = buildElevationSpec(helper, name, owner);
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(spec.script, 'utf16le').toString('base64')], { env: { ...process.env, ...spec.environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    child = spawn(helper, ['--pipe', name, '--owner', owner], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  child.on('error', error => { childError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  try {
    const deadline = Date.now() + (elevated ? 55000 : 7000);
    while (!socket) {
      if (childError) throw childError;
      if (child.exitCode !== null && (!elevated || child.exitCode !== 0)) throw new Error(`Helper startup failed (${child.exitCode}): ${stderr}`);
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(`\\\\.\\pipe\\${name}`);
          const failed = error => { candidate.destroy(); reject(error); };
          candidate.once('error', failed);
          candidate.once('connect', () => { candidate.removeListener('error', failed); resolve(candidate); });
        });
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`Named-pipe connection timed out: ${stderr || error.message}`);
        await delay(60);
      }
    }
    channel = new JsonChannel(socket, socket, () => socket.destroy());
    // Reading a request must precede impersonation; a connected, silent client remains valid.
    await delay(150);
    assert.equal(channel.closed, false, `Helper closed before the first request: ${stderr}`);
    assert.deepEqual(await channel.request('hello', {}, 5000), { protocol: 1, role: 'readonly-volume-reader', sessionReuse: true });
    await assert.rejects(channel.request('write', {}, 5000), { code: 'UNKNOWN_COMMAND' });
    assert.deepEqual(await channel.request('release', {}, 5000), { released: true });
    assert.deepEqual(await channel.request('hello', {}, 5000), { protocol: 1, role: 'readonly-volume-reader', sessionReuse: true });
    assert.deepEqual(await channel.request('close', {}, 5000), { closed: true });
    if (!elevated) {
      for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(20);
      assert.equal(child.exitCode, 0, stderr);
    }
    console.log(JSON.stringify({ helper, elevated, namedPipe: 'hello/unsupported-command/release/hello/close', openedDevice: false }));
  } finally {
    channel?.destroy(); socket?.destroy();
    if (child.exitCode === null) child.kill();
  }
}

test('compiled helper accepts a restricted named-pipe client and authorizes its first request before dispatch', { skip: process.platform !== 'win32', timeout: 15000 }, () => verifyPipe(false));

// Explicit opt-in only: this launches the real Windows UAC approval flow; no device is opened.
if (process.env.RECOVERY_TEST_ELEVATED === '1') {
  test('real elevated helper connects to its requesting user and closes without opening a volume', { timeout: 65000 }, () => verifyPipe(true));
}
