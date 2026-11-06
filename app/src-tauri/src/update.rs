//! 应用内更新器：检查清单 → 下载（镜像回退）→ 签名校验 → 安装 / 仅下载。
//!
//! 清单放在滚动 tag `updates` 的 `latest.json`（Tauri 静态 JSON 格式），
//! 完整性以 minisign 签名校验为准：镜像返回错文件时签名必然不匹配，直接拒绝。

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str =
    "https://github.com/yunyu697/renomio-releases/releases/download/updates/latest.json";
const HOMEPAGE: &str = "https://github.com/yunyu697/renomio-releases";

/// base64(公钥文件全文)。私钥只在本机 `Documents\Trae-CN\renomio-signing`，不入仓库。
const PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZENTBCQzBCQjZFREQ4QTEKUldTaDJPMjJDN3hRL2JURjBoajFjMERSZ1dWMHNncDVqdmR1S1o4L1VzSWIvbndwUlc3SWJrWXYK";

/// 加速镜像前缀；顺序即「自动」模式的尝试顺序，官方地址永远最后兜底。
const MIRRORS: [(&str, &str); 3] = [
    ("ghproxy", "https://ghproxy.net/"),
    ("gh-proxy", "https://gh-proxy.com/"),
    ("ghfast", "https://ghfast.top/"),
];

const DOWNLOAD_DIR: &str = "renomio-update";

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub pub_date: String,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformAsset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PlatformAsset {
    pub signature: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub source: String,
    pub installable: bool,
    pub asset_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedUpdate {
    pub path: String,
    pub version: String,
    pub source: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: String,
    received: u64,
    total: u64,
    percent: f64,
    source: String,
    attempt: u32,
    message: String,
}

#[derive(Clone, Debug)]
struct SavedRecord {
    path: PathBuf,
    version: String,
    signature: String,
    asset_name: String,
}

static SAVED: Mutex<Option<SavedRecord>> = Mutex::new(None);

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    received: u64,
    total: u64,
    source: &str,
    attempt: u32,
    message: &str,
) {
    let percent = if total > 0 {
        (received as f64 / total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    let _ = app.emit(
        "update-progress",
        UpdateProgress {
            phase: phase.to_string(),
            received,
            total,
            percent,
            source: source.to_string(),
            attempt,
            message: message.to_string(),
        },
    );
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .user_agent(format!("Renomio/{}", current_version()))
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{e}"))
}

/// 某一下载源的候选地址：选定的镜像 + 官方兜底；未去重前不重复尝试同一地址。
fn url_candidates(mirror: &str, url: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |source: &str, candidate: String| {
        if out.iter().any(|(_, existing)| existing == &candidate) {
            return;
        }
        out.push((source.to_string(), candidate));
    };
    match mirror {
        "official" => push("GitHub", url.to_string()),
        id if MIRRORS.iter().any(|(name, _)| *name == id) => {
            let prefix = MIRRORS
                .iter()
                .find(|(name, _)| *name == id)
                .map(|(_, prefix)| *prefix)
                .unwrap_or("");
            push(id, format!("{prefix}{url}"));
            push("GitHub", url.to_string());
        }
        _ => {
            for (name, prefix) in MIRRORS {
                push(name, format!("{prefix}{url}"));
            }
            push("GitHub", url.to_string());
        }
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| format!("base64 解码失败：{e}"))
}

fn quote_field<'a>(comment: &'a str, key: &str) -> Option<&'a str> {
    comment
        .split(['\t', ' ', '\n'])
        .find_map(|part| part.strip_prefix(key)?.strip_prefix(':'))
        .map(str::trim)
}

