# NTFS image scan checkpoints

`engine/ntfs-image.mjs` can resume a cancelled deleted-record scan for an immutable NTFS image. Checkpoints contain progress metadata and record fingerprints only. They never contain volume bytes, Node buffers, file handles, provider references, or native pointers.

## API

- `image.exportCheckpoint()` is synchronous. It returns the most recent scan progress as a JSON-safe object. It throws `CHECKPOINT_UNAVAILABLE` before a scan has started and `CHECKPOINT_LIMIT` if a non-default scan accumulated more than 10000 candidates.
- `image.scanDeleted({ ..., resumeFrom: checkpoint })` validates and resumes a saved checkpoint. Restored candidates are emitted again through `onCandidate`, followed by newly discovered candidates. The returned `candidates`, `warnings`, `stats`, `complete`, and `truncated` fields have the same whole-scan meaning as a scan started at record zero.

The version 1 object is:

```text
{
  version: 1,
  nextRecord,
  recordCount,
  recordSize,
  volumeSize,
  malformedRecords,
  warnings: [{ recordNumber, code, message }],
  entries: [{ recordNumber, fingerprint }]
}
```

`warnings` is bounded to 100 entries while `malformedRecords` preserves the full count. `entries` is bounded to 10000. `nextRecord` is updated only after the current record and any candidate derived from it have been fully processed. Cancellation therefore exports the last safe resume boundary.

## Validation and limits

- Resume is allowed for `openNtfsImage()` and supplied providers whose `info.sourceKind` is exactly `image` or `volume-image`. Raw-volume providers fail with `CHECKPOINT_UNSUPPORTED`; they must be scanned again because live allocation can change independently of an exported checkpoint.
- Version, integer bounds, volume geometry, ordered and unique record numbers, warning bounds, and lowercase SHA-256 record fingerprints are checked before traversal resumes. Malformed input fails with `INVALID_CHECKPOINT`; it is never silently ignored.
- Every stored candidate record is read again. It must still be a deleted base record, remain free in the MFT bitmap, and match the stored fingerprint before its candidate is rebuilt through the normal allocation and metadata checks. A mismatch fails with `SOURCE_CHANGED`.
- The caller must also bind its persisted checkpoint to the immutable source identity and stable partition identity before passing `resumeFrom`. The engine validates NTFS geometry and saved candidate records; its compact format does not hash every earlier non-candidate record.
- Earlier malformed-record warnings remain in the resumed result, so `complete` remains false even if the remaining records are well formed.
- Starting another scan changes only the engine's in-memory candidate map and checkpoint. Previously recovered output files are not opened or modified.

The intended persistence envelope can store one engine checkpoint per stable partition identifier together with the application's separately verified source identity. Corrupt or mismatched state should be surfaced to the user as an explicit resume failure rather than falling back to a new scan without notice.

## 확장 기록 증거

각 entries 항목은 선택적인 extensions 배열을 포함합니다. 배열에는 recordNumber와 fingerprint(SHA-256)가 들어가며, 재개 시 현재 확장 기록을 다시 읽어 비교합니다. 파일당 최대 64개, 전체 체크포인트의 확장 기록 증거는 최대 10,000개입니다. 이전 일반 파일 체크포인트의 배열 생략은 빈 배열로 처리합니다.
