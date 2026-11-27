//! 资源管理器集成：每用户右键菜单（注册表计划）与 `.lnk` 快捷方式字节生成。
//!
//! 设计取舍：
//! - **只写 HKCU**（`Software\Classes\...`），不需要管理员权限，卸载程序/用户自己都能删干净；
//!   不碰 `HKLM`，避免安装包需要提权与「卸载后残留」。
//! - 菜单计划（[`menu_entries`]）是**纯数据**，任何平台都能算、都能测；真正落注册表的
//!   [`apply_menu`] / [`remove_menu`] / [`menu_state`] 只在 Windows 上有效，其他平台
//!   返回「不支持」而不是假装成功。
//! - 快捷方式**不调 COM**：直接按 Shell Link（`.lnk`）二进制规范生成字节。好处是纯函数、
//!   可逐字段断言、不依赖 `IShellLink`（也就不会在测试里弹 Explorer 的东西）。
//!   生成的结构是「LinkInfo（含 Unicode 本地路径）+ 名称 / 工作目录 / 参数 / 图标」，
//!   没有写 `IDList`——桌面与开始菜单都用得到，且少了 PIDL 序列化这一层风险。

use std::path::Path;

/// 右键菜单项的作用域。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuScope {
    /// 任意文件
    File,
    /// 文件夹（选中文件夹本身）
    Directory,
    /// 文件夹空白处（背景）
    Background,
}

impl MenuScope {
    pub fn as_str(self) -> &'static str {
        match self {
            MenuScope::File => "file",
            MenuScope::Directory => "directory",
            MenuScope::Background => "background",
        }
    }

    /// 注册表路径（HKCU 相对，不含 `HKEY_CURRENT_USER\` 前缀）。
    fn key(self) -> &'static str {
        match self {
            MenuScope::File => "Software\\Classes\\*\\shell\\Renomio",
            MenuScope::Directory => "Software\\Classes\\Directory\\shell\\Renomio",
            MenuScope::Background => "Software\\Classes\\Directory\\Background\\shell\\Renomio",
        }
    }

    /// 菜单文案（写进默认值与 `MUIVerb`）。注册表里的文案不随界面语言变，统一用中文。
    fn label(self) -> &'static str {
        match self {
            MenuScope::File => "用 Renomio 打开",
            MenuScope::Directory | MenuScope::Background => "用 Renomio 打开此文件夹",
        }
    }

    /// 传给程序的占位符：文件/文件夹是 `%1`，背景是 `%V`（当前目录）。
    fn placeholder(self) -> &'static str {
        match self {
            MenuScope::File | MenuScope::Directory => "%1",
            MenuScope::Background => "%V",
        }
    }
}

/// 一条右键菜单项：注册表键位 + 三处值 + 命令行。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuEntry {
    pub scope: String,
    /// HKCU 相对键位（`Software\Classes\...`）
    pub key: String,
    pub label: String,
    pub icon: String,
    /// `command` 子键的默认值
    pub command: String,
}

/// 菜单状态：是否支持、是否已装、是否有半装（部分键在、部分键缺）。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    pub supported: bool,
    pub installed: bool,
    /// 部分条目已在注册表里（装了一半或版本切换残留）
    pub partial: bool,
    pub entries: Vec<MenuEntry>,
    /// 给界面直接显示的一句话（不支持时的原因 / 已装 / 未装）
    pub detail: String,
}

/// 程序路径校验：必须是绝对路径、不含引号与换行（命令行要原样引用它）。
pub fn validate_exe(exe: &str) -> Result<(), String> {
    let trimmed = exe.trim();
    if trimmed.is_empty() {
        return Err("程序路径为空".to_string());
    }
    if !Path::new(trimmed).is_absolute() {
        return Err(format!("程序路径必须是绝对路径：{trimmed}"));
    }
    if trimmed.contains('"') {
        return Err("程序路径不能包含引号".to_string());
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("程序路径不能包含换行".to_string());
    }
    Ok(())
}

/// 三条菜单项的计划：文件、文件夹、文件夹背景。
pub fn menu_entries(exe: &str) -> Result<Vec<MenuEntry>, String> {
    validate_exe(exe)?;
    let exe = exe.trim();
    let icon = exe.to_string();
    let scopes = [MenuScope::File, MenuScope::Directory, MenuScope::Background];
    Ok(scopes
        .into_iter()
        .map(|scope| MenuEntry {
            scope: scope.as_str().to_string(),
            key: scope.key().to_string(),
            label: scope.label().to_string(),
            icon: icon.clone(),
            command: format!("\"{exe}\" \"{}\"", scope.placeholder()),
        })
        .collect())
}

