# 启动分段计时（无可见窗口）：把 app 进程创建在独立隐藏桌面上，
# 读取 %APPDATA%\app.renomio.desktop\logs\startup.log 的时间戳，
# 输出「进程启动 → 窗口可见」「窗口可见 → 首屏可交互」。
#
# 不会在当前桌面创建任何窗口，也不会抢焦点。
# 冷启动：先把 %LOCALAPPDATA%\app.renomio.desktop（WebView2 用户数据）移到临时备份；
# 每轮冷启动都删除新生成的目录；结束后恢复备份。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\measure-startup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\measure-startup.ps1 -ColdRuns 3 -HotRuns 3

param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\src-tauri\target\release\renomio.exe'),
  [int]$ColdRuns = 3,
  [int]$HotRuns = 3,
  [int]$HoldMs = 6000,
  [switch]$KeepProfile
)

$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$ProfileDir = Join-Path $env:LOCALAPPDATA 'app.renomio.desktop'
$LogPath = Join-Path $env:APPDATA 'app.renomio.desktop\logs\startup.log'
$BackupDir = Join-Path $env:TEMP ("renomio-profile-backup-" + (Get-Date -Format 'yyyyMMddHHmmss'))

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HiddenDesktopRunner
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, int access, IntPtr sa);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
        int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    private static IntPtr _desktop;
    private static string _name;

    public static int Launch(string exe)
    {
        _name = "rs-measure-" + Guid.NewGuid().ToString("N");
        _desktop = CreateDesktop(_name, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
        if (_desktop == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = _name;
        var pi = new PROCESS_INFORMATION();
        if (!CreateProcess(null, "\"" + exe + "\"", IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero,
                System.IO.Path.GetDirectoryName(exe), ref si, out pi))
        {
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        }
        return pi.dwProcessId;
    }

    public static void Dispose()
    {
        if (_desktop != IntPtr.Zero) { CloseDesktop(_desktop); _desktop = IntPtr.Zero; }
    }
}
'@

function Stop-App([int]$ProcessId) {
  # 结束进程树（WebView2 子进程随浏览器进程退出，但 NET 兜底）
  & taskkill.exe /PID $ProcessId /T /F *> $null
}

function Read-StartupEvents([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $out = @()
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    $p = $line -split "`t"
    if ($p.Count -lt 4) { continue }
    # 前端标记是批量上报的：行首时间是写入日志的时间，真实时刻在消息里的 at=
    $msg = ($p[3..($p.Count - 1)] -join "`t")
    $at = $null
    if ($msg -match 'at=(\d+)') { $at = [uint64]$Matches[1] }
    $ts = if ($at) { $at } else { [uint64]$p[0] }
    $out += [pscustomobject]@{ ts = $ts; event = $p[2]; msg = $msg }
  }
  return $out
}

function Invoke-Run([string]$Label) {
  if (Test-Path -LiteralPath $LogPath) { Remove-Item -LiteralPath $LogPath -Force }
  # 进程启动前判定：冷启动为首次创建 WebView2 用户数据目录，热启动为复用
  $profileAtLaunch = if (Test-Path -LiteralPath $ProfileDir) { 'exists' } else { 'absent' }
  $pidRun = [HiddenDesktopRunner]::Launch($Exe)
  $createdAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  try {
    $deadline = (Get-Date).AddMilliseconds($HoldMs)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 100
      if (Test-Path -LiteralPath $LogPath) {
        $txt = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
        if ($txt -and $txt.Contains('app_ready')) { break }
      }
    }
    Start-Sleep -Milliseconds 400
  } finally {
    Stop-App $pidRun
    [HiddenDesktopRunner]::Dispose()
  }

  $events = Read-StartupEvents $LogPath
  $map = @{}
  foreach ($e in $events) { $map[$e.event] = $e }
  $proc = if ($map.ContainsKey('proc_start')) { $map['proc_start'].ts } else { $createdAt }
  $show = if ($map.ContainsKey('window_show')) { $map['window_show'].ts } else { $null }
  $ready = if ($map.ContainsKey('app_ready')) { $map['app_ready'].ts } elseif ($map.ContainsKey('app_ready_demo')) { $map['app_ready_demo'].ts } else { $null }
  $firstPaint = if ($map.ContainsKey('first_paint')) { $map['first_paint'].ts } else { $null }
  $dom = if ($map.ContainsKey('dom_content_loaded')) { $map['dom_content_loaded'].ts } else { $null }
  $commit = if ($map.ContainsKey('react_commit')) { $map['react_commit'].ts } else { $null }

  $revealKind = if ($map.ContainsKey('reveal_raf')) { 'raf' } elseif ($map.ContainsKey('reveal_timer')) { 'timer' } else { 'none' }
  $fallback = $map.ContainsKey('show_fallback')
  $navStart = if ($map.ContainsKey('navigation_start')) { $map['navigation_start'].ts } else { $null }

  [pscustomobject]@{
    label            = $Label
    createToMain     = if ($proc) { $proc - $createdAt } else { $null }
    toNavigation     = if ($navStart) { $navStart - $proc } else { $null }
    toShow           = if ($show) { $show - $proc } else { $null }
    showToReady      = if ($show -and $ready) { $ready - $show } else { $null }
    total            = if ($ready) { $ready - $proc } else { $null }
    procToDom        = if ($dom) { $dom - $proc } else { $null }
    procToFirstPaint = if ($firstPaint) { $firstPaint - $proc } else { $null }
    procToCommit     = if ($commit) { $commit - $proc } else { $null }
    reveal           = $revealKind
    showFallback     = $fallback
    setupMs          = if ($map.ContainsKey('core_ready') -and $map.ContainsKey('setup_begin')) {
      $map['core_ready'].ts - $map['setup_begin'].ts
    } else { $null }
    webviewProfile   = if (Test-Path -LiteralPath $ProfileDir) { 'exists' } else { 'absent' }
    profileAtLaunch  = $profileAtLaunch
  }
}

