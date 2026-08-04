[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SnapshotPath,
    [string]$ControlRoot = (Join-Path $env:LOCALAPPDATA 'Integrated Mod Manager (IMM) State')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedFullPath {
    param([Parameter(Mandatory)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-StrictChildPath {
    param(
        [Parameter(Mandatory)][string]$Candidate,
        [Parameter(Mandatory)][string]$Parent
    )
    $candidateFull = Get-NormalizedFullPath $Candidate
    $parentFull = Get-NormalizedFullPath $Parent
    $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the control root: $candidateFull"
    }
    return $candidateFull
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory)][string]$Root)
    $entries = @(Get-Item -LiteralPath $Root -Force) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
    foreach ($entry in $entries) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Snapshot contains a reparse point: $($entry.FullName)"
        }
    }
}

$controlRootFull = Get-NormalizedFullPath $ControlRoot
$snapshotFull = Assert-StrictChildPath -Candidate $SnapshotPath -Parent $controlRootFull
if (-not (Test-Path -LiteralPath $snapshotFull -PathType Container)) {
    throw "Snapshot directory does not exist: $snapshotFull"
}
Assert-NoReparseTree $snapshotFull

$manifestPath = Join-Path $snapshotFull 'manifest.json'
$manifestHashPath = Join-Path $snapshotFull 'manifest.sha256'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestHashPath -PathType Leaf)) {
    throw 'Snapshot manifest or manifest hash is missing.'
}

$declaredManifestHash = ((Get-Content -LiteralPath $manifestHashPath -Raw -Encoding utf8) -split '\s+')[0].ToUpperInvariant()
$actualManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
if ($declaredManifestHash -ne $actualManifestHash) {
    throw "Manifest hash mismatch: declared $declaredManifestHash, actual $actualManifestHash"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
    throw "Unsupported manifest schema: $($manifest.schemaVersion)"
}

$expectedArtifacts = @('manifest.json', 'manifest.sha256')
$sourceRoots = @{}
foreach ($sourceRoot in $manifest.sourceRoots) {
    if ($sourceRoots.ContainsKey($sourceRoot.id)) {
        throw "Duplicate source root id: $($sourceRoot.id)"
    }
    $sourceRoots[$sourceRoot.id] = $sourceRoot
}

$configCount = 0
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.artifactPath
    if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains('..')) {
        throw "Unsafe artifact path in manifest: $relative"
    }
    $artifactPath = Assert-StrictChildPath -Candidate (Join-Path $snapshotFull ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)) -Parent $snapshotFull
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Manifest artifact is missing: $relative"
    }
    $artifact = Get-Item -LiteralPath $artifactPath
    $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash
    if ($artifact.Length -ne [long]$entry.length -or $actualHash -ne [string]$entry.sha256) {
        throw "Artifact verification failed: $relative"
    }
    $expectedArtifacts += $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)

    if ($entry.kind -eq 'legacy-config-raw') {
        $configCount++
        if (-not $sourceRoots.ContainsKey($entry.sourceRootId)) {
            throw "Config references an unknown source root: $relative"
        }
        $sourcePath = Join-Path ([string]$sourceRoots[$entry.sourceRootId].path) ([string]$entry.relativeSourcePath)
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Legacy source disappeared after snapshot: $sourcePath"
        }
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        if ($sourceHash -ne $actualHash) {
            throw "Legacy source changed after snapshot: $sourcePath"
        }
    }
}

if ($configCount -ne 7) {
    throw "Expected 7 raw configs, found $configCount"
}

$localStoragePath = Join-Path $snapshotFull 'webview\local-storage.json'
$localStorage = Get-Content -LiteralPath $localStoragePath -Raw -Encoding utf8 | ConvertFrom-Json
$localStorageKeys = @($localStorage.records.PSObject.Properties.Name | Sort-Object)
$expectedLocalStorageKeys = @('game-theme', 'imm-lang')
if (($localStorageKeys -join "`n") -ne ($expectedLocalStorageKeys -join "`n")) {
    throw "Unexpected LocalStorage keys: $($localStorageKeys -join ', ')"
}

$actualArtifacts = @(
    Get-ChildItem -LiteralPath $snapshotFull -File -Force -Recurse |
        ForEach-Object { [IO.Path]::GetRelativePath($snapshotFull, $_.FullName) } |
        Sort-Object
)
$expectedArtifacts = @($expectedArtifacts | Sort-Object -Unique)
if (($actualArtifacts -join "`n") -ne ($expectedArtifacts -join "`n")) {
    throw "Snapshot has missing or unexpected files.`nExpected: $($expectedArtifacts -join ', ')`nActual: $($actualArtifacts -join ', ')"
}
if ($actualArtifacts | Where-Object { $_ -match '\.(ldb|log)$|(^|\\)(CURRENT|LOCK|MANIFEST-|LOG)' }) {
    throw 'Snapshot contains a raw LevelDB artifact.'
}

$allowedSids = @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$acl = Get-Acl -LiteralPath $snapshotFull
foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $sid -notin $allowedSids) {
        throw "Unexpected snapshot ACL rule: $($rule.IdentityReference) $($rule.AccessControlType)"
    }
}

[ordered]@{
    snapshotPath = $snapshotFull
    manifestSha256 = $actualManifestHash
    artifactCount = $actualArtifacts.Count
    configCount = $configCount
    localStorageKeys = $localStorageKeys
    rawLevelDbArtifacts = 0
    sourceHashesStillMatch = $true
} | ConvertTo-Json -Depth 4
