import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { carveFiles } from '../engine/carving.mjs';
import { validateHwpExtent } from '../engine/hwp-carving.mjs';
import { previewHwp } from '../engine/hwp-preview.mjs';
import { CFB_MARKERS, createHwpFixture } from './hwp-carving-fixture.mjs';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

class BufferProvider {
  constructor(bytes, { failAfterReads = Number.POSITIVE_INFINITY, mutateSecondWholeRead = null } = {}) {
    this.bytes = Buffer.from(bytes);
    this.info = { size: this.bytes.length, sectorSize: 512, readOnly: true };
    this.failAfterReads = failAfterReads;
    this.mutateSecondWholeRead = mutateSecondWholeRead;
    this.reads = [];
    this.assertions = 0;
    this.wholeReads = 0;
  }

  async assertUnchanged() { this.assertions += 1; }

  async read(offset, length, { signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    if (this.reads.length >= this.failAfterReads) throw Object.assign(new Error('synthetic read error'), { code: 'EIO' });
    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 1024 * 1024);
    assert.ok(offset + length <= this.bytes.length);
    this.reads.push({ offset, length });
    let source = this.bytes;
    if (offset === 0 && length === this.bytes.length) {
      this.wholeReads += 1;
      if (this.wholeReads === 2 && this.mutateSecondWholeRead) {
        source = Buffer.from(this.bytes);
        this.mutateSecondWholeRead(source);
      }
    }
    return Buffer.from(source.subarray(offset, offset + length));
  }
}

async function validate(bytes, {
  availableBytes = bytes.length,
  maxFileBytes = MAX_FILE_BYTES,
  onRead
} = {}) {
  const reads = [];
  const result = await validateHwpExtent(async (relative, length) => {
    assert.ok(Number.isSafeInteger(relative) && relative >= 0, 'relative read offset is bounded');
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 4096, 'individual validator reads stay bounded');
    assert.ok(relative + length <= availableBytes, 'validator never reads outside the selected bytes');
    reads.push({ relative, length });
    if (onRead) await onRead({ relative, length, reads });
    return Buffer.from(bytes.subarray(relative, relative + length));
  }, availableBytes, maxFileBytes);
  return { result, reads };
}

async function isolated(callback) {
  const temporaryRoot = path.resolve(os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, 'recoverychat-hwp-carving-'));
  try {
    await callback(root);
  } finally {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('recoverychat-hwp-carving-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  }
}

function readableHwpCandidates(result) {
  return result.candidates.filter(candidate => candidate.format === 'hwp' && candidate.status === 'readable');
}

function mutateFixture(mutator, options) {
  const fixture = createHwpFixture(options);
  const bytes = Buffer.from(fixture.bytes);
  mutator(bytes, fixture.layout);
  return bytes;
}

test('validates the exact minimal HWP extent with bounded reads and leaves input unchanged', async () => {
  const { bytes, layout } = createHwpFixture();
  const originalHash = sha256(bytes);
  const withNeighbor = Buffer.concat([bytes, Buffer.alloc(733, 0x6e)]);
  const { result, reads } = await validate(withNeighbor);

  assert.deepEqual({
    state: result.state,
    length: result.length,
    extension: result.extension,
    kind: result.kind,
    validation: result.validation,
    validationScope: result.validationScope,
    originalLengthKnown: result.originalLengthKnown
  }, {
    state: 'complete',
    length: layout.length,
    extension: 'hwp',
    kind: 'document',
    validation: 'hwp5-cfb-allocation-chains',
    validationScope: 'container-and-stream-allocation',
    originalLengthKnown: false
  });
  assert.match(result.structuralSha256, /^[0-9a-f]{64}$/);
  assert.ok(reads.length > 0 && reads.every(read => read.relative + read.length <= layout.length));
  assert.equal(sha256(bytes), originalHash, 'fixture bytes remain unchanged');
});

test('accepts valid non-monotonic FAT and directory chains', async () => {
  const { bytes, layout } = createHwpFixture({ nonMonotonic: true });
  assert.deepEqual(layout.sectors.directory, [2, 1]);
  assert.deepEqual(layout.sectors.binData, [12, 5, 11, 6, 10, 7, 9, 8]);
  const { result } = await validate(bytes);
  assert.equal(result.state, 'complete');
  assert.equal(result.length, bytes.length);
});

test('carves an exact HWP whose signature crosses a 1 MiB scan chunk boundary', async () => isolated(async root => {
  const { bytes: hwp } = createHwpFixture();
  const prefix = Buffer.alloc(1024 * 1024 - 4, 0x31);
  const provider = new BufferProvider(Buffer.concat([prefix, hwp, Buffer.alloc(97, 0x71)]));
  const result = await carveFiles(provider, path.join(root, 'output'));
  const candidates = readableHwpCandidates(result);

  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.offset, prefix.length);
  assert.equal(candidate.kind, 'document');
  assert.equal(candidate.nameIsGenerated, true);
  assert.equal(candidate.originalIdentityVerified, false);
  assert.equal(candidate.applicationOpenVerified, false);
  assert.equal(candidate.originalLengthKnown, false);
  assert.equal(candidate.bodyAssociation, 'not-asserted');
  assert.match(candidate.name, /^carved-[0-9a-f]{12}\.hwp$/);
  assert.deepEqual(await readFile(candidate.path), hwp);
  assert.equal(candidate.structuralValidation.scope, 'container-and-stream-allocation');
  assert.match(candidate.structuralValidation.sha256, /^[0-9a-f]{64}$/);
  assert.equal(candidate.structuralValidation.savedOutputRechecked, true);
  assert.equal(candidate.structuralValidation.fullDocumentValidated, false);
  assert.ok(provider.assertions >= 3);
}));

