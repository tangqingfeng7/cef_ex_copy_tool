param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [string]$SourceDir,
    [string]$FilesJson,
    [switch]$Inspect
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function Get-ArchiveHashes([string]$Path) {
    $taskArchive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $taskHashes = [ordered]@{}
        foreach ($taskEntry in $taskArchive.Entries) {
            if ($taskHashes.Contains($taskEntry.FullName)) { throw 'Duplicate ZIP entry' }
            $taskStream = $taskEntry.Open()
            $taskSha = [System.Security.Cryptography.SHA256]::Create()
            try { $taskHashes[$taskEntry.FullName] = ([BitConverter]::ToString($taskSha.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
            finally { $taskSha.Dispose(); $taskStream.Dispose() }
        }
        return $taskHashes
    } finally { $taskArchive.Dispose() }
}
if ($Inspect) {
    Get-ArchiveHashes ([System.IO.Path]::GetFullPath($ArchivePath)) | ConvertTo-Json -Compress
    exit
}
$taskSource = (Resolve-Path -LiteralPath $SourceDir).Path
$taskNames = ConvertFrom-Json -InputObject $FilesJson
if ($taskNames.Count -eq 0) { throw 'Empty ZIP input' }
$taskExpected = [ordered]@{}
foreach ($taskName in $taskNames) {
    if ($taskName -notmatch '^[A-Za-z0-9_.-]+$' -or $taskName -in @('.', '..') -or $taskExpected.Contains($taskName)) {
        throw 'Invalid ZIP entry name'
    }
    $taskInput = [System.IO.File]::OpenRead((Join-Path $taskSource $taskName))
    $taskSha = [System.Security.Cryptography.SHA256]::Create()
    try { $taskExpected[$taskName] = ([BitConverter]::ToString($taskSha.ComputeHash($taskInput))).Replace('-', '').ToLowerInvariant() }
    finally { $taskSha.Dispose(); $taskInput.Dispose() }
}
$taskOutput = [System.IO.Path]::GetFullPath($ArchivePath)
$taskPartial = $taskOutput + '.partial'
if ((Test-Path -LiteralPath $taskOutput) -or (Test-Path -LiteralPath $taskPartial)) { throw 'ZIP output already exists' }
$taskZip = [System.IO.Compression.ZipFile]::Open($taskPartial, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($taskName in $taskNames) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip, (Join-Path $taskSource $taskName),
            $taskName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $taskZip.Dispose() }
$taskActual = Get-ArchiveHashes $taskPartial
foreach ($taskName in $taskNames) {
    if ($taskActual[$taskName] -ne $taskExpected[$taskName]) { throw "ZIP verification failed: $taskName" }
}
Move-Item -LiteralPath $taskPartial -Destination $taskOutput
$taskActual | ConvertTo-Json -Compress
