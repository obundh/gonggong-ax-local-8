@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "dist\win-unpacked\공공 AX 로컬 시리즈 8 - 파일 복구.exe" (
  start "" "dist\win-unpacked\공공 AX 로컬 시리즈 8 - 파일 복구.exe"
  exit /b
)
echo 먼저 이 폴더에서 npm ci 및 npm run build:win을 실행하세요.
echo 또는 Releases에서 Windows ZIP 전체를 내려받아 압축을 푸세요.
pause