/// 校验安装包字节：签名有效 + 签名绑定的版本 / 文件名与清单一致（签名里没写版本时跳过版本比对）。
fn verify_bytes(
    data: &[u8],
    signature_b64: &str,
    expected_version: &str,
    expected_name: &str,
) -> Result<(), String> {
    let sig_text = String::from_utf8(base64_decode(signature_b64)?)
        .map_err(|_| "签名不是 UTF-8 文本".to_string())?;
    let signature = Signature::decode(&sig_text).map_err(|e| format!("签名格式无效：{e}"))?;
    let pubkey_text =
        String::from_utf8(base64_decode(PUBKEY_B64)?).map_err(|_| "内置公钥无效".to_string())?;
    let public_key = PublicKey::decode(&pubkey_text).map_err(|e| format!("内置公钥无效：{e}"))?;
    public_key
        .verify(data, &signature, false)
        .map_err(|_| "安装包签名校验失败：文件内容与签名不匹配".to_string())?;
    let comment = signature.trusted_comment();
    if let Some(version) = quote_field(comment, "version") {
        if version != expected_version {
            return Err(format!(
                "签名绑定的版本是 {version}，与清单版本 {expected_version} 不一致，已拒绝"
            ));
        }
    }
    if let Some(name) = quote_field(comment, "file") {
        if name != expected_name {
            return Err(format!(
                "签名绑定的文件名是 {name}，与清单里的 {expected_name} 不一致，已拒绝"
            ));
        }
    }
    Ok(())
}

fn is_newer(remote: &str, current: &str) -> Result<bool, String> {
    let remote =
        semver::Version::parse(remote).map_err(|e| format!("清单版本号 {remote} 不合法：{e}"))?;
    let current =
        semver::Version::parse(current).map_err(|e| format!("当前版本号 {current} 不合法：{e}"))?;
    Ok(remote > current)
}

fn pick_asset(manifest: &UpdateManifest) -> Result<PlatformAsset, String> {
    manifest
        .platforms
        .get(platform_key())
        .cloned()
        .ok_or_else(|| format!("更新清单里没有当前平台（{}）的安装包", platform_key()))
}

fn asset_file_name(url: &str) -> String {
    let raw = url.split(['?', '#']).next().unwrap_or(url);
    let raw = raw.rsplit('/').next().unwrap_or("renomio-update");
    sanitize_file_name(raw)
}

fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        return "renomio-update.bin".to_string();
    }
    // 保留扩展名，超长主体截断，避免 Windows 单段名过长无法创建文件。
    let path = Path::new(&trimmed);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    if trimmed.chars().count() > 120 {
        let stem: String = trimmed
            .chars()
            .take(120usize.saturating_sub(ext.chars().count()))
            .collect();
        return format!("{stem}{ext}");
    }
    trimmed
}

fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("renomio-update");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    for n in 2..=999 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.join(format!("{stem}-{stamp}{ext}"))
}

/// 应用启动时清理上次中断留下的半截下载。
pub fn cleanup_stale_parts() {
    cleanup_parts(&std::env::temp_dir().join(DOWNLOAD_DIR));
}

/// 下载目录旁的签名旁挂文件：`setup.exe` → `setup.exe.sig`。
fn sidecar_path(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("renomio-update")
        .to_string();
    name.push_str(".sig");
    target.with_file_name(name)
}

fn downloads_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().download_dir() {
        return dir;
    }
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        return home.join("Downloads");
    }
    std::env::temp_dir()
}

fn fetch_manifest(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    mirror: &str,
) -> Result<(UpdateManifest, String), String> {
    let candidates = url_candidates(mirror, MANIFEST_URL);
    let mut errors: Vec<String> = Vec::new();
    for (index, (source, url)) in candidates.iter().enumerate() {
        emit_progress(
            app,
            "checking",
            0,
            0,
            source,
            index as u32 + 1,
            "读取更新清单",
        );
        let response = client
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .and_then(|r| r.error_for_status());
        match response {
            Ok(resp) => match resp.json::<UpdateManifest>() {
                Ok(manifest) => return Ok((manifest, source.clone())),
                Err(err) => errors.push(format!("{source}：清单不是合法 JSON（{err}）")),
            },
            Err(err) => errors.push(format!("{source}：{err}")),
        }
    }
    Err(format!(
        "无法获取更新清单，已尝试 {} 个源：{}",
        candidates.len(),
        errors.join("；")
    ))
}

