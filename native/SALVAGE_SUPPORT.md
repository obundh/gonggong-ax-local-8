# 제한된 부분 복구 지원 범위

`engine/document-salvage.mjs`는 원본을 고치거나 일반적인 조각 복구를 수행하지 않습니다. 사용자가 선택한 일반 파일(`sourceKind: "user-selected"`) 또는 이 앱이 소유한 카빙 조각(`sourceKind: "owned-carved"`)만 읽습니다. 임의의 원시 장치나 승인되지 않은 경로는 `SOURCE_NOT_AUTHORIZED`로 거부합니다.

## 손상 Office/HWPX 문서

`salvageDocument(filePath, destination, options)`는 중앙 디렉터리가 없고, 각 로컬 ZIP 항목이 압축·원본 크기와 CRC를 선언한 경우에만 DOCX, XLSX, PPTX, HWPX의 알려진 텍스트 XML을 제한적으로 추출합니다. 저장 결과는 새 UUID 폴더 안의 `*.salvaged.txt`이며, 첫 줄부터 **부분 복구 결과**임을 표시합니다. 결과 상태는 `partial`이고 `originalIdentityVerified`는 항상 `false`입니다.

암호화, 데이터 디스크립터, ZIP64/크기 제한 초과, CRC 오류, 매크로·스크립트 항목, 외부 엔터티, 알려지지 않은 문서 구조는 거부합니다. XML 텍스트만 읽고 실행 가능한 콘텐츠, 링크, 첨부물, 매크로, 문서 서식과 ZIP 중앙 디렉터리는 만들거나 실행하지 않습니다.

## PNG 조각 재구성

`reconstructPngChunks(filePath, destination, options)`는 유일한 IHDR·IEND와 최대 6개 IDAT 조각을 찾습니다. 조각마다 CRC를 검사한 뒤 서로 다른 순서를 최대 720개 비교합니다. 전체 zlib 입력 소비, Adler 검사, 8비트 비인터레이스의 행 길이와 필터 값을 검증한 순서가 정확히 하나일 때만 새 PNG를 저장합니다. 여러 유효 순서, 누락, CRC 오류, 압축 해제 실패는 거절합니다.

순서 탐색은 누적 압축·해제 바이트 256MiB, 10초 한도를 갖습니다. 한도 안에 모든 순서를 확인하지 못하면 일부 순서가 맞아도 결과를 공개하지 않습니다. 팔레트·인터레이스·애니메이션 전체 복원과 임의 형식의 조각 재조합은 지원하지 않습니다. 결과는 `reconstructed`, 원본 동일 여부는 항상 `false`입니다. 부가 청크와 원래 서식 정보는 재현하지 않을 수 있습니다.

세 IDAT 조각의 순서를 뒤섞은 합성 이미지에서 정답 PNG와 바이트가 일치하는 시험, 중복 zlib 스트림과 복수 머리말·CRC 오류·7개 조각 거절 시험을 포함합니다. 구조 기준은 [W3C PNG의 IDAT 및 단일 zlib 데이터 스트림](https://www.w3.org/TR/png-3/), 런타임 동작은 [Node.js zlib](https://nodejs.org/api/zlib.html)을 참고했습니다.

## 공통 안전 동작

두 작업은 소스 링크·클라우드 오프라인 자리표시자·비일반 파일을 거부하고, 읽기 전후의 파일 식별자를 확인합니다. 입력은 기본 64 MiB로 제한되며 취소 신호와 `control.checkpoint()`를 존중합니다. 출력은 대상 폴더의 새 비공개 임시 폴더에 `wx`로 쓴 뒤 새 UUID 폴더로 이름을 바꾸므로 기존 결과를 덮어쓰지 않습니다. 반환값에는 출력 SHA-256과 검증 내역이 포함됩니다.
