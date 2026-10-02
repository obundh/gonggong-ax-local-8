import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { decompressLznt1 } from '../engine/lznt1.mjs';

const MICROSOFT_EXAMPLE = Buffer.from(
  '38b08846232000204720410010a24701a045204400084501507900c045200524138805b4024a44ef0358028c091601484500be009e000401189000',
  'hex',
);
const MICROSOFT_TEXT = Buffer.from(
  'F# F# G A A G F# E D D E F# F# E E F# F# G A A G F# E D D E F# E D D E E F# D E F# G F# D E F# G F# E D E A F# F# G A A G F# E D D E F# E D D\0',
  'ascii',
);

test('decodes the complete published MS-XCA overlapping-copy example', () => {
  assert.deepEqual(decompressLznt1(MICROSOFT_EXAMPLE), MICROSOFT_TEXT);
});

test('decodes uncompressed chunks and enforces headers, references, and output bounds', () => {
  const literal = Buffer.concat([Buffer.from([0x02, 0x30]), Buffer.from('abc')]);
  assert.deepEqual(decompressLznt1(literal), Buffer.from('abc'));
  for (const invalid of [
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x20, 0x41]),
    Buffer.from([0x02, 0xb0, 0x01, 0x00, 0x00]),
    Buffer.concat([literal, Buffer.from([0, 0, 1])]),
  ]) assert.throws(() => decompressLznt1(invalid), { code: 'INVALID_LZNT1' });
  assert.throws(() => decompressLznt1(literal, { maxOutput: 2 }), { code: 'INVALID_LZNT1' });
});

test('matches a complete 64KiB buffer compressed by Windows RtlCompressBuffer', { skip: process.platform !== 'win32' }, () => {
  const script = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RecoveryChatLznt1Native {
  [DllImport("ntdll.dll")]
  public static extern int RtlGetCompressionWorkSpaceSize(ushort format, out uint compress, out uint fragment);
  [DllImport("ntdll.dll")]
  public static extern int RtlCompressBuffer(ushort format, byte[] source, uint sourceSize, byte[] dest, uint destSize, uint chunkSize, out uint finalSize, IntPtr workspace);
  public static string CompressFixture() {
    var source = new byte[65536];
    for (int i = 0; i < source.Length; i++) source[i] = (byte)(65 + ((i >> 12) % 4));
    uint workspaceSize, fragmentSize, finalSize;
    int status = RtlGetCompressionWorkSpaceSize(2, out workspaceSize, out fragmentSize);
    if (status != 0) throw new InvalidOperationException("RtlGetCompressionWorkSpaceSize failed: " + status);
    IntPtr workspace = Marshal.AllocHGlobal((int)workspaceSize);
    try {
      var dest = new byte[65536];
      status = RtlCompressBuffer(2, source, (uint)source.Length, dest, (uint)dest.Length, 4096, out finalSize, workspace);
      if (status != 0) throw new InvalidOperationException("RtlCompressBuffer failed: " + status);
      return Convert.ToBase64String(dest, 0, (int)finalSize);
    } finally { Marshal.FreeHGlobal(workspace); }
  }
}
"@
[Console]::Out.Write('__LZNT1__' + [RecoveryChatLznt1Native]::CompressFixture())
`;
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const match = result.stdout.match(/__LZNT1__([A-Za-z0-9+/=]+)/);
  assert.ok(match, `native compressed bytes missing: ${result.stdout}`);
  const expected = Buffer.alloc(65536);
  for (let index = 0; index < expected.length; index += 1) expected[index] = 65 + (Math.floor(index / 4096) % 4);
  assert.deepEqual(decompressLznt1(Buffer.from(match[1], 'base64'), { maxOutput: 65536 }), expected);
});
