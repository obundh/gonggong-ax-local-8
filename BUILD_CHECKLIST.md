> **개발 이력 문서입니다.** 아래 수치·미지원 상태·실행 경로는 작성 당시 기록이며 최신 상태가 아닐 수 있습니다. 현재 상태는 [공개 현황](docs/STATUS.md)을 따릅니다. 기존 구현표 103/103과 현재 필수 인수 21/54는 서로 다른 기준입니다. 로컬 원자료 전체는 공개하지 않습니다.

# RecoveryChat.GUI 개발 체크리스트

**개발 진행률: 103/103 (100.0%)**

이 수치는 BLUEPRINT 기능표의 모든 항목을 같은 비중으로 계산한 완료 기능 수이다. 조건부 항목도 기본 분모에 포함한다. 제외 항목은 기능표에 없으므로 분모에 넣지 않는다. 시간 추정이나 파일 복구 성공 확률이 아니다.

## 현재 마일스톤

- **0.3.7 본문 복구 확인과 원래 이름 복원** — 확인 가능한 본문 저장, 저장본 재읽기 검증, 근거가 있는 이름 복원, 결과별 내용 확인을 연결한다. 최종 시험·배포 결과는 `dist/release-0.3.7.json`에 기록한다.
- 새 체크: 동일 파일 이름 이력 연결, 모호한 이력 보류, 저장본 전체 크기·해시 일치, 문서 검사 한계 구분, 복구본 미리보기와 변경 감지, 결과 덮어쓰기 방지, 취소 시 완료 미표시, 배포본 일치.

- **0.3.6 빠른 삭제 이력 검색 GUI 연결** — Windows NTFS의 전체·기간 검색을 네이티브 삭제 이력 경로로 연결하고, 빈 기록 추가 탐색과 선택 시 내용 확인을 제공한다.
- 구현: 작업자 연결, 미리보기·저장 전 재검증, 이전 이름 이력 표시, 추가 탐색 버튼.
- 검증과 패키지 결과: `dist/release-0.3.6.json`에 최종 결과를 기록한다.
- 한계: 앞선 실제 C: 시험에서 작은 TXT/PDF 3개를 삭제 직후 복구했다. 오래된 파일이나 큰·조각난 파일의 성공률, 어제 삭제한 사용자 파일 33개의 복구는 확인되지 않았다. 이번 GUI 연결 시험은 사용자 파일을 삭제하지 않는다.

## 단계 순서

1. **A. 이미지 기반 NTFS 기초** — NTFS 볼륨·파티션 이미지와 검증된 공급자를 읽기 전용으로 분석한다. (11/11)
2. **B. 실제 Windows 장치와 별도 출력** — 실제 장치의 읽기 전용 접근과 원본과 다른 물리 장치 출력의 안전 조건을 연결한다. (13/13)
3. **C. 안내 GUI와 일반 이름 검색** — 버튼형 안내, 후보·미리보기, 현재 남은 파일의 이름 검색을 연결한다. (63/63)
4. **D. 카빙** — 기록 없는 영역에서 제한한 형식만 추출하고 임시 출력을 관리한다. (9/9)
5. **E. 파일명 임베딩과 백업** — 선택적 의미 검색과 지원 앱의 자동 저장·백업 경로를 더한다. (5/5)
6. **F. 파일시스템·고급 복구 확대** — 다른 파일시스템 및 확인된 복잡 속성·다중 구간 복구를 확대한다. (2/2)

## A. 이미지 기반 NTFS 기초

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| NT-01 | 테스트용 디스크 이미지와 지원 장치의 읽기 전용 데이터 공급자 | 1차 | 완료 | 합성 NTFS/FAT/exFAT 이미지와 read-only provider 시험. 실제 원시 장치 읽기는 미실증이다. |
| NT-02 | NTFS 볼륨 기본 구조와 파일 관리 기록(MFT) 읽기·유효성 확인 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-03 | 삭제 상태의 파일 기록 탐색, 남은 이름·크기·속성 수집 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-04 | 부모 폴더 기록이 유효할 때 원래 경로 구성, 불확실하면 경로 미확인 표시 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-05 | 파일명·확장자·종류·확인 가능한 날짜 필터 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-06 | 기록 안에 들어 있는 작은 데이터와 외부 저장 영역의 기본 데이터 읽기 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-07 | 유효한 저장 위치 목록을 해석하고 파일 순서대로 읽기 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-08 | 기록 재사용·현재 할당 여부·잘못된 위치·범위 초과 등을 검사하고 불확실성 표시 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-09 | 먼저 파일 후보 목록을 제공하고, 선택한 파일의 내용 읽기·복구 수행 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-10 | 삭제 시각을 확인할 수 없는 경우 ‘모름’ 표시. 수정일·마지막 목격일을 삭제 시각으로 바꾸지 않기 | 1차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |
| NT-11 | 검증된 다중 구간 파일 복구 범위 확대 | 2차 | 완료 | ntfs-image.mjs 구현과 ntfs-image/ntfs-safety/ntfs-advanced/checkpoint 합성 시험. |

