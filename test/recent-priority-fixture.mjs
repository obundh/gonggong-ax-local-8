// Controlled NTFS image and journal. No live device or pre-deletion hints.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createFixture, fixtureGeometry as g, fixturePrimitives as p } from './ntfs-fixtures.mjs';
import { usnRecord } from './usn-fixture.mjs';

export const targetNumber = 200;
export const targetName = 'newest-document.txt';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createPriorityFixture(directory, { variant = 'normal', count = 70 } = {}) {
  const original = await createFixture(directory);
  const bytes = await readFile(original.imagePath), mftOffset = g.mftLcn * g.clusterSize;
  const mftCount = 256, mftBytes = mftCount * g.fileRecordSize, clusters = mftBytes / g.clusterSize;
  const savedSystems = [3, 5].map(n => [n, Buffer.from(bytes.subarray(mftOffset + n * 1024, mftOffset + (n + 1) * 1024))]);
  bytes.fill(0, mftOffset, mftOffset + mftBytes);
  const mftBitmap = Buffer.alloc(mftCount / 8), volumeBitmap = Buffer.alloc(g.totalClusters / 8);
  for (const n of [0, 3, 5, 6]) p.setBitmapBit(mftBitmap, n);
  if (variant === 'allocated') p.setBitmapBit(mftBitmap, targetNumber);
  for (let n = 0; n < g.mftLcn + clusters; n++) p.setBitmapBit(volumeBitmap, n);
  const put = (number, record) => record.copy(bytes, mftOffset + number * g.fileRecordSize);
  put(0, p.makeFileRecord({ recordNumber: 0, name: '$MFT', active: true, attributes: [
    p.nonresidentAttribute(0x80, [{ lcn: g.mftLcn, clusters }], mftBytes, 2,
      { allocatedSize: mftBytes, initializedSize: mftBytes }), p.residentAttribute(0xb0, mftBitmap, 3),
  ] }));
  for (const [n, record] of savedSystems) put(n, record);
  put(6, p.makeFileRecord({ recordNumber: 6, name: '$Bitmap', active: true,
    attributes: [p.residentAttribute(0x80, volumeBitmap, 2)] }));
  const originals = [], events = [];
  for (const n of [...Array.from({ length: count }, (_, i) => 16 + i), targetNumber]) {
    const name = n === targetNumber ? targetName : `old-${n}.txt`, content = Buffer.from(`Known original document ${n}\n`);
    put(n, p.makeFileRecord({ recordNumber: n, name, sequence: 7,
      attributes: [p.residentAttribute(0x80, content, 2)] }));
    originals.push({ recordNumber: n, name, size: content.length, sha256: hash(content) });
    const event = usnRecord({ recordNumber: n, sequence: variant === 'wrong-generation' && n === targetNumber ? 4 : 6,
      name: variant === 'wrong-name' && n === targetNumber ? 'another-file.txt' : name,
      deletedAt: variant === 'unknown-time' && n === targetNumber ? null
        : n === targetNumber ? '2026-09-26T08:00:00Z' : '2026-09-25T08:00:00Z', usn: 1000 + n * 100 });
    if (variant === 'wrong-parent' && n === targetNumber) event.writeBigUInt64LE(6n | 1n << 48n, 16);
    events.push(event);
  }
  await writeFile(original.imagePath, bytes);
  const head = Buffer.alloc(8); head.writeBigInt64LE(50000n);
  return { imagePath: original.imagePath, originals, imageSha256: hash(bytes),
    journal: { async queryJournal() { return { journalId: 'priority-fixture', firstUsn: '1000', lowestValidUsn: '1000', nextUsn: '50000' }; },
      async readJournal() { return { data: Buffer.concat([head, ...events]) }; } } };
}
