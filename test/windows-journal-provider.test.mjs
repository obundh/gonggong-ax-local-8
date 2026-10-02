import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  normalizeJournalQuery,
  normalizeJournalRead,
  planJournalRead
} from '../engine/windows-device.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reasonMask = 0x00000200 | 0x00001000 | 0x00002000;

test('journal requests preserve 64-bit identifiers as bounded canonical decimals', () => {
  assert.deepEqual(planJournalRead({
    startUsn: '9007199254740993', journalId: '18446744073709551615', maxBytes: 65536
  }), { startUsn: '9007199254740993', journalId: '18446744073709551615', maxBytes: 65536 });
  assert.throws(() => planJournalRead({ startUsn: 1, journalId: '2' }), { code: 'INVALID_JOURNAL_REQUEST' });
  assert.throws(() => planJournalRead({ startUsn: '01', journalId: '2' }), { code: 'INVALID_JOURNAL_REQUEST' });
  assert.throws(() => planJournalRead({ startUsn: '9223372036854775808', journalId: '2' }), { code: 'INVALID_JOURNAL_REQUEST' });
  assert.throws(() => planJournalRead({ startUsn: '1', journalId: '18446744073709551616' }), { code: 'INVALID_JOURNAL_REQUEST' });
  assert.throws(() => planJournalRead({ startUsn: '1', journalId: '2', maxBytes: 1024 * 1024 + 1 }), { code: 'INVALID_JOURNAL_REQUEST' });
});

test('journal query normalization rejects unsafe or inconsistent helper metadata', () => {
  const valid = normalizeJournalQuery({
    journalId: '18446744073709551615', firstUsn: '10', nextUsn: '20', lowestValidUsn: '5',
    maxUsn: '9223372036854775807', maximumSize: '33554432', allocationDelta: '8388608'
  });
  assert.equal(valid.journalId, '18446744073709551615');
  assert.ok(Object.isFrozen(valid));
  assert.throws(() => normalizeJournalQuery({ ...valid, nextUsn: 20 }), { code: 'HELPER_PROTOCOL' });
  assert.throws(() => normalizeJournalQuery({ ...valid, firstUsn: '21' }), { code: 'HELPER_PROTOCOL' });
});

test('journal buffer normalization binds next USN, byte count, cap, and fixed reason mask', () => {
  const bytes = Buffer.alloc(16);
  bytes.writeBigInt64LE(9007199254740993n, 0);
  const result = normalizeJournalRead({
    data: bytes.toString('base64'), bytesRead: bytes.length,
    nextUsn: '9007199254740993', reasonMask
  }, 16);
  assert.deepEqual(result.data, bytes);
  assert.equal(result.nextUsn, '9007199254740993');
  assert.throws(() => normalizeJournalRead({ ...result, nextUsn: '9007199254740994', data: bytes.toString('base64') }, 16), { code: 'HELPER_PROTOCOL' });
  assert.throws(() => normalizeJournalRead({ ...result, reasonMask: 0xffffffff, data: bytes.toString('base64') }, 16), { code: 'HELPER_PROTOCOL' });
  assert.throws(() => normalizeJournalRead({ ...result, bytesRead: 17, data: bytes.toString('base64') }, 16), { code: 'HELPER_PROTOCOL' });
});

test('compiled helper keeps journal commands behind an already-open allowlisted volume', async () => {
  const executable = path.join(root, 'native', 'bin', 'RecoveryChat.VolumeReader.exe');
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; });
  child.stdin.write(`${JSON.stringify({ id: 'q', command: 'queryJournal' })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 'r', command: 'readJournal', startUsn: '0', journalId: '0', maxBytes: 8 })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 'c', command: 'close' })}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exitCode, 0);
  const replies = output.trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(replies.map(reply => reply.id), ['q', 'r', 'c']);
  assert.deepEqual(replies.slice(0, 2).map(reply => reply.error.code), ['NOT_OPEN', 'NOT_OPEN']);
  assert.equal(replies[2].result.closed, true);
});
