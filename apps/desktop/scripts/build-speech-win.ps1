param(
  [Parameter(Mandatory = $true)][string]$CommandFile,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [ValidateSet("x64", "arm64")][string]$Arch
)
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$installation = & $vswhere -latest -products * -property installationPath
if (!$installation) { throw "Install Visual Studio with the C++ desktop workload and Windows SDK." }
$vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvarsall.bat"
# Use the x64 compiler host on both runners; arm64 runners can run it, and both images carry these tools.
$target = if ($Arch -eq "arm64") { "x64_arm64" } else { "x64" }
# cl.exe takes its arguments (sources, /DELAYLOAD:node.exe, the libraries) from the command file build-speech-win.ts
# wrote, the list the unit test checks, and writes the objects to its working directory beside speech.node.
$command = "call `"$vcvars`" $target && cd /d `"$WorkingDirectory`" && cl.exe @`"$CommandFile`""
& $env:ComSpec /d /s /c "`"$command`""
if ($LASTEXITCODE -ne 0) { throw "Windows speech addon compilation failed ($LASTEXITCODE)." }
Write-Output "built dist/native/speech.node ($Arch)"
