[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$ConfirmDshFullyExited,
  [string]$PlanPath = (Join-Path $PSScriptRoot '..\session-history-hotfix-plan-20261101.json'),
  [string]$SessionsRoot = (Join-Path $env:USERPROFILE '.dsh\sessions'),
  [string]$NodePath = 'node',
  [int[]]$AdditionalPort = @()
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-RegularPath([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) { throw 'REGULAR_FILE_REQUIRED' }
  $current = $item.FullName
  while ($current) {
    $entry = Get-Item -LiteralPath $current -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REFUSED' }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}
function Hash-File([string]$Path) {
  Assert-RegularPath $Path
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Offline {
  if (-not $ConfirmDshFullyExited) { throw 'Confirm ALL DSH processes, including headless hosts, have exited. Then pass -ConfirmDshFullyExited.' }
  foreach ($port in (@(14983) + $AdditionalPort | Select-Object -Unique)) {
    if ($port -lt 1 -or $port -gt 65535) { throw 'INVALID_PORT' }
    foreach ($address in @('127.0.0.1', '::1')) {
      $socket = New-Object Net.Sockets.TcpClient
      try {
        $pendingConnect = $socket.BeginConnect($address, $port, $null, $null)
        # Verdict window 10s: a refused loopback connect can take seconds to
        # surface when a filter driver delays SYNs (~2.4s measured on this
        # machine), and a 1s window is then always inconclusive.
        if (-not $pendingConnect.AsyncWaitHandle.WaitOne(10000)) { throw 'OFFLINE_CHECK_INCONCLUSIVE' }
        try { $socket.EndConnect($pendingConnect) }
        catch {
          $cause = $_.Exception
          while ($cause.InnerException) { $cause = $cause.InnerException }
          $refused = ($cause -is [Net.Sockets.SocketException]) -and ($cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused)
          $noIpv6 = ($address -eq '::1') -and ($cause -is [Net.Sockets.SocketException]) -and ($cause.SocketErrorCode -in @([Net.Sockets.SocketError]::AddressFamilyNotSupported, [Net.Sockets.SocketError]::AddressNotAvailable, [Net.Sockets.SocketError]::ProtocolNotSupported))
          if (-not ($refused -or $noIpv6)) { throw 'OFFLINE_CHECK_INCONCLUSIVE' }
        }
        if ($socket.Connected) { throw "DSH_PORT_IS_LISTENING: $port. Exit DSH before applying." }
      } finally { $socket.Dispose() }
    }
  }
  # Closed ports do not prove headless writers have stopped. The explicit human
  # confirmation above is essential; this script never kills or starts DSH.
}

Assert-RegularPath $PlanPath
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$allowed = @('session-access', 'usage', 'usage-journal', 'child-session', 'native-recovery', 'tool', 'index') | ForEach-Object { "lib/$_.js" }
if ($plan.schemaVersion -ne 1 -or $plan.plugin -ne 'dsh-maestro-codex' -or $plan.files.Count -ne $allowed.Count) { throw 'INVALID_HOTFIX_PLAN' }
if (@(Compare-Object ($allowed | Sort-Object) ($plan.files.path | Sort-Object)).Count -ne 0) { throw 'INVALID_HOTFIX_FILE_LIST' }
$packagePath = Join-Path $plan.targetRoot 'package.json'
Assert-RegularPath $packagePath
$installed = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installed.name -ne $plan.plugin -or $installed.version -ne $plan.version) { throw 'INSTALLED_PLUGIN_VERSION_CHANGED' }
$repairScript = Join-Path $PSScriptRoot 'repair-maestro-session-tree.mjs'
Assert-RegularPath $repairScript
# Handle native exit codes explicitly, including JSON reports written to stderr.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
& $NodePath -e 'if(typeof require("node:zlib").zstdDecompressSync!=="function")process.exit(2)'
if ($LASTEXITCODE -ne 0) { throw 'A Node.js version with ZSTD support is required (the verified environment uses Node 24.8.0).' }
if ($Apply) { Assert-Offline }
elseif ($ConfirmDshFullyExited) { throw 'Use -ConfirmDshFullyExited only with -Apply.' }

$changes = @()
foreach ($entry in $plan.files) {
  if ($entry.beforeSha256 -notmatch '^[a-f0-9]{64}$' -or $entry.afterSha256 -notmatch '^[a-f0-9]{64}$') { throw 'INVALID_PLAN_HASH' }
  $source = Join-Path $plan.sourceRoot $entry.path
  $target = Join-Path $plan.targetRoot $entry.path
  if ((Hash-File $source) -ne $entry.afterSha256) { throw "BUILD_CHANGED: $($entry.path). Re-verify the build before preparing another plan." }
  $current = Hash-File $target
  if ($current -eq $entry.afterSha256) { continue }
  if ($current -ne $entry.beforeSha256) { throw "INSTALLED_FILE_CHANGED: $($entry.path). No unreviewed file will be overwritten." }
  if (((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { throw 'READONLY_TARGET_REFUSED' }
  $changes += [pscustomobject]@{ Source = $source; Target = $target; Before = $current; After = $entry.afterSha256; Backup = "$target.maestro-history-original-$current.bak" }
}
Write-Host ("Verified hotfix plan: {0} runtime modules need replacement." -f $changes.Count)
if ($Apply) {
  # Complete every verified code backup before replacing the first module.
  foreach ($entry in $changes) {
    if ((Hash-File $entry.Target) -ne $entry.Before) { throw 'INSTALLED_FILE_CHANGED' }
    if (-not (Test-Path -LiteralPath $entry.Backup)) { [IO.File]::Copy($entry.Target, $entry.Backup, $false) }
    if ((Hash-File $entry.Backup) -ne $entry.Before) { throw 'CODE_BACKUP_VERIFY_FAILED' }
  }
  foreach ($entry in $changes) {
    Assert-Offline
    if ((Hash-File $entry.Source) -ne $entry.After -or (Hash-File $entry.Target) -ne $entry.Before) { throw 'FILE_CHANGED_BEFORE_INSTALL' }
    $temporary = "$($entry.Target).maestro-history-$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::Copy($entry.Source, $temporary, $false)
    if ((Hash-File $temporary) -ne $entry.After) { throw 'CODE_TEMP_VERIFY_FAILED' }
    # Windows ReplaceFile preserves destination metadata; do not fall back to
    # delete/copy if it refuses. Retain backups/temporary evidence on failure.
    # PowerShell coerces $null to an empty string for this string parameter;
    # NullString passes a real .NET null (no second backup) to File.Replace.
    [IO.File]::Replace($temporary, $entry.Target, [NullString]::Value)
    if ((Hash-File $entry.Target) -ne $entry.After) { throw 'CODE_INSTALL_VERIFY_FAILED' }
    Write-Host ("Installed: {0}; original: {1}" -f [IO.Path]::GetFileName($entry.Target), $entry.Backup)
  }
  Assert-Offline
}
$repairArgs = @($repairScript)
if ($Apply) { $repairArgs += @('--apply', '--confirm-dsh-fully-exited') }
foreach ($port in $AdditionalPort) { $repairArgs += @('--port', [string]$port) }
$repairArgs += $SessionsRoot
$repairOutput = @(& $NodePath @repairArgs 2>&1 | ForEach-Object { $_.ToString() })
$repairExitCode = $LASTEXITCODE
if ($repairOutput.Count -gt 0) {
  try { $report = ($repairOutput -join [Environment]::NewLine) | ConvertFrom-Json }
  catch { throw 'LOG_REPAIR_REPORT_INVALID. Keep DSH closed and preserve all backups; no automatic rollback is attempted.' }
  if ($null -eq $report -or -not $report.PSObject.Properties['status']) { throw 'LOG_REPAIR_REPORT_INVALID' }
  $reportPath = Join-Path $plan.sourceRoot ("session-history-repair-{0}-{1}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 40) + [Environment]::NewLine)
  $reportFile = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $reportFile.Write($bytes, 0, $bytes.Length); $reportFile.Flush($true) } finally { $reportFile.Dispose() }
  Write-Host ("Log repair report: {0}" -f $reportPath)
  Write-Host ("Status: {0}" -f $report.status)
  if ($report.PSObject.Properties['scan']) {
    Write-Host ("Planned: {0}; repaired: {1}; marked events: {2}" -f $report.planned, $report.repaired, $report.markedEvents)
    Write-Host ("Scan summary: {0}" -f ($report.scan.summary | ConvertTo-Json -Compress))
  }
  if ($report.PSObject.Properties['error']) { Write-Host ("Repair error: {0}; phase: {1}" -f $report.error.code, $report.error.phase) }
  elseif ($report.PSObject.Properties['code']) { Write-Host ("Repair error: {0}" -f $report.code) }
} elseif ($repairExitCode -eq 0) {
  throw 'LOG_REPAIR_REPORT_MISSING. Keep DSH closed and preserve all backups.'
}
if ($repairExitCode -ne 0) { throw 'LOG_REPAIR_STOPPED. Keep DSH closed. Preserve all backups and inspect the reported failure; no automatic rollback is attempted.' }
if ($Apply) {
  Write-Host 'Offline code and log repair completed. Start DSH manually, refresh the existing GUI, and verify the original session history.'
} else {
  Write-Host 'Read-only check completed. Nothing was installed or repaired. Apply requires ALL DSH processes to be fully exited.'
}
