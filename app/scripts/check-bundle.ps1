# 打包合规检查（只读实际产物与生成脚本，不需要 UAC，不启动安装器）
# 用法：npm run test:bundle
# 规则：MSI 固定机器级（ALLUSERS=1 / InstallScope=perMachine / ProgramFiles64Folder）；
#       NSIS 保留双范围选择（installMode=both + MULTIUSER_PAGE_INSTALLMODE）。
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$msiPath = Join-Path $app 'src-tauri\target\release\bundle\msi\Renomio_0.1.0_x64_en-US.msi'
$nsisPath = Join-Path $app 'src-tauri\target\release\bundle\nsis\Renomio_0.1.0_x64-setup.exe'
$wxsPath = Join-Path $app 'src-tauri\target\release\wix\x64\main.wxs'
$nsiPath = Join-Path $app 'src-tauri\target\release\nsis\x64\installer.nsi'

$script:failures = 0
function Assert($name, $ok, $detail) {
  if ($ok) {
    Write-Host "PASS  $name"
  } else {
    Write-Host "FAIL  $name -- $detail" -ForegroundColor Red
    $script:failures++
  }
}

Assert 'MSI 产物存在' (Test-Path -LiteralPath $msiPath) $msiPath
Assert 'NSIS 产物存在' (Test-Path -LiteralPath $nsisPath) $nsisPath
Assert 'WiX 生成脚本存在' (Test-Path -LiteralPath $wxsPath) $wxsPath
Assert 'NSIS 生成脚本存在' (Test-Path -LiteralPath $nsiPath) $nsiPath

# --- MSI：读已打包的数据库，而不是只读源码 ---
if (Test-Path -LiteralPath $msiPath) {
  try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $db = $installer.OpenDatabase($msiPath, 0) # 0 = msiOpenDatabaseModeReadOnly
    $props = @{}
    $view = $db.OpenView('SELECT Property, Value FROM Property')
    $view.Execute()
    while ($record = $view.Fetch()) { $props[$record.StringData(1)] = $record.StringData(2) }
    $view.Close()

    $allUsers = if ($props.ContainsKey('ALLUSERS')) { $props['ALLUSERS'] } else { '<缺失>' }
    Assert 'MSI Property 表 ALLUSERS = 1（机器级）' ($allUsers -eq '1') "实际值：$allUsers"

    $productName = if ($props.ContainsKey('ProductName')) { $props['ProductName'] } else { '<缺失>' }
    Assert 'MSI ProductName = Renomio' ($productName -eq 'Renomio') "实际值：$productName"
  } catch {
    Assert 'MSI 数据库可读取' $false $_.Exception.Message
  }
}

# --- MSI：WiX 生成脚本里的 scope 与安装目录根 ---
if (Test-Path -LiteralPath $wxsPath) {
  $wxs = Get-Content -LiteralPath $wxsPath -Raw
  Assert 'WiX InstallScope="perMachine"' ($wxs -match 'InstallScope="perMachine"') '未找到 InstallScope="perMachine"'
  Assert 'WiX 安装根使用 $(var.PlatformProgramFilesFolder)' `
    ($wxs.Contains('<Directory Id="$(var.PlatformProgramFilesFolder)" Name="PFiles">')) `
    '未找到 ProgramFiles 目录根'
  Assert 'WiX INSTALLDIR 名为 Renomio' `
    ($wxs.Contains('<Directory Id="INSTALLDIR" Name="Renomio"/>')) `
    '未找到 <Directory Id="INSTALLDIR" Name="Renomio"/>'

  # UpgradeCode 必须换新（不能沿用旧版 Rename Studio 的 b9847038-…），否则旧版会被当成同一应用升级。
  $upgradeCode = ($wxs | Select-String -Pattern 'UpgradeCode="([^"]+)"' | Select-Object -First 1)
  $code = if ($upgradeCode) { $upgradeCode.Matches[0].Groups[1].Value.ToLower() } else { '' }
  Assert 'WiX UpgradeCode 已更新（非旧版 b9847038-…）' `
    ($code -eq '3c7b1e4a-9f62-4d8b-a5e1-6d2c8f4b7a09') `
    "实际值：$code"

  # x64 分支必须解析为 ProgramFiles64Folder（不是 ProgramFilesFolder）
  $lines = Get-Content -LiteralPath $wxsPath
  $x64Line = ($lines | Select-String -SimpleMatch '<?elseif $(sys.BUILDARCH)="x64"?>' | Select-Object -First 1).LineNumber
  $x64Root = $false
  if ($x64Line) {
    $x64Root = ($lines[$x64Line + 1] -match 'PlatformProgramFilesFolder = "ProgramFiles64Folder"')
  }
  Assert 'x64 分支安装根 = ProgramFiles64Folder' $x64Root 'x64 分支未定义 ProgramFiles64Folder'
}

# --- NSIS：双范围选择不能回退 ---
if (Test-Path -LiteralPath $nsiPath) {
  $nsi = Get-Content -LiteralPath $nsiPath -Raw
  Assert 'NSIS INSTALLMODE = both' ($nsi -match '!define INSTALLMODE "both"') '未找到 !define INSTALLMODE "both"'
  Assert 'NSIS 存在范围选择页 MULTIUSER_PAGE_INSTALLMODE' `
    ($nsi -match '!insertmacro MULTIUSER_PAGE_INSTALLMODE') `
    '未找到 !insertmacro MULTIUSER_PAGE_INSTALLMODE'
  Assert 'NSIS 默认机器范围使用 ProgramFiles64' `
    ($nsi -match '!define MULTIUSER_USE_PROGRAMFILES64') `
    '未找到 !define MULTIUSER_USE_PROGRAMFILES64'
}

Write-Host ''
if ($script:failures -gt 0) {
  Write-Host "打包合规检查失败：$($script:failures) 条断言不成立" -ForegroundColor Red
  exit 1
}
Write-Host '打包合规检查全部通过（MSI 机器级 / NSIS 双范围）'
exit 0
