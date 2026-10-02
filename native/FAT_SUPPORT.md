# FAT-family recovery support

The FAT reader lives in `engine/fat-volume.mjs` and uses the same exact-read provider contract as the NTFS engine. It contains no device-opening, write, mount, format, or shell code. A caller reads the first 512 bytes and selects `openFatProvider(provider)` when the OEM bytes are `EXFAT   ` or when the sector and cluster fields form a valid FAT12/16/32 BPB; `NTFS    ` at bytes 3–10 selects the NTFS provider instead.

Implemented recovery scope:

- FAT12, FAT16, and FAT32 boot-region and table-bound validation. FAT12/16 mirrored copies, and FAT32 copies while mirroring is enabled, must agree for every allocation entry used as recovery evidence. FAT32 with mirroring disabled reads only the BPB-selected active FAT.
- Iterative traversal of the fixed FAT12/16 root, FAT32 root chain, and active subdirectories, with entry, directory, and chain-loop limits.
- Deleted short directory entries. The lost first short-name byte is shown as `?`. Surviving long-name fragments are used only when their Unicode and short-name checksum evidence remain internally possible.
- Single-cluster classic FAT files only when the current FAT entry is currently free. Empty files are supported. Multi-cluster deleted classic FAT files are reported as `unsupported` because cleared FAT links do not prove the old order. A contiguous-cluster guess is explicitly refused.
- exFAT inactive file entry sets, including sets which cross adjacent clusters in the directory chain, with the deletion bits restored for entry-set checksum verification, valid stream and filename secondaries, valid Unicode, and allocation-bitmap checks. exFAT uses only the active FAT selected by its volume flags; its two-FAT mode does not use classic FAT mirroring semantics.
- exFAT `NoFatChain` contiguous extents when the surviving stream metadata proves that layout and every cluster is currently free. FAT-linked exFAT files are readable only when an exact, finite chain survives and every referenced allocation-bitmap bit is free.
- Before recovery, after copying, and before publication, the provider identity, record fingerprint, chain evidence, and current free-allocation state are checked again.

Candidates with allocated clusters are `conflict`. Invalid starts, missing or looping chains, disagreeing mirrored FAT entries, malformed names, invalid checksums, aggregate chain-metadata limit overruns, and ambiguous classic FAT multi-cluster layouts are refused or reported as warnings. Deletion time is always `null`; FAT modification timestamps are retained only as modification evidence. A saved result is hashed, but `originalIdentityVerified` remains `false` unless an independent original hash is available outside this module.

Primary format references:

- Microsoft, [exFAT File System Specification](https://learn.microsoft.com/en-us/windows/win32/fileio/exfat-specification), especially volume layout, allocation bitmap, directory entry sets, `SetChecksum`, and `NoFatChain`.
- Microsoft, *Extensible Firmware Initiative FAT32 File System Specification, FAT: General Overview of On-Disk Format*, version 1.03. The historical Microsoft download is no longer consistently served; the format definitions are also reflected in Microsoft's [Windows fastfat sample structures](https://github.com/microsoft/Windows-driver-samples/blob/main/filesys/fastfat/fat.h).
