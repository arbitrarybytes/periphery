<#
.SYNOPSIS
    Runs Periphery — the Node (Electron) edition by default, or the Rust
    (Tauri) preview edition.

.DESCRIPTION
    Periphery ships as two editions of one product (see ai-native/versioning.md).
    Both answer the same cue contract on 127.0.0.1:49123, which is deliberate:
    every hook, CLI call, and agent config keeps working when you switch.

    The consequence is that only ONE may run at a time. This script makes that
    constraint impossible to trip over by accident — it checks the port first,
    tells you which edition is holding it, and refuses rather than starting a
    second instance that would silently fail to receive cues.

.PARAMETER Edition
    'node' (default) runs the stable Electron build.
    'tauri' runs the Rust preview build.

.PARAMETER Release
    Tauri only. Builds and runs an optimised binary instead of a debug one.
    Slower to compile, much faster to run.

.PARAMETER Force
    Stops whatever is already holding the port, then starts the edition asked
    for. Without this, an occupied port is an error.

.PARAMETER Stop
    Stops any running Periphery and exits without starting anything.

.PARAMETER Devtools
    Tauri only. Opens devtools on the first overlay. The overlay is
    click-through, so this is the only way to inspect it.

.EXAMPLE
    .\scripts\run.ps1
    Runs the Node edition.

.EXAMPLE
    .\scripts\run.ps1 -Edition tauri -Force
    Stops whatever is running and starts the Rust preview.

.EXAMPLE
    .\scripts\run.ps1 -Stop
#>

[CmdletBinding()]
param(
    [ValidateSet('node', 'tauri')]
    [string]$Edition = 'node',

    [switch]$Release,
    [switch]$Force,
    [switch]$Stop,
    [switch]$Devtools
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Port = 49123

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

function Write-Step { param([string]$Message) Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "  $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }

<#
    Asks the running instance which edition it is. The cue receiver reports
    this precisely because the two editions behave alike and are otherwise
    indistinguishable from the outside.
#>
function Get-RunningEdition {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        return [pscustomobject]@{
            Edition = $health.edition
            Version = $health.version
        }
    } catch {
        return $null
    }
}

function Test-PortBusy {
    # -ErrorAction SilentlyContinue would still trip StrictMode on an empty
    # result, so the lookup is wrapped instead.
    try {
        $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return $null -ne $listeners
    } catch {
        return $false
    }
}

function Stop-Periphery {
    $stopped = @()

    # A process can exit between enumeration and Stop-Process — killing the
    # Electron main process takes its children with it — so a miss is success,
    # not an error.
    function Stop-Quietly {
        param([int]$ProcessId)
        try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch {}
    }

    # The Tauri build is a single native process.
    foreach ($proc in @(Get-Process -Name 'periphery' -ErrorAction SilentlyContinue)) {
        $stopped += "periphery (pid $($proc.Id))"
        Stop-Quietly $proc.Id
    }

    # Electron reports itself as 'electron' in a dev run. Match only the ones
    # started from this repo, so an unrelated Electron app is left alone.
    foreach ($proc in @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue)) {
        $path = ''
        try { $path = $proc.Path } catch { $path = '' }
        if ($path -and $path.StartsWith($RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $stopped += "electron (pid $($proc.Id))"
            Stop-Quietly $proc.Id
        }
    }

    if ($stopped.Count -gt 0) {
        Write-Step "Stopped: $($stopped -join ', ')"
        # Give the OS a moment to release the listening socket, or the next
        # bind races it and reports a false conflict.
        Start-Sleep -Milliseconds 700
    }
    return $stopped.Count
}

function Assert-Command {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found on PATH. $Hint"
    }
}

# --------------------------------------------------------------------------
# Stop mode
# --------------------------------------------------------------------------

if ($Stop) {
    Write-Host "`nPeriphery — stopping" -ForegroundColor White
    if ((Stop-Periphery) -eq 0) { Write-Note 'Nothing was running.' }
    Write-Host ''
    exit 0
}

Write-Host "`nPeriphery — $Edition edition" -ForegroundColor White

# --------------------------------------------------------------------------
# One at a time
# --------------------------------------------------------------------------

$running = Get-RunningEdition
if ($null -ne $running) {
    if ($Force) {
        Write-Step "Replacing the running $($running.Edition) edition (v$($running.Version))."
        Stop-Periphery | Out-Null
    } else {
        Write-Warn "The $($running.Edition) edition (v$($running.Version)) is already listening on 127.0.0.1:$Port."
        Write-Note 'Both editions share that port on purpose, so only one can run at a time.'
        Write-Note "Re-run with -Force to replace it, or -Stop to shut it down."
        Write-Host ''
        exit 1
    }
} elseif (Test-PortBusy) {
    # Something holds the port but does not answer /health — not Periphery.
    Write-Warn "Port $Port is in use by another program, and Periphery cannot receive cues without it."
    Write-Note "Find it with: Get-NetTCPConnection -LocalPort $Port -State Listen"
    Write-Host ''
    exit 1
} else {
    # A stale process can exist without holding the port (mid-shutdown, or a
    # crashed run). Clear it so the tray does not end up with two icons.
    Stop-Periphery | Out-Null
}

# --------------------------------------------------------------------------
# Launch
# --------------------------------------------------------------------------

Push-Location $RepoRoot
try {
    if ($Edition -eq 'node') {
        Assert-Command -Name 'npm' -Hint 'Install Node.js 18.17 or newer from https://nodejs.org.'

        if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
            Write-Step 'Installing dependencies (first run only)…'
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
        }

        # Some tooling (and this repo's own asset scripts) set
        # ELECTRON_RUN_AS_NODE. Left set, `electron .` starts as plain Node and
        # dies with "Cannot read properties of undefined (reading 'getPath')",
        # which reads like a bug in Periphery rather than an inherited variable.
        if ($env:ELECTRON_RUN_AS_NODE) {
            Write-Note 'Clearing ELECTRON_RUN_AS_NODE for this run (it would start Electron as plain Node).'
            $env:ELECTRON_RUN_AS_NODE = $null
        }

        Write-Step 'Starting Electron. Periphery lives in the tray; Ctrl+C here stops it.'
        Write-Note "Fire a test cue:  Invoke-RestMethod http://127.0.0.1:$Port/notify -Method POST ``"
        Write-Note "                    -ContentType 'application/json' -Body '{""cue"":""comet"",""msg"":""hello""}'"
        Write-Host ''
        npm start
        exit $LASTEXITCODE
    }

    # --- Tauri -------------------------------------------------------------
    # rustup installs to ~/.cargo/bin but does not always reach an existing
    # shell session, so make sure it is reachable before giving up.
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if ((Test-Path $cargoBin) -and ($env:PATH -notlike "*$cargoBin*")) {
        $env:PATH = "$cargoBin;$env:PATH"
    }
    Assert-Command -Name 'cargo' -Hint 'Install Rust from https://rustup.rs, plus the MSVC C++ build tools (cargo cannot link without them).'

    if ($Devtools) {
        $env:PERIPHERY_DEVTOOLS = '1'
        Write-Note 'Devtools will open on the first overlay.'
    }

    $profileArgs = @()
    if ($Release) {
        $profileArgs = @('--release')
        Write-Note 'Release profile: slower to compile, much faster to run.'
    }

    Write-Step 'Building and starting the Rust preview. The first build takes a few minutes.'
    Write-Note 'Connectors and the Settings frontend are not wired up yet — see ai-native/versioning.md.'
    Write-Host ''
    Push-Location (Join-Path $RepoRoot 'src-tauri')
    try {
        cargo run @profileArgs
        exit $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}
