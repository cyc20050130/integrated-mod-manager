[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'Integrated Mod Manager (IMM) Data'),
    [string]$WebViewRoot = (Join-Path $env:LOCALAPPDATA 'jp.bhatt.wwmm\EBWebView'),
    [string]$ControlRoot = (Join-Path $env:LOCALAPPDATA 'Integrated Mod Manager (IMM) State')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$readerCommit = '9639a318ce0f7b546e1d8d02d89423ab6b4ae202'
$snappyCommit = '3d085230baa8c46cf2090ebba29bf6e8eab31087'
$configNames = @(
    'config.json',
    'configWW.json',
    'configNTE.json',
    'configGI.json',
    'configSR.json',
    'configZZ.json',
    'configEF.json'
)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ImmLegacySnapshot
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeFileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public NativeFileTime CreationTime;
        public NativeFileTime LastAccessTime;
        public NativeFileTime LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileAttributeTagInformation
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    public sealed class CopyResult
    {
        public long Length { get; internal set; }
        public string Sha256 { get; internal set; }
        public uint VolumeSerialNumber { get; internal set; }
        public ulong FileIndex { get; internal set; }
        public ulong LastWriteFileTime { get; internal set; }
        public uint NumberOfLinks { get; internal set; }
    }

    public static class NativeSnapshot
    {
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint OpenExisting = 3;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileFlagSequentialScan = 0x08000000;
        private const uint FileAttributeReparsePoint = 0x00000400;
        private const int FileAttributeTagInfo = 9;
        private const uint MoveFileWriteThrough = 0x00000008;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out ByHandleFileInformation info);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file,
            int informationClass,
            out FileAttributeTagInformation info,
            uint bufferSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(string existingName, string newName, uint flags);

        private static SafeFileHandle OpenSource(string path)
        {
            SafeFileHandle handle = CreateFileW(
                path,
                GenericRead,
                FileShareRead,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOpenReparsePoint | FileFlagSequentialScan,
                IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Unable to open source without write/delete sharing: " + path);
            }

            if (!GetFileInformationByHandleEx(
                    handle,
                    FileAttributeTagInfo,
                    out FileAttributeTagInformation tagInfo,
                    (uint)Marshal.SizeOf<FileAttributeTagInformation>()))
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, "Unable to inspect source attributes: " + path);
            }

            if ((tagInfo.FileAttributes & FileAttributeReparsePoint) != 0)
            {
                handle.Dispose();
                throw new IOException("Refusing reparse-point source: " + path);
            }

            return handle;
        }

        private static ByHandleFileInformation GetInformation(SafeFileHandle handle, string path)
        {
            if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to inspect source identity: " + path);
            }
            return info;
        }

        private static ulong Combine(uint high, uint low)
        {
            return ((ulong)high << 32) | low;
        }

        private static bool SameIdentity(ByHandleFileInformation left, ByHandleFileInformation right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber
                && left.FileIndexHigh == right.FileIndexHigh
                && left.FileIndexLow == right.FileIndexLow
                && left.FileSizeHigh == right.FileSizeHigh
                && left.FileSizeLow == right.FileSizeLow
                && left.LastWriteTime.High == right.LastWriteTime.High
                && left.LastWriteTime.Low == right.LastWriteTime.Low
                && left.FileAttributes == right.FileAttributes
                && left.NumberOfLinks == right.NumberOfLinks;
        }

        private static string HashStream(Stream stream)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return Convert.ToHexString(sha.ComputeHash(stream));
            }
        }

        public static FileStream OpenReadLease(string path)
        {
            return new FileStream(OpenSource(path), FileAccess.Read, 1, false);
        }

        public static CopyResult CopyExact(string sourcePath, string destinationPath)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath));
            bool destinationCreated = false;
            try
            {
                using (SafeFileHandle sourceHandle = OpenSource(sourcePath))
                {
                    ByHandleFileInformation before = GetInformation(sourceHandle, sourcePath);
                    using (var source = new FileStream(sourceHandle, FileAccess.Read, 64 * 1024, false))
                    using (var destination = new FileStream(
                        destinationPath,
                        FileMode.CreateNew,
                        FileAccess.ReadWrite,
                        FileShare.None,
                        64 * 1024,
                        FileOptions.SequentialScan | FileOptions.WriteThrough))
                    {
                        destinationCreated = true;
                        using (var firstHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                        {
                            byte[] buffer = new byte[64 * 1024];
                            int read;
                            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                firstHash.AppendData(buffer, 0, read);
                                destination.Write(buffer, 0, read);
                            }
                            destination.Flush(true);
                            string copyHash = Convert.ToHexString(firstHash.GetHashAndReset());

                            source.Position = 0;
                            string sourceHash = HashStream(source);
                            destination.Position = 0;
                            string destinationHash = HashStream(destination);
                            ByHandleFileInformation after = GetInformation(sourceHandle, sourcePath);

                            if (!String.Equals(copyHash, sourceHash, StringComparison.Ordinal)
                                || !String.Equals(copyHash, destinationHash, StringComparison.Ordinal))
                            {
                                throw new IOException("Source/destination hash mismatch: " + sourcePath);
                            }
                            if (!SameIdentity(before, after))
                            {
                                throw new IOException("Source identity changed during snapshot: " + sourcePath);
                            }

                            return new CopyResult
                            {
                                Length = checked((long)Combine(before.FileSizeHigh, before.FileSizeLow)),
                                Sha256 = copyHash,
                                VolumeSerialNumber = before.VolumeSerialNumber,
                                FileIndex = Combine(before.FileIndexHigh, before.FileIndexLow),
                                LastWriteFileTime = Combine(before.LastWriteTime.High, before.LastWriteTime.Low),
                                NumberOfLinks = before.NumberOfLinks
                            };
                        }
                    }
                }
            }
            catch
            {
                if (destinationCreated)
                {
                    try { File.Delete(destinationPath); } catch { }
                }
                throw;
            }
        }

        public static void WriteDurableUtf8(string path, string text)
        {
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(text);
            using (var output = new FileStream(
                path,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough))
            {
                output.Write(bytes, 0, bytes.Length);
                output.Flush(true);
            }
        }

        public static void MoveDirectoryWriteThrough(string source, string destination)
        {
            if (!MoveFileExW(source, destination, MoveFileWriteThrough))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to publish snapshot directory");
            }
        }
    }
}
'@

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
        throw "Path is outside the owned parent: $candidateFull"
    }
    return $candidateFull
}

