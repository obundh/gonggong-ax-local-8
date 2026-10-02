import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { carveFiles } from '../engine/carving.mjs';

let table;
function crc32(buffer) {
  table ??= Array.from({ length: 256 }, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ table[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function makePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = deflateSync(Buffer.from([0, 255, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', pixels), pngChunk('IEND')
  ]);
}

function makeJpeg() {
  const app = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame, scan, Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd9])]);
}

function makePdf(extra = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'ascii'), extra, Buffer.from('\n%%EOF\n', 'ascii')]);
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(value);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

class BufferProvider {
  constructor(bytes, { failOffset = null } = {}) {
    this.bytes = Buffer.from(bytes);
    this.failOffset = failOffset;
    this.info = { size: this.bytes.length, sectorSize: 512, readOnly: true };
    this.assertions = 0;
    this.reads = [];
  }

  async assertUnchanged() { this.assertions++; }

  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) {
      const error = new Error('cancelled');
      error.code = 'CANCELLED';
      throw error;
    }
    assert.ok(length <= 1024 * 1024, 'engine must keep provider reads bounded');
    this.reads.push({ offset, length });
    if (this.failOffset !== null && offset <= this.failOffset && offset + length > this.failOffset) {
      const error = new Error('synthetic read failure');
      error.code = 'EIO';
      throw error;
    }
    return Buffer.from(this.bytes.subarray(offset, offset + length));
  }
}

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-carving-'));
  try { await callback(root); }
  finally {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('recoverychat-carving-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

test('carves exact PNG, JPEG, PDF and Office ZIP bytes with generated names', async () => isolated(async root => {
  const png = makePng();
  const jpeg = makeJpeg();
  const pdf = makePdf();
  const docx = makeZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<document/>']]);
  const sources = [png, jpeg, pdf, docx];
  const separators = [Buffer.alloc(19, 0x71), Buffer.alloc(23, 0x72), Buffer.alloc(29, 0x73)];
  const bytes = Buffer.concat([sources[0], separators[0], sources[1], separators[1], sources[2], separators[2], sources[3]]);
  const provider = new BufferProvider(bytes);
  const streamed = [];
  const result = await carveFiles(provider, path.join(root, 'output'), { onCandidate: candidate => streamed.push(candidate) });
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.map(candidate => candidate.format), ['png', 'jpg', 'pdf', 'docx']);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), streamed.map(candidate => candidate.id));
  for (let index = 0; index < sources.length; index++) {
    const candidate = result.candidates[index];
    assert.equal(candidate.source, 'carved');
    assert.equal(candidate.status, 'readable');
    assert.equal(candidate.nameIsGenerated, true);
    assert.deepEqual(await readFile(candidate.path), sources[index]);
  }
  assert.ok(provider.assertions >= 6);
  assert.ok(provider.reads.every(read => read.length <= 1024 * 1024));
}));

test('finds a PNG signature split across adjacent 1 MiB scan chunks', async () => isolated(async root => {
  const png = makePng();
  const prefix = Buffer.alloc(1024 * 1024 - 4, 0x33);
  const provider = new BufferProvider(Buffer.concat([prefix, png]));
  const result = await carveFiles(provider, path.join(root, 'output'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].offset, prefix.length);
  assert.deepEqual(await readFile(result.candidates[0].path), png);
}));

test('classifies XLSX, PPTX, and HWPX only from validated ZIP entry names', async () => isolated(async root => {
  const xlsx = makeZip([['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook/>']]);
  const pptx = makeZip([['[Content_Types].xml', '<Types/>'], ['ppt/presentation.xml', '<presentation/>']]);
  const hwpx = makeZip([['version.xml', '<version/>'], ['Contents/content.hpf', '<content/>']]);
  const provider = new BufferProvider(Buffer.concat([xlsx, Buffer.alloc(17), pptx, Buffer.alloc(17), hwpx]));
  const result = await carveFiles(provider, path.join(root, 'output'));
  assert.deepEqual(result.candidates.map(candidate => candidate.format), ['xlsx', 'pptx', 'hwpx']);
  assert.ok(result.candidates.every(candidate => candidate.kind === 'document'));
}));

