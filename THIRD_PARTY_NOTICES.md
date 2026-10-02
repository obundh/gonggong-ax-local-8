# 오픈소스 및 구성 요소 고지

이 앱의 자체 복구 엔진·Windows 읽기 모듈·안내 UI는 이 프로젝트의 코드입니다. 프로젝트 라이선스는 package.json의 UNLICENSED이며, 외부 오픈소스 라이선스를 자체 코드에 자동 적용한 것으로 해석하지 않습니다.

## 기본 배포

| 구성 요소 | 버전 | 라이선스·고지 위치 |
| --- | --- | --- |
| Electron | 44.3.0 | MIT, 배포 폴더 LICENSE.electron.txt |
| Chromium 및 Electron의 포함 구성 요소 | Electron에 고정된 버전 | 배포 폴더 LICENSES.chromium.html |
| Node.js 및 포함 구성 요소 | Electron에 포함 | Electron/Chromium 고지 및 https://github.com/nodejs/node/blob/main/LICENSE |

Electron의 공식 라이선스: https://github.com/electron/electron/blob/v44.3.0/LICENSE

electron-builder 26.15.3은 개발 시 패키징 도구이며 MIT 라이선스입니다. 빌드 도구 자체를 복구 런타임으로 실행하지 않습니다. 기본 엔진은 Node.js 기본 모듈을 사용합니다.

UI 디자인은 assistant-ui Stockbroker 예시를 참고한 자체 구현이며 assistant-ui 패키지를 런타임 종속성으로 넣지 않았습니다.

## 선택형 AI 팩

파일명 의미 검색은 기본 배포와 분리된 optional-ai 폴더를 사용합니다. 설치·모델 다운로드는 개발 준비 단계에서 명시적으로 실행하며 앱의 시작·검색 과정에서 자동 다운로드하지 않습니다.

- Transformers.js 4.2.0: Apache-2.0. 파일명 전용 수정 내용과 원문 고지는 optional-ai/SBOM.json 및 optional-ai/vendor/LICENSE.transformers.txt를 따릅니다.
- ONNX Runtime Node/Common 1.24.3: MIT. 포함 파일과 라이선스 위치는 optional-ai/SBOM.json, runtime-manifest.json, vendor의 LICENSE 및 ThirdPartyNotices 파일에 기록합니다.
- Xenova/paraphrase-multilingual-MiniLM-L12-v2 및 원본 Sentence Transformers 모델: Apache-2.0.
- 모델의 고정 리비전·파일별 해시·출처·라이선스는 models/name-embedding/paraphrase-multilingual-MiniLM-L12-v2/model-manifest.json과 models/README.md.
- 포함 구성 요소는 SBOM과 파일 해시 목록, 각 패키지의 원문 라이선스를 따릅니다. npm 설치용 잠금 파일만으로 이 별도 구성 런타임 전체의 검토를 대체하지 않습니다.

기술 문서를 참고한 것과 그 문서의 소프트웨어를 동봉하는 것은 다릅니다. TestDisk/PhotoRec·Windows File Recovery를 이 배포물에 동봉하거나 대신 실행하지 않습니다.

## 0.6.0 독립 비교 시험 도구

TSK 4.15.0과 PhotoRec 7.2의 공식 portable 배포본을 E:의 별도 시험 폴더에서 실행했습니다. 이 제품의 런타임이나 배포 ZIP에 포함하지 않습니다. 역할·버전·공식 출처·라이선스와 SHA-256은 [비교 기록](docs/independent-comparison-0.6.0.md)에 있습니다. Windows 바로가기 파서는 Microsoft MS-SHLLINK 문서를 참고한 자체 구현입니다.
