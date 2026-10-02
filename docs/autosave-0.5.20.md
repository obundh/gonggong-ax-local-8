# 0.5.20 — Office 자동 복구 위치의 사본 찾기

`도구 · 안내 → 저장하지 못한 문서 · 자동 저장본 → 자동 저장 위치 한 번에 찾기`로 시작한다. 직접 찾기와 질문으로 찾기에서 같은 검색을 사용한다. 저장 위치는 후보를 고르고 사본을 저장할 때 선택한다.

## 지원 범위

Windows 사용자 홈 아래 다음 기본 위치만 확인한다. 설치된 Office 앱이나 실제 앱 설정을 읽은 결과가 아니다.

- `AppData/Local/Microsoft/Office/UnsavedFiles`
- `AppData/Roaming/Microsoft/Word`
- `AppData/Roaming/Microsoft/Excel`
- `AppData/Roaming/Microsoft/PowerPoint`

지원 문서 확장자와 `.asd`, `.wbk`, `.tmp`, `.bak`, `.xar`, 확장자 없는 파일을 후보로 표시한다. Office 소유자 표시 파일(`~$`)과 실행 파일은 제외한다. 파일 본문을 자동으로 읽거나 변경하지 않는다. 앱 출처·발견 위치·사본 수정 시각을 표시하고 수정일 최신순으로 정렬한다. 수정 시각은 문서 버전이나 삭제 시각의 증거가 아니다.

기본 전체 한도는 후보 2,000개, 확인 파일 20,000개, 방문 폴더 2,048개, 경과 시간 10초다. 일시정지 시간도 경과 시간에 포함하며 개별 파일시스템 요청을 강제 중단하는 실시간 보장은 아니다. 한도·읽기 오류와 검사하지 못한 범위를 작업 기록과 경고에 남긴다. 연결 지점은 따라가지 않는다. 원본 폴더 식별자와 파일 식별 정보가 달라지면 미리보기·저장을 중단한다. 검색 폴더 안에는 작업 공간이나 출력 폴더를 만들지 않는다.

저장 시 원래 발견된 파일 이름을 사용해 별도 파일로 복사하고 저장 바이트를 검사한다. 기존 사본의 출처를 결과와 JSON에 보존한다. `originalIdentityVerified:false`와 `relationship:unknown`을 유지한다. 같은 파일명이나 수정 시각만으로 삭제 전 문서와 같다고 판정하지 않는다.

## 남은 한계

사용자가 바꾼 자동 복구 위치는 `다른 백업 폴더 선택`으로 직접 지정해야 한다. HWP 앱별 자동 복구 위치, 클라우드 버전 기록, VSS, 파일 기록 탐색은 이번 범위에 포함하지 않았다. `.asd` 등의 전용 문서 변환과 문서 앱 전체 열림은 보장하지 않는다. 임시 파일이 단순 조각인지, 어떤 원본과 관련됐는지, 어느 버전이 최신인지는 아직 자동 판정하지 않는다.

Microsoft 안내의 [이전 Office 파일 버전 복구](https://support.microsoft.com/en-us/office/collab-files/recover-an-earlier-version-of-an-office-file)와 [Word 복구 파일 안내](https://support.microsoft.com/en-us/word/recover-your-word-files-and-documents)는 자동 복구 자료가 남아 있는 조건과 사용자 확인 절차를 설명한다. 이 기능은 이미 남은 로컬 파일만 찾는다. 새 백업·스냅샷을 만들거나 상시 감시하지 않는다.

## 검증과 인수

`test/autosave-search.test.mjs`는 기본 위치, 확장자 범위, 누락과 오류 구분, 중복, 전역 한도, 취소, 연결 지점과 변경된 폴더를 검사한다. `test/autosave-jobs.test.mjs`는 실제 Worker로 목록·미리보기·정확한 사본 저장·출처 보존·원본 변경 거절을 검사한다. `test/electron-autosave.mjs`는 임시 Office 폴더 2곳의 문서/임시 자료 5개로 두 UI 모드의 실제 IPC·Worker·저장 흐름을 검사한다. 폴더 위치와 저장 대화상자의 선택값만 시험 입력이다.

상세 실행 로그, 스크린샷, 패키지 대조와 최종 인수 기록은 `E:/RecoveryChat-Autosave-0520-20260927/`에 보관한다. Office 앱 자체가 생성한 자동 복구 파일을 수집한 시험이나 실제 SSD 삭제·복구율 재측정은 아니다. F38은 일부 구현이며 **필수 인수 19/54(35.2%)**를 유지한다.
