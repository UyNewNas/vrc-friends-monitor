#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$files = @(git -C $repoRoot ls-files)
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'No tracked source files to audit.' }
$problems = [System.Collections.Generic.List[string]]::new()
$allowedRoot = @('.gitignore','.gitattributes','.editorconfig','global.json','Directory.Build.props','README.md','LICENSE','CONTRIBUTING.md','SECURITY.md')
$pathPatterns = @('(^|/)(bin|obj|artifacts|logs|log-test-artifacts|\.build-home|\.vs|\.codex)(/|$)', '(^|/)(settings\.json|session\.bin|\.env(?:\..*)?|test-results\.txt)$', '\.(exe|dll|pdb|zip|log|pfx|p12|pem|key)$')
# Report only filenames, never potentially secret matching values.
$contentPatterns = @(
    '(?i)[A-Z]:[\\/](?:Users|[^\\/]+[\\/]Documents)[\\/]',
    '(?i)/(?:Users|home)/[^/\s]+/',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{30,}',
    'authcookie_[A-Za-z0-9-]{20,}',
    '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
foreach ($file in $files) {
    $allowed = $allowedRoot -contains $file -or $file -match '^src/VRCFriendsMonitor/[^/]+\.(cs|csproj)$' -or $file -match '^scripts/[^/]+\.ps1$' -or $file -match '^docs/(?:[^/]+\.(md|txt)|images/[^/]+\.png)$' -or $file -match '^\.github/(?:workflows/[^/]+\.yml|ISSUE_TEMPLATE/[^/]+\.yml|dependabot\.yml|pull_request_template\.md)$'
    if (!$allowed -or ($pathPatterns | Where-Object { $file -match $_ })) { $problems.Add("Disallowed tracked path: $file"); continue }
    if ($file.EndsWith('.png')) { continue }
    $content = [System.IO.File]::ReadAllText((Join-Path $repoRoot $file))
    if ($contentPatterns | Where-Object { $content -match $_ }) { $problems.Add("Potential private data in: $file") }
}
if ($problems.Count -gt 0) { $problems | Write-Output; throw 'Privacy audit failed.' }
Write-Output "Privacy audit passed for $($files.Count) tracked project files."
