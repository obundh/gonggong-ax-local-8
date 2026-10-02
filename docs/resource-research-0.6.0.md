# 0.6.0 resource budget and SSD-internal research gates

This record separates a bounded candidate-store check from claims about deleted-body recovery. The check uses generated fixture candidates only. It does not enumerate a source disk, open raw storage, read private files, alter TRIM, issue power/device commands, or create/decrypt recovery content.

## Preset before execution

`scripts/verify-resource-budget.mjs` writes `budget-preset.json` before opening the engine. Its fixed run is 100,000 accepted fixture candidates plus 10,000 synthetic candidates intentionally beyond the engine cap. It measures import duration, one 20-row first page, the final 20-row page, timer delay while synchronous work holds this Node event loop, **RSS sampled after each synchronous batch**, and receipt/database size. It does not measure an operating-system peak-RSS trace.

The guards are: import and event-loop block at most 60 seconds; either 20-row page at most one second; sampled batch-boundary RSS at most 512 MiB per Node process; outputs at most 256 MiB; and exact first/tail IDs, an accepted count of 100,000, and exactly 10,000 limit rejections. The 512 MiB limit is deliberately a process guardrail suitable for an 8 GiB worker allocation. It is not evidence from an 8 GiB computer or an OS-peak-RSS guarantee.

Run:

```powershell
node --max-old-space-size=384 .\scripts\verify-resource-budget.mjs --engine .\engine --output E:\RecoveryChat-TenStage-0600-20260927\resource-research
```

## Executed receipt

The final Node 22.23.1 receipt used the 384 MiB V8 old-space cap and passed on 2026-09-27 in `E:\RecoveryChat-TenStage-0600-20260927\resource-research\resource-budget-YveRQM`: 100,000 accepted, 10,000 rejected at the explicit limit, import 6,360.43 ms, first page 142.24 ms, tail page 290.88 ms, maximum **batch-boundary sampled** RSS 113.00 MiB, and output 62.97 MiB. The tail at offset 99,980 contained `fixture-000019` through `fixture-000000`, so the final candidates were present and ordered.

The import's timer delay was 6,335.39 ms because `setBatch()` is synchronous in this process. It remains inside the 60-second bounded budget, but it must remain behind the existing worker boundary; this result does not make it safe to run the import on an interactive UI event loop. The receipt database was written beneath E:, so its I/O timing also reflects the attached XrayDisk volume and current host load; it is not a P5 Plus or 8 GiB-device benchmark.

## Machine boundary (read-only inventory)

The run host reports AMD Ryzen 7 5700X3D (8 cores/16 logical processors) and 31.89 GiB physical RAM. Its C: volume maps to the 931.51 GiB Crucial CT1000P5PSSD8; E: maps to the 476.94 GiB XrayDisk 512GB PRO. Therefore this is not an 8 GiB-machine performance test, and it does not identify the XrayDisk controller, firmware, encryption state, or internal translation metadata. C: and E: were recorded only through read-only CIM inventory.

## R01–R06 research ledger