function Assert-RegularDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        throw "Expected a directory: $Path"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point directory: $Path"
    }
}

function Set-NewRestrictedDirectoryAcl {
    param([Parameter(Mandatory)][string]$Path)
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $rights = [Security.AccessControl.FileSystemRights]::FullControl

    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($currentSid)
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, $allow))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Remove-OwnedTree {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$OwnedParent
    )
    $validated = Assert-StrictChildPath -Candidate $Path -Parent $OwnedParent
    if (Test-Path -LiteralPath $validated) {
        Remove-Item -LiteralPath $validated -Recurse -Force
    }
}

function Get-SourceRootId {
    param([Parameter(Mandatory)][string]$Path)
    $normalized = (Get-NormalizedFullPath $Path).ToUpperInvariant()
    $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return ([Convert]::ToHexString($hash)).Substring(0, 24).ToLowerInvariant()
}

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

function Checkout-PinnedRepository {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Commit,
        [Parameter(Mandatory)][string]$Destination
    )
    Invoke-NativeChecked git @('clone', '--filter=blob:none', '--no-checkout', $Url, $Destination)
    Invoke-NativeChecked git @('-C', $Destination, 'fetch', '--depth', '1', 'origin', $Commit)
    Invoke-NativeChecked git @('-C', $Destination, 'checkout', '--detach', $Commit)
    $actual = (& git -C $Destination rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actual -ne $Commit) {
        throw "Pinned repository checkout mismatch: expected $Commit, got $actual"
    }
}

