param([string]$BuildToolsPath)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'build-environment.ps1')
$taskEnvironment = Resolve-CefBuildEnvironment -BuildToolsPath $BuildToolsPath
$taskCmake = $taskEnvironment.CMakePath
$BuildToolsPath = $taskEnvironment.BuildToolsPath
$taskDetours = @(
    (Join-Path $taskRoot 'vcpkg_installed\x86-windows'),
    (Join-Path $taskRoot 'out\build\x86-Release\vcpkg_installed\x86-windows')
) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'lib\detours.lib') } | Select-Object -First 1
if (-not $taskDetours) { throw 'Missing x86 Detours package (include and lib/detours.lib).' }
$taskBuild = Join-Path $taskRoot 'out\build\x86-integrated'
& $taskCmake -S $taskRoot -B $taskBuild -G 'Visual Studio 17 2022' -A Win32 `
    "-DCMAKE_GENERATOR_INSTANCE=$BuildToolsPath" `
    "-DDETOURS_INCLUDE_DIRS=$taskDetours/include" "-DDETOURS_LIBRARY=$taskDetours/lib/detours.lib"
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed' }
& $taskCmake --build $taskBuild --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw 'DLL build failed' }
Write-Output "DLL: $taskBuild\src\Release\winmm.dll"