fn download_one(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    url: &str,
    part: &Path,
    source: &str,
    attempt: u32,
) -> Result<u64, String> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(900))
        .send()
        .map_err(|e| format!("网络错误：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(part).map_err(|e| format!("创建临时文件失败：{e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("读取下载数据失败：{e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buf[..read])
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        received += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            emit_progress(app, "download", received, total, source, attempt, "下载中");
        }
    }
    file.sync_all()
        .map_err(|e| format!("临时文件落盘失败：{e}"))?;
    emit_progress(
        app,
        "download",
        received,
        total,
        source,
        attempt,
        "下载完成",
    );
    Ok(received)
}

fn cleanup_parts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) == Some("part") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// 下载并校验；`save` 模式落到默认下载文件夹，`install` 模式留在临时目录待安装。
fn download_and_verify(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    asset: &PlatformAsset,
    version: &str,
    mirror: &str,
    save: bool,
) -> Result<SavedUpdate, String> {
    let asset_name = asset_file_name(&asset.url);
    // URL 必须指向清单声明的版本，防止清单被改写后指向旧包。
    if !asset_name.contains(version) {
        return Err(format!(
            "清单里的安装包文件名（{asset_name}）与版本 {version} 不一致，已拒绝"
        ));
    }
    let temp_dir = std::env::temp_dir().join(DOWNLOAD_DIR);
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    cleanup_parts(&temp_dir);
    let part = temp_dir.join(format!("{asset_name}.part"));
    let candidates = url_candidates(mirror, &asset.url);
    let mut errors: Vec<String> = Vec::new();

    for (index, (source, url)) in candidates.iter().enumerate() {
        let attempt = index as u32 + 1;
        let outcome = download_one(app, client, url, &part, source, attempt).and_then(|size| {
            emit_progress(app, "verify", size, size, source, attempt, "校验签名");
            let data = fs::read(&part).map_err(|e| format!("读取临时文件失败：{e}"))?;
            verify_bytes(&data, &asset.signature, version, &asset_name)
                .map_err(|e| format!("{e}（{source} 返回的文件不可信）"))?;
            Ok(size)
        });
        let size = match outcome {
            Ok(size) => size,
            Err(err) => {
                let _ = fs::remove_file(&part);
                errors.push(format!("{source}：{err}"));
                continue;
            }
        };
        let verified = temp_dir.join(&asset_name);
        if verified.exists() {
            let _ = fs::remove_file(&verified);
        }
        fs::rename(&part, &verified).map_err(|e| format!("整理已验证文件失败：{e}"))?;

        let target = if save {
            let dir = downloads_dir(app);
            fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
            let target = unique_target(&dir, &asset_name);
            let target_part = dir.join(format!(
                "{}.part",
                target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("renomio-update")
            ));
            fs::copy(&verified, &target_part).map_err(|e| format!("复制到下载目录失败：{e}"))?;
            fs::rename(&target_part, &target).map_err(|e| {
                let _ = fs::remove_file(&target_part);
                format!("写入下载目录失败：{e}")
            })?;
            fs::write(sidecar_path(&target), asset.signature.as_bytes())
                .map_err(|e| format!("写入签名文件失败：{e}"))?;
            let _ = fs::remove_file(&verified);
            target
        } else {
            verified
        };
        let record = SavedRecord {
            path: target.clone(),
            version: version.to_string(),
            signature: asset.signature.clone(),
            asset_name: asset_name.clone(),
        };
        if let Ok(mut slot) = SAVED.lock() {
            *slot = Some(record);
        }
        emit_progress(
            app,
            if save { "ready" } else { "verified" },
            size,
            size,
            source,
            attempt,
            if save {
                "已保存到下载文件夹"
            } else {
                "校验通过"
            },
        );
        return Ok(SavedUpdate {
            path: target.to_string_lossy().to_string(),
            version: version.to_string(),
            source: source.clone(),
            size,
        });
    }

    let _ = fs::remove_file(&part);
    Err(format!(
        "下载失败，已尝试 {} 个源：{}",
        candidates.len(),
        errors.join("；")
    ))
}

