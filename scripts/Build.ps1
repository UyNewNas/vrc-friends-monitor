#requires -Version 7.0
param([switch]$SkipRestore)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repoRoot 'src/VRCFriendsMonitor/VRCFriendsMonitor.csproj'
[xml]$project = Get-Content -LiteralPath $projectPath -Raw
$version = [string]$project.Project.PropertyGroup.Version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$') { throw 'Invalid project version.' }
$publishDir = Join-Path $repoRoot 'artifacts/publish'
$packageRoot = Join-Path $repoRoot ('artifacts/staging/' + [guid]::NewGuid().ToString('N'))
$assetRoot = Join-Path $repoRoot 'artifacts/packages'
New-Item -ItemType Directory -Path $publishDir,$packageRoot,$assetRoot -Force | Out-Null
if (!$SkipRestore) {
    dotnet restore $projectPath -r win-x64
    if ($LASTEXITCODE -ne 0) { throw 'Restore failed.' }
}
dotnet publish $projectPath -c Release -r win-x64 --self-contained true --no-restore -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:ContinuousIntegrationBuild=true -o $publishDir
if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
# Copy only these files. Never archive the checkout, publish folder, or user profile.
Copy-Item -LiteralPath (Join-Path $publishDir 'VRChatFriendNotifier.exe') -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE'),(Join-Path $repoRoot 'README.md'),(Join-Path $repoRoot 'docs/QUICKSTART.txt') -Destination $packageRoot
$asset = Join-Path $assetRoot "VRC-Friends-Monitor-$version-win-x64.zip"
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $asset -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($asset)
try {
    $actual = @($archive.Entries.FullName | Sort-Object)
    $expected = @('LICENSE','QUICKSTART.txt','README.md','VRChatFriendNotifier.exe' | Sort-Object)
    if (Compare-Object $actual $expected) { throw 'Unexpected file in release archive.' }
} finally { $archive.Dispose() }
$checksum = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($asset + '.sha256', "$checksum  $([System.IO.Path]::GetFileName($asset))`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Package: $([System.IO.Path]::GetFileName($asset))"
