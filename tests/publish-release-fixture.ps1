param([Parameter(Mandatory)][string]$ScriptPath, [ValidateSet('existing','new','stale','hash','download','extra')][string]$Scenario='existing')
$ErrorActionPreference='Stop'
$fixture=Join-Path $env:TEMP ('cef-publish-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$fixture/releases","$fixture/out/publish" -Force | Out-Null
[IO.File]::WriteAllText("$fixture/VERSION", '1.2.0')
[IO.File]::WriteAllText("$fixture/releases/v1.2.0.md", 'Fixture release notes')
[IO.File]::WriteAllText("$fixture/out/publish/winmm.dll", 'fixture DLL bytes')
$hash=(Get-FileHash "$fixture/out/publish/winmm.dll").Hash.ToLowerInvariant()
if ($Scenario -eq 'hash') { $hash='0'*64 }
[IO.File]::WriteAllText("$fixture/out/publish/winmm.dll.sha256",$hash)
$global:commit='a'*40
$global:uploads=0
$global:edits=0
$global:views=0
$global:draft=$false
function global:git {
    $global:LASTEXITCODE=0
    if ($args[0] -eq 'rev-parse') { return $global:commit }
    if ($args[0] -eq 'status') { return }
    if ($args[0] -eq 'ls-remote') {
        $head=if($Scenario -eq 'stale'){'b'*40}else{$global:commit}
        return @("$('c'*40)`trefs/tags/v1.2.0", "$head`trefs/tags/v1.2.0^{}")
    }
    throw 'Unexpected git command'
}
function global:gh {
    $global:LASTEXITCODE=0
    if ($args[0] -eq 'api') { $global:LASTEXITCODE=1; return 'HTTP 404' }
    switch ($args[1]) {
        'view' {
            $global:views++
            if($Scenario -eq 'new' -and $global:views -eq 1){$global:LASTEXITCODE=1;return}
            $assets=@(@{name='winmm.dll'})
            if($Scenario -eq 'extra'){$assets+=@{name='do-not-delete.zip'}}
            return @{assets=$assets;targetCommitish=$global:commit;isDraft=$global:draft;url='https://fixture.invalid/release'} | ConvertTo-Json -Depth 4 -Compress
        }
        'create' {$global:draft=$true;return}
        'edit' {$global:edits++;if($args -contains '--draft=false'){$global:draft=$false};return}
        'upload' {
            if($args -notcontains '--clobber'){throw 'Missing clobber flag'}
            $global:uploads++
            Copy-Item "$fixture/out/publish/winmm.dll" "$fixture/server.dll"
            return
        }
        'download' {
            $index=[Array]::IndexOf($args,'--dir')
            $dest=$args[$index+1]
            Copy-Item "$fixture/server.dll" (Join-Path $dest 'winmm.dll')
            if($Scenario -eq 'download'){[IO.File]::WriteAllText((Join-Path $dest 'winmm.dll'),'corrupted')}
            return
        }
        default {throw 'Unexpected gh command'}
    }
}
Push-Location $fixture
try {
    $failed=$false
    try { & $ScriptPath -Tag v1.2.0 -Commit $global:commit -Repository fixture/repo }
    catch {$failed=$true;Write-Output ('OBSERVED_ERROR='+$_.Exception.Message)}
    $expectedFail=$Scenario -in @('stale','hash','download','extra')
    if($failed -ne $expectedFail){throw "Unexpected result for $Scenario"}
    if($Scenario -in @('stale','hash','extra') -and $global:uploads -ne 0){throw 'Guard allowed upload'}
    if($Scenario -in @('existing','new') -and $global:uploads -ne 1){throw 'Expected one upload'}
    Write-Output "PASS scenario=$Scenario uploads=$global:uploads failed=$failed"
} finally {Pop-Location}
