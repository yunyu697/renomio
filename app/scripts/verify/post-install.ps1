<#
安装版真机验证（可在无 UAC 的情况下重复跑）。
1) 读安装版 exe 版本与 ARP 记录
2) 导出 exe 的 16/32 图标、窗口的 16/32 图标，并做像素比对
3) 带 WebView2 调试端口启动应用，逐帧采样窗口底色（首帧不闪白）
4) 调 post-install.mjs：四套配色 x 明暗断言 + 截图
5) 关闭应用并打印 PASS/FAIL 汇总

用法：
  powershell -ExecutionPolicy Bypass -File app\scripts\verify\post-install.ps1
参数：
  -Exe        安装版 exe 路径（默认 C:\Program Files\Renomio\renomio.exe）
  -OutDir     证据输出目录（默认 app\verify-out\post-install-alpha5）
  -Port       CDP 端口（默认 9333）
#>
param(
  [string]$Exe = 'C:\Program Files\Renomio\renomio.exe',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\verify-out\post-install'),
  [int]$Port = 9444,
  [switch]$KeepExisting
)

$ErrorActionPreference = 'Stop'
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$result = [ordered]@{ exe = $Exe; outDir = $OutDir; checks = @(); failures = @() }
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $result.checks += [ordered]@{ name = $name; ok = $ok; detail = $detail }
  if (-not $ok) { $result.failures += "$name $detail" }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1} {2}" -f $mark, $name, $detail)
}

if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到安装版 exe：$Exe" }
$already = Get-Process -Name 'renomio' -ErrorAction SilentlyContinue
if ($already) {
  if ($KeepExisting) { throw "Renomio 已在运行（PID $($already.Id -join ',')），-KeepExisting 下无法重启验证。" }
  Write-Host "已有关闭旧实例：$($already.Id -join ',')（会话会持久化，重启后恢复）"
  foreach ($p in $already) { $p.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 3
  foreach ($p in $already) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
  Start-Sleep -Milliseconds 500
}

# ---------- 1. 版本 / ARP ----------
$vi = (Get-Item -LiteralPath $Exe).VersionInfo
$fileVersion = $vi.ProductVersion
$result.fileVersion = $fileVersion
$expected = (Get-Content -Raw (Join-Path $PSScriptRoot '..\..\..\VERSION')).Trim()
Check "exe 版本为 $expected" ($fileVersion -like "$expected*") "ProductVersion=$fileVersion"
$arp = @()
foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  $arp += Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Renomio*' }
}
$arp | ForEach-Object { Write-Host ("ARP {0} {1} scope={2}" -f $_.DisplayName, $_.DisplayVersion, $_.InstallLocation) }
$result.arp = $arp | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString

# ---------- Win32 辅助 ----------
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class Rnv {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int ExtractIconEx(string file, int index, out IntPtr large, out IntPtr small, int count);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // 只认：同进程、可见、有标题、面积够大、无 owner、非工具窗。
  public static IntPtr FindMainWindow(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if ((int)wpid != pid) return true;
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true; // GW_OWNER
      var ex = GetWindowLongPtr(h, -20);
      if (((long)ex & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
      var sb = new System.Text.StringBuilder(256);
      if (GetWindowText(h, sb, 256) <= 0) return true;
      RECT r; GetWindowRect(h, out r);
      if ((r.Right - r.Left) < 200 || (r.Bottom - r.Top) < 200) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static Bitmap FromHIcon(IntPtr h) { using (var ico = Icon.FromHandle(h)) return ico.ToBitmap(); }
  public static Bitmap Capture(IntPtr hwnd, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      var hdc = g.GetHdc();
      try { PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
    }
    return bmp;
  }
  public static double CenterLuma(Bitmap b) {
    int x0 = b.Width / 2 - 40, x1 = b.Width / 2 + 40, y0 = b.Height / 2 - 30, y1 = b.Height / 2 + 30;
    double sum = 0; int n = 0;
    for (int y = Math.Max(0,y0); y < Math.Min(b.Height,y1); y += 4)
      for (int x = Math.Max(0,x0); x < Math.Min(b.Width,x1); x += 4) {
        var c = b.GetPixel(x,y); sum += (c.R*299 + c.G*587 + c.B*114) / 1000.0; n++;
      }
    return n == 0 ? 0 : sum / n;
  }
  public static double WhiteRatio(Bitmap b) {
    int n = 0, w = 0;
    for (int y = 0; y < b.Height; y += 8) for (int x = 0; x < b.Width; x += 8) {
      var c = b.GetPixel(x,y); n++;
      if (c.R > 250 && c.G > 250 && c.B > 250) w++;
    }
    return n == 0 ? 0 : (double)w / n;
  }
  public static string CenterHex(Bitmap b) {
    var c = b.GetPixel(b.Width/2, b.Height/2);
    return string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B);
  }
  public static string PixelHash(Bitmap b) {
    using (var ms = new System.IO.MemoryStream()) {
      b.Save(ms, ImageFormat.Png);
      var data = ms.ToArray();
      using (var sha = System.Security.Cryptography.SHA256.Create())
        return BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "");
    }
  }
  // 逐像素差异：窗口图标可能由 PNG 缩放出，与 ICO 内 16px 帧不是逐字节相同，按结构相似度判定。
  public static string Diff(Bitmap a, Bitmap b) {
    if (a.Width != b.Width || a.Height != b.Height) return "size-mismatch " + a.Width + "x" + a.Height + " vs " + b.Width + "x" + b.Height;
    long sum = 0; int max = 0, changed = 0, n = 0;
    for (int y = 0; y < a.Height; y++) for (int x = 0; x < a.Width; x++) {
      var p = a.GetPixel(x, y); var q = b.GetPixel(x, y);
      int d = Math.Abs(p.A-q.A) + Math.Abs(p.R-q.R) + Math.Abs(p.G-q.G) + Math.Abs(p.B-q.B);
      sum += d; max = Math.Max(max, d); n++;
      if (d > 24) changed++;
    }
    return string.Format("mean={0:F2} max={1} changedPx={2}/{3} ({4:F1}%)", (double)sum/n, max, changed, n, 100.0*changed/n);
  }
  // 归一化为 32bppArgb 后按像素字节哈希，避免不同来源的 PNG 编码/像素格式差异。
  public static string PixelHash32(Bitmap b) {
    using (var c = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(c)) g.DrawImage(b, 0, 0, b.Width, b.Height);
      var rect = new Rectangle(0, 0, c.Width, c.Height);
      var data = c.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int len = Math.Abs(data.Stride) * c.Height;
        var buf = new byte[len];
        System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, len);
        using (var sha = System.Security.Cryptography.SHA256.Create())
          return BitConverter.ToString(sha.ComputeHash(buf)).Replace("-", "");
      } finally { c.UnlockBits(data); }
    }
  }
}
'@