$dataRootFull = Get-NormalizedFullPath $DataRoot
$webViewRootFull = Get-NormalizedFullPath $WebViewRoot
$controlRootFull = Get-NormalizedFullPath $ControlRoot
$levelDbRoot = Join-Path $webViewRootFull 'Default\Local Storage\leveldb'
$snapshotId = ([Guid]::NewGuid().ToString('N'))
$snapshotName = 'snapshot-{0}-{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')), $snapshotId.Substring(0, 12)
$stagingRoot = Join-Path $controlRootFull ('.' + $snapshotName + '.staging')
$finalRoot = Join-Path $controlRootFull $snapshotName
$toolsRoot = Join-Path ([IO.Path]::GetTempPath()) ('imm-legacy-snapshot-tools-' + $snapshotId)
$levelDbLease = $null
$published = $false

try {
    if (Get-Process -Name 'integrated-mod-manager' -ErrorAction SilentlyContinue) {
        throw 'IMM is running. Close it before taking the legacy snapshot.'
    }
    $boundWebViews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*$webViewRootFull*" })
    if ($boundWebViews.Count -ne 0) {
        throw "WebView2 still has the IMM profile open (PIDs: $($boundWebViews.ProcessId -join ', '))."
    }

    Assert-RegularDirectory $dataRootFull
    Assert-RegularDirectory $webViewRootFull
    Assert-RegularDirectory $levelDbRoot

    if (-not (Test-Path -LiteralPath $controlRootFull)) {
        [IO.Directory]::CreateDirectory($controlRootFull) | Out-Null
        Set-NewRestrictedDirectoryAcl $controlRootFull
    }
    Assert-RegularDirectory $controlRootFull
    if ((Test-Path -LiteralPath $stagingRoot) -or (Test-Path -LiteralPath $finalRoot)) {
        throw "Snapshot destination already exists: $snapshotName"
    }

    [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    $dataSourceRootId = Get-SourceRootId $dataRootFull
    $webViewSourceRootId = Get-SourceRootId $levelDbRoot
    $manifestFiles = @()

    foreach ($configName in $configNames) {
        $sourcePath = Join-Path $dataRootFull $configName
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Required legacy config is missing: $sourcePath"
        }
        $artifactRelative = "raw/$dataSourceRootId/$configName"
        $destinationPath = Join-Path $stagingRoot ($artifactRelative -replace '/', [IO.Path]::DirectorySeparatorChar)
        $copy = [ImmLegacySnapshot.NativeSnapshot]::CopyExact($sourcePath, $destinationPath)
        $manifestFiles += [ordered]@{
            artifactPath = $artifactRelative
            kind = 'legacy-config-raw'
            length = $copy.Length
            relativeSourcePath = $configName
            sha256 = $copy.Sha256
            sourceIdentity = [ordered]@{
                fileIndex = $copy.FileIndex.ToString()
                lastWriteFileTime = $copy.LastWriteFileTime.ToString()
                numberOfLinks = $copy.NumberOfLinks
                volumeSerialNumber = $copy.VolumeSerialNumber
            }
            sourceRootId = $dataSourceRootId
        }
    }

    $lockPath = Join-Path $levelDbRoot 'LOCK'
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "Chromium LocalStorage LOCK file is missing: $lockPath"
    }
    $levelDbLease = [ImmLegacySnapshot.NativeSnapshot]::OpenReadLease($lockPath)
    $levelDbCopy = Join-Path $stagingRoot '.localstorage-leveldb'
    [IO.Directory]::CreateDirectory($levelDbCopy) | Out-Null

    $levelDbEntries = @(Get-ChildItem -LiteralPath $levelDbRoot -Force)
    if ($levelDbEntries.Count -eq 0) {
        throw 'Chromium LocalStorage LevelDB is empty.'
    }
    foreach ($entry in $levelDbEntries) {
        if ($entry.PSIsContainer -or (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Unexpected non-regular LevelDB entry: $($entry.FullName)"
        }
        [ImmLegacySnapshot.NativeSnapshot]::CopyExact($entry.FullName, (Join-Path $levelDbCopy $entry.Name)) | Out-Null
    }
    $levelDbLease.Dispose()
    $levelDbLease = $null

    [IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
    $readerRoot = Join-Path $toolsRoot 'ccl_chromium_reader'
    $snappyRoot = Join-Path $toolsRoot 'ccl_simplesnappy'
    Checkout-PinnedRepository 'https://github.com/cclgroupltd/ccl_chromium_reader.git' $readerCommit $readerRoot
    Checkout-PinnedRepository 'https://github.com/cclgroupltd/ccl_simplesnappy.git' $snappyCommit $snappyRoot

    $localStorageArtifact = Join-Path $stagingRoot 'webview\local-storage.json'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $localStorageArtifact)) | Out-Null
    $extractor = Join-Path $PSScriptRoot 'extract-legacy-localstorage.py'
    Invoke-NativeChecked python @(
        $extractor,
        '--leveldb', $levelDbCopy,
        '--reader-root', $readerRoot,
        '--snappy-root', $snappyRoot,
        '--output', $localStorageArtifact
    )

    $localStorage = Get-Content -LiteralPath $localStorageArtifact -Raw -Encoding utf8 | ConvertFrom-Json
    $actualKeys = @($localStorage.records.PSObject.Properties.Name | Sort-Object)
    $expectedKeys = @('game-theme', 'imm-lang')
    if (($actualKeys -join "`n") -ne ($expectedKeys -join "`n")) {
        throw "LocalStorage whitelist mismatch: $($actualKeys -join ', ')"
    }
    Remove-OwnedTree $levelDbCopy $stagingRoot

    $localStorageItem = Get-Item -LiteralPath $localStorageArtifact
    $localStorageHash = (Get-FileHash -LiteralPath $localStorageArtifact -Algorithm SHA256).Hash
    $manifestFiles += [ordered]@{
        artifactPath = 'webview/local-storage.json'
        kind = 'chromium-localstorage-whitelist'
        keys = $actualKeys
        length = $localStorageItem.Length
        sha256 = $localStorageHash
        sourceRootId = $webViewSourceRootId
        storageKey = $localStorage.storageKey
    }

    $installedExe = 'D:\Apps\Integrated Mod Manager (IMM)\integrated-mod-manager.exe'
    $installedVersion = $null
    if (Test-Path -LiteralPath $installedExe -PathType Leaf) {
        $versionInfo = (Get-Item -LiteralPath $installedExe).VersionInfo
        $installedVersion = [ordered]@{
            fileVersion = $versionInfo.FileVersion
            path = $installedExe
            productVersion = $versionInfo.ProductVersion
            sha256 = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash
        }
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        snapshotId = $snapshotId
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        tool = [ordered]@{
            cclChromiumReaderCommit = $readerCommit
            cclSimpleSnappyCommit = $snappyCommit
            name = 'IMM legacy state snapshot'
        }
        installedVersion = $installedVersion
        sourceRoots = @(
            [ordered]@{ id = $dataSourceRootId; kind = 'legacy-data'; path = $dataRootFull },
            [ordered]@{ id = $webViewSourceRootId; kind = 'chromium-localstorage'; path = $levelDbRoot }
        )
        files = $manifestFiles
    }
    $manifestText = ($manifest | ConvertTo-Json -Depth 12) + "`n"
    $manifestPath = Join-Path $stagingRoot 'manifest.json'
    [ImmLegacySnapshot.NativeSnapshot]::WriteDurableUtf8($manifestPath, $manifestText)
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
    [ImmLegacySnapshot.NativeSnapshot]::WriteDurableUtf8(
        (Join-Path $stagingRoot 'manifest.sha256'),
        ($manifestHash + '  manifest.json' + "`n"))

    [ImmLegacySnapshot.NativeSnapshot]::MoveDirectoryWriteThrough($stagingRoot, $finalRoot)
    $published = $true
    [ordered]@{
        snapshotPath = $finalRoot
        manifestSha256 = $manifestHash
        configCount = $configNames.Count
        localStorageKeys = $actualKeys
    } | ConvertTo-Json -Depth 4
}
finally {
    if ($null -ne $levelDbLease) {
        $levelDbLease.Dispose()
    }
    if (-not $published -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-OwnedTree $stagingRoot $controlRootFull
    }
    if (Test-Path -LiteralPath $toolsRoot) {
        Remove-OwnedTree $toolsRoot ([IO.Path]::GetTempPath())
    }
}
