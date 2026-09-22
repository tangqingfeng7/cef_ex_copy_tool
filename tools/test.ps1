param([string]$BuildToolsPath)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'build-environment.ps1')
$taskEnvironment = Resolve-CefBuildEnvironment -BuildToolsPath $BuildToolsPath
& (Join-Path $PSScriptRoot 'build-dll.ps1') -BuildToolsPath $taskEnvironment.BuildToolsPath
$taskCTest = $taskEnvironment.CTestPath
& $taskCTest --test-dir (Join-Path $taskRoot 'out\build\x86-integrated') -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
& node (Join-Path $PSScriptRoot 'transpile\build.js')
if ($LASTEXITCODE -ne 0) { throw 'Script build failed' }
$taskTests = @(Get-ChildItem (Join-Path $taskRoot 'tests') -Filter '*.cjs' | ForEach-Object { $_.FullName })
& node --test @taskTests
if ($LASTEXITCODE -ne 0) { throw 'Runtime tests failed' }
& node (Join-Path $PSScriptRoot 'test-clipboard.cjs') (Join-Path $taskRoot 'out\build\x86-integrated\src\Release\winmm.dll')
if ($LASTEXITCODE -ne 0) { throw 'Browser clipboard tests failed' }
& node --test (Join-Path $taskRoot 'tests/release.test.js')
if ($LASTEXITCODE -ne 0) { throw 'Release archive or symbol tests failed' }
