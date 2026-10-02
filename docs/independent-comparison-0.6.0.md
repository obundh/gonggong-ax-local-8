# 0.6.0 독립 도구 비교 — Stage 9 제한 시험

2026-09-27에 RecoveryChat 0.5.20, The Sleuth Kit 4.15.0, PhotoRec 7.2를 같은 고정 FAT16 이미지에서 실제 실행했다. 이 버전 표기는 당시 실행 영수증의 정체성을 보존한다. 재현 스크립트는 이후 실행부터 `package.json`의 현재 버전을 읽어 기록한다. 결론은 **F49 도구 선정 완료, F50~F54 제한 증거 확보·전체 인수 미완료**다. 이 자료는 2.45 MiB 합성 fixture의 단일 클러스터 파일 시험이며, 전문 포렌식 도구와의 전반적 동등성·실제 SSD 복구율·다른 파일시스템 성능을 뜻하지 않는다.

## 독립 구현과 역할

| 구현 | 실제 실행 구성 | 맡은 역할 | 버전·실행 파일 SHA-256 |
|---|---|---|---|
| RecoveryChat | `fat-volume.mjs`, `getUnallocatedRanges`, `carveFiles` | 삭제 디렉터리 항목 기반 복구와 검증된 FAT 자유 공간 카빙. 카빙 형식은 제품의 기본 다중 형식 집합 | 제품 0.5.20; 비교 전후 관련 엔진 소스 합산 해시 동일 |
| The Sleuth Kit | `fls -r -d -p`로 삭제 항목을 찾고, 그 출력의 inode만 `icat`에 전달 | 독립 메타데이터 복구 | 4.15.0; `fls.exe` `5be3b65d6e5966d3e29f43631aa6dc3c86f69c5acf504b0be16442f2851385d3`; `icat.exe` `5a765c240becaac6e555d8391de03912b9638e38fc68fd3200afe189e4166928` |
| CGSecurity PhotoRec | `freespace`, PDF만 활성화한 스크립트 실행 | 독립 서명 카빙 | 7.2; `photorec_win.exe` `d75b9a6ff60f91479085a578aca518abb1cd7405f24506a61afa2f7e222147bf` |

TSK의 `fls`와 `icat`은 한 제품의 두 CLI 구성요소이므로 독립 도구 두 개로 세지 않았다. TSK는 공식 설명대로 `fls`가 삭제 파일 이름을 표시하고 `icat`이 메타데이터 구조가 가리키는 내용을 출력하는 역할이다. PhotoRec은 파일시스템을 무시하고 본문 서명을 찾는 도구라서 메타데이터 성적과 직접 합산하지 않았다.

공식 근거:

