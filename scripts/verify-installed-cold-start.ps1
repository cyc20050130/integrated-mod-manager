param(
	[Parameter(Mandatory = $true)]
	[string]$ExePath,
	[int]$Iterations = 10,
	[int]$SampleSeconds = 5
)

$ErrorActionPreference = "Stop"

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
$startedAt = Get-Date
$results = @()

function Stop-ElevatedProcessTree {
	param([int]$ProcessId)

	$taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
	$startArgs = @{
		FilePath = $taskkill
		ArgumentList = @("/PID", "$ProcessId", "/T", "/F")
		Verb = "RunAs"
		Wait = $true
		PassThru = $true
		WindowStyle = "Hidden"
	}
	$killer = Start-Process @startArgs
	if ($killer.ExitCode -ne 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
		throw "Elevated taskkill failed for PID $ProcessId with exit code $($killer.ExitCode)"
	}
}

foreach ($existing in @(Get-Process -Name "integrated-mod-manager" -ErrorAction SilentlyContinue)) {
	Stop-ElevatedProcessTree -ProcessId $existing.Id
}

for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
	$app = Start-Process -FilePath $resolvedExe -PassThru -WindowStyle Hidden
	Start-Sleep -Seconds $SampleSeconds
	$app.Refresh()

	$children = @(
		Get-CimInstance Win32_Process |
			Where-Object { $_.ParentProcessId -eq $app.Id }
	)
	$webViewChildren = @($children | Where-Object { $_.Name -eq "msedgewebview2.exe" })
	$webViewVersion = $null
	if ($webViewChildren.Count -gt 0 -and $webViewChildren[0].ExecutablePath) {
		$webViewVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo(
			$webViewChildren[0].ExecutablePath
		).FileVersion
	}

	$result = [pscustomobject]@{
		Iteration = $iteration
		Pid = $app.Id
		Exited = $app.HasExited
		Responding = if ($app.HasExited) { $false } else { $app.Responding }
		WebViewChildren = $webViewChildren.Count
		WebViewVersion = $webViewVersion
		ExitCode = if ($app.HasExited) { $app.ExitCode } else { $null }
	}
	$results += $result
	$result | Format-Table -AutoSize

	if (-not $app.HasExited) {
		Stop-ElevatedProcessTree -ProcessId $app.Id
	}
	Start-Sleep -Milliseconds 500
}

Start-Sleep -Seconds 3
$crashEvents = @(
	Get-WinEvent -FilterHashtable @{
		LogName = "Application"
		StartTime = $startedAt
	} -ErrorAction SilentlyContinue |
		Where-Object {
			$_.ProviderName -in @("Application Error", "Windows Error Reporting") -and
			$_.Message -match "integrated-mod-manager"
		}
)

$failedRuns = @(
	$results |
		Where-Object { $_.Exited -or -not $_.Responding -or $_.WebViewChildren -lt 1 }
)
$remainingProcesses = @(Get-Process -Name "integrated-mod-manager" -ErrorAction SilentlyContinue)

Write-Output "SUMMARY iterations=$Iterations failures=$($failedRuns.Count) crashEvents=$($crashEvents.Count) remainingProcesses=$($remainingProcesses.Count)"

if ($failedRuns.Count -gt 0 -or $crashEvents.Count -gt 0 -or $remainingProcesses.Count -gt 0) {
	if ($crashEvents.Count -gt 0) {
		$crashEvents |
			Select-Object TimeCreated, ProviderName, Id, Message |
			Format-List
	}
	exit 1
}
