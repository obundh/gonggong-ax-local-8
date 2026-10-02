// Bounded HWP 5 PrvText reader. No document code, body scripts, or external links run.
// Structure references: Microsoft MS-CFB and Hancom's published HWP 5 format.
const END = 0xfffffffe, FREE = 0xffffffff, FAT = 0xfffffffd;
const check = (ok, code = 'HWP_INVALID_STRUCTURE') => { if (!ok) throw Object.assign(new Error(code), { code }); };
export function previewHwp(bytes) {
  try {
    check(Buffer.isBuffer(bytes) && bytes.length >= 1536 && bytes.length <= 8 * 1024 * 1024);
    check(bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')));
    check(bytes.readUInt16LE(26) === 3 && bytes.readUInt16LE(28) === 0xfffe && bytes.readUInt16LE(30) === 9 && bytes.readUInt16LE(32) === 6, 'HWP_CFB_VERSION_UNSUPPORTED');
    check(bytes.length % 512 === 0 && bytes.readUInt32LE(56) === 4096 && bytes.readUInt32LE(72) === 0);
    const count = bytes.length / 512 - 1, fatCount = bytes.readUInt32LE(44);
    check(fatCount > 0 && fatCount <= 109 && fatCount <= count);
    const used = new Set(), miniUsed = new Set();
    const sector = id => { check(Number.isInteger(id) && id >= 0 && id < count); return bytes.subarray((id + 1) * 512, (id + 2) * 512); };
    const fatIds = [];
    for (let i = 0; i < fatCount; i++) { const id = bytes.readUInt32LE(76 + i * 4); check(id < count && !used.has(id)); used.add(id); fatIds.push(id); }
    const tableBytes = Buffer.concat(fatIds.map(sector));
    const fatNext = id => { check(id * 4 + 4 <= tableBytes.length); return tableBytes.readUInt32LE(id * 4); };
    for (const id of fatIds) check(fatNext(id) === FAT);
    function chain(first, exactSize, maxSectors = count) {
      if (exactSize === 0) { check(first === END || first === FREE); return Buffer.alloc(0); }
      const chunks = []; let id = first;
      while (id !== END) { check(chunks.length < maxSectors && !used.has(id)); used.add(id); chunks.push(sector(id)); id = fatNext(id); }
      const data = Buffer.concat(chunks);
      if (exactSize !== null) check(data.length >= exactSize && data.length - exactSize < 512);
      return exactSize === null ? data : data.subarray(0, exactSize);
    }
    const directory = chain(bytes.readUInt32LE(48), null, 32);
    check(directory.length >= 128);
    const entries = [];
    for (let at = 0; at + 128 <= directory.length; at += 128) {
      const type = directory[at + 66], n = directory.readUInt16LE(at + 64);
      if (!type) { entries.push(null); continue; }
      check([1, 2, 5].includes(type) && n >= 2 && n <= 64 && n % 2 === 0 && directory.readUInt16LE(at + n - 2) === 0);
      const size = directory.readBigUInt64LE(at + 120); check(size <= BigInt(bytes.length));
      entries.push({ type, name: directory.toString('utf16le', at, at + n - 2), left: directory.readUInt32LE(at + 68), right: directory.readUInt32LE(at + 72), child: directory.readUInt32LE(at + 76), first: directory.readUInt32LE(at + 116), size: Number(size) });
    }
    const root = entries[0]; check(root?.type === 5);
    const direct = [], queue = [root.child], seen = new Set();
    while (queue.length) { const id = queue.pop(); if (id === FREE) continue; check(id > 0 && id < entries.length && !seen.has(id) && entries[id]); seen.add(id); const entry = entries[id]; direct.push(entry); queue.push(entry.left, entry.right); }
    const headerEntries = direct.filter(e => e.type === 2 && e.name === 'FileHeader');
    const textEntries = direct.filter(e => e.type === 2 && e.name === 'PrvText');
    check(headerEntries.length === 1 && textEntries.length === 1, 'HWP_PREVIEW_TEXT_MISSING');
    const miniFatCount = bytes.readUInt32LE(64); check(miniFatCount > 0 && miniFatCount <= count);
    const miniFat = chain(bytes.readUInt32LE(60), miniFatCount * 512);
    const miniStream = chain(root.first, root.size);
    function stream(entry) {
      if (entry.size >= 4096) return chain(entry.first, entry.size);
      check(entry.size > 0);
      const chunks = []; let id = entry.first;
      while (id !== END) { check(chunks.length <= Math.ceil(entry.size / 64) && id * 64 + 64 <= miniStream.length && id * 4 + 4 <= miniFat.length && !miniUsed.has(id)); miniUsed.add(id); chunks.push(miniStream.subarray(id * 64, id * 64 + 64)); id = miniFat.readUInt32LE(id * 4); }
      const data = Buffer.concat(chunks); check(data.length >= entry.size && data.length - entry.size < 64); return data.subarray(0, entry.size);
    }
    const header = stream(headerEntries[0]);
    check(header.length >= 40 && header.toString('ascii', 0, 17) === 'HWP Document File' && header[35] === 5, 'HWP_VERSION_UNSUPPORTED');
    const flags = header.readUInt32LE(36);
    check(!(flags & (2 | 4 | 256 | 512 | 1024)), 'HWP_PROTECTED_DOCUMENT');
    const text = stream(textEntries[0]); check(text.length % 2 === 0 && text.length <= 1024 * 1024);
    const decoded = new TextDecoder('utf-16le', { fatal: true }).decode(text).replace(/\u0000/g, '').trim();
    check(decoded.length > 0, 'HWP_PREVIEW_TEXT_MISSING');
    return { type: 'text', text: decoded, truncated: true, validation: { format: 'hwp', checks: ['CFB v3 FAT/miniFAT bounds', 'HWP 5 FileHeader', 'PrvText only; full body/layout not validated'], originalIdentityVerified: false } };
  } catch (error) { return { type: 'unsupported', reason: error.code ?? 'HWP_INVALID_STRUCTURE', validation: { format: 'hwp', checks: [], originalIdentityVerified: false } }; }
}
