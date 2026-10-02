# Disk and volume layout support

`engine/volume-layout.mjs` discovers filesystem volumes through an existing exact-read provider. It contains no raw-device open, mount, format, repair, or write operation.

## Selection contract

`discoverVolumes(provider)` validates a standalone NTFS, FAT12/16/32, or exFAT volume, an MBR partition table, or a GPT partition table. GPT acceptance requires valid primary and backup header CRC32 values, valid and identical primary and backup partition-entry arrays, array CRC32 values, usable-LBA bounds, non-overlapping partitions, and a valid supported filesystem boot region inside each returned volume. MBR validates the signature, status fields, non-empty entries, disk bounds, and overlap; extended/logical MBR partitions are reported as unsupported.

`openPartitionBytes(provider, descriptor)` accepts only a trusted descriptor returned for that same provider. It translates reads into the parent range and never closes the parent, so sibling partitions remain usable. The caller owns and closes the parent provider after all children finish.

`discoverVolumes(provider, { searchEmbeddedBoot: { maxBytes } })` optionally searches at sector boundaries for lost-table boot records. The default bound is 64 MiB and the hard bound is 256 MiB. Hits are returned separately as `recoveryCandidates` with `trusted: false`; they cannot be opened as trusted partitions. A future user-confirmed promotion flow must independently validate collision, source identity, and intended bounds.

## Unallocated ranges

`getUnallocatedRanges(volumeProvider)` returns byte ranges only after completing the relevant allocation metadata scan:

- NTFS uses the existing NTFS engine to validate the boot record, MFT, `$Bitmap` record, and volume bitmap stream. The layout layer reads the complete bitmap through that engine's current internal `volumeBitmap`, `info.clusterCount`, `info.clusterSize`, and `readStream` interface. If that interface changes or validation fails, the result is unsupported and requires an explicit whole-source choice.
- FAT12/16 reads all mirrored FAT copies and treats a data cluster as free only when every copy agrees on zero. FAT32 does the same while mirroring is enabled; when mirroring is disabled, it obeys the BPB active-FAT index and ignores inactive copies.
- exFAT follows the root-directory FAT chain, selects the allocation bitmap for the active FAT, validates its length and chain, and treats only clear bitmap bits as free.

Range construction is capped at 1,000,000 coalesced extents. Cancellation, malformed metadata, disagreeing mirrored FAT entries, partial reads, loops, or limit overruns return no partial range set. Deep scanning should default to these verified ranges. When `supported` is false, the UI must ask the user whether to scan the whole selected source and explain the additional time and read scope.

Sparse-file decoding is outside this layout module. It does not change the NTFS recovery engine's current sparse-file support.

Primary references:

- UEFI Forum, [GUID Partition Table disk layout](https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html), including primary/backup headers, usable LBAs, and header and partition-entry-array CRC32 requirements.
- Microsoft, [exFAT File System Specification](https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification), including boot regions, active FAT selection, cluster heap, and allocation bitmap.
- Microsoft, [Windows fastfat on-disk structures](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/fastfat/fat.h), alongside the Microsoft FAT32 File System Specification version 1.03.
