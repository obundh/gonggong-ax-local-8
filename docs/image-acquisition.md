# Stage 2 raw image acquisition core

`engine/image-acquisition.mjs` implements a bounded byte-for-byte acquisition path for F09 and F12. It works only with an already opened byte reader. It does not enumerate devices, request elevation, open a raw volume, choose an output disk, or close the reader.

This module is implementation and generated-fixture evidence. It is not a claim that F09, F12, or Stage 2 have passed on real hardware.

## Public interface

```js
import { acquireImage, verifyAcquisition } from './engine/image-acquisition.mjs';

const manifest = await acquireImage({
  reader,
  outputDirectory,
  source: { identity, kind, label, device },
  resume: false,
  signal,
  onProgress,
  readSize: 1024 * 1024,
  checkpointSize: 16 * 1024 * 1024,
  maxReadAttempts: 3,
  readTimeoutMs: 30_000,
  retryDelayMs: 50,
  maxDurationMs: 86_400_000,
  maxErrorRanges: 4096
});

const report = await verifyAcquisition(outputDirectory, {
  signal,
  onProgress,
  readSize: 1024 * 1024
});
```

The reader contract is:

```js
{
  info: { size, identity, sectorSize, sourceKind },
  read(offset, length, { signal }),
  assertUnchanged(),
  close()
}
```

`source.identity` and `source.kind` must exactly match `reader.info.identity` and `reader.info.sourceKind`. The core never calls `reader.close()`; its caller owns the reader lifetime. Every `read()` request is at most 1 MiB.

`outputDirectory` must already exist, be absolute, resolve to itself, and be empty for a new acquisition. The caller creates a unique directory after separately confirming that the destination is on an appropriate physical device. The core refuses links, an exchanged directory, exchanged artifact files, unexpected entries, and pre-existing output. Every owned artifact must have exactly one filesystem link; this prevents a substituted `image.raw` hardlink from causing truncation or writes to another name, including the original image. It does not delete unrelated files.

## Output and scope

The directory contains:

- `image.raw`: raw bytes for offsets `0..reader.info.size`.
- `acquisition.json`: the current atomic manifest.
- `acquisition.journal`: newline-delimited chunk records with a SHA-256 hash chain.

The manifest calls this a `volume-image` of the selected volume or existing image and explicitly records `wholePhysicalDisk: false`. Its advertised range includes allocated space, unallocated space, and filesystem slack that exist inside that selected byte source. It excludes bytes outside the selected volume or image. The core does not claim access to physical-disk regions that the reader did not expose.

The manifest records source identity, source size and sector size, acquisition scope, creation/start/finish times, bounded settings, state, image SHA-256, bytes written, readback status, retry/error ranges, zero-filled byte count, checkpoints, stop reason, and resume history.

Terminal state meanings are:

- `complete`: every advertised byte was read without an error, `assertUnchanged()` passed, and a full readback SHA-256 of `image.raw` matched the streamed bytes.
- `partial`: the full advertised range was visited, but one or more failed reads were replaced with zeros and listed in `readErrors`. This state is never marked complete.
- `cancelled`: cancellation was observed and the successfully written prefix was checkpointed. The image and history remain on disk.
- `error`: a terminal source, output, integrity, ledger, or time failure stopped acquisition. The committed prefix and failure reason remain on disk.

A readable source range that contains zero bytes creates no read-error entry. A failed read creates an entry with offset, length, error code, attempt count, and `zeroFilled: true`. The manifest also says that zero filler is not evidence of TRIM and does not prove that the source stored zeros. Adjacent identical failures are coalesced. If the bounded ledger cannot record a new distinct range, acquisition stops instead of silently omitting it.

## Checkpoints, cancellation, and resume

The default checkpoint block is 16 MiB and is assembled from reads no larger than 1 MiB. Memory use for data buffers does not grow with image size. A chunk record is committed in this order: sync raw bytes, append and sync the chained journal record, then atomically replace the manifest. If a process stops between these operations, the manifest is authoritative; resume truncates only the module-owned uncommitted tail.

