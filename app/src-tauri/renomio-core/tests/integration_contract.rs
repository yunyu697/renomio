//! 资源管理器集成契约：右键菜单计划 + Windows 注册表落盘与回读。
//!
//! 跨平台可跑：计划与字节生成是纯函数；真正落注册表的两条只在 Windows 上执行。

use renomio_core::integration;


#[test]
fn menu_plan_covers_three_scopes() {
    let entries = integration::menu_entries("C:\\Program Files\\Renomio\\renomio.exe").unwrap();
    assert_eq!(entries.len(), 3);
    let scopes: Vec<String> = entries.iter().map(|e| e.scope.clone()).collect();
    assert_eq!(scopes, vec!["file", "directory", "background"]);
}

#[test]
fn menu_keys_stay_under_hkcu_classes() {
    let entries = integration::menu_entries("C:\\Program Files\\Renomio\\renomio.exe").unwrap();
    for entry in &entries {
        assert!(entry.key.starts_with("Software\\Classes\\"), "{}", entry.key);
        assert!(!entry.key.contains("HKEY_"), "{}", entry.key);
        assert!(entry.key.ends_with("\\shell\\Renomio"), "{}", entry.key);
    }
}

#[test]
fn menu_commands_quote_exe_and_placeholder() {
    let exe = "C:\\Program Files\\Renomio\\renomio.exe";
    let entries = integration::menu_entries(exe).unwrap();
    assert_eq!(entries[0].command, format!("\"{exe}\" \"%1\""));
    assert_eq!(entries[1].command, format!("\"{exe}\" \"%1\""));
    assert_eq!(entries[2].command, format!("\"{exe}\" \"%V\""));
    for entry in &entries {
        assert_eq!(entry.icon, exe);
        assert!(!entry.label.is_empty());
    }
}

#[test]
fn menu_plan_rejects_bad_exe() {
    assert!(integration::menu_entries("").is_err());
    assert!(integration::menu_entries("renomio.exe").is_err());
    assert!(integration::menu_entries("C:\\a\"b\\renomio.exe").is_err());
    assert!(integration::menu_entries("C:\\a\nb\\renomio.exe").is_err());
    // 带空格的绝对路径必须被接受（安装目录默认就带空格）
    assert!(integration::menu_entries("C:\\Program Files\\Renomio\\renomio.exe").is_ok());
}

#[test]
fn menu_state_reports_platform_support() {
    let state = integration::menu_state("C:\\Program Files\\Renomio\\renomio.exe");
    assert_eq!(state.supported, cfg!(windows));
    assert_eq!(state.entries.len(), 3);
    if !cfg!(windows) {
        assert!(!state.installed);
        assert!(!state.partial);
        assert!(state.detail.contains("不支持"));
    }
}

#[test]
fn non_windows_apply_is_explicit_failure() {
    if cfg!(windows) {
        return;
    }
    assert!(integration::apply_menu("C:\\Renomio\\renomio.exe").is_err());
    assert!(integration::remove_menu("C:\\Renomio\\renomio.exe").is_err());
}

/// 真写注册表：装 → 状态为已装 → 再装一次幂等 → 删 → 状态回到未装。
/// 只动 HKCU 下我们自己的三条键，结束必然删除（失败也会重试删除）。
#[cfg(windows)]
#[test]
fn windows_registry_install_and_remove_round_trip() {
    let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
    let installed = integration::apply_menu(&exe).expect("安装菜单失败");
    assert!(installed.installed, "{}", installed.detail);
    assert!(!installed.partial);

    let again = integration::apply_menu(&exe).expect("重复安装失败");
    assert!(again.installed, "重复安装必须幂等");

    let removed = integration::remove_menu(&exe).expect("卸载菜单失败");
    assert!(!removed.installed);
    assert!(!removed.partial);

    // 再删一次也必须成功（幂等）
    let removed_twice = integration::remove_menu(&exe).expect("重复卸载失败");
    assert!(!removed_twice.installed);
}
