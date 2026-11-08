<#
.SYNOPSIS
Installs (or upgrades, or removes) Agent Office from this folder on Windows.

.DESCRIPTION
Copies the package to %LOCALAPPDATA%\AgentOffice (or -Prefix), writes an agent-office.cmd launcher and a Start Menu
shortcut. Needs Node.js 22.12 or newer. Your own data (%USERPROFILE%\.agent-office) is never touched.

  .\install.ps1                 install or upgrade
  .\install.ps1 -AddToPath      also put agent-office on your user PATH
  .\install.ps1 -Uninstall      remove the hooks, the shortcut, the PATH entry and the install folder

If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'AgentOffice'),
  [switch]$AddToPath,
  [switch]$NoShortcut,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent Office.lnk'

function Test-Ours([string]$dir) {
  $pkg = Join-Path $dir 'package.json'
  return (Test-Path -LiteralPath $pkg) -and ((Get-Content -LiteralPath $pkg -Raw) -match '"name":\s*"agent-office"')
}

function Remove-FromPath([string]$dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { return }
  $kept = $current.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir.TrimEnd('\')) }
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

if ($Uninstall) {
  if ((Test-Path -LiteralPath $Prefix) -and -not (Test-Ours $Prefix)) { throw "$Prefix is not an Agent Office install: not removing it." }
  $cli = Join-Path $Prefix 'bin\agent-office.mjs'
  if ((Test-Path -LiteralPath $cli) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $cli hooks uninstall --all
  }
  if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
  Remove-FromPath $Prefix
  if (Test-Path -LiteralPath $Prefix) { Remove-Item -LiteralPath $Prefix -Recurse -Force }
  Write-Host 'Agent Office removed. Its data in ~\.agent-office was kept.'
  return
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22.12 or newer is required (https://nodejs.org).' }
$found = [version](((& node --version) -replace '^v', '') -replace '[^0-9.].*$', '')
if ($found -lt [version]'22.12.0') { throw "Node.js 22.12 or newer is required (found $found)." }
if (-not (Test-Ours $here)) { throw 'Run this script from the unpacked Agent Office folder.' }
if ((Resolve-Path -LiteralPath $here).Path.TrimEnd('\') -eq [IO.Path]::GetFullPath($Prefix).TrimEnd('\')) {
  throw "The install folder can't be the folder you are installing from."
}
if ((Test-Path -LiteralPath $Prefix) -and -not (Test-Ours $Prefix)) {
  throw "$Prefix exists and is not an Agent Office install: choose another -Prefix."
}

# copy next to the target and swap, so hooks keep pointing at the same path across upgrades
$new = "$Prefix.new"
$old = "$Prefix.old"
foreach ($d in @($new, $old)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Prefix) | Out-Null
Copy-Item -LiteralPath $here -Destination $new -Recurse
if (Test-Path -LiteralPath $Prefix) { Move-Item -LiteralPath $Prefix -Destination $old }
Move-Item -LiteralPath $new -Destination $Prefix
if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }

Set-Content -LiteralPath (Join-Path $Prefix 'agent-office.cmd') -Encoding Ascii -Value @(
  '@echo off',
  'node "%~dp0bin\agent-office.mjs" %*',
  'exit /b %ERRORLEVEL%'
)

if (-not $NoShortcut) {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($shortcut)
  $lnk.TargetPath = $node.Source
  $lnk.Arguments = '"' + (Join-Path $Prefix 'bin\agent-office.mjs') + '" start --open'
  $lnk.WorkingDirectory = $Prefix
  $lnk.Description = 'Agent Office'
  $lnk.Save()
}

if ($AddToPath) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { $current = '' }
  if (-not ($current.Split(';') | Where-Object { $_.TrimEnd('\') -eq $Prefix.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($current.TrimEnd(';') + ';' + $Prefix).TrimStart(';')), 'User')
    Write-Host 'Added to your PATH: open a new terminal to use the agent-office command.'
  }
}

$version = & node (Join-Path $Prefix 'bin\agent-office.mjs') version
Write-Host "Installed Agent Office $version in $Prefix"
Write-Host ''
Write-Host 'Next:'
if (-not $NoShortcut) { Write-Host '  Start Menu > Agent Office                                     run the office' }
Write-Host "  & `"$Prefix\agent-office.cmd`" start --open                     run the office from a terminal"
Write-Host "  & `"$Prefix\agent-office.cmd`" hooks install --provider gemini-cli   (optional) watch Gemini CLI"
Write-Host "  & `"$Prefix\agent-office.cmd`" hooks install --provider codex        (optional) live Codex activity"
Write-Host '  Claude Code needs nothing: the office reads its folders.'
Write-Host 'To upgrade, unpack the new version and run its install.ps1 again.'
