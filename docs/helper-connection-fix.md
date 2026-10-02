# 관리자 볼륨 도우미 연결 오류 수정 · 2026-09-13

사용 중 발생한 `The elevated volume helper did not connect.`를 실제 실행 폴더의 도우미로 재현했다. 수정은 native/VolumeReader.cs와 해당 실행 파일에 한정되며 UI와 원시 장치 읽기 명령은 변경하지 않았다.

1. NamedPipeServerStream의 추가 권한 인수에 허용되지 않는 ReadWrite를 전달하여 생성 단계에서 종료됐다. 추가 권한을 0으로 수정했다.
2. 비동기 연결 대기를 호출하면서 Asynchronous 옵션이 없어 종료됐다. 비동기 옵션을 추가했다.
3. 첫 데이터를 읽기 전에 클라이언트 가장을 시도하여 종료됐다. 첫 줄을 읽은 뒤 SID를 확인하고, 확인 성공 후에만 JSON 해석과 명령 처리를 수행한다.

파이프 ACL과 요청 사용자 SID 검사는 유지한다. 콘솔 인코딩 설정은 표준 입출력 모드에서만 수행한다. API 근거: [비동기 연결 대기](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeserverstream.beginwaitforconnection), [파이프 클라이언트 가장](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient).

## 확인 결과

- 전체 엔진 172/172, 집중 시험 11/11 통과.
- 실제 Windows RunAs를 통한 관리자 도우미 연결 시험 2/2 통과. 일반 권한과 관리자 권한에서 각각 연결 후 hello → 미지원 쓰기 명령 거부 → hello → close를 확인했다. 디스크는 열지 않았다.
- 사용 중인 `dist/RecoveryChat-0.3.0-win-x64` 폴더의 교체된 도우미로 파이프 시험 1/1 통과.
- 별도 읽기 전용 검토 `volume_helper_fix_review`: ship. 다른 Windows 계정의 연결 거부 및 실제 원시 볼륨 읽기/복구는 이번 시험 범위 밖이다.
- `win-unpacked`와 사용 중인 압축 해제 폴더의 도우미를 동일한 수정본으로 교체했다. 앱 작업 공간은 변경하지 않았다.
- ZIP의 100개 파일 내용을 수정 전과 비교하여 도우미 파일 1개만 변경된 것을 확인했다. 이전 ZIP은 `output/helper-connection-fix/RecoveryChat-0.3.0-before.zip`에 보관한다.

증거: `output/helper-connection-fix/`의 TAP, applied-binaries.json, zip-verification.json. 배포 ZIP 해시는 `dist/RecoveryChat-0.3.0-win-x64.zip.sha256`에 갱신했다.

수정한 도우미 SHA-256: `1a83d08885d8d3fa911513cdfec53656549af189c3a95474120d08774130d7b1`.
