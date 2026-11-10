# Exercise the actual electron-builder setup executables, not an architecture model.
param([string]$SetupDir = "apps/desktop/dist/release")

$ErrorActionPreference = "Stop"
$nativeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($nativeArch -notin @("x64", "arm64")) { throw "Unexpected Windows architecture: $nativeArch" }
$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Doriterm-architecture-smoke"
if (Test-Path $installRoot) { throw "Smoke install directory already exists" }

function Get-DoritermLinks {
    foreach ($folder in @("Desktop", "CommonDesktopDirectory", "StartMenu", "CommonStartMenu")) {
        $path = [Environment]::GetFolderPath($folder)
        if ($path -and (Test-Path $path)) {
            Get-ChildItem $path -Filter "*Doriterm*.lnk" -Recurse -File
        }
    }
}

function Invoke-Setup([string]$arch, [string]$destination) {
    $setup = (Resolve-Path (Join-Path $SetupDir "Doriterm-$version-$arch-setup.exe")).Path
    # NSIS requires /D last, without quoting its value, even if it contains spaces.
    $process = Start-Process -FilePath $setup -ArgumentList @("/S", "/D=$destination") -PassThru -Wait
    Write-Host "$arch setup on $nativeArch Windows exited $($process.ExitCode)"
    return $process.ExitCode
}

function Assert-Installed([string]$arch) {
    $destination = "$installRoot-$arch"
    if (Test-Path $destination) { throw "Smoke install directory already exists: $arch" }
    $code = Invoke-Setup $arch $destination
    if ($code -ne 0) { throw "Supported $arch setup failed: $code" }
    foreach ($file in @("Doriterm.exe", "resources\bin\doriface-host.exe", "Uninstall Doriterm.exe")) {
        if (!(Test-Path (Join-Path $destination $file))) { throw "$arch install is missing $file" }
    }
    $reported = & (Join-Path $destination "resources\bin\doriface-host.exe") --version
    if ($LASTEXITCODE -ne 0 -or $reported -ne "doriface-host $version") {
        throw "Installed $arch host did not report the packaged version: $reported"
    }
    Write-Host "PASS: $arch setup installed the app and runnable host on $nativeArch Windows"
    # _?= keeps NSIS in this process instead of copying the uninstaller to TEMP,
    # so -Wait observes completion without sleeps or polling.
    $uninstall = Start-Process -FilePath (Join-Path $destination "Uninstall Doriterm.exe") `
        -ArgumentList @("/S", "_?=$destination") -PassThru -Wait
    if ($uninstall.ExitCode -ne 0) { throw "Uninstall failed: $($uninstall.ExitCode)" }
    if (Test-Path (Join-Path $destination "Doriterm.exe")) { throw "Uninstall left the application behind" }
}

if (@(Get-DoritermLinks).Count -ne 0) { throw "Runner already has Doriterm shortcuts" }
if ($nativeArch -eq "x64") {
    $rejected = "$installRoot-rejected"
    $code = Invoke-Setup "arm64" $rejected
    if ($code -ne 1633) { throw "ARM64 setup must refuse x64 Windows with exit 1633, got $code" }
    if (Test-Path $rejected) { throw "Refused setup left an install directory" }
    if (@(Get-DoritermLinks).Count -ne 0) { throw "Refused setup left a shortcut" }
    Write-Host "PASS: arm64 setup refused x64 Windows with no install directory or shortcuts"
}

# x64 on ARM64 is deliberately supported via emulation, as in electron-builder.
Assert-Installed "x64"
if ($nativeArch -eq "arm64") { Assert-Installed "arm64" }
