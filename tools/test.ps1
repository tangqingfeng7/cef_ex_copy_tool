param([string]$BuildToolsPath = 'D:\Admin\VSBuildTools')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'build-dll.ps1') -BuildToolsPath $BuildToolsPath
$taskCTest = Join-Path $BuildToolsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe'
& $taskCTest --test-dir (Join-Path $taskRoot 'out\build\x86-integrated') -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
& node (Join-Path $PSScriptRoot 'transpile\build.js')
if ($LASTEXITCODE -ne 0) { throw 'Script build failed' }
$taskTests = @(Get-ChildItem (Join-Path $taskRoot 'tests') -Filter '*.cjs' | ForEach-Object { $_.FullName })
& node --test @taskTests
if ($LASTEXITCODE -ne 0) { throw 'Runtime tests failed' }
& node (Join-Path $PSScriptRoot 'test-clipboard.cjs') (Join-Path $taskRoot 'out\build\x86-integrated\src\Release\winmm.dll')
if ($LASTEXITCODE -ne 0) { throw 'Browser clipboard tests failed' }