/// 安装器启动计划：程序与命令参数。msi 交给 msiexec，exe 直接以 NSIS 静默参数启动。
#[cfg(target_os = "windows")]
fn installer_invocation(path: &Path) -> Result<(std::ffi::OsString, String), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "msi" => Ok((
            std::ffi::OsString::from("msiexec.exe"),
            format!(
                "/i \"{}\" /quiet AUTOLAUNCHAPP=True",
                path.to_string_lossy().replace('"', "")
            ),
        )),
        "exe" => Ok((path.as_os_str().to_owned(), "/S /UPDATE /R".to_string())),
        _ => Err(format!("不支持自动安装的文件类型：.{ext}")),
    }
}

/// 把 `ShellExecuteW(runas)` 的结果翻译成用户可读结果：成功、取消授权、其它原始错误码。
#[cfg(target_os = "windows")]
fn launch_outcome_message(
    outcome: Result<crate::win_elevation::LaunchOutcome, isize>,
) -> Result<(), String> {
    match outcome {
        Ok(crate::win_elevation::LaunchOutcome::Started) => Ok(()),
        Ok(crate::win_elevation::LaunchOutcome::Cancelled) => {
            Err("已取消授权：用户拒绝了 UAC，安装已中止".to_string())
        }
        Err(code) => Err(format!("启动安装程序失败（ShellExecuteW 返回 {code}）")),
    }
}

/// 启动安装程序。Windows 上唯一路径是 `ShellExecuteW(runas)`，不再直接 spawn（否则 740）。
fn launch_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (program, params) = installer_invocation(path)?;
        launch_outcome_message(crate::win_elevation::run_elevated(&program, Some(&params)))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台暂不支持应用内自动安装，请手动打开下载的文件".to_string())
    }
}

/// 安装未启动成功时清理应用自己下载的临时包；用户主动「仅下载」的文件不删。
fn discard_owned_install(path: &Path, owned_temp: bool) {
    if owned_temp {
        let _ = fs::remove_file(path);
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let _ = fs::remove_file(path.with_file_name(format!("{name}.part")));
    }
}

fn finish_install(app: &AppHandle, path: &Path, owned_temp: bool) -> Result<(), String> {
    emit_progress(app, "installing", 0, 0, "local", 0, "正在启动安装程序");
    if let Err(err) = launch_installer(path) {
        discard_owned_install(path, owned_temp);
        return Err(err);
    }
    emit_progress(
        app,
        "restarting",
        0,
        0,
        "local",
        0,
        "安装程序已启动，应用即将退出",
    );
    std::thread::sleep(Duration::from_millis(250));
    app.exit(0);
    Ok(())
}

fn resolve_saved_signature(
    app: &AppHandle,
    path: &Path,
    mirror: &str,
) -> Result<(String, String, String), String> {
    if let Ok(slot) = SAVED.lock() {
        if let Some(record) = slot.as_ref() {
            if record.path == path {
                return Ok((
                    record.signature.clone(),
                    record.version.clone(),
                    record.asset_name.clone(),
                ));
            }
        }
    }
    // 应用重启后内存记录丢失：优先读下载目录旁的 .sig，其次重新拉清单。
    let sidecar = sidecar_path(path);
    let asset_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("renomio-update")
        .to_string();
    if let Ok(sig) = fs::read_to_string(&sidecar) {
        let sig_text = String::from_utf8(base64_decode(&sig)?)
            .map_err(|_| "签名文件不是 UTF-8 文本".to_string())?;
        if let Ok(signature) = Signature::decode(&sig_text) {
            if let Some(version) = quote_field(signature.trusted_comment(), "version") {
                return Ok((sig.trim().to_string(), version.to_string(), asset_name));
            }
        }
    }
    let client = build_client()?;
    let (manifest, _) = fetch_manifest(app, &client, mirror)?;
    let asset = pick_asset(&manifest)?;
    Ok((
        asset.signature,
        manifest.version,
        asset_file_name(&asset.url),
    ))
}