| ID | Attempted action | Evidence and bounded finding | Remaining requirement | Park condition | Restart criterion |
| --- | --- | --- | --- | --- | --- |
| R01 | Identify attached media without raw reads | Read-only CIM maps C: to CT1000P5PSSD8 and E: to XrayDisk 512GB PRO. Crucial's P5 Plus product flyer lists TRIM support, ECC, and full-drive-encryption capability (TCG Opal 2.0). | Exact model/firmware/controller documentation for every target medium, plus a lawful forensic acquisition plan. | Hardware identity alone cannot expose FTL tables or deleted NAND pages. | Target model, firmware, lawful acquisition authority, and a documented non-destructive interface are supplied. |
| R02 | Establish what host-visible deletion can say | Microsoft documents that NTFS can send TRIM hints for normal deletes; the SSD may apply, defer, or discard a hint. Microsoft also warns that SSD free space may have been overwritten. | Per-target observation of host commands and device behavior, without modifying a real loss medium. | Host-visible metadata cannot prove physical NAND retention or erasure. | A sacrificial, consented model-specific test device and a write-blocked acquisition workflow are available. |
| R03 | Evaluate FTL/ECC feasibility from primary sources | Micron explains that NAND management needs controller/firmware functions including ECC, bad-block management, wear leveling, and FTL. No FTL mapping, ECC parity, or controller debug material was accessed. | Vendor/controller forensic interface, firmware-specific format, NAND geometry, and independently reproducible interpretation. | Do not claim raw-page reconstruction or a novel recovery algorithm. | Vendor documentation or a legally obtained, reproducible laboratory method is available. |
| R04 | Evaluate encryption gate | The official P5 Plus flyer says the model is capable of TCG Opal 2.0 full-drive encryption; capability does not establish enablement. Micron describes cryptographic erase as destroying the encryption key. No credential, key, Opal state, or secure-erase action was requested or read. | Verified security state and lawful decryption authority for the specific device; key material must remain outside this project/chat. | Encryption state/key absence blocks content claims. | The owner provides authorized, non-secret evidence of state and a separate approved handling procedure. |
| R05 | Preserve baseline evidence and park a new hypothesis | Baseline only: the 0518 `fixed-summary.json` has 286 fixed synthetic runs; several `split-sparse` groups changed from 0/10 exact on 0.5.17 to 10/10 on 0.5.18. That is an already implemented synthetic-fixture observation, not a new solution. **Proposed, unproven hypothesis:** a fixture corpus that independently varies sparse-run boundary order and initializedness can reject a candidate when its returned bytes match a zero-heavy decoy hash despite a known non-zero expected hash. Test it with a newly generated, blinded corpus of at least 20 cases, precommitted expected hashes, and a separate verifier; reject the hypothesis if any verifier-labelled exact output has the decoy hash or any expected hash is omitted. | Independent fixture generator, blinded expected-hash manifest, and verifier distinct from the generator; real-media comparison still requires R01–R04 gates. | No novel algorithm, SSD-body recovery, or causal improvement is claimed. | The independent test passes its precommitted acceptance/rejection rule and is reproduced by a second verifier. |
| R06 | Classify the known 35 failures without overreach | Permitted 0518 summary metadata now includes `slot-summary.json`, `verified-live-outputs.json`, and `live-summary.json`. The correction records the parent-audit label **29 reused slots observed after query time** and **6 zero-heavy hash mismatches** as observed metadata to be preserved, not re-derived physical facts: the available summaries contain 29 verified-live-output records and `native.nonexactSaved: 6`, but no per-entry query-time field and no raw-body inspection occurred. Class: **observed metadata reused / zero-heavy / model unobservable**. It does not establish TRIM timing, garbage collection, physical overwrite, crypto erase, ECC failure, or body recovery. | The exact 35-failure receipt/definition, a timestamped query-to-read trace, and physical-state evidence if an SSD causal statement is wanted. | Summary metadata cannot determine the storage model or timing cause. | Parent supplies the canonical failure receipt and a separately authorized model-specific lab protocol. |

## Source limits

- [Crucial P5 Plus product flyer](https://eu.crucial.com/content/dam/crucial/archive/ssd/p5-plus/b2c/crucial-P5-plus-productflyer-consumer.pdf): capability statement for this Crucial model only; it does not report this host's current security state or controller internals.
- [Microsoft on TRIM/Unmap hints](https://learn.microsoft.com/en-us/windows/compatibility/new-api-allows-apps-to-send-trim-and-unmap-hints): operating-system/host behavior; it does not prove a particular SSD's internal timing.
- [Microsoft Windows File Recovery](https://support.microsoft.com/en-us/windows/experience/backup-recovery/windows-file-recovery): user-facing recovery boundary, including SSD overwrite risk; it is not a low-level SSD forensic method.
- [Micron on NAND management](https://www.micron.com/products/storage/nand-flash/choosing-the-right-nand): general controller/FTL/ECC framing; it does not provide this device's FTL map.
- [Micron product security center](https://www.micron.com/about/company/product-security-center): general cryptographic-erase explanation; it does not establish any attached drive's key state.

## F43–F48 partial gates

| Gate | Status | Meaning |
| --- | --- | --- |
| F43 | Parked | Media-repeat verification needs the same controlled medium and a repeatable acquisition protocol; this fixture-only candidate-store run performs neither. |
| F44 | Parked | Delete timing, elapsed time, and intervening-write conditions need a controlled sacrificial-medium experiment. No real deletion or write was performed here. |
| F45 | Parked | Discovery and body-capture latency require timed end-to-end capture on an authorized medium. The measured values cover only synthetic candidate-store import/pagination. |
| F46 | Partial | The 100,000-plus-10,000 fixture capacity run met its preset on the current engine, including sampled batch-boundary RSS. It is not an 8 GiB-machine test; repeat on a constrained 8 GiB target with an OS-peak-RSS monitor. |
| F47 | Parked | Application lifecycle, permissions, sleep, and disconnect behavior were not exercised by this non-interactive Node receipt. |
| F48 | Outside this subtask | This resource run did not build a package. The parent-selected final package is assessed separately in ten-stage-closeout-0.6.0.md and the release acceptance receipt. |
