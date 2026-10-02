# 2단계 F07/F08 읽기 계층 준비도

이 문서는 F07·F08 전체 완료 보고서가 아니다. 현재 구현은 Windows 메타데이터와 앱이 제공한 실행 경로를 읽어, 일반 복구 준비 상태와 향후 볼륨 이미지 수집 가능 여부를 구분해 보고한다. 원시 장치를 열거나 바이트를 읽지 않고, 관리자 권한을 요청하지 않고, 파일·작업 폴더·복구 작업을 만들지 않는다.

## F07 장치 메타데이터

`listWindowsDevices()`는 권한 상승 없이 `Get-Volume`, `Get-Partition`, `Get-Disk`를 사용한다. BitLocker cmdlet을 사용할 수 있으면 `Get-BitLockerVolume`을 읽고, 사용할 수 없으면 `Win32_EncryptableVolume` CIM 조회를 시도한다. 두 조회가 모두 불가능한 경우 암호화 상태는 `unknown`이다. 조회 실패를 `unlocked`로 바꾸지 않는다.

볼륨 항목에는 다음 필드가 추가된다.

```js
{
  scope: 'volume',
  physicalDisks: [{
    diskId,
    identity,       // Get-Disk UniqueId, SerialNumber, Path 순서로 관측
    identityKind,   // unique-id | serial-number | device-path | unknown
    model,
    serialNumber,
    size,
    interface,
    logicalSectorSize,
    physicalSectorSize
  }],
  physicalDiskIdentity,
  physicalDiskModel,
  partitionOffset,
  partitionNumber,
  sourceTopology,  // single-partition-single-disk | multi-partition-or-disk | unknown
  logicalSectorSize,
  physicalSectorSize,
  sectorProfile,   // 512n | 512e | 4Kn | unsupported | unknown
  interface,
  encryption       // locked | unlocked | unknown
}
```

값을 관측하지 못하면 `unknown`으로 남긴다. 여러 파티션 또는 디스크에 걸친 볼륨의 단일 파티션 오프셋이나 섹터 정보를 임의로 고르지 않는다. 잠긴 볼륨은 `ready: false`, `reason: 'LOCKED'`다. 암호화 상태가 `unknown`이라는 이유만으로 잠겼거나 해제됐다고 간주하지 않는다.

기존 Windows 볼륨 `identity`는 계속 `id`, `serial`, `size`, 정렬한 `diskIds`만 해시한다. 새 메타데이터를 해시 재료에 넣지 않았으므로 기존 선택·헬퍼 계약과 호환된다. 일반적인 볼륨 GUID `id`는 드라이브 문자가 바뀌어도 동일하다. GUID 없이 드라이브 문자만 식별자로 얻은 볼륨은 이 보장을 할 수 없으며 다시 선택해야 한다.

볼륨 ID가 같아도 교체된 물리 장치를 이전 선택으로 받아들이지 않도록 별도 `readLayerFingerprint()`를 대조한다. 물리 디스크 고유 ID/일련번호, 파티션 시작점·번호, 논리·물리 섹터 크기, 파일시스템과 단일 디스크 구조를 묶는다. 알 수 없는 계층은 `null`이며 수집 준비 완료의 근거가 되지 않는다. 장치 목록을 새로 읽을 때 계층이 바뀌면 새 원본 선택 ID를 만들고 이전 선택 스냅샷을 유지한다. 준비도 검사·수집 시작·실제 읽기 연결 직후에 이를 재확인한다. 읽기 도우미의 재사용 키에도 계층을 포함하며, 열린 핸들의 후속 변경 검사는 기존 네이티브 식별 검사로 계속 수행한다.

## 준비도 및 이미지 수집 게이트

`inspectSourceReadiness()`는 기존 반환 필드를 유지하면서 다음을 추가한다.

