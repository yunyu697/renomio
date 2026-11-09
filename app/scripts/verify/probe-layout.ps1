param(
  [string]$Exe = 'C:\Program Files\Renomio\renomio.exe',
  [string]$Corpus = 'D:\Users\Tyler Zhang\Documents\Trae-CN\temp_20261105_06\real-corpus-alpha4',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\verify-out\layout'),
  [int]$Port = 9446
)

$ErrorActionPreference = 'Stop'
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }

Get-Process -Name renomio -ErrorAction SilentlyContinue | ForEach-Object {
  $_.CloseMainWindow() | Out-Null
  Start-Sleep -Milliseconds 300
  if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force }
}
Start-Sleep -Milliseconds 700

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LayoutWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  public static IntPtr Find(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if ((int)p == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
$proc = Start-Process -FilePath $Exe -PassThru
$cdpOk = $false
for ($i = 0; $i -lt 40; $i++) {
  try { $j = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/json" -TimeoutSec 1; if ($j.StatusCode -eq 200) { $cdpOk = $true; break } } catch {}
  Start-Sleep -Milliseconds 300
}
if (-not $cdpOk) { throw "CDP not ready on port $Port" }
Start-Sleep -Milliseconds 1200

$hwnd = [LayoutWin]::Find($proc.Id)
if ($hwnd -eq [IntPtr]::Zero) { throw "main window not found for pid $($proc.Id)" }
Write-Host "[info] pid=$($proc.Id) hwnd=$hwnd"

$Sizes = @(
  @{ W = 1440; H = 900; Tag = '1440x900' },
  @{ W = 1280; H = 800; Tag = '1280x800' },
  @{ W = 1100; H = 720; Tag = '1100x720' }
)
$Views = @('files-left', 'files-top')

$ErrorActionPreference = 'Continue'
foreach ($s in $Sizes) {
  [LayoutWin]::ShowWindow($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 300
  [LayoutWin]::MoveWindow($hwnd, 20, 20, $s.W, $s.H, $true) | Out-Null
  Start-Sleep -Milliseconds 500
  [LayoutWin]::MoveWindow($hwnd, 20, 20, $s.W, $s.H, $true) | Out-Null
  Start-Sleep -Milliseconds 900
  foreach ($view in $Views) {
    $env:CDP_PORT = "$Port"
    $env:LAYOUT_LABEL = "$($s.Tag)-$view"
    $env:LAYOUT_VIEW = $view
    $env:LAYOUT_RULES = $(if ($view -eq 'files-top') { '4' } else { '0' })
    $env:CHAIN_CORPUS = $Corpus
    $env:VERIFY_OUT = $OutDir
    Write-Host "[run] $($s.Tag) $view"
    node (Join-Path $PSScriptRoot 'probe-layout.mjs')
    if ($LASTEXITCODE -ne 0) { Write-Host "[warn] node exit $LASTEXITCODE" }
  }
}

# restore user settings/session saved by the first probe run
$env:CDP_PORT = "$Port"
$env:VERIFY_OUT = $OutDir
$env:LAYOUT_RESTORE = '1'
node (Join-Path $PSScriptRoot 'probe-layout.mjs')

$ErrorActionPreference = 'Stop'
Get-Process -Name renomio -ErrorAction SilentlyContinue | ForEach-Object {
  $_.CloseMainWindow() | Out-Null
  Start-Sleep -Milliseconds 300
  if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force }
}
Write-Host "[done] reports in $OutDir"
