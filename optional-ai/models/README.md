# 오프라인 이름 의미 검색 팩

이 디렉터리는 별도 다운로드 팩의 배치 계약을 설명한다. 기본 앱 ZIP에는 약 150 MB의 모델 가중치를 포함하지 않는다.

배포 시 `optional-ai` 폴더(`package.json`, `runtime-manifest.json`, `vendor/`)를 실행 파일 옆에 놓는다. 모델은 실행 파일 옆 `models/name-embedding/paraphrase-multilingual-MiniLM-L12-v2`에 놓거나 사용자가 모델 폴더 선택기로 직접 지정한다.

```text
RecoveryChat.exe
optional-ai/
  package.json
  runtime-manifest.json
  vendor/
models/
  name-embedding/
    paraphrase-multilingual-MiniLM-L12-v2/
      model-manifest.json
      onnx/model_quantized.onnx
```

패키지 런타임 호출은 `runtimeRoot = <exe directory>/optional-ai`를 전달한다. 개발 환경에서는 이 값을 생략하면 소스 트리의 `optional-ai`가 사용된다. 모델과 런타임 매니페스트의 크기와 SHA-256이 모두 맞아야 로드된다. 실행 중 원격 다운로드는 허용되지 않는다.

정상 앱 ZIP은 이 모델 폴더와 `optional-ai` 런타임 폴더를 제외한다. 별도 오프라인 AI ZIP은 위 두 폴더를 같은 실행 파일 기준 위치에 풀 수 있는 구조로 묶는다. 팩에는 `SBOM.json`, Transformers.js 라이선스, ONNX Runtime 라이선스와 `ThirdPartyNotices.onnxruntime.txt`를 함께 포함한다.