/// 检查更新：只读清单，不下载。
#[tauri::command]
pub async fn check_update(app: AppHandle, mirror: Option<String>) -> Result<UpdateInfo, String> {
    let mirror = mirror.unwrap_or_else(|| "auto".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client()?;
        let (manifest, source) = fetch_manifest(&app, &client, &mirror)?;
        let asset = pick_asset(&manifest)?;
        let current = current_version();
        Ok::<UpdateInfo, String>(UpdateInfo {
            available: is_newer(&manifest.version, &current)?,
            current_version: current,
            version: manifest.version,
            notes: manifest.notes,
            pub_date: manifest.pub_date,
            source,
            installable: cfg!(target_os = "windows"),
            asset_name: asset_file_name(&asset.url),
        })
    })
    .await
    .map_err(|e| format!("检查更新任务异常：{e}"))?
}

/// 下载更新：`mode = install` 下载→校验→安装→重启；`mode = save` 只落盘并返回路径。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    mode: String,
    mirror: Option<String>,
) -> Result<SavedUpdate, String> {
    let mirror = mirror.unwrap_or_else(|| "auto".to_string());
    let app_task = app.clone();
    let install = mode == "install";
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let client = build_client()?;
        let (manifest, _) = fetch_manifest(&app_task, &client, &mirror)?;
        let current = current_version();
        if !is_newer(&manifest.version, &current)? {
            return Err(format!("当前已是最新版本（{current}），无需下载"));
        }
        let asset = pick_asset(&manifest)?;
        download_and_verify(
            &app_task,
            &client,
            &asset,
            &manifest.version,
            &mirror,
            !install,
        )
    })
    .await
    .map_err(|e| format!("下载任务异常：{e}"))??;

    if install {
        finish_install(&app, Path::new(&saved.path), true)?;
    }
    Ok(saved)
}

/// 安装此前「仅下载」的包：再次用同一签名校验后启动安装程序。
#[tauri::command]
pub async fn install_saved_update(
    app: AppHandle,
    path: String,
    mirror: Option<String>,
) -> Result<(), String> {
    let app_task = app.clone();
    let mirror = mirror.unwrap_or_else(|| "auto".to_string());
    let target = PathBuf::from(&path);
    let path_for_task = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !target.exists() {
            return Err(format!("安装包不存在：{path_for_task}"));
        }
        let data = fs::read(&target).map_err(|e| format!("读取安装包失败：{e}"))?;
        let (signature, version, asset_name) =
            resolve_saved_signature(&app_task, &target, &mirror)?;
        verify_bytes(&data, &signature, &version, &asset_name)?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("校验安装包任务异常：{e}"))??;

    finish_install(&app, Path::new(&path), false)
}