test('selected range must fully contain the HWP and cannot bridge an omitted gap', async () => isolated(async root => {
  const { bytes: hwp } = createHwpFixture();
  const prefix = Buffer.alloc(83, 0x62);
  const suffix = Buffer.alloc(91, 0x63);
  const source = Buffer.concat([prefix, hwp, suffix]);
  const start = prefix.length;

  const contained = await carveFiles(new BufferProvider(source), path.join(root, 'contained'), {
    ranges: [{ offset: start, length: hwp.length }]
  });
  assert.equal(readableHwpCandidates(contained).length, 1);
  assert.deepEqual(await readFile(readableHwpCandidates(contained)[0].path), hwp);

  const crossingGap = await carveFiles(new BufferProvider(source), path.join(root, 'gap'), {
    ranges: [
      { offset: start, length: hwp.length - 1024 },
      { offset: start + hwp.length - 512, length: 512 + suffix.length }
    ]
  });
  assert.equal(readableHwpCandidates(crossingGap).length, 0);
}));

test('PrvText is optional for carving even though the bounded preview cannot display it', async () => isolated(async root => {
  const { bytes } = createHwpFixture({ includePrvText: false });
  const { result: validation } = await validate(bytes);
  assert.equal(validation.state, 'complete');
  assert.equal(previewHwp(bytes).type, 'unsupported');

  const carved = await carveFiles(new BufferProvider(bytes), path.join(root, 'output'));
  assert.equal(readableHwpCandidates(carved).length, 1);
}));

test('rejects signature-only data and a structurally valid non-HWP OLE file', async () => {
  const signatureOnly = Buffer.alloc(512);
  CFB_SIGNATURE.copy(signatureOnly);
  assert.notEqual((await validate(signatureOnly)).result.state, 'complete');

  const nonHwp = mutateFixture((bytes, layout) => {
    bytes.write('Not an HWP stream', layout.streams.FileHeader.offset, 'ascii');
  });
  assert.equal((await validate(nonHwp)).result.state, 'invalid');
});

test('rejects FAT cycles, miniFAT cycles, ownership overlap, and out-of-range chains', async t => {
  const cases = {
    'FAT cycle': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(layout.sectors.binData[0], layout.fatEntries[layout.sectors.binData.at(-1)]);
    }),
    'miniFAT cycle': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(0, layout.miniFatEntries[3]);
    }),
    'stream overlap': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(0, layout.directoryEntries.DocInfo.offset + 116);
    }),
    'out-of-range FAT sector': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(200, layout.fatEntries[layout.sectors.binData.at(-1)]);
    })
  };
  for (const [name, bytes] of Object.entries(cases)) await t.test(name, async () => {
    assert.equal((await validate(bytes)).result.state, 'invalid');
  });
});