## B. 실제 Windows 장치와 별도 출력

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| OUT-01 | 쓰기 작업 전에 원본과 다른 물리 장치의 작업 폴더 지정 | 1차 | 완료 | 동일 물리 디스크·runtime 분리 guard를 구현·합성 시험했다. 실제 장치/UAC는 미실증이다. |
| OUT-02 | 드라이브 문자가 달라도 같은 물리 장치면 제한, 관계를 확인 못하면 안내 | 1차 | 완료 | disk identity 불명·동일 disk를 fail-closed로 처리하는 unit/integration 시험. 실제 장치는 미실증이다. |
| OUT-03 | 출력 권한·여유 공간·파일시스템의 파일 크기 한계 확인 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-04 | 선택 파일만 복구하거나 임시 복구된 파일을 최종 보관 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-05 | 기록이 확인되는 범위에서 폴더 구조 보존, 알 수 없는 경로는 별도 폴더 사용 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-06 | 동일 이름 충돌 시 기본적으로 덮어쓰지 않고 번호·별도 폴더 사용 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-07 | 출력 경로의 잘못된 문자·상위 경로 이동·예상 폴더 밖 저장 방지 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-08 | 진행 중 임시 파일과 완료 파일 분리, 중단 파일을 정상 저장본으로 표시하지 않기 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-09 | 파일별 저장 완료·부분 저장·쓰기 실패·확인 불가 표시 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-10 | 실패한 항목 재시도, 저장 위치 바꾸기, 성공한 파일 유지 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-11 | 결과 폴더 열기·결과 목록 저장·다른 후보로 돌아가기 | 1차 | 완료 | job-service/job-worker 출력 경계와 합성 복구·저장 시험. |
| OUT-12 | 임시 파일과 최종 보관본 구별, 사용자가 정리할 대상·용량을 확인한 뒤 정리 | 1차 | 완료 | test/cleanup.test.mjs 2/2: exact reviewed manifest, 변경·새 파일 제외, 정상 .tmp/.partial 보존, 결과 폴더와 미리보기 처리. packaged Electron 미리보기→복구→정리 후 복구본 해시 불변을 확인했다. |
| OUT-13 | 정답이 있는 시험에서는 원본·복구본 해시 비교, 실사용에서는 확인된 검사 범위만 표시 | 1차 | 완료 | 합성 정답 이미지의 선택 복구 SHA-256과 원본 불변을 ntfs/job-service/carving 시험으로 확인했다. |

