$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\native\VolumeReader.cs'
$outputDirectory = Join-Path $PSScriptRoot '..\native\bin'
$output = Join-Path $outputDirectory 'RecoveryChat.VolumeReader.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  throw "The 64-bit .NET Framework C# compiler was not found: $compiler"
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ /checked+ /warnaserror+ `
  /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll `
  "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed with exit code $LASTEXITCODE." }
Get-Item -LiteralPath $output | Select-Object FullName, Length, LastWriteTime