- [The Sleuth Kit 4.15.0 공식 릴리스](https://github.com/sleuthkit/sleuthkit/releases/tag/sleuthkit-4.15.0), [TSK 역할과 라이선스](https://github.com/sleuthkit/sleuthkit#overview)
- [CGSecurity 공식 다운로드](https://www.cgsecurity.org/wiki/TestDisk_Download), [PhotoRec의 역할·읽기 전용 동작·GPL v2+](https://www.cgsecurity.org/wiki/PhotoRec), [스크립트 실행 문법](https://www.cgsecurity.org/wiki/Scripted_run)

두 도구는 설치하지 않았다. 공식 Windows portable ZIP을 `E:/RecoveryChat-TenStage-0600-20260927/comparison/tools/` 아래에만 풀어 시험했고 제품이나 배포 ZIP에는 넣지 않았다. 관리자 권한과 이메일은 사용하지 않았다. TSK 파일시스템 도구는 프로젝트가 밝힌 IBM Open Source License/Common Public License 계열이고, PhotoRec은 GPL v2 이상이다. 이번 용도는 시험 실행뿐이며 재배포하지 않는다.

다운로드 영수증:

| 파일 | 공식 URL | SHA-256 |
|---|---|---|
| `sleuthkit-4.15.0-win32.zip` | `https://github.com/sleuthkit/sleuthkit/releases/download/sleuthkit-4.15.0/sleuthkit-4.15.0-win32.zip` | `c2ebab8105b893d97bd8ce35b88e01985e2a106efc97f03adf95840a631b20ce` |
| `testdisk-7.2.win64.zip` | `https://www.cgsecurity.org/testdisk-7.2.win64.zip` | `e97e203ce77b6b1a3a37d01beccf069dc6c4632b579ffbb82ae739cdda229f38` |

## 입력 동결과 정답 분리

스크립트는 먼저 fixture와 정답표를 만들고 그 뒤 엔진별 읽기 전용 사본을 만든다. 세 사본은 모두 2,572,800바이트이고 SHA-256은 `96fb5911c9832cfa187f7bb3330e85e6ee5566908e9d75d9ea27b0c1617e297e`다. 실행 후 해시도 세 사본 모두 같았다. 실제 디스크·라이브 볼륨은 열지 않았다.

정답은 다음 여섯 항목이다.

| 항목 | 역할 | 크기 | 정답 SHA-256 |
|---|---|---:|---|
| 삭제 `REPORT.PDF` | 메타데이터 + 카빙 | 474 | `d8674eee7442cb25b25ea060dcab7cfcbee9296c5209259a48bbc43b8a38d305` |
| 삭제 `COPY.PDF` | 위 PDF의 의도적 동일 사본 | 474 | 위와 같음 |
| 삭제 `NOTES.TXT` | 메타데이터 전용 양성 | 99 | `248ba434c9f662f145119082063e09c5847849ec1eb2737623990fc004278c10` |
| 삭제 `DECOY.PDF` | 확장자만 PDF인 음성 서명 대조군 | 81 | `45e8200d1b70496ca51196e961bc587782f77f3131af835a67f695e4bbdb35f9` |
| 디렉터리 항목 없는 PDF | 카빙 전용 양성 | 470 | `32b0d27f6bbd48765a85074f6a1899296f4f8d802a1a8728f88f7b28feaeac9f` |
| 할당 상태 `ACTIVE.PDF` | 자유 공간 카빙 음성 대조군 | 487 | `6175f202ac0bf4fadea505dc36b3c06e261b41733031efc00dbcd76cdff2feef` |

RecoveryChat과 PhotoRec에는 이미지 경로와 일반 설정만 전달했다. 예상 클러스터·바이트 위치·정답 해시는 검색과 복구에 전달하지 않았다. RecoveryChat의 카빙 범위는 FAT 할당표를 읽는 제품 코드가 계산했다. PhotoRec 로그도 FAT16 할당 상태를 읽어 사용 중 공간을 제거했다. 두 카빙 경로의 **자유 공간 의미와 입력 바이트는 같지만 형식 필터는 같지 않다**. RecoveryChat은 기본 PNG/PDF/ZIP/JPEG/HWP 서명 집합을 유지했고 PhotoRec은 PDF만 활성화했다. 이 fixture의 카빙 양성은 PDF뿐이므로 아래 수치는 PDF 정답에 대한 제한 비교이며, 전체 카빙 형식 성능의 동등 조건 비교가 아니다. TSK의 `icat` 식별자는 정답표가 아니라 같은 TSK 실행의 `fls` 출력에서만 얻었다. 정답표는 결과가 나온 뒤 검증과 채점에만 사용한다.

RecoveryChat이 계산한 자유 공간은 두 구간, 합계 2,559,488바이트였다. 카빙 coverage는 그 전부를 읽었고 읽기 오류·미검사 바이트 0, 종료 이유 `end-of-ranges`, 출력 1,418바이트를 기록했다. 외부 TSK·PhotoRec subprocess에는 각각 120초 제한을 두었다. RecoveryChat은 같은 Node 프로세스 안에서 실행돼 별도 벽시계 제한이 없었다. 따라서 세 구현이 동일한 시간 제한을 적용받았다고 볼 수 없고, 아래 경과 시간은 이 작은 완주 실행의 관측값일 뿐 공정한 제한 시간 성능 순위가 아니다. Windows x64, Node 22.23.1, 논리 CPU 16개, RAM 약 31.9 GiB 환경에서 실행했다. 최고 메모리와 CPU 시간은 측정하지 않았으므로 자원 비교 완료로 보지 않는다.

## 결과

| 역할 | RecoveryChat | 독립 도구 | 이름 복원 | 오탐·중복 | 경과 시간 |
|---|---:|---:|---:|---|---:|
| 삭제 메타데이터 4건 | 원본 바이트 4/4 | TSK 원본 바이트 4/4 | 둘 다 0/4 | 둘 다 정답 외 해시 0 | 239.476 ms / 250.797 ms |
| 자유 공간 PDF 3개 인스턴스 | 3/3, 고유 해시 2/2 | PhotoRec 3/3, 고유 해시 2/2 | 둘 다 0/3 | 각각 원시 출력 3, 고유 2, 중복 1, 오탐 0 | 231.474 ms / 2,128.507 ms |

삭제 FAT 짧은 이름은 첫 글자가 삭제 표식으로 바뀌므로 RecoveryChat과 TSK 모두 `_EPORT.PDF`, `_OPY.PDF`처럼 표시했고 원래 이름 정확 일치는 0/4다. PhotoRec은 생성 이름을 쓰므로 0/3이다. 이름 점수를 본문 복구 점수로 바꾸지 않았다.

정상 PDF 출력은 외부 Poppler `pdfinfo`가 모두 종료 코드 0으로 읽었다. `DECOY.PDF`는 두 메타데이터 엔진이 정확한 삭제 바이트로 회수했지만 `pdfinfo`가 거절했으며 정상 문서로 세지 않았다. PhotoRec과 RecoveryChat 카빙은 이 음성 대조군을 출력하지 않았다. `pdfinfo` 성공은 PDF 구조를 읽었다는 별도 검사일 뿐, Microsoft/Adobe 등 사용자 앱에서 완전하게 열렸다는 증거는 아니다. 잘못된 파일을 정상 원본으로 확정한 사례는 0건이다.

PhotoRec은 `ACTIVE.PDF`를 출력하지 않았다. 실행 로그는 FAT16을 인식하고 `fat16_remove_used_space`를 적용한 뒤 PDF 3개를 찾았다고 기록한다. RecoveryChat도 같은 할당표에서 검증한 자유 공간만 카빙했으므로 현재 할당 파일을 읽지 않았다.

TSK가 정확히 회수했지만 RecoveryChat 메타데이터 복구가 실패한 항목은 0건이다. PhotoRec이 정확히 카빙했지만 RecoveryChat 카빙이 실패한 항목도 0건이다. 이 좁은 fixture에는 세 구현이 모두 실패한 정답 항목이 없어서 F53이 요구하는 all-fail 추가 진단 절차는 실제로 시험되지 않았다. 이 부재를 물리적 소실 증거로 해석하지 않는다.

## F49~F54 판정

| 항목 | 판정 | 이유 |
|---|---|---|
| F49 | 완료 | TSK 4.15.0과 PhotoRec 7.2라는 서로 다른 구현을 실제 실행하고 메타데이터·카빙 역할, 버전, 설정, 라이선스를 고정했다. |
| F50 | 부분 | 같은 해시 이미지, 읽기 전용 사본, 동일한 자유 공간 범위 의미를 기록했다. 외부 도구에만 120초 제한이 있었고 RecoveryChat에는 벽시계 제한이 없었다. 또한 RecoveryChat은 기본 다중 형식, PhotoRec은 PDF 전용이라 형식 필터가 다르다. FAT16 단일 클러스터와 PDF/TXT만 다뤘고 더 큰 매체·NTFS·다중 클러스터·손상 변환 계층은 비교하지 않았다. |
| F51 | 부분 | 원본 바이트, 외부 PDF 구조 검사, 이름, 오탐, 중복, 분모, 경과 시간을 계산했다. 부분 추출, 최고 메모리, CPU 시간, 넓은 문서 형식은 빠졌다. |
| F52 | 부분 | 이 범위에서 TSK/PhotoRec 성공 대비 RecoveryChat 실패는 0건이다. 이 작은 자료로 제품의 필수 전체 범위를 닫을 수 없다. |
| F53 | 부분 | all-fail 정답 사례가 없어 진단 경로를 실행하지 못했다. 물리적 소실 주장은 하지 않는다. |
| F54 | 부분 | 재실행 스크립트·원시 로그·정답·출력을 공개하고 오판 0을 확인했지만, 개발에 쓰지 않은 별도 자료로 독립 평가자가 재실행하지 않았다. |

따라서 허용되는 문구는 **“정해진 합성 FAT16 시험 범위에서 TSK 메타데이터 및 PhotoRec PDF 카빙과 비교한 제한 검증을 완료했다”**다. “전문 도구 수준”, “Stage 9 전체 완료”, “실제 SSD 복구 검증 완료”라고 표현하면 안 된다.

## 재현과 증거

재현 명령:

```powershell
node scripts\compare-independent-tools.mjs --output 'E:\RecoveryChat-TenStage-0600-20260927\comparison'
```

스크립트는 매번 `package.json`에서 RecoveryChat 버전을 읽고 `runs/<UTC 시각>/`에 새 실행 폴더를 만들므로 이전 영수증을 덮어쓰지 않는다. 최신 요약은 `E:/RecoveryChat-TenStage-0600-20260927/comparison/comparison-report.json`, 정답은 `input/oracle.json`, 실제 TSK/PhotoRec 로그와 복구본은 보고서의 `run.root` 아래에 있다. 다운로드 ZIP과 실행 파일도 같은 증거 트리에서 해시를 다시 확인할 수 있다. 이 문서가 설명하는 기존 보고서는 당시 0.5.20 실행을 유지하며, 스크립트 수정만으로 소급해 0.6.0 결과로 바꾸지 않는다.

비교 전후에 `engine/fat-volume.mjs`, `engine/carving.mjs`, `engine/volume-layout.mjs`, `package.json`의 합산 SHA-256은 모두 `a2a519376256640ddef57c44966191ce00a3d16f066a4f9dfae2dece7fa89ca2`로 같았다. 비교 스크립트는 제품 엔진을 수정하지 않았다.
