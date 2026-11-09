param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Headers,
  [Parameter(Mandatory = $true)][string]$Library,
  [ValidateSet("x64", "arm64")][string]$Arch
)
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$installation = & $vswhere -latest -products * -property installationPath
if (!$installation) { throw "Install Visual Studio with the C++ desktop workload and Windows SDK." }
$vcvars = Join-Path $installation "VC\Auxiliary\Build\vcvarsall.bat"
# Use the x64 compiler host on both runners; arm64 runners can run it, and both images carry these tools.
$target = if ($Arch -eq "arm64") { "x64_arm64" } else { "x64" }
$source = Join-Path $Root "native\speech\speech-win.cc"
$out = Join-Path $Root "dist\native"
$command = "call `"$vcvars`" $target && cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /MD /LD /DNODE_GYP_MODULE_NAME=speech /I`"$Headers`" `"$source`" /Fo`"$out\speech.obj`" /link /OUT:`"$out\speech.node`" `"$Library`" sapi.lib ole32.lib uuid.lib"
& $env:ComSpec /d /s /c "`"$command`""
if ($LASTEXITCODE -ne 0) { throw "Windows speech addon compilation failed ($LASTEXITCODE)." }
Write-Output "built dist/native/speech.node ($Arch)"
