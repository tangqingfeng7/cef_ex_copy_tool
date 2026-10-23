function Resolve-CefBuildEnvironment {
    [CmdletBinding()]
    param([string]$BuildToolsPath)

    $taskCandidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($BuildToolsPath)) {
        $taskCandidates.Add($BuildToolsPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:VSINSTALLDIR)) {
        $taskCandidates.Add($env:VSINSTALLDIR.TrimEnd('\'))
    }
    $taskVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $taskVswhere) {
        $taskDetected = & $taskVswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($taskDetected)) {
            $taskCandidates.Add($taskDetected.Trim())
        }
    }

    $taskInstallation = $null
    foreach ($taskCandidate in $taskCandidates) {
        if ([string]::IsNullOrWhiteSpace($taskCandidate)) { continue }
        $taskResolved = [System.IO.Path]::GetFullPath($taskCandidate)
        if (Test-Path -LiteralPath (Join-Path $taskResolved 'VC\Tools\MSVC')) {
            $taskInstallation = $taskResolved
            break
        }
    }
    if (-not $taskInstallation) {
        throw 'Visual Studio 2022 C++ Build Tools not found. Install the x86/x64 C++ workload or pass -BuildToolsPath.'
    }

    $taskBundledCmake = Join-Path $taskInstallation 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
    if (Test-Path -LiteralPath $taskBundledCmake) {
        $taskCmake = $taskBundledCmake
    } else {
        $taskCmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
        if (-not $taskCmakeCommand) { throw "CMake not found for Visual Studio installation: $taskInstallation" }
        $taskCmake = $taskCmakeCommand.Source
    }

    $taskCTest = Join-Path (Split-Path $taskCmake -Parent) 'ctest.exe'
    if (-not (Test-Path -LiteralPath $taskCTest)) {
        $taskCTestCommand = Get-Command ctest.exe -ErrorAction SilentlyContinue
        if (-not $taskCTestCommand) { throw 'CTest not found next to CMake or on PATH.' }
        $taskCTest = $taskCTestCommand.Source
    }

    [pscustomobject]@{
        BuildToolsPath = $taskInstallation
        CMakePath = $taskCmake
        CTestPath = $taskCTest
    }
}
