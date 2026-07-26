[CmdletBinding()]
param(
    [string]$DestinationRoot = (Join-Path $HOME ".agents\skills"),
    [switch]$Replace
)

$ErrorActionPreference = "Stop"
$PackageRoot = $PSScriptRoot
$Source = Join-Path $PackageRoot "commercial-self-intro"
$Target = Join-Path $DestinationRoot "commercial-self-intro"
$Manifest = Join-Path $PackageRoot "MANIFEST.sha256"
$Backup = $null

if (-not (Test-Path -LiteralPath (Join-Path $Source "SKILL.md"))) {
    throw "Package is incomplete: commercial-self-intro\SKILL.md is missing."
}

if (-not (Test-Path -LiteralPath $Manifest)) {
    throw "Package is incomplete: MANIFEST.sha256 is missing."
}

foreach ($line in Get-Content -LiteralPath $Manifest -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
        throw "Invalid MANIFEST.sha256 line: $line"
    }
    $Expected = $Matches[1].ToUpperInvariant()
    $Relative = $Matches[2] -replace '/', [IO.Path]::DirectorySeparatorChar
    $File = Join-Path $PackageRoot $Relative
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        throw "Integrity check failed; file is missing: $Relative"
    }
    $Actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
    if ($Actual -ne $Expected) {
        throw "Integrity check failed: $Relative"
    }
}

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

if (Test-Path -LiteralPath $Target) {
    if (-not $Replace) {
        throw "Target already exists: $Target. Re-run with -Replace to upgrade."
    }
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $Backup = "$Target.backup-$Stamp"
    Move-Item -LiteralPath $Target -Destination $Backup
}

try {
    Copy-Item -LiteralPath $Source -Destination $Target -Recurse

    $Python = Get-Command python -ErrorAction SilentlyContinue
    if ($Python) {
        & $Python.Source -X utf8 (Join-Path $Target "scripts\validate_book_coverage.py")
        if ($LASTEXITCODE -ne 0) {
            throw "The installed skill failed the 64-technique coverage check."
        }
    } else {
        Write-Warning "Python was not found. Files were installed, but coverage validation was skipped."
    }
} catch {
    if (Test-Path -LiteralPath $Target) {
        $Failed = "$Target.failed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Move-Item -LiteralPath $Target -Destination $Failed
    }
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
        Move-Item -LiteralPath $Backup -Destination $Target
    }
    throw
}

Write-Host "Installed: $Target"
if ($Backup) { Write-Host "Previous version backup: $Backup" }
Write-Host 'Open a new Codex task and invoke: $commercial-self-intro'