## C. 안내 GUI와 일반 이름 검색

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| UI-01 | 소형 창, 제목 표시줄 드래그, 최소화·최대화·닫기, 창 크기 변경 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-02 | 한 번에 질문 하나와 소수의 선택 버튼 표시 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-03 | 사용자가 누른 답을 내 말풍선으로 남기고 현재 단계 표시 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-04 | 파일명 등 글로 답할 때만 입력창 표시, 제출하면 숨기기 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-05 | 질문별 구체적인 입력 예시, 한글 입력 중 Enter 오작동 방지 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-06 | 모름·건너뛰기·이전 답 수정·처음부터 시작 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-07 | 검색 위치·조건을 짧게 요약하고 수정 가능하게 표시 | 1차 | 완료 | app.js 단서 요약·수정 및 새 검색 시 모든 결과 조건 초기화. packaged Electron 조건 회귀 시험에서 종류 단서, 이름 조건 해제, 한국 시간 자정 날짜, 재시작 초기화를 확인했다. |
| UI-08 | 도움말, 단계별 용어 설명, 키보드 이동·확대 글자·고대비 대응 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-09 | 검색 중에도 후보를 열어보고 안내 대화로 돌아오기 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| UI-10 | 시뮬레이션과 실검색을 명확히 구별하고 가상 파일을 실결과에 섞지 않기 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-01 | 직접 삭제 / 갑자기 보이지 않음 / 원인 모름 분기 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-02 | 휴지통 확인 여부와 휴지통 비우기 여부를 별도로 처리 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-03 | 휴지통에 파일이 있으면 기존 복원 경로 안내 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-04 | 일반 삭제·Shift+Delete 등 답을 검색 순서 참고로 사용, 절대적인 삭제 상태로 단정하지 않기 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-05 | 드라이브·장치·폴더 선택, 연결된 장치와 사용 가능 상태 표시 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-06 | 파일명 일부·확장자·종류·원래 위치·마지막으로 본 시점 입력 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-07 | 공유 폴더·클라우드·온라인 전용 파일·미연결 장치 경로 구별 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-08 | 물리 장치와 볼륨·드라이브 문자 매핑, 원본 장치 식별 | 1차 | 완료 | windows-device.mjs의 volume/disk 안정 식별과 windows-device.test.mjs. 실제 Windows 메타데이터 열거·출력 위치 물리 식별의 내부 일관성을 시험했고 원시 장치 탈착/재연결은 미실증이다. |
| IN-09 | 파일시스템과 읽기 권한·장치 잠금·지원 여부 확인 | 1차 | 완료 | 장치 ready·파일시스템·권한 오류 경계와 windows-device.test.mjs. 실제 잠긴 장치는 미실증이다. |
| IN-10 | 원시 장치 접근 등 필요한 작업 직전에만 관리자 권한 요청 | 1차 | 완료 | NEEDS_ADMIN일 때만 고정 helper elevation을 요청하고 elevation spec을 단위 시험했다. 실제 UAC/raw-volume은 미실증이다. |
| IN-11 | 원본이 시스템 장치일 때 앱 외의 Windows 쓰기까지 막는 것은 아니라고 안내 | 1차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| IN-12 | 저장되지 않은 새 문서는 삭제 파일과 다르므로 자동 저장·복구 기록 확인 경로 안내 | 2차 | 완료 | app.js/index.html/electron bridge 구현 검토와 packaged Electron GUI smoke 2/2. |
| CP-01 | 선택한 위치에서 현재 존재하는 파일명 검색 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-02 | 일부 이름·공백·구분자·오탈자 등 일반 문자열 유사도 검색 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-03 | 복사본·최종·수정본·날짜 접미사 등 이름 변형 후보 찾기 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-04 | 파일 종류·크기·수정일·경로로 후보 좁히기 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-05 | 서로 비교 가능한 파일의 해시로 내용 동일 후보 묶기 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-06 | 이미 존재하는 파일은 위치 열기 또는 다른 장치로 복사 | 1차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CA-01 | 우선 후보 3~5개와 더 보기, 전체 개수·현재 확인 범위 표시 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-02 | 파일명·경로·크기·확인 가능한 날짜·발견 이유 표시 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-03 | 삭제 기록 / 정밀 추출 / 현재 남은 파일 등 발견 출처 표시 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-04 | 이름 비슷함 / 파일명 의미 비슷함 / 비교한 파일끼리 동일 등 판단 근거 구별 | 1차·2차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-05 | 새 후보는 누적하되 보고 있는 카드와 선택 상태가 갑자기 이동하지 않도록 처리 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-06 | 여러 파일 선택·선택 해제·선택 항목 확인, 필터 변경 후 선택 유지 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-07 | 이름·종류·크기·날짜 필터와 사용자 정렬 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-08 | 여기에 없음 → 다른 후보·검색 범위 확대·다른 검색 종류 제안 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-09 | 이미지·텍스트·PDF의 제한적 미리보기 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-10 | Office·HWP·HWPX 미리보기와 구조 검사 | 2차·조건부 | 완료 | OOXML/HWPX 안전 XML과 HWP 5 PrvText의 제한 미리보기·구조 검사를 file-preview/hwp-preview 시험으로 확인했다. |
| CA-11 | 작성 중·암호 설정·미지원·손상으로 미리보기 불가한 이유 구별 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| CA-12 | 미리보기에서 매크로·외부 연결·실행 파일을 자동 실행하지 않기 | 1차 | 완료 | candidate/filter/preview 구현과 file-preview·hwp-preview·packaged GUI 검토. |
| JOB-01 | 검색 중에도 창·버튼이 응답하도록 UI와 실제 작업 분리 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-02 | 현재 단계·읽은 범위·발견 수·선택 수 표시 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-03 | 속도를 관찰해 예상 남은 시간 범위를 갱신, 불확실하면 계산 중 또는 예측 어려움 표시 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-04 | 유력 후보 발견 / 주기적 진행 상황 / 완료 시 알림 선택 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-05 | 후보를 좁힐 단서가 없으면 ‘유력 후보’ 알림을 약속하지 않기 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-06 | 주기 알림은 매번 답을 요구하지 않고, 후보는 언제든 확인 가능 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-07 | 검색 취소와 중지 처리 중 상태, 완료된 후보·출력 보존 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-08 | 일시정지·이어하기는 엔진에 안전한 중단 지점이 구현된 범위에서 제공 | 조건부 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-09 | 앱 재실행 후 이어하기, 작업 기록 복원과 원본 장치 재확인 | 2차·조건부 | 완료 | history 재선택·source identity 확인과 NTFS image checkpoint resume을 시험했다. raw volume은 재개하지 않고 재검색한다. |
| JOB-10 | 최소화 상태에서도 계속 검색, 닫기와 작업 종료를 명확히 안내 | 1차 | 완료 | 최소화/복원과 busy close 확인 대화·dispose를 electron/main.cjs에 구현했다. 실제 장시간 작업 수명주기는 미실증이다. |
| JOB-11 | 이름·날짜 변경은 후보 재평가, 원본 변경은 별도 작업으로 처리 | 1차 | 완료 | worker/job-service 상태 전이·checkpoint·packaged GUI 시험. |
| JOB-12 | 절전·장치 분리·프로그램 오류 후 중단 상태 처리 | 1차 | 완료 | worker error/cancel/source drift 중단 상태를 구현·시험했다. 실제 절전·분리/재연결은 미실증이다. |
| SYS-01 | 후보 없음 / 범위 일부 미검사 / 권한 없음 / 잠긴 장치 / 사용자 중단 구별 | 1차 | 완료 | Worker 한 작업·청크/메모리/후보 제한. candidate-store.test.mjs에서 반복 인덱스 가져오기에도 10,000개 한도 유지 및 기존 후보 갱신을 확인했다. |
| SYS-02 | 장치 연결 끊김·읽기 실패·출력 공간 부족·쓰기 실패별 안내와 다음 행동 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-03 | 재연결된 장치의 식별, 읽기 오류 재시도 횟수 제한 | 1차 | 완료 | 안정 device identity 재확인과 제한된 실패 경계를 구현했다. 실제 재연결 장치 시나리오는 미실증이다. |
| SYS-04 | 한 번에 정밀 작업 하나, 자료를 나눠 읽기, 후보 페이지 나누기 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-05 | 큰 파일·복잡한 미리보기의 처리 크기·시간 제한 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-07 | 기본 오프라인 처리, 파일 내용·이름의 자동 업로드 없음 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-08 | 최소한의 진단 기록과 사용자용 결과 목록 구별, 기록 저장 위치·지우기 제공 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-09 | 실행 압축 해제·사용자 데이터·세션 캐시·로그의 외부 작업 위치 정책 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-10 | 손상된 파일과 장치 메타데이터를 신뢰하지 않고 길이·위치·작업 범위 검사 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |
| SYS-11 | 일반 GUI와 권한이 필요한 장치 읽기 모듈 분리, 제한된 작업 명령만 전달 | 1차 | 완료 | GUI IPC와 allowlisted read-only native helper를 분리했고 helper protocol unit 시험을 통과했다. 실제 UAC는 미실증이다. |
| SYS-12 | 버전·지원 기능·오픈소스 고지·모델 및 종속 라이선스 목록 제공 | 1차 | 완료 | 범위 제한·오프라인·IPC 경계 구현과 엔진 시험. |