test('garbage signatures are ignored while a structurally truncated PNG is a named partial result', async () => isolated(async root => {
  const valid = makePng();
  const truncated = valid.subarray(0, valid.length - 7);
  const garbage = Buffer.from('%PDF-nope\nPK\x03\x04bad\xff\xd8\xffbad', 'latin1');
  const provider = new BufferProvider(Buffer.concat([garbage, Buffer.alloc(11), truncated]));
  const result = await carveFiles(provider, path.join(root, 'output'));
  assert.equal(result.complete, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].status, 'partial');
  assert.ok(result.candidates[0].path.endsWith('.partial'));
  assert.ok(result.warnings.some(warning => warning.code === 'TRUNCATED_FILE'));
  assert.deepEqual(await readFile(result.candidates[0].path), truncated);
}));

test('selected ranges are explicit, merged, and do not claim an unallocated-space scan', async () => isolated(async root => {
  const png = makePng();
  const bytes = Buffer.concat([Buffer.alloc(40), png, Buffer.alloc(40), makeJpeg()]);
  const provider = new BufferProvider(bytes);
  const result = await carveFiles(provider, path.join(root, 'output'), {
    ranges: [{ offset: 20, length: 20 + png.length }, { offset: 30, length: 30 + png.length }]
  });
  assert.equal(result.stats.scanScope, 'selected-ranges');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].format, 'png');
}));

test('scan read errors are separate warnings and prevent a complete claim', async () => isolated(async root => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 10, 0x44);
  const provider = new BufferProvider(bytes, { failOffset: 1024 * 1024 + 1 });
  const result = await carveFiles(provider, path.join(root, 'output'));
  assert.equal(result.complete, false);
  assert.equal(result.stats.readErrors, 1);
  assert.equal(result.stats.bytesRead, 1024 * 1024 + 10);
  assert.ok(result.warnings.some(warning => warning.code === 'READ_FAILED'));
}));

test('cancellation during streamed output preserves only a clearly named partial write', async () => isolated(async root => {
  const pdf = makePdf(Buffer.alloc(2 * 1024 * 1024, 0x20));
  const provider = new BufferProvider(pdf);
  const controller = new AbortController();
  let caught;
  try {
    await carveFiles(provider, path.join(root, 'output'), {
      signal: controller.signal,
      onProgress: progress => {
        if (progress.phase === 'extract' && progress.bytesWritten > 0) controller.abort();
      }
    });
  } catch (error) { caught = error; }
  assert.equal(caught?.code, 'CANCELLED');
  assert.ok(caught.details.partialPath.endsWith('.carving-writing.partial'));
  const partial = await readFile(caught.details.partialPath);
  assert.equal(partial.length, 1024 * 1024);
}));

test('oversized structures and ZIP expansion bombs are refused without publishing candidates', async () => isolated(async root => {
  const oversizedPdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'), Buffer.alloc(4096, 0x20)]);
  const provider = new BufferProvider(oversizedPdf);
  const limited = await carveFiles(provider, path.join(root, 'limited'), { maxFileBytes: 1024 });
  assert.equal(limited.candidates.length, 0);
  assert.equal(limited.complete, false);
  assert.ok(limited.warnings.some(warning => warning.code === 'FILE_LIMIT'));

  const bomb = makeZip([['huge.txt', 'x']]);
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(500 * 1024 * 1024, central + 24);
  const bombProvider = new BufferProvider(bomb);
  const rejected = await carveFiles(bombProvider, path.join(root, 'bomb'));
  assert.equal(rejected.candidates.length, 0);
  assert.ok(rejected.warnings.some(warning => warning.code === 'UNSUPPORTED_STRUCTURE'));
}));
