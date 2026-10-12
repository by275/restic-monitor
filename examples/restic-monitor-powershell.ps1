param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('backup', 'forget', 'prune', 'forget_prune', 'copy', 'stats', 'check', 'restore')]
    [string] $Operation,

    [Parameter(Mandatory = $true)]
    [string] $PingUrl,

    [ValidateSet('restore-size', 'raw-data')]
    [string] $StatsMode = 'restore-size',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ResticArguments = @()
)

$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$runId = [guid]::NewGuid().ToString()
$baseUrl = $PingUrl.TrimEnd('/')

function Send-Ping {
    param(
        [Parameter(Mandatory = $true)][string] $Uri,
        [hashtable] $Body
    )
    $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 8 -Compress } else { $null }
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $request = @{ Method = 'Post'; Uri = $Uri; TimeoutSec = 5; ErrorAction = 'Stop' }
            if ($null -ne $json) {
                $request.ContentType = 'application/json'
                $request.Body = $json
            }
            Invoke-RestMethod @request | Out-Null
            return $true
        }
        catch {
            $statusCode = $null
            try { $statusCode = [int] $_.Exception.Response.StatusCode } catch { }
            if ($null -ne $statusCode -and $statusCode -notin @(408, 429) -and $statusCode -lt 500) {
                break
            }
            if ($attempt -lt 4) {
                Start-Sleep -Seconds ([math]::Pow(2, $attempt - 1))
            }
        }
    }
    return $false
}

function Get-SafeCounter {
    param([object] $Value)
    if ($null -eq $Value) { return $null }
    try {
        $number = [decimal] $Value
        if ($number -lt 0 -or $number -gt 9007199254740991 -or $number -ne [decimal]::Floor($number)) { return $null }
        return [long] $number
    }
    catch { return $null }
}

$startUri = "$baseUrl/runs/$runId/start"
if (-not (Send-Ping -Uri $startUri)) {
    [Console]::Error.WriteLine('Restic Monitor start ping failed; continuing with Restic.')
}

switch ($Operation) {
    'backup' { $arguments = @('backup', '--json') + $ResticArguments }
    'stats' { $arguments = @('stats', '--json', '--mode', $StatsMode) + $ResticArguments }
    'forget_prune' { $arguments = @('forget', '--prune') + $ResticArguments }
    default { $arguments = @($Operation) + $ResticArguments }
}

$stdoutFile = [System.IO.Path]::GetTempFileName()
$stderrFile = [System.IO.Path]::GetTempFileName()
# Capture both streams so JSON parsing cannot mix Restic diagnostics into its output.
try {
    & restic @arguments 1> $stdoutFile 2> $stderrFile
    $resticExitCode = $LASTEXITCODE
}
catch {
    [System.IO.File]::AppendAllText($stderrFile, $_.Exception.Message + [Environment]::NewLine)
    $resticExitCode = 127
}
$outputLines = @(Get-Content -LiteralPath $stdoutFile)
$errorLines = @(Get-Content -LiteralPath $stderrFile)
foreach ($line in $outputLines) { [Console]::Out.WriteLine([string] $line) }
foreach ($line in $errorLines) { [Console]::Error.WriteLine([string] $line) }

$resticVersion = $null
try {
    $versionText = (& restic version 2>$null | Select-Object -First 1)
    if ($versionText -match '^restic\s+([^\s]+)') { $resticVersion = $Matches[1] }
}
catch { }

$completion = @{ exit_code = [int] $resticExitCode }
if ($resticVersion) { $completion.restic_version = $resticVersion }

if ($Operation -eq 'backup') {
    $summary = $null
    foreach ($line in $outputLines) {
        try {
            $item = ConvertFrom-Json -InputObject ([string] $line) -ErrorAction Stop
            if ($item.message_type -eq 'summary') { $summary = $item }
        }
        catch { }
    }
    if ($null -ne $summary) {
        $metrics = @{}
        foreach ($pair in @(
            @{ target = 'bytes_processed'; source = 'total_bytes_processed' },
            @{ target = 'bytes_added'; source = 'data_added' },
            @{ target = 'bytes_added_packed'; source = 'data_added_packed' },
            @{ target = 'files_new'; source = 'files_new' },
            @{ target = 'files_changed'; source = 'files_changed' },
            @{ target = 'files_unmodified'; source = 'files_unmodified' }
        )) {
            $value = Get-SafeCounter $summary.($pair.source)
            if ($null -ne $value) { $metrics[$pair.target] = $value }
        }
        if ($summary.snapshot_id -match '^[a-fA-F0-9]{8,64}$') { $metrics.snapshot_id = $summary.snapshot_id }
        if ($metrics.Count -gt 0) { $completion.metrics = $metrics }
    }
}
elseif ($Operation -eq 'stats' -and $resticExitCode -eq 0) {
    $stats = $null
    foreach ($line in $outputLines) {
        try { $stats = ConvertFrom-Json -InputObject ([string] $line) -ErrorAction Stop }
        catch { }
    }
    if ($null -ne $stats) {
        $valueBytes = Get-SafeCounter $stats.total_size
        if ($null -ne $valueBytes) {
            $measurement = @{ mode = $StatsMode; value_bytes = $valueBytes }
            foreach ($name in @('total_file_count', 'total_blob_count', 'snapshots_count', 'total_uncompressed_size')) {
                $value = Get-SafeCounter $stats.$name
                if ($null -ne $value) { $measurement[$name] = $value }
            }
            $completion.repository_stats = $measurement
        }
    }
}

$completeUri = "$baseUrl/runs/$runId/complete"
if (-not (Send-Ping -Uri $completeUri -Body $completion)) {
    [Console]::Error.WriteLine('Restic Monitor completion ping failed; no local delivery queue is configured.')
}

Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
exit $resticExitCode