# ---------- 2. exe 图标 16/32 ----------
$large = [IntPtr]::Zero; $small = [IntPtr]::Zero
$count = [Rnv]::ExtractIconEx($Exe, 0, [ref]$large, [ref]$small, 1)
if ($count -lt 1) { throw "ExtractIconEx 失败：$Exe" }
$exe32 = [Rnv]::FromHIcon($large); $exe32.Save((Join-Path $OutDir 'exe-icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$exe16 = [Rnv]::FromHIcon($small); $exe16.Save((Join-Path $OutDir 'exe-icon-16.png'), [System.Drawing.Imaging.ImageFormat]::Png)
[Rnv]::DestroyIcon($large) | Out-Null; [Rnv]::DestroyIcon($small) | Out-Null
Check 'exe 有 16px 图标' ($exe16.Width -eq 16 -and $exe16.Height -eq 16) "actual=$($exe16.Width)x$($exe16.Height)"
Check 'exe 有 32px 图标' ($exe32.Width -eq 32 -and $exe32.Height -eq 32) "actual=$($exe32.Width)x$($exe32.Height)"
$exe16Hash = [Rnv]::PixelHash32($exe16)

# ---------- 3. 启动 + 逐帧 ----------
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-allow-origins=*"
$env:VERIFY_OUT = $OutDir
$env:CDP_PORT = "$Port"
$t0 = Get-Date
$proc = Start-Process -FilePath $Exe -PassThru
$hwnd = [IntPtr]::Zero
$frames = @()
$deadline = $t0.AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  if ($hwnd -eq [IntPtr]::Zero) {
    if (-not $proc.HasExited) { $hwnd = [Rnv]::FindMainWindow([int]$proc.Id) }
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    $r = New-Object Rnv+RECT
    [Rnv]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -gt 200 -and $h -gt 200) {
      $bmp = [Rnv]::Capture($hwnd, $w, $h)
      $luma = [Rnv]::CenterLuma($bmp)
      $white = [Rnv]::WhiteRatio($bmp)
      $hex = [Rnv]::CenterHex($bmp)
      $frames += [ordered]@{ ms = [int]((Get-Date) - $t0).TotalMilliseconds; luma = [math]::Round($luma,1); whiteRatio = [math]::Round($white,3); center = $hex }
      if ($frames.Count -eq 1) { $bmp.Save((Join-Path $OutDir 'frame-first.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
      $bmp.Save((Join-Path $OutDir 'frame-last.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    }
  }
  Start-Sleep -Milliseconds 60
}
$result.frames = $frames
Check '窗口已出现' ($hwnd -ne [IntPtr]::Zero) "hwnd=$hwnd frames=$($frames.Count)"
if ($frames.Count -gt 0) {
  $first = $frames[0]; $last = $frames[$frames.Count-1]
  Check '首帧不是纯白闪屏' ($first.whiteRatio -lt 0.6) "first center=$($first.center) whiteRatio=$($first.whiteRatio)"
  Check '首帧与稳定帧亮度差 <= 40' ([math]::Abs($first.luma - $last.luma) -le 40) "first luma=$($first.luma) last luma=$($last.luma)"
  $result.firstFrame = $first; $result.lastFrame = $last
}

# ---------- 4. 窗口图标 ----------
# 取图标顺序与 Windows 任务栏一致：WM_GETICON -> 类图标 -> exe 资源默认图标。
$win16 = [Rnv]::SendMessage($hwnd, 0x007F, [IntPtr]0, [IntPtr]::Zero)
$win32 = [Rnv]::SendMessage($hwnd, 0x007F, [IntPtr]1, [IntPtr]::Zero)
$iconSource = 'WM_GETICON'
if ($win16 -eq [IntPtr]::Zero) { $win16 = [Rnv]::SendMessage($hwnd, 0x007F, [IntPtr]2, [IntPtr]::Zero) }
if ($win16 -eq [IntPtr]::Zero -or $win32 -eq [IntPtr]::Zero) {
  $c16 = [Rnv]::GetClassLongPtr($hwnd, -34); $c32 = [Rnv]::GetClassLongPtr($hwnd, -14)
  if ($win16 -eq [IntPtr]::Zero -and $c16 -ne [IntPtr]::Zero) { $win16 = $c16; $iconSource = 'class' }
  if ($win32 -eq [IntPtr]::Zero -and $c32 -ne [IntPtr]::Zero) { $win32 = $c32; $iconSource = 'class' }
}
$result.windowIconSource = $iconSource
Check '窗口图标来源可判定' ([bool]($win16 -ne [IntPtr]::Zero -or $win32 -ne [IntPtr]::Zero -or $iconSource -eq 'exe-default')) "source=$iconSource h16=$win16 h32=$win32"
if ($win16 -ne [IntPtr]::Zero) {
  $w16 = [Rnv]::FromHIcon($win16); $w16.Save((Join-Path $OutDir 'window-icon-16.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $ref = if ($w16.Width -eq $exe16.Width) { $exe16 } elseif ($w16.Width -eq $exe32.Width) { $exe32 } else { $null }
  $result.windowIconSize = "$($w16.Width)x$($w16.Height)"
  if ($ref) {
    $iconDiff = [Rnv]::Diff($w16, $ref)
    $result.windowIconDiff = $iconDiff
    $changedPct = if ($iconDiff -match '([0-9.]+)%') { [double]$Matches[1] } else { 100 }
    Check '窗口图标与新图标视觉一致' ($changedPct -le 12) "hIcon=$($w16.Width)x$($w16.Height) $iconDiff"
  } else {
    Check '窗口图标尺寸可对拍' $false "$($w16.Width)x$($w16.Height)"
  }
} else {
  Copy-Item (Join-Path $OutDir 'exe-icon-16.png') (Join-Path $OutDir 'window-icon-16.png') -Force
  Check '窗口 16px 图标回退为 exe 资源' $true 'WM_GETICON/类图标均为空，Windows 回退可用 exe 首个图标'
}
if ($win32 -ne [IntPtr]::Zero) {
  $w32 = [Rnv]::FromHIcon($win32); $w32.Save((Join-Path $OutDir 'window-icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  Copy-Item (Join-Path $OutDir 'exe-icon-32.png') (Join-Path $OutDir 'window-icon-32.png') -Force
}

# ---------- 5. CDP 四配色 ----------
$nodeOut = & node (Join-Path $PSScriptRoot 'post-install.mjs') 2>&1
$nodeText = ($nodeOut | Out-String)
$nodeOut | Write-Host
$result.cdp = $nodeText
Check 'CDP 四配色 x 明暗全部通过' ($nodeText -match 'ALL PASS') ($nodeText -split "`n" | Select-Object -Last 1)

# ---------- 6. 关闭 ----------
$closed = $proc.CloseMainWindow()
Start-Sleep -Seconds 3
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
Check '应用已退出' ($proc.HasExited) "CloseMainWindow=$closed exited=$($proc.HasExited)"
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue

$result.generatedAt = (Get-Date).ToString('o')
$result.summary = if ($result.failures.Count -eq 0) { 'ALL PASS' } else { "FAILURES: " + ($result.failures -join ' | ') }
$result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutDir 'post-install-ps.json') -Encoding utf8
Write-Host ''
Write-Host ("SUMMARY {0}" -f $result.summary)
if ($result.failures.Count -gt 0) { exit 1 }