if (Get-Process -Name 'renomio' -ErrorAction SilentlyContinue) {
  throw '检测到 renomio 正在运行，先退出后再测量（避免占用 WebView2 用户数据目录）'
}

$results = @()
try {
  # ---- 冷启动：每轮都使用全新的 WebView2 用户数据目录 ----
  if ($ColdRuns -gt 0) {
    if (Test-Path -LiteralPath $ProfileDir) {
      Move-Item -LiteralPath $ProfileDir -Destination $BackupDir
      Write-Host "[准备] 已备份现有 WebView2 用户数据到 $BackupDir"
    }
    for ($i = 1; $i -le $ColdRuns; $i++) {
      if (Test-Path -LiteralPath $ProfileDir) { Remove-Item -LiteralPath $ProfileDir -Recurse -Force }
      Write-Host "[冷启动 $i/$ColdRuns] 隐藏桌面创建进程…"
      $results += Invoke-Run "cold-$i"
    }
  }

  # ---- 热启动：沿用上一轮已生成的用户数据目录 ----
  for ($i = 1; $i -le $HotRuns; $i++) {
    Write-Host "[热启动 $i/$HotRuns] 隐藏桌面创建进程…"
    $results += Invoke-Run "hot-$i"
  }
} finally {
  # 清掉测试生成的用户数据，恢复用户原来的数据（设置、localStorage 不丢）
  if (-not $KeepProfile) {
    if (Test-Path -LiteralPath $ProfileDir) { Remove-Item -LiteralPath $ProfileDir -Recurse -Force }
    if (Test-Path -LiteralPath $BackupDir) {
      Move-Item -LiteralPath $BackupDir -Destination $ProfileDir
      Write-Host "[恢复] WebView2 用户数据已恢复"
    }
  } else {
    Write-Host "[保留] 测试生成的数据目录保留在 $ProfileDir；备份在 $BackupDir"
  }
}

$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$results | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'measure-startup.json') -Encoding UTF8
Write-Host "明细已写入 scripts\measure-startup.json"