/// 平台是否支持注册表集成（只有 Windows 支持）。
pub const fn supported() -> bool {
    cfg!(windows)
}

/// 读当前菜单状态（不写注册表）。
pub fn menu_state(exe: &str) -> MenuState {
    let entries = menu_entries(exe).unwrap_or_default();
    let detail_default = if supported() {
        "未安装"
    } else {
        "当前平台不支持资源管理器右键菜单（仅 Windows）"
    };
    let mut state = MenuState {
        supported: supported(),
        installed: false,
        partial: false,
        entries,
        detail: detail_default.to_string(),
    };
    if !supported() {
        return state;
    }
    #[cfg(windows)]
    {
        let present = state
            .entries
            .iter()
            .filter(|e| win_menu_entry_matches(e))
            .count();
        state.partial = present > 0 && present < state.entries.len();
        state.installed = present == state.entries.len() && !state.entries.is_empty();
        state.detail = if state.installed {
            "已安装（每用户，HKCU）"
        } else if state.partial {
            "部分条目存在，建议重新安装"
        } else {
            "未安装"
        }
        .to_string();
    }
    state
}

/// 写 HKCU 注册表（幂等：重复安装只覆盖同样的值）。
pub fn apply_menu(exe: &str) -> Result<MenuState, String> {
    let entries = menu_entries(exe)?;
    if !supported() {
        return Err("当前平台不支持资源管理器右键菜单（仅 Windows）".to_string());
    }
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        for entry in &entries {
            let (key, _) = hkcu
                .create_subkey(entry.key.as_str())
                .map_err(|e| format!("写注册表失败（{}）：{e}", entry.key))?;
            key.set_value("", &entry.label)
                .map_err(|e| format!("写菜单文案失败：{e}"))?;
            key.set_value("MUIVerb", &entry.label)
                .map_err(|e| format!("写 MUIVerb 失败：{e}"))?;
            key.set_value("Icon", &entry.icon)
                .map_err(|e| format!("写图标失败：{e}"))?;
            let (cmd, _) = hkcu
                .create_subkey(format!("{}\\command", entry.key))
                .map_err(|e| format!("写命令行子键失败：{e}"))?;
            cmd.set_value("", &entry.command)
                .map_err(|e| format!("写命令行失败：{e}"))?;
        }
    }
    Ok(menu_state(exe))
}

/// 删掉三条菜单项（整棵子树删，幂等：不存在也不报错）。
pub fn remove_menu(exe: &str) -> Result<MenuState, String> {
    let entries = menu_entries(exe)?;
    if !supported() {
        return Err("当前平台不支持资源管理器右键菜单（仅 Windows）".to_string());
    }
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        for entry in &entries {
            match hkcu.delete_subkey_all(entry.key.as_str()) {
                Ok(()) => {}
                // 本来就不存在：幂等
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("删除注册表项失败（{}）：{e}", entry.key)),
            }
        }
    }
    Ok(menu_state(exe))
}

#[cfg(windows)]
fn win_menu_entry_matches(entry: &MenuEntry) -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(entry.key.as_str()) else {
        return false;
    };
    let label: String = key.get_value("MUIVerb").unwrap_or_default();
    if label != entry.label {
        return false;
    }
    let Ok(cmd_key) = hkcu.open_subkey(format!("{}\\command", entry.key)) else {
        return false;
    };
    let command: String = cmd_key.get_value("").unwrap_or_default();
    command == entry.command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_plan_has_three_entries_in_order() {
        let entries = menu_entries("C:\\Program Files\\Renomio\\renomio.exe").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].scope, "file");
        assert_eq!(entries[1].scope, "directory");
        assert_eq!(entries[2].scope, "background");
    }

    #[test]
    fn menu_plan_quotes_command() {
        let exe = "C:\\Program Files\\Renomio\\renomio.exe";
        let entries = menu_entries(exe).unwrap();
        assert_eq!(entries[0].command, format!("\"{exe}\" \"%1\""));
        assert_eq!(entries[2].command, format!("\"{exe}\" \"%V\""));
    }
}