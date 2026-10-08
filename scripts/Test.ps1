#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repoRoot 'artifacts/publish/VRChatFriendNotifier.exe'
$testRoot = Join-Path $repoRoot 'artifacts/tests'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
function Invoke-AppCheck([string]$Mode, [string]$OutputPath) {
    $process = Start-Process -FilePath $exe -ArgumentList @($Mode, ('"' + $OutputPath + '"')) -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(90000)) { $process.Kill(); throw "Check timed out: $Mode" }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "Check failed: $Mode (exit $($process.ExitCode))" }
}
$report = Join-Path $testRoot 'self-test.txt'
Invoke-AppCheck '--self-test' $report
Get-Content -LiteralPath $report
$previewDir = Join-Path $testRoot 'preview'
Invoke-AppCheck '--render-preview' $previewDir
foreach ($name in @('settings-preview.png','logs-preview.png','toast-preview.png','login-preview.png')) {
    if (!(Test-Path -LiteralPath (Join-Path $previewDir $name))) { throw "Missing UI preview: $name" }
}
Write-Output 'UI checks passed (synthetic data only; clipboard writer mocked).'
