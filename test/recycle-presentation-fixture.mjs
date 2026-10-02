import { buildRecycleMetadataCandidate } from '../engine/recycle-metadata.mjs';

export function metadataClue() {
  const originalPath = 'C:\\자료\\예산 회의.pdf', text = Buffer.from(originalPath + '\0', 'utf16le');
  const bytes = Buffer.alloc(28 + text.length);
  bytes.writeBigUInt64LE(2n); bytes.writeBigUInt64LE(42000n, 8);
  bytes.writeBigUInt64LE((BigInt(Date.parse('2026-09-24T12:00:00Z')) + 11644473600000n) * 10000n, 16);
  bytes.writeUInt32LE(text.length / 2, 24); text.copy(bytes, 28);
  return buildRecycleMetadataCandidate({ bytes,
    record: { recordNumber: 46, sequence: 2, fingerprint: 'a'.repeat(64), name: '$IABC123.pdf',
      nameReferences: [{ name: '$IABC123.pdf', namespace: 1, parent: { recordNumber: 45, sequence: 1 } }] },
    directoryEvidence: [
      { recordNumber: 45, sequence: 1, fingerprint: 'b'.repeat(64), name: 'S-1-5-21-1-2-3-1001', parent: { recordNumber: 44, sequence: 1 } },
      { recordNumber: 44, sequence: 1, fingerprint: 'c'.repeat(64), name: '$Recycle.Bin', parent: { recordNumber: 5, sequence: 1 } },
      { recordNumber: 5, sequence: 1, fingerprint: 'd'.repeat(64), name: '.', parent: { recordNumber: 5, sequence: 1 } }
    ] });
}
