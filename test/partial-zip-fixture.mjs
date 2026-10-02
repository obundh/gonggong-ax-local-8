import { deflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; }

/**
 * Makes a deliberately central-directory-free local ZIP entry.  These are
 * damaged-document fixtures, not ZIP files that an office suite should open.
 */
export function localZipEntry(name, body, {
  method = 8,
  flags = 0,
  crc = crc32(body),
  compressedSize,
  uncompressedSize = body.length,
  extra = Buffer.alloc(0),
} = {}) {
  const input = Buffer.from(body);
  const packed = method === 8 ? deflateRawSync(input) : input;
  const nameBytes = Buffer.from(name, 'utf8');
  const declaredCompressed = compressedSize ?? packed.length;
  return Buffer.concat([
    Buffer.from('504b0304', 'hex'), u16(20), u16(flags | 0x800), u16(method), u16(0), u16(0),
    u32(crc), u32(declaredCompressed), u32(uncompressedSize), u16(nameBytes.length), u16(extra.length),
    nameBytes, extra, packed,
  ]);
}

export function damagedZip(entries, tail = Buffer.alloc(0)) {
  return Buffer.concat([...entries, Buffer.from(tail)]);
}

export function textXml(text, root = 'w:document') {
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?><${root} xmlns:w="urn:fixture"><w:body><w:t>${text}</w:t></w:body></${root}>`);
}

export function brokenLocalHeader({ declaredBodyBytes = 64, name = 'word/truncated.xml' } = {}) {
  const header = localZipEntry(name, Buffer.from('short'), { method: 0, compressedSize: declaredBodyBytes });
  // Leave the complete header but remove declared bytes from its body.
  return header.subarray(0, Math.max(0, header.length - 3));
}

export function corruptCrc(entry) {
  const result = Buffer.from(entry);
  result.writeUInt32LE((result.readUInt32LE(14) + 1) >>> 0, 14);
  return result;
}

export function centralDirectoryMarker() { return Buffer.from('504b0506000000000000000000000000000000000000', 'hex'); }

export const fixtureText = Object.freeze({
  docx: 'DOCX 앞부분 확인 텍스트',
  xlsxGood: 'XLSX 확인 텍스트',
  xlsxBad: 'XLSX 손상 텍스트',
  pptxGood: 'PPTX 첫 슬라이드',
  pptxBad: 'PPTX 손상 슬라이드',
  hwpxGood: 'HWPX 첫 본문',
  hwpxBad: 'HWPX 손상 본문',
  decoy: '손상 뒤 미끼 텍스트',
});
