# 打包合规检查（只读实际产物与生成脚本，不需要 UAC，不启动安装器）
# 用法：npm run test:bundle
# 规则：MSI 固定机器级（ALLUSERS=1 / InstallScope=perMachine / ProgramFiles64Folder）；
#       NSIS 保留双范围选择（installMode=both + MULTIUSER_PAGE_INSTALLMODE）。
param([switch]$Offline)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$repoRoot = Split-Path -Parent $app
# 版本唯一来源：仓库根 VERSION；产物文件名随版本变化，这里不写死版本号。
$versionFile = Join-Path $repoRoot 'VERSION'
$appVersion = if (Test-Path -LiteralPath $versionFile) { (Get-Content -LiteralPath $versionFile -Raw).Trim() } else { '' }
$msiPath = Join-Path $app "src-tauri\target\release\bundle\msi\Renomio_${appVersion}_x64_en-US.msi"
$nsisPath = Join-Path $app "src-tauri\target\release\bundle\nsis\Renomio_${appVersion}_x64-setup.exe"
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

# --- 离线组（11 条）：只读源码配置与安装钩子，不依赖构建产物；CI 每次真实执行 ---
$confPath = Join-Path $app 'src-tauri\tauri.conf.json'
$hooksPath = Join-Path $app 'src-tauri\installer-hooks.nsh'
$offlineTotal = 11
$conf = $null

Assert 'tauri.conf.json 存在' (Test-Path -LiteralPath $confPath) $confPath
if (Test-Path -LiteralPath $confPath) {
  try { $conf = Get-Content -LiteralPath $confPath -Raw | ConvertFrom-Json } catch { }
}
Assert 'tauri.conf.json 可解析' ($null -ne $conf) 'JSON 解析失败'

$targets = @()
if ($conf) { $targets = @($conf.bundle.targets) }
Assert 'bundle.targets 覆盖 nsis 与 msi' `
  (($targets -contains 'all') -or (($targets -contains 'nsis') -and ($targets -contains 'msi'))) `
  "实际值：$($targets -join ',')"

$productName = if ($conf) { $conf.productName } else { '<缺失>' }
Assert 'productName = Renomio' ($productName -eq 'Renomio') "实际值：$productName"

$identifier = if ($conf) { $conf.identifier } else { '<缺失>' }
Assert 'identifier = app.renomio.desktop' ($identifier -eq 'app.renomio.desktop') "实际值：$identifier"

$version = if ($conf) { $conf.version } else { '<缺失>' }
Assert 'version 与仓库根 VERSION 一致' `
  ((-not [string]::IsNullOrWhiteSpace($appVersion)) -and ($version -eq $appVersion)) `
  "tauri.conf.json=$version / VERSION=$appVersion"

# NSIS 双范围：源配置必须声明 installMode = both（产物里的 MULTIUSER_* 由它生成）
$installMode = if ($conf -and $conf.bundle.windows -and $conf.bundle.windows.nsis) {
  $conf.bundle.windows.nsis.installMode
} else { '<缺失>' }
Assert 'NSIS 源配置 installMode = both' ($installMode -eq 'both') "实际值：$installMode"

Assert 'installer-hooks.nsh 存在' (Test-Path -LiteralPath $hooksPath) $hooksPath
$hooks = if (Test-Path -LiteralPath $hooksPath) { Get-Content -LiteralPath $hooksPath -Raw } else { '' }
Assert '钩子里声明旧显示名 Rename Studio' ($hooks.Contains('RENOMIO_LEGACY_NAME "Rename Studio"')) '未找到旧显示名常量'
Assert '钩子里声明旧 MSI UpgradeCode' ($hooks.Contains('243680c53c703a6a67d59bb28307489b')) '未找到旧 UpgradeCode 常量'
Assert '旧版检测在写文件前中止（RMDir + Abort）' `
  ($hooks.Contains('NSIS_HOOK_PREINSTALL') -and $hooks.Contains('RMDir "$INSTDIR"') -and $hooks.Contains('Abort')) `
  '未找到 PREINSTALL 钩子中止逻辑'
Assert '卸载提示包含「不要勾选删除应用数据」' ($hooks.Contains('删除应用数据')) '未找到应用数据保留提示'

if ($Offline) {
  Write-Host ''
  if ($script:failures -gt 0) {
    Write-Host "离线断言失败：$($script:failures) 条（共 $offlineTotal 条）" -ForegroundColor Red
    exit 1
  }
  Write-Host "离线断言全部通过（$offlineTotal/$offlineTotal），本次未读取任何构建产物"
  exit 0
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