```js
{
  runtimeLocations: [{
    purpose,
    path,
    access,          // read-only | writable; 설명용이며 판정을 완화하지 않음
    canonicalPath,
    diskIds,
    physicalDiskIdentities,
    identity,
    identityStatus, // observed | current | changed | unavailable
    separation,     // separate | same | unknown
    checkId
  }],
  acquisition: {
    scope: 'volume' | 'not-applicable',
    canAcquire,
    reasons: [{ code, detail }],
    geometry: {
      status: 'supported' | 'unsupported' | 'unknown',
      profile: '512n' | '512e' | '4Kn' | 'unsupported' | 'unknown',
      logicalSectorSize,
      physicalSectorSize
    },
    sourceTopology: {
      status: 'supported' | 'unsupported' | 'unknown',
      kind
    }
  }
}
```

볼륨 이미지 수집의 `canAcquire`가 `true`가 되려면 다음 조건을 모두 만족해야 한다.

- 선택한 원본 식별 정보가 현재 목록과 일치하고 Windows가 볼륨을 준비된 상태로 보고해야 한다. 잠금이 관측되면 거절한다. 암호화 상태를 조회하지 못한 `unknown`은 그대로 보고하며, 이를 잠금 해제 또는 암호화 없음의 증거로 삼지 않는다.
- 고유 ID 또는 일련번호가 있는 단일 물리 디스크여야 한다.
- 512n, 512e, 4Kn 중 하나이며 단일 파티션·단일 디스크 구조와 파티션 오프셋을 확인해야 한다.
- 작업 공간, 출력 위치, 앱·헬퍼·로그·캐시·임시 위치가 원본과 다른 물리 디스크여야 한다.
- 출력 위치의 선택 당시 식별 정보가 현재 정보와 일치해야 한다.

조건을 알 수 없으면 거절 사유를 `*_UNKNOWN` 코드로 남긴다. 여러 파티션이나 디스크에 걸친 볼륨, 지원하지 않는 섹터 조합은 각각 `SOURCE_TOPOLOGY_UNSUPPORTED`, `GEOMETRY_UNSUPPORTED`다. 이 두 사유는 이미지 수집 게이트만 닫으며 기존 일반 복구 경로를 자동으로 차단하지 않는다.

`runtimePaths`는 선택적 입력이며 각 항목은 `{ purpose, path, access?, identity? }` 형식이다. 제공한 경로는 검사 시점에 다시 조회한다. `identity`를 제공하면 현재 볼륨 식별 정보와 비교한다. 실행 경로가 없으면 이전 호출자의 일반 준비도 결과는 유지하지만 이미지 수집은 `RUNTIME_PATHS_NOT_PROVIDED`로 거절한다. `access: 'read-only'`는 앱 또는 헬퍼 자체의 의도를 기록할 뿐, 같은 디스크 사용을 허용하는 예외가 아니다.

실제 볼륨에서는 작업 공간·출력·실행 위치가 같은 물리 디스크이거나 관계를 알 수 없으면 수집을 허용하지 않는다. 파일 이미지·폴더·문서 원본은 고정된 경로를 읽는 기존 방식이므로 같은 디스크 관계를 `warning`으로 보고하며 볼륨 수집 게이트 대상이 아니다.

## 제한

이 검사는 앱이 원본을 쓰기 모드로 열지 않는다는 기존 경로와 저장 위치 분리를 확인하는 소프트웨어 준비도 검사다. 하드웨어 쓰기 차단기 존재나 효과를 확인하지 않으며 이를 대신하지 않는다. 운영체제, 파일시스템, 백신, 다른 프로그램은 원본에 쓸 수 있다. SSD의 TRIM 요청, 컨트롤러 내부 정리, 전원 상태에 따른 NAND 변화도 멈추지 않는다.

볼륨 수집 범위는 `scope: 'volume'`이다. 물리 디스크 전체, 다른 파티션, 볼륨 밖 미할당 영역을 포함한다고 주장하지 않는다. 이 API는 이미지 파일을 생성하지 않고, 전체 이미지 해시·오류 구간·수집 이력·재개 이력을 검증하지 않는다. 그러한 기능은 F09~F12의 별도 수집 계층과 시험 증거가 필요하다.
