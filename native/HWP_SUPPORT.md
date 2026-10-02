# HWP 미리보기 범위

engine/hwp-preview.mjs는 CFB v3(512바이트 섹터)의 FAT·miniFAT·직접 루트 디렉터리를 범위 검사한 뒤 HWP 5의 FileHeader와 PrvText만 읽는다. DIFAT 확장, 암호/배포/DRM 플래그, 순환·중복 섹터, 미리보기 없음은 거절한다. 최대 입력 8MiB, 미리보기 텍스트 1MiB다.

반환 텍스트는 문서에 저장되어 있던 제한된 미리보기다. 전체 본문·레이아웃·첨부물·스크립트를 해석하지 않으며, originalIdentityVerified는 false이고 truncated는 true다.

test/hwp-preview.test.mjs는 합성 FAT/miniFAT 한국어 문서와 보호 플래그·순환·누락·범위 초과를 확인한다. 실제 여러 버전의 한글 문서에 대한 호환성은 별도 확인 대상이다.

참고한 구조 문서:
- [한컴 HWP 포맷 설명](https://tech.hancom.com/python-hwp-parsing-1/)
- [Microsoft MS-CFB](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/50708a61-81d9-49c8-ab9c-43c98a795242)

외부 파서 코드는 복사하거나 동봉하지 않았다.