test('rejects cyclic, unreachable, and duplicate directory structures', async t => {
  const cases = {
    'directory self-cycle': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(layout.directoryEntries.BodyText.index, layout.directoryEntries.BodyText.offset + 68);
    }),
    'unreachable allocated entries': mutateFixture((bytes, layout) => {
      bytes.writeUInt32LE(layout.directoryEntries.FileHeader.index, layout.directoryEntries['Root Entry'].offset + 76);
    }),
    'duplicate required name': mutateFixture((bytes, layout) => {
      const source = layout.directoryEntries.DocInfo.offset;
      const target = layout.directoryEntries.PrvText.offset;
      bytes.copy(bytes, target, source, source + 64);
      bytes.writeUInt16LE(bytes.readUInt16LE(source + 64), target + 64);
    })
  };
  for (const [name, bytes] of Object.entries(cases)) await t.test(name, async () => {
    assert.equal((await validate(bytes)).result.state, 'invalid');
  });
});

test('rejects invalid allocation markers and protected HWP documents', async t => {
  const invalidFatMarker = mutateFixture((bytes, layout) => {
    bytes.writeUInt32LE(CFB_MARKERS.END, layout.fatEntries[layout.sectors.fat[0]]);
  });
  assert.equal((await validate(invalidFatMarker)).result.state, 'invalid');

  for (const flag of [2, 4, 0x100, 0x200, 0x400]) await t.test(`protected flag 0x${flag.toString(16)}`, async () => {
    const { result } = await validate(createHwpFixture({ protectionFlags: flag }).bytes);
    assert.notEqual(result.state, 'complete');
  });
});

test('classifies CFB v4 and external DIFAT chains as unsupported', async () => {
  const version4 = mutateFixture((bytes, layout) => {
    bytes.writeUInt16LE(4, layout.header.majorVersion);
    bytes.writeUInt16LE(12, layout.header.sectorShift);
  });
  assert.equal((await validate(version4)).result.state, 'unsupported');

  const externalDifat = mutateFixture((bytes, layout) => {
    bytes.writeUInt32LE(layout.sectors.binData[0], layout.header.firstDifatSector);
    bytes.writeUInt32LE(1, layout.header.difatSectorCount);
  });
  assert.equal((await validate(externalDifat)).result.state, 'unsupported');
});

test('read errors, cancellation, file limits, and truncation never publish a readable HWP', async () => isolated(async root => {
  const { bytes, layout } = createHwpFixture();
  const ioError = Object.assign(new Error('synthetic validation read error'), { code: 'EIO' });
  await assert.rejects(() => validateHwpExtent(async () => { throw ioError; }, bytes.length, MAX_FILE_BYTES), { code: 'EIO' });

  const failingProvider = new BufferProvider(bytes, { failAfterReads: 1 });
  const failed = await carveFiles(failingProvider, path.join(root, 'read-error'));
  assert.equal(readableHwpCandidates(failed).length, 0);
  assert.ok(failed.warnings.some(warning => warning.code === 'READ_FAILED'));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => carveFiles(new BufferProvider(bytes), path.join(root, 'cancelled'), { signal: controller.signal }), { code: 'CANCELLED' });

  assert.equal((await validate(bytes, { maxFileBytes: layout.length - 1 })).result.state, 'limit');
  const limited = await carveFiles(new BufferProvider(bytes), path.join(root, 'limited'), { maxFileBytes: layout.length - 1 });
  assert.equal(readableHwpCandidates(limited).length, 0);
  assert.ok(limited.warnings.some(warning => warning.code === 'FILE_LIMIT'));

  const truncatedBytes = bytes.subarray(0, bytes.length - 512);
  assert.notEqual((await validate(truncatedBytes)).result.state, 'complete');
  const truncated = await carveFiles(new BufferProvider(truncatedBytes), path.join(root, 'truncated'));
  assert.equal(readableHwpCandidates(truncated).length, 0);
}));

test('saved-output revalidation refuses a structurally changed HWP and preserves only the partial artifact', async () => isolated(async root => {
  const { bytes, layout } = createHwpFixture();
  const provider = new BufferProvider(bytes, {
    mutateSecondWholeRead: output => output.writeUInt32LE(0x12345678, layout.header.transactionSignature)
  });
  const result = await carveFiles(provider, path.join(root, 'output'));

  assert.equal(readableHwpCandidates(result).length, 0);
  const warning = result.warnings.find(item => item.code === 'OUTPUT_VERIFICATION_FAILED');
  assert.ok(warning);
  assert.ok(warning.partialPath.endsWith('.carving-writing.partial'));
  assert.equal((await stat(warning.partialPath)).size, bytes.length);
  const partial = await readFile(warning.partialPath);
  assert.equal(partial.readUInt32LE(layout.header.transactionSignature), 0x12345678);
  assert.notEqual(sha256(partial), sha256(bytes));
}));