Stable file/image source kinds `image`, `file`, `image-file`, and `raw-image` can resume. Resume requires the same recorded identity, kind, and size. Before admitting any mutation, it verifies single-link ownership, path-to-handle identity, every committed output chunk, unchanged artifact metadata, the manifest snapshot, the same source prefix, and `assertUnchanged()`. Only after all those read-only checks pass may it truncate an uncommitted tail or update state. A failed source, output, or prefix check therefore leaves the artifacts untouched. Acquisitions that already contain zero-filled read errors are not resumable because the same original prefix cannot be proven from those bytes.

Live-volume resume is rejected with `LIVE_RESUME_UNSUPPORTED`. A changing live volume must start a separate acquisition rather than presenting multiple volatile epochs as one consistent snapshot. `complete` and full-range `partial` states are also not resumable.

Cancellation is checked before work, between reads, while retrying, during resume verification, and during full verification. Cancellation after output creation records a `cancelled` manifest and retains the image. A cancellation before creation leaves no acquisition files.

## Bounded failures

Read retries, per-read timeout, retry delay, total run duration, error ranges, and resume history are capped. Short reads and ordinary media read errors are retried; they are never treated as a successful offset advance. Windows device/session change, helper close/failure/protocol errors, invalid geometry, disconnect, and source-change codes stop immediately without zero filler. A timeout is also terminal because a provider that ignored abort might still have an outstanding read; starting retries in that state could overlap native work. External cancellation races the reader promise directly, so a provider that ignores its abort signal cannot hold cancellation until the read timeout. Output writes loop until all bytes are accepted, and a zero/invalid short write or filesystem error such as `ENOSPC` stops with an error manifest. Successfully accepted prefix bytes are checkpointed without skipping the unwritten suffix. If the destination cannot allocate an atomic manifest replacement, the core removes only its own failed temporary and attempts a bounded in-place emergency update of the already allocated manifest. A filesystem that cannot update even those existing blocks may retain only the preceding running checkpoint; no program can guarantee a new stop record when the destination accepts no further metadata or data writes.

`verifyAcquisition()` rereads the journal and complete raw file with bounded buffers. It checks single-link ownership, artifact path-to-handle identity, artifact sizes, journal sequence and hash chain, every chunk SHA-256, full image SHA-256, and the relationship between `complete`, source size, read errors, and acquisition-time readback. It snapshots device/inode, size, link count, modification time, and change time for the manifest, image, and journal, then checks them again after hashing. A concurrent replacement or same-inode mutation fails verification instead of adopting a mixed-time image. `report.valid` describes internal artifact integrity. `report.complete` additionally requires the acquisition state to be `complete`. A valid `partial`, `cancelled`, or `error` artifact therefore remains incomplete.

Malformed manifests and unsafe/substituted paths throw an `ImageAcquisitionError`; ordinary post-acquisition byte/hash mismatches appear in `report.errors` with `valid: false`.

## Generated-fixture verification

`test/image-acquisition.test.mjs` creates only generated byte fixtures below `E:\RecoveryChat-Stage2-20260920\tests`. Each test verifies its randomly named child is directly below that exact canonical test directory before removing that child. The shared base directory is preserved.

The focused test covers:

- a known positive fixture whose source, `image.raw`, manifest SHA-256, and independent full verification hash match;
- the 1 MiB maximum reader request and multi-checkpoint streaming;
- real readable zeros versus recorded zero filler after bounded retries;
- short reads without offset skipping;
- cancellation, retained artifacts, and exact file-image resume;
- changed source prefix, changed output, and live-volume resume rejection;
- hardlinked `image.raw` rejection without changing the generated original;
- concurrent same-inode modification detection during verification;
- injected output-full behavior with a verifiable committed prefix;
- refusal to overwrite a non-empty output directory;
- tamper detection by chunk and full-image hashes.

Run it with:

```powershell
node --test test/image-acquisition.test.mjs
```

Remaining Stage 2 evidence includes real source/destination physical separation, real Windows volume acquisition, device removal, true destination-full behavior, operating-system write activity, 512e/4Kn and bridge variants, encryption states, SSD/TRIM limits, and comparison with an independently verified acquisition tool.
