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
& node (Join-Path $PSScriptRoot 'test-js.cjs')
if ($LASTEXITCODE -ne 0) { throw 'JS/browser/incremental/archive tests failed' }
