param(
    [Parameter(Mandatory)][string]$Tag,
    [Parameter(Mandatory)][string]$Commit,
    [Parameter(Mandatory)][string]$Repository,
    [string]$DllPath = 'out/publish/winmm.dll',
    [string]$HashPath = 'out/publish/winmm.dll.sha256'
)
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $Commit -notmatch '^[0-9a-f]{40}$') { throw 'Invalid repository or commit identity.' }
$Version = (Get-Content -LiteralPath VERSION -Raw).Trim()
if ($Tag -ne "v$Version" -or $Version -notmatch '^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$') { throw 'Tag must match VERSION.' }
if ((git rev-parse HEAD).Trim() -ne $Commit -or $LASTEXITCODE) { throw 'Checkout does not match triggering commit.' }
if (git status --porcelain --untracked-files=no) { throw 'Tracked checkout must be clean.' }
$notes = "releases/$Tag.md"
if (-not (Test-Path -LiteralPath $notes)) { throw "Missing version-controlled release notes: $notes" }
function Assert-LiveTag {
    $refs = @(git ls-remote origin "refs/tags/$Tag" "refs/tags/$Tag^{}")
    if ($LASTEXITCODE -ne 0 -or -not $refs.Count) { throw 'Cannot verify remote tag.' }
    $peeled = @($refs | Where-Object { $_ -match '\^\{\}$' })
    $line = if ($peeled.Count) { $peeled[0] } else { $refs[0] }
    if (($line -split '\s+')[0] -ne $Commit) { throw 'Remote tag moved; stale build must not publish.' }
}
Assert-LiveTag
$dll = (Resolve-Path -LiteralPath $DllPath).Path
if ([IO.Path]::GetFileName($dll) -ne 'winmm.dll') { throw 'Only winmm.dll may be published.' }
$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
if ((Get-Content -LiteralPath $HashPath -Raw).Trim().ToLowerInvariant() -ne $hash) { throw 'Artifact checksum mismatch.' }
$existingJson = gh release view $Tag -R $Repository --json assets,targetCommitish 2>$null
if ($LASTEXITCODE -eq 0) {
    $existing = $existingJson | ConvertFrom-Json
    if (@($existing.assets | Where-Object name -ne 'winmm.dll').Count) { throw 'Unexpected release assets; refusing to delete user assets automatically.' }
    gh release edit $Tag -R $Repository --target $Commit --notes-file $notes
    if ($LASTEXITCODE) { throw 'Release notes update failed.' }
} else {
    # Do not confuse an auth/network failure with an absent release.
    $apiError = gh api "repos/$Repository/releases/tags/$Tag" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or $apiError -notmatch '\b404\b') { throw 'Cannot establish whether release exists.' }
    gh release create $Tag -R $Repository --verify-tag --draft --title $Tag --target $Commit --notes-file $notes
    if ($LASTEXITCODE) { throw 'Draft release creation failed.' }
}
Assert-LiveTag
gh release upload $Tag -R $Repository $dll --clobber
if ($LASTEXITCODE) { throw 'DLL upload failed.' }
$download = Join-Path ([IO.Path]::GetTempPath()) ('cef-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $download | Out-Null
gh release download $Tag -R $Repository --pattern winmm.dll --dir $download
if ($LASTEXITCODE) { throw 'Published DLL download failed.' }
if ((Get-FileHash -LiteralPath (Join-Path $download 'winmm.dll') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Published DLL checksum mismatch.' }
Assert-LiveTag
gh release edit $Tag -R $Repository --draft=false --target $Commit
if ($LASTEXITCODE) { throw 'Release publication failed.' }
$result = gh release view $Tag -R $Repository --json assets,targetCommitish,isDraft,url | ConvertFrom-Json
if ($LASTEXITCODE -or $result.isDraft -or $result.targetCommitish -ne $Commit -or @($result.assets).Count -ne 1 -or $result.assets[0].name -ne 'winmm.dll') { throw 'Release postconditions failed.' }
Write-Output "Published $($result.url) SHA256=$hash"