## D. 카빙

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| DP-01 | 기본 검색에서 못 찾았을 때만 정밀 검색 제안 | 2차 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-02 | 지원되는 볼륨의 미할당 영역 검색, 필요할 때 더 넓은 범위 선택 | 2차 | 완료 | 미할당 우선과 WHOLE_SOURCE_REQUIRED→whole 범위 경로를 volume-layout/job-service 합성 시험으로 확인했다. |
| DP-03 | 지원 파일 형식의 시작·구조 단서를 찾아 후보 추출 | 2차 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-04 | 별도 작업 폴더에 임시 복구하고 완료된 산출물만 후보로 공개 | 2차 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-05 | 원래 이름 없는 파일은 생성된 이름임을 표시하고 형식·크기·미리보기로 분류 | 2차 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-06 | 정상적으로 읽은 부분과 손상·읽기 실패 부분 구분 | 2차 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-07 | 불완전 파일·부분 텍스트·이미지 추출을 정상 전체 복구와 구분 | 조건부 | 완료 | carving/volume-layout 구현과 합성 구조·whole-image 카빙 시험. |
| DP-08 | 조각 순서가 사라진 파일의 재조합, 손상 문서 형식별 수리 | 조건부 | 완료 | test/document-salvage.test.mjs 6/6: 중앙 목록 없는 OOXML/HWPX의 CRC 검증 텍스트 추출, 최대 6 IDAT 조각의 유일 순서 재조합(3조각 정답 PNG 바이트 일치). 720순서·256MiB·10초 제한; 일반 형식 전체 수리는 범위 밖. |
| DP-09 | 빠른 포맷·파티션 정보 손실 상황에서 이미지 기반 탐색 | 조건부 | 완료 | MBR/GPT/lost-table bounded discovery와 WHOLE_SOURCE_REQUIRED whole-image PDF/PNG 카빙을 합성 시험했다. 실제 빠른 포맷 매체는 미실증이다. |

