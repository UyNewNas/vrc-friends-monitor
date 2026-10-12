#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$files = @(git -C $repoRoot ls-files)
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'No tracked source files to audit.' }
$problems = [System.Collections.Generic.List[string]]::new()
$allowedRoot = @('.gitignore','.gitattributes','.editorconfig','global.json','Directory.Build.props','README.md','LICENSE','CONTRIBUTING.md','SECURITY.md')
$pathPatterns = @('(^|/)(bin|obj|artifacts|logs|log-test-artifacts|node_modules|dist|coverage|test-results|playwright-report|browser-profile|\.build-home|\.vs|\.codex)(/|$)', '(^|/)(settings\.json|session\.bin|credentials\.json|cookies\.json|\.env(?:\..*)?|test-results\.txt)$', '\.(exe|dll|pdb|zip|log|pfx|p12|pem|key)$')
$extensionRootFiles = @('manifest.json','package.json','README.md','background.js','api.js','core.js','monitor.js','popup.html','dashboard.html','ui.js','ui.css')
$extensionScriptFiles = @('project-files.mjs','check.mjs','package.mjs','ui-smoke.mjs')
# Report only filenames, never potentially secret matching values.
$contentPatterns = @(
    '(?i)[A-Z]:[\\/](?:Users|[^\\/]+[\\/]Documents)[\\/]',
    '(?i)(?<![A-Za-z0-9.:/])/(?:Users|home)/[^/\s]+/',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{30,}',
    'authcookie_[A-Za-z0-9-]{20,}',
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
foreach ($file in $files) {
    $extensionAllowed = ($file -match '^browser-extension/([^/]+)$' -and $extensionRootFiles -contains $Matches[1]) -or ($file -match '^browser-extension/scripts/([^/]+)$' -and $extensionScriptFiles -contains $Matches[1]) -or $file -match '^browser-extension/tests/[a-z0-9-]+\.test\.mjs$' -or $file -match '^browser-extension/icons/icon(?:16|32|48|128)\.png$'
    $allowed = $allowedRoot -contains $file -or $file -match '^src/VRCFriendsMonitor/[^/]+\.(cs|csproj)$' -or $file -match '^scripts/[^/]+\.ps1$' -or $file -match '^docs/(?:[^/]+\.(md|txt)|images/[^/]+\.png)$' -or $file -match '^\.github/(?:workflows/[^/]+\.yml|ISSUE_TEMPLATE/[^/]+\.yml|dependabot\.yml|pull_request_template\.md)$' -or $extensionAllowed
    if (!$allowed -or ($pathPatterns | Where-Object { $file -match $_ })) { $problems.Add("Disallowed tracked path: $file"); continue }
    if ($file.EndsWith('.png')) { continue }
    $content = [System.IO.File]::ReadAllText((Join-Path $repoRoot $file))
    if ($contentPatterns | Where-Object { $content -match $_ }) { $problems.Add("Potential private data in: $file") }
}
if ($problems.Count -gt 0) { $problems | Write-Output; throw 'Privacy audit failed.' }
Write-Output "Privacy audit passed for $($files.Count) tracked project files."
