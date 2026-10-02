> 이 문서는 A1 단계의 역사적 엔진 기록입니다. 현재 0.2.0은 실제 GUI·Windows 공급자·FAT/exFAT·카빙·고급 NTFS와 연결되어 있습니다. 현재 사용법은 상위 README.md, 지원 범위는 SUPPORT.md 및 native 문서를 따르세요. 아래의 미완료·하드 링크 제한은 당시 상태이며 현재 상태가 아닙니다.

# NTFS 이미지 복구 엔진 · 첫 제작 단계

일반 NTFS 볼륨 이미지에서 삭제 표시가 남은 파일 기록을 찾고 선택 파일의 바이트를 별도 파일로 저장한다. Node.js 기본 모듈만 사용하며 추가 패키지·AI·인터넷·관리자 권한이 필요 없다. 현재 개발 실행에는 Node.js 22가 필요하다. 기존 Electron 실행파일에는 아직 연결하지 않았다.

현재 입력은 **NTFS 파티션의 첫 섹터부터 시작하는 일반 이미지 파일**이다. `C:`·USB 같은 실제 장치, 파티션 테이블을 포함하는 전체 디스크 이미지, VHD/VHDX 컨테이너는 지원하지 않는다. 시험은 프로그램으로 만든 합성 이미지에서 수행했다. Windows가 포맷한 실제 파일시스템 및 실제 삭제 장치의 결과를 입증한 단계는 아니다.

## 실행

RecoveryChat.GUI 폴더에서 실행한다.

```powershell
# 새 시험 이미지와 복구본, 원본 비교 보고서를 한 번에 생성
npm run demo:engine

# 독립 시험
npm run test:engine

# 개발 진행률
npm run progress
```

`demo:engine`은 `output/recovery-engine/run-*` 아래에 매번 별도 폴더를 만든다. 기존 파일이나 실제 장치에는 접근하지 않는다. 디스크 공간 정리는 자동 수행하지 않는다.

자신이 보유한 NTFS 볼륨 이미지를 명시적으로 지정하려면 다음 명령을 사용한다.

```powershell
node engine/cli.mjs scan --image "D:\images\volume.img"
node engine/cli.mjs recover --image "D:\images\volume.img" --record 24 --destination "E:\recovered"
```

파일 기록 번호는 검색 결과의 `recordNumber`다. 명령행 복구는 먼저 검색하고 해당 번호를 다시 읽어 확인한다. JSON 결과는 표준 출력, 진행 상황·오류는 표준 오류로 내보낸다. Ctrl+C로 취소할 수 있다. API 사용 시에도 `scanDeleted()` 뒤에 `recover()`를 호출한다.

## 현재 처리 범위

- 부트 정보, NTFS 3.0/3.1 버전, MFT 크기와 기본 저장 위치, 섹터 갱신 번호(USA), 속성 길이·범위·끝 검증.
- 삭제된 일반 파일의 이름·크기·수정일·남아 있는 부모 참조 수집. 부모 기록의 번호와 세대가 맞지 않으면 원래 경로는 `unknown`. 삭제 시각은 `null`.
- 레코드 안의 작은 데이터, 압축되지 않은 기본 비상주 데이터, 여러 데이터 구간과 음수 상대 위치를 해석하는 순서 복원.
- MFT 할당 비트맵과 볼륨 할당 비트맵 확인. 현재 사용 중인 공간, 잘못된 데이터 위치, 알려진 관리 영역과 겹치는 후보는 복구 거절.
- 후보 조회 후 선택한 파일만 복구. 이전 파일을 덮어쓰지 않는 파일별 새 폴더와 안전한 출력 이름 사용.
- 읽기 전용 입력, 최대 1MiB 단위 읽기·쓰기, 후보 최대 10,000개 기본 제한, 기록 이상 경고 최대 100개와 전체 이상 개수.
- 원본 파일 식별·크기·수정 정보와 선택한 MFT 기록을 다시 확인. 작업 중 원본 변경이 확인되면 완료 파일로 공개하지 않음.
- 중단 시 `.recovery-writing.partial`을 남기며 완료 파일로 표시하지 않음. 오류의 `details.partialPath`로 경로 제공.

`status: readable`은 현재 지원하는 구조에서 바이트를 읽을 수 있다는 뜻이다. 해시를 계산해도 삭제 전 원본이 없으면 원본 동일 여부를 알 수 없다. `originalIdentityVerified`는 항상 `false`다. 시험 보고서의 `fixtureBytesMatched`만 정답 시험 자료와의 비교 결과다.

`scan.complete: false`는 후보 제한이나 손상 기록 때문에 전체 해석을 완료하지 못했다는 뜻이다. 끝까지 읽었는지는 `stats.recordsRead/recordsTotal`, 손상 기록 수는 `malformedRecords`를 함께 본다. 손상 기록을 후보 없음으로 숨기지 않는다.

## 남은 범위

- 실제 Windows 장치 공급자, 관리자 읽기 모듈, 실제 물리 장치 매핑·다른 장치 출력 검사.
- GUI 연결, 사무용 PC 부하 측정, 큰 실제 볼륨과 Windows에서 삭제한 표본 시험.
- 파일별 내용·문서 구조 검사, 미리보기, 검색 조건·필터, 저장 공간 사전 확인과 사용자용 실패 안내.
- 압축·암호화·희소 속성, 초기화되지 않은 꼬리, 속성 확장 목록, 대체 데이터 스트림과 재분석점·링크·클라우드 자리표시자 파일은 현재 거절한다.
- 파일 구조 복구와 RAID·클라우드 복구는 현재 구현하지 않았다. FAT/exFAT·정밀 카빙·이름 의미 검색은 후속 단계다.
- 현재 출력 완료 처리는 하드 링크를 지원하는 파일시스템이 필요하다. FAT/exFAT 출력은 다음 저장 모듈에서 다룬다. 지원하지 않는 출력에서 실패하면 작업 파일 경로를 반환한다.
- 이미지 모드에서는 이미지 파일 자체를 수정하지 않지만 출력 장치와 이미지 보관 장치의 물리적 분리를 강제하지 않는다. 이 정책을 실장치 복구 모드에 적용해서는 안 된다.
- 원본 이미지가 다른 프로세스에 의해 변경되지 않는 작업 사본이라는 전제가 필요하다. 파일 정보 재확인은 물리 장치 스냅샷이나 악의적인 동시 변경에 대한 보장이 아니다.

## 설계 참고

외부 복구 엔진 소스를 복사하거나 동봉하지 않았다. 구조의 의미는 Microsoft의 [파일 기록 헤더](https://learn.microsoft.com/en-us/windows/win32/devnotes/file-record-segment-header), [속성 헤더와 저장 위치 목록](https://learn.microsoft.com/en-us/windows/win32/devnotes/attribute-record-header), [MFT와 할당 비트맵](https://learn.microsoft.com/en-us/windows/win32/devnotes/master-file-table) 문서를 참고했다. 공식 구조 설명도 적용 NTFS 버전의 범위를 명시한다.
