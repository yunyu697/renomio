//! 快捷方式：Windows 上走 COM `IShellLink` + `IPersistFile.Save`。
//!
//! 为什么不手写 `.lnk` 字节：Shell Link 的目标解析优先走 `IDList`（PIDL），
//! 只写 `LinkInfo` 的 `.lnk` 用 `WScript.Shell` 回读时 `TargetPath` 为空，
//! Explorer 也可能不去解析。交给系统自己写就不会有这种「文件在、目标空」的坑。
//! 非 Windows 平台没有等价概念，明确返回「不支持」而不是假装成功。

use std::path::Path;

/// 平台是否支持创建快捷方式。
pub const fn supported() -> bool {
    cfg!(windows)
}

#[cfg(windows)]
pub fn create_shortcut(
    lnk: &Path,
    target: &str,
    args: &str,
    workdir: &str,
    icon: &str,
) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    // 目标必须是绝对路径：COM 对相对路径不报错，会生成「目标为空」的坏快捷方式
    if !Path::new(target).is_absolute() {
        return Err(format!("快捷方式目标必须是绝对路径：{target}"));
    }
    if target.contains('\0') || args.contains('\0') || workdir.contains('\0') || icon.contains('\0') {
        return Err("快捷方式字段不能包含 NUL 字符".to_string());
    }

    let lnk_wide = to_wide(lnk.to_string_lossy().as_ref());
    let target_wide = to_wide(target);
    let args_wide = to_wide(args);
    let workdir_wide = to_wide(workdir);
    let icon_wide = to_wide(icon);

    unsafe {
        // 失败（例如线程已初始化成别的套间模型）也继续：COM 已经可用就行
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> Result<(), String> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 ShellLink 失败：{e}"))?;
            link.SetPath(PCWSTR(target_wide.as_ptr()))
                .map_err(|e| format!("设置目标失败：{e}"))?;
            if !args.is_empty() {
                link.SetArguments(PCWSTR(args_wide.as_ptr()))
                    .map_err(|e| format!("设置参数失败：{e}"))?;
            }
            if !workdir.is_empty() {
                link.SetWorkingDirectory(PCWSTR(workdir_wide.as_ptr()))
                    .map_err(|e| format!("设置工作目录失败：{e}"))?;
            }
            if !icon.is_empty() {
                link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)
                    .map_err(|e| format!("设置图标失败：{e}"))?;
            }
            let file: IPersistFile = link
                .cast()
                .map_err(|e| format!("转换为 IPersistFile 失败：{e}"))?;
            file.Save(PCWSTR(lnk_wide.as_ptr()), true.into())
                .map_err(|e| format!("保存快捷方式失败：{e}"))?;
            Ok(())
        })();
        CoUninitialize();
        result
    }
}

#[cfg(not(windows))]
pub fn create_shortcut(
    _lnk: &Path,
    _target: &str,
    _args: &str,
    _workdir: &str,
    _icon: &str,
) -> Result<(), String> {
    Err("当前平台不支持创建 Windows 快捷方式".to_string())
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    /// 用 COM 把刚写出的 `.lnk` 读回来：目标路径、参数、工作目录、图标。
    fn read_back(lnk: &Path) -> (String, String, String, String) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            let wide = to_wide(lnk.to_string_lossy().as_ref());
            file.Load(PCWSTR(wide.as_ptr()), windows::Win32::System::Com::STGM_READ).unwrap();
            let mut buf = vec![0u16; 1024];
            link.GetPath(buf.as_mut_slice(), std::ptr::null_mut(), 0)
                .unwrap();
            let mut args = vec![0u16; 1024];
            link.GetArguments(args.as_mut_slice()).unwrap();
            let mut work = vec![0u16; 1024];
            link.GetWorkingDirectory(work.as_mut_slice())
                .unwrap();
            let mut icon = vec![0u16; 1024];
            let mut idx = 0i32;
            link.GetIconLocation(icon.as_mut_slice(), &mut idx)
                .unwrap();
            CoUninitialize();
            (
                String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string(),
                String::from_utf16_lossy(&args).trim_end_matches('\0').to_string(),
                String::from_utf16_lossy(&work).trim_end_matches('\0').to_string(),
                String::from_utf16_lossy(&icon).trim_end_matches('\0').to_string(),
            )
        }
    }

    #[test]
    fn shortcut_round_trips_through_com() {
        let dir = std::env::temp_dir().join(format!("renomio-shortcut-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let lnk = dir.join("Renomio.lnk");
        let target = std::env::var("SystemRoot").unwrap() + "\\notepad.exe";
        create_shortcut(&lnk, &target, "--open \"%1\"", &dir.to_string_lossy(), &target).unwrap();
        assert!(lnk.exists());
        let (path, args, work, icon) = read_back(&lnk);
        assert!(path.eq_ignore_ascii_case(&target), "目标路径必须被系统解析出来：{path}");
        assert_eq!(args, "--open \"%1\"");
        assert!(icon.eq_ignore_ascii_case(&target), "图标应为目标本身：{icon}");
        assert!(!work.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shortcut_rejects_relative_target() {
        let dir = std::env::temp_dir().join(format!("renomio-shortcut-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let lnk = dir.join("Bad.lnk");
        let result = create_shortcut(&lnk, "relative.exe", "", &dir.to_string_lossy(), "");
        assert!(result.is_err(), "相对目标必须报错");
        assert!(!lnk.exists(), "报错时不能留下快捷方式文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_platform_is_explicit() {
        assert_eq!(supported(), cfg!(windows));
    }
}
