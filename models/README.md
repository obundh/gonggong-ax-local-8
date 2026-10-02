# 선택형 파일명 의미 검색 모델

이 모델은 앱 시작 시 자동으로 내려받거나 실행하지 않는다. 사용자가 의미 검색을 명시적으로 시작하고 로컬 모델 폴더를 선택했을 때만 검증 후 CPU로 연다. 실행 중 원격 모델과 네트워크 조회는 꺼져 있다. 카빙 과정에서 만든 이름과 빈 이름은 임베딩하지 않는다.

## 고정 모델

- 모델: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- 고정 리비전: `2c4055b12046f11709e9df2c122e59ffbdc2f900`
- 원본: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, 리비전 `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- 용도: 한국어와 영어를 포함하는 다국어 파일명 임베딩. 생성형 대화나 본문 검색 모델이 아니다.
- 가중치: `onnx/model_quantized.onnx` (`q8`)
- 모델 파일 합계: 150,156,464바이트
- 모델 폴더 전체: 150,159,104바이트

[변환 모델](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/2c4055b12046f11709e9df2c122e59ffbdc2f900)은 원본 모델을 연결한다. [원본 모델](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42)은 Apache-2.0과 50개 언어 지원을 명시한다. [Transformers.js](https://github.com/huggingface/transformers.js/tree/54652ba3366ccd1e3b64e689a96504309e6fb53b)도 Apache-2.0이다. 배포 팩에는 라이선스 원문이 들어 있다.

각 모델 파일의 고정 URL, 크기, SHA-256은 `model-manifest.json`에 기록된다. 개발자가 아래 명령을 직접 실행할 때만 고정 리비전에서 내려받는다.

```powershell
cd optional-ai
npm run download:model
npm run smoke:model
```

## 실제 실행 측정

2026-09-12, Windows x64, Node 22.23.1, CPU 2스레드에서 q8 모델을 실행했다.

- 모델 검증과 첫 로드: 1,287ms
- 후보 3개 순위 계산: 28ms
- RSS 증가: 301,789,184바이트
- 검증 매니페스트에 포함된 선택형 런타임: 25,877,823바이트

측정값은 성능 보장이 아니다. 실제 한국어·영어 스모크 테스트에서 `annual financial report`는 `연간 재무 보고서.xlsx`를 날씨 사진보다 높게 정렬했다.

## 런타임 구성과 감사

선택형 팩은 Transformers.js 4.2.0의 텍스트 실행 번들과 ONNX Runtime Node 1.24.3의 Windows x64 CPU 파일만 담는다. 파일명 검색에 쓰지 않는 `sharp` 정적 import는 호출 시 명시적으로 실패하는 이미지 전용 스텁으로 바꿨다. `onnxruntime-node`의 다운로드 및 압축 설치 스크립트와 그 스크립트가 쓰던 `adm-zip`, `global-agent`도 배포 팩에 없다. `runtime-manifest.json`으로 런타임 파일의 크기와 SHA-256을 검증한다.

`optional-ai/package.json`에는 외부 npm 의존성이 없다. 2026-09-12 `npm audit --prefix optional-ai --json` 결과는 잠금 파일의 npm 의존성에서 알려진 취약점 0건이었다. 이 감사는 `vendor` 파일을 검사하지 않으므로 전체 AI 팩이 안전하다는 증명이 아니다. 원본 버전, 라이선스, 고정 소스 해시, 포함 및 제외 구성요소와 관련 자문 ID는 `optional-ai/SBOM.json`에 기록했다. 별도 팩의 배치는 `optional-ai/models/README.md`에 적혀 있다.

개발자는 빈 절대 출력 폴더를 지정해 고정 소스에서 런타임을 재현할 수 있다.

```powershell
npm run prepare:runtime -- --output C:\fresh\offline-ai\vendor
```
