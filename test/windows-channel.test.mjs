import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { JsonChannel } from '../engine/windows-device.mjs';

test('read-only helper channel bounds unterminated responses and rejects every pending request', async () => {
  const input = new PassThrough(), output = new PassThrough(); let retired = false;
  const channel = new JsonChannel(input, output, () => { retired = true; });
  const pending = channel.request('hello');
  input.write('x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(pending, { code: 'HELPER_PROTOCOL_LIMIT' });
  assert.equal(channel.closed, true); assert.equal(retired, true); assert.equal(channel.buffer, '');
  input.destroy(); output.destroy();
});

test('helper request timeout retires the channel, so subsequent requests never reuse blocked native work', async () => {
  const input = new PassThrough(), output = new PassThrough(); let retired = false;
  const channel = new JsonChannel(input, output, () => { retired = true; });
  await assert.rejects(channel.request('hello', {}, 10), { code: 'HELPER_TIMEOUT' });
  await assert.rejects(channel.request('read'), { code: 'HELPER_CLOSED' });
  assert.equal(retired, true); assert.equal(channel.pending.size, 0);
  input.write('{"id":"1","ok":true,"result":{}}\n');
  assert.equal(channel.closed, true);
  input.destroy(); output.destroy();
});