## E. 파일명 임베딩과 백업

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| CP-07 | 지원 앱의 자동 저장본·백업·버전 기록 탐색 | 2차 | 완료 | 지원 Office 자동 저장 폴더를 열거·선택하는 backups 경로를 구현했다. 계정 전체 클라우드/일반 버전 공급자는 범위 밖이다. |
| CP-08 | 작은 로컬 임베딩 모델로 파일명의 의미 유사도 보조 | 2차 | 완료 | 선택형 로컬 한국어 다국어 embedding의 실제 IPC folder scan→rank packaged smoke 1/1 통과; 원본 해시는 불변이었다. |
| CP-09 | 모델이 없거나 꺼져 있어도 일반 검색을 완결, 작업 전에 필요성을 안내 | 2차 | 완료 | file-search/candidate-filter 구현과 단위·통합 시험. |
| CP-10 | 파일명·경로 인덱스의 선택적 재사용, 변경·삭제된 파일의 갱신 | 2차 | 완료 | file-search 및 job-service 회귀 시험과 실제 Electron 인덱스 재확인 흐름. 삭제·확인 불가 후보는 두 캐시와 선택 상태에서 제외하고 인덱스 밖 현재 후보를 보존한다. 변경 파일 갱신과 작업당 10,000개 제한을 유지한다. |
| SYS-06 | 임베딩은 요청할 때만 실행, 원본 장치에 모델 설치·다운로드하지 않기 | 2차 | 완료 | 온디맨드 local AI만 실행하며 원본에 설치/다운로드하지 않는다. packaged semantic smoke 1/1로 실제 rank를 확인했다. |

## F. 파일시스템·고급 복구 확대

| ID | 기능 | 단계 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| NT-12 | 특수 속성·복잡한 확장 기록·압축·희소 파일 등 처리 | 조건부 | 완료 | ntfs-attributes/advanced/limits 시험: resident ATTRIBUTE_LIST와 최대 64개 확장 기록의 소유 관계·VCN·지문, 일반 분할 DATA, 희소·initialized tail 및 검증된 LZNT1을 처리한다. LZNT1은 4KiB/16클러스터 단위·65,536단위(4GiB)까지. 기존 범위 storage_release_acceptance_v3 ship. 0.3.4에서 단일 base-record resident Zone.Identifier 최대 512바이트의 정확한 보존을 추가했다. ntfs-zone-identifier 시험 4/4 및 부모 전체 엔진 시험 202/202 통과. 그 밖의 ADS·암호화·비resident/중첩 목록·분할 압축/희소는 미지원. 실장치 본문 복구 성공은 별도 미확인. |
| NT-13 | FAT/exFAT 등 다른 파일시스템의 삭제 기록 분석 | 2차 | 완료 | FAT12/16/32·exFAT 삭제 구조를 합성 이미지에서 시험했다. 실제 매체 복구 성공률은 미실증이다. |

## 갱신 방법

`node scripts/progress.mjs --write`로 이 파일을 다시 만듭니다. `progress.json`에서 각 ID의 `status`를 `pending`, `in_progress`, `done` 중 하나로 지정하고, `done`에는 재현 가능한 시험·검토 증거를 `evidence`에 기록합니다.
