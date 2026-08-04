param(
	[Parameter(Mandatory = $true)]
	[string]$Url,
	[Parameter(Mandatory = $true)]
	[string]$FileName,
	[Parameter(Mandatory = $true)]
	[long]$ExpectedSize,
	[Parameter(Mandatory = $true)]
	[string]$Md5,
	[Parameter(Mandatory = $true)]
	[string]$PreviewUrl
)

$ErrorActionPreference = "Stop"
$env:IMM_LIVE_NTE_URL = $Url
$env:IMM_LIVE_NTE_FILE = $FileName
$env:IMM_LIVE_NTE_SIZE = "$ExpectedSize"
$env:IMM_LIVE_NTE_MD5 = $Md5
$env:IMM_LIVE_NTE_PREVIEW_URL = $PreviewUrl

Push-Location (Join-Path $PSScriptRoot "..\src-tauri")
try {
	& rtk proxy cargo test live_nte_zip_uses_download_hash_extract_and_library_wal_path --all-features -- --ignored --nocapture --test-threads=1
	exit $LASTEXITCODE
}
finally {
	Pop-Location
}
