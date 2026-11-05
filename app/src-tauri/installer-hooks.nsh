; 安装前检查（由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引入）。
;
; 两类检查：
; 1) 旧产品并存：旧版 Rename Studio 与本版 Renomio 不是原地升级，两个应用不能同时存在。
;    判据是「旧显示名」与「旧 MSI UpgradeCode」两条，命中后给出卸载命令并中止。
; 2) 安装范围互斥：NSIS 支持 both 模式后，用户可在安装时切换「所有用户 / 当前用户」。
;    若机器上已存在相反范围的安装，两者会装到不同目录、写不同注册表根、
;    生成两个同名快捷方式，形成两份程序与两条卸载项，因此这里在写文件前中止并明确提示。

; 旧版 Rename Studio 的显示名与 MSI UpgradeCode（注册表里保存为倒序打包形式）。
!define RENOMIO_LEGACY_NAME "Rename Studio"
!define RENOMIO_LEGACY_UPGRADE "243680c53c703a6a67d59bb28307489b"

; 检测旧版；结果写到 $R9：空串 = 未检测到，否则为可直接执行的卸载命令/提示。
Function RenomioDetectLegacy
  StrCpy $R9 ""

  ; 1) HKLM ARP：按旧显示名（覆盖机器范围 NSIS 与机器级 MSI）
  StrCpy $R0 0
  renomio_lm_loop:
    EnumRegKey $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" renomio_lm_done
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R2 "${RENOMIO_LEGACY_NAME}" 0 renomio_lm_loop
    ReadRegStr $R9 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "UninstallString"
    StrCmp $R9 "" 0 renomio_done
    StrCpy $R9 "msiexec.exe /x $R1"
    Goto renomio_done
  renomio_lm_done:

  ; 2) HKCU ARP：按旧显示名（覆盖用户范围 NSIS 与用户级 MSI）
  StrCpy $R0 0
  renomio_cu_loop:
    EnumRegKey $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" renomio_cu_done
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCmp $R2 "${RENOMIO_LEGACY_NAME}" 0 renomio_cu_loop
    ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "UninstallString"
    StrCmp $R9 "" 0 renomio_done
    StrCpy $R9 "msiexec.exe /x $R1"
    Goto renomio_done
  renomio_cu_done:

  ; 3) MSI UpgradeCodes：按旧 UpgradeCode（即使 ARP 显示名被改动也能命中）
  StrCpy $R0 0
  renomio_upg_loop:
    EnumRegKey $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Installer\UpgradeCodes" $R0
    StrCmp $R1 "" renomio_upg_done
    IntOp $R0 $R0 + 1
    StrCmp $R1 "${RENOMIO_LEGACY_UPGRADE}" 0 renomio_upg_loop
    StrCpy $R9 "（注册表仍残留旧版 MSI 的 UpgradeCode，请先在「设置 → 应用」中卸载 ${RENOMIO_LEGACY_NAME}）"
  renomio_upg_done:

  renomio_done:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call RenomioDetectLegacy
  StrCmp $R9 "" renomio_no_legacy
    MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND "检测到已安装的旧版 ${RENOMIO_LEGACY_NAME}。$\r$\n$\r$\n${PRODUCTNAME} 不是 ${RENOMIO_LEGACY_NAME} 的原地升级，两个应用不能并存。$\r$\n请先卸载旧版，再安装 ${PRODUCTNAME}。$\r$\n$\r$\n卸载命令：$\r$\n$R9$\r$\n$\r$\n卸载时请不要勾选「删除应用数据」，否则新版无法导入你的配置与撤销历史。" /SD IDOK
    RMDir "$INSTDIR"
    Abort
  renomio_no_legacy:

  ${If} $MultiUser.InstallMode == "AllUsers"
    ReadRegStr $R9 HKCU "${UNINSTKEY}" "UninstallString"
    ${If} $R9 != ""
      MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND "已检测到「当前用户」范围的 ${PRODUCTNAME} 安装：$\r$\n$R9$\r$\n$\r$\n请先卸载该用户范围的版本，再为所有用户安装。" /SD IDOK
      RMDir "$INSTDIR"
      Abort
    ${EndIf}
  ${ElseIf} $MultiUser.InstallMode == "CurrentUser"
    ReadRegStr $R9 HKLM "${UNINSTKEY}" "UninstallString"
    ${If} $R9 != ""
      MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND "已检测到「所有用户」范围的 ${PRODUCTNAME} 安装：$\r$\n$R9$\r$\n$\r$\n请先在「设置 → 应用」中卸载机器范围的版本，再为当前用户安装。" /SD IDOK
      RMDir "$INSTDIR"
      Abort
    ${EndIf}
  ${EndIf}
!macroend