#[tauri::command]
pub fn open_homepage() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", HOMEPAGE])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开主页失败：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(HOMEPAGE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开主页失败：{e}"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(HOMEPAGE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开主页失败：{e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用真实私钥对固定字节签出的签名（私钥不入库），验证「镜像给错文件必须被拒」。
    /// 值即 Tauri `.sig` 文件内容（本身是 minisign 文本的 base64）。
    const FIXTURE_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTaDJPMjJDN3hRL2M4cHJiRHIrSkI3Q1NmK1hiV1pyenJwRDJaWTdseHQ2YVQ4cGRXZzU4ZWc4N3BmaWZmSnFrTHhCWVVuTmRqTzJpZDdkbTBpS3VDTXdNd1JUa0pJK1FBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTM2ODAyCWZpbGU6cmVub21pby10ZXN0LXBheWxvYWQuYmluCkhGdWViUG5XdENBZDU0Zit5cGJ6djRVY2toMzlSZmRFQkNVTk9QR2FDK0podTB1RHBtSmx5MXFTRVNVWW45TVFvWkVXOFM5ZWhIVnpZOUR4cVJHREJ3PT0K";
    const FIXTURE_BYTES: &[u8] = b"renomio-updater-fixture-v1";
    const FIXTURE_NAME: &str = "renomio-test-payload.bin";

    #[test]
    fn auto_mirror_tries_all_then_official() {
        let urls = url_candidates("auto", "https://example.com/a.exe");
        assert_eq!(urls.len(), 4);
        assert_eq!(urls[0].0, "ghproxy");
        assert_eq!(urls[1].0, "gh-proxy");
        assert_eq!(urls[2].0, "ghfast");
        assert_eq!(urls[3].0, "GitHub");
    }

    #[test]
    fn selected_mirror_falls_back_to_official() {
        let urls = url_candidates("ghproxy", "https://example.com/a.exe");
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].1, "https://ghproxy.net/https://example.com/a.exe");
        assert_eq!(urls[1].1, "https://example.com/a.exe");
    }

    #[test]
    fn official_only_has_one_candidate() {
        let urls = url_candidates("official", "https://example.com/a.exe");
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].1, "https://example.com/a.exe");
    }

    #[test]
    fn wrong_file_is_rejected() {
        let err =
            verify_bytes(b"tampered-bytes", FIXTURE_SIG, "1.0.0-alpha5", FIXTURE_NAME).unwrap_err();
        assert!(err.contains("签名校验失败"), "{err}");
        assert!(verify_bytes(FIXTURE_BYTES, FIXTURE_SIG, "1.0.0-alpha5", FIXTURE_NAME).is_ok());
    }

    #[test]
    fn mismatched_name_is_rejected() {
        let err =
            verify_bytes(FIXTURE_BYTES, FIXTURE_SIG, "1.0.0-alpha5", "other.exe").unwrap_err();
        assert!(err.contains("文件名"), "{err}");
    }

    #[test]
    fn version_compare_handles_prerelease() {
        assert!(is_newer("1.0.0-alpha5", "1.0.0-alpha4").unwrap());
        assert!(!is_newer("1.0.0-alpha4", "1.0.0-alpha5").unwrap());
        assert!(!is_newer("1.0.0-alpha4", "1.0.0-alpha4").unwrap());
        assert!(is_newer("1.0.0", "1.0.0-alpha5").unwrap());
    }

    #[test]
    fn file_name_is_sanitized() {
        assert_eq!(
            asset_file_name("https://a/b/Renomio_1.0.0-alpha5_x64-setup.exe"),
            "Renomio_1.0.0-alpha5_x64-setup.exe"
        );
        assert_eq!(asset_file_name("https://a/b/file.exe?x=1"), "file.exe");
        assert_eq!(sanitize_file_name("a\\b:c*.exe"), "a_b_c_.exe");
    }

    #[test]
    fn duplicate_download_name_gets_suffix() {
        let dir = std::env::temp_dir().join(format!("renomio-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let first = dir.join("setup.exe");
        fs::write(&first, b"x").unwrap();
        let second = unique_target(&dir, "setup.exe");
        assert_eq!(second.file_name().unwrap(), "setup (2).exe");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn installer_invocation_maps_nsis_and_msi() {
        let exe = Path::new(r"C:\Temp\Renomio_1.0.0-alpha7_x64-setup.exe");
        let (program, params) = installer_invocation(exe).unwrap();
        assert_eq!(program, exe.as_os_str().to_owned());
        assert_eq!(params, "/S /UPDATE /R");

        let msi = Path::new(r"C:\Temp\Renomio_1.0.0-alpha7_x64_en-US.msi");
        let (program, params) = installer_invocation(msi).unwrap();
        assert_eq!(program, std::ffi::OsString::from("msiexec.exe"));
        assert!(params.contains(r#""C:\Temp\Renomio_1.0.0-alpha7_x64_en-US.msi""#));
        assert!(params.contains("/quiet AUTOLAUNCHAPP=True"));

        assert!(installer_invocation(Path::new("pkg.txt")).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cancelled_uac_is_not_reported_as_failure() {
        use crate::win_elevation::LaunchOutcome;
        let cancel = launch_outcome_message(Ok(LaunchOutcome::Cancelled)).unwrap_err();
        assert!(cancel.contains("已取消授权"), "{cancel}");
        assert!(!cancel.contains("启动安装程序失败"), "{cancel}");
        assert!(!cancel.contains("740"), "{cancel}");

        let failed = launch_outcome_message(Err(5)).unwrap_err();
        assert!(failed.contains("返回 5"), "{failed}");
        assert!(!failed.contains("已取消授权"), "{failed}");

        assert!(launch_outcome_message(Ok(LaunchOutcome::Started)).is_ok());
    }

    #[test]
    fn failed_install_leaves_no_owned_package_or_part() {
        let dir = std::env::temp_dir().join(format!("renomio-launch-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let owned = dir.join("pkg.exe");
        fs::write(&owned, b"x").unwrap();
        fs::write(dir.join("pkg.exe.part"), b"x").unwrap();
        discard_owned_install(&owned, true);
        assert!(!owned.exists());
        assert!(!dir.join("pkg.exe.part").exists());

        // 用户主动「仅下载」的包不删，只清同名 .part。
        let saved = dir.join("saved.exe");
        fs::write(&saved, b"x").unwrap();
        fs::write(dir.join("saved.exe.part"), b"x").unwrap();
        discard_owned_install(&saved, false);
        assert!(saved.exists());
        assert!(!dir.join("saved.exe.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 回归护栏：安装器启动不得退回未提权的 `Command::new`，否则真机必然 740。
    #[cfg(target_os = "windows")]
    #[test]
    fn installer_launch_never_spawns_unelevated() {
        let src = include_str!("update.rs");
        let spawned = concat!("Command::new", "(", "path", ")");
        assert!(
            !src.contains(spawned),
            "安装器启动不应再直接 spawn 未提权进程"
        );
        let entry = concat!("run_", "elevated");
        assert!(
            src.contains(entry),
            "安装器启动应统一走 ShellExecuteW(runas)"
        );
    }

    /// 真实产物反例（需手动提供路径，CI 跳过）：
    /// `RENOMIO_TEST_EXE` / `RENOMIO_TEST_MSI` / `RENOMIO_TEST_SIG`。
    /// 用 NSIS 包的签名校验 MSI 包，必须被拒。
    #[test]
    #[ignore]
    fn real_packages_negative_signature() {
        let exe = fs::read(std::env::var("RENOMIO_TEST_EXE").expect("缺少 RENOMIO_TEST_EXE"))
            .expect("读取 exe");
        let msi = fs::read(std::env::var("RENOMIO_TEST_MSI").expect("缺少 RENOMIO_TEST_MSI"))
            .expect("读取 msi");
        let sig =
            fs::read_to_string(std::env::var("RENOMIO_TEST_SIG").expect("缺少 RENOMIO_TEST_SIG"))
                .expect("读取 sig");
        verify_bytes(
            &exe,
            &sig,
            "1.0.0-alpha5",
            "Renomio_1.0.0-alpha5_x64-setup.exe",
        )
        .expect("真实 NSIS 包应通过签名校验");
        let err = verify_bytes(
            &msi,
            &sig,
            "1.0.0-alpha5",
            "Renomio_1.0.0-alpha5_x64-setup.exe",
        )
        .expect_err("把 exe 的签名套到 msi 必须失败");
        assert!(err.contains("签名校验失败"), "{err}");
    }
}
