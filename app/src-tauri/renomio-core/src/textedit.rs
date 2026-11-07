//! 文本编码转换：检测源编码 → 按目标编码重写；原地覆盖前自动生成 `.bak`，也可「另存为」。
//!
//! 约束（与界面契约一致）：
//! 1. 只支持 UTF-8、UTF-8 with BOM、GB18030、UTF-16 LE、UTF-16 BE 五种；
//! 2. 非 UTF-8 不做静默猜测：GB18030 试探解码成功也标记为「未确认」，界面必须提示用户确认
//!    或手动指定源编码；试探失败返回「未识别」；
//! 3. 原地覆盖默认先备份为同目录 `原文件名.<时间戳>.bak`；
//! 4. 写完立即按目标编码回读并逐字符比较，验证失败视为失败。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 五种受支持编码的稳定 id
const UTF8: &str = "utf8";
const UTF8BOM: &str = "utf8bom";
const GB18030: &str = "gb18030";
const UTF16LE: &str = "utf16le";
const UTF16BE: &str = "utf16be";

fn label(id: &str) -> &'static str {
    match id {
        UTF8 => "UTF-8",
        UTF8BOM => "UTF-8 with BOM",
        GB18030 => "GB18030",
        UTF16LE => "UTF-16 LE",
        UTF16BE => "UTF-16 BE",
        _ => "未识别",
    }
}

fn is_known(id: &str) -> bool {
    matches!(id, UTF8 | UTF8BOM | GB18030 | UTF16LE | UTF16BE)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDetect {
    pub path: String,
    /// 编码 id；无法识别时为 unknown
    pub encoding: String,
    pub encoding_label: String,
    /// 是否由 BOM / 合法 UTF-8 结构确认（GB18030 试探为 false）
    pub confirmed: bool,
    pub bytes: u64,
    pub chars: usize,
    pub lines: usize,
    pub preview: String,
    pub warnings: Vec<String>,
}

fn decode_utf16(data: &[u8], little: bool) -> Result<String, String> {
    let body = if matches!(data.get(..2), Some([0xFF, 0xFE]) | Some([0xFE, 0xFF])) {
        &data[2..]
    } else {
        data
    };
    if body.len() % 2 != 0 {
        return Err("UTF-16 字节数为奇数，结构无效".into());
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| {
            if little {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    Ok(String::from_utf16(&units).map_err(|e| format!("UTF-16 解码失败（包含非法代理项）：{e}"))?)
}

fn decode(data: &[u8], encoding: &str) -> Result<String, String> {
    match encoding {
        UTF8 => Ok(String::from_utf8_lossy_checked(data)?),
        UTF8BOM => {
            let body = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(data);
            Ok(String::from_utf8_lossy_checked(body)?)
        }
        GB18030 => gb18030_to_string(data),
        UTF16LE => decode_utf16(data, true),
        UTF16BE => decode_utf16(data, false),
        other => Err(format!("未知编码：{other}")),
    }
}

/// GB18030 通过 Windows 代码页 54936 转换（不引入第三方 crate，避免 Cargo.lock 变更）
#[cfg(windows)]
fn gb18030_to_string(data: &[u8]) -> Result<String, String> {
    use std::os::raw::{c_int, c_uint};
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: c_uint,
            flags: c_uint,
            bytes: *const u8,
            count: c_int,
            out: *mut u16,
            out_len: c_int,
        ) -> c_int;
    }
    const CP_GB18030: c_uint = 54936;
    if data.is_empty() {
        return Ok(String::new());
    }
    let len = unsafe { MultiByteToWideChar(CP_GB18030, 0, data.as_ptr(), data.len() as c_int, std::ptr::null_mut(), 0) };
    if len <= 0 {
        return Err("GB18030 解码失败（存在无法映射的字节）".into());
    }
    let mut wide = vec![0u16; len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_GB18030,
            0,
            data.as_ptr(),
            data.len() as c_int,
            wide.as_mut_ptr(),
            len,
        )
    };
    if written <= 0 {
        return Err("GB18030 解码失败（存在无法映射的字节）".into());
    }
    String::from_utf16(&wide).map_err(|e| format!("GB18030 解码结果包含非法代理项：{e}"))
}

#[cfg(not(windows))]
fn gb18030_to_string(_data: &[u8]) -> Result<String, String> {
    Err("GB18030 仅支持在 Windows 上转换".into())
}

#[cfg(windows)]
fn string_to_gb18030(text: &str) -> Result<Vec<u8>, String> {
    use std::os::raw::{c_int, c_uint};
    #[link(name = "kernel32")]
    extern "system" {
        fn WideCharToMultiByte(
            code_page: c_uint,
            flags: c_uint,
            wide: *const u16,
            count: c_int,
            out: *mut u8,
            out_len: c_int,
            default_char: *const u8,
            used_default: *mut c_int,
        ) -> c_int;
    }
    const CP_GB18030: c_uint = 54936;
    const WC_NO_BEST_FIT_CHARS: c_uint = 0x0000_0400;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    // WC_NO_BEST_FIT_CHARS 在部分代码页不受支持：先严格尝试，失败后回退到无标志
    for flags in [WC_NO_BEST_FIT_CHARS, 0] {
        let mut used_default: c_int = 0;
        let len = unsafe {
            WideCharToMultiByte(
                CP_GB18030,
                flags,
                wide.as_ptr(),
                wide.len() as c_int,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                if flags == 0 { std::ptr::null_mut() } else { &mut used_default },
            )
        };
        if len <= 0 {
            continue;
        }
        let mut out = vec![0u8; len as usize];
        used_default = 0;
        let written = unsafe {
            WideCharToMultiByte(
                CP_GB18030,
                flags,
                wide.as_ptr(),
                wide.len() as c_int,
                out.as_mut_ptr(),
                len,
                std::ptr::null(),
                if flags == 0 { std::ptr::null_mut() } else { &mut used_default },
            )
        };
        if written <= 0 || (flags != 0 && used_default != 0) {
            continue;
        }
        return Ok(out);
    }
    Err("存在 GB18030 无法表示的字符".into())
}

#[cfg(not(windows))]
fn string_to_gb18030(_text: &str) -> Result<Vec<u8>, String> {
    Err("GB18030 仅支持在 Windows 上转换".into())
}

trait Utf8Checked {
    fn from_utf8_lossy_checked(bytes: &[u8]) -> Result<String, String>;
}

impl Utf8Checked for String {
    fn from_utf8_lossy_checked(bytes: &[u8]) -> Result<String, String> {
        std::str::from_utf8(bytes)
            .map(|s| s.to_string())
            .map_err(|e| format!("不是有效的 UTF-8：{e}"))
    }
}

fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        UTF8 => Ok(text.as_bytes().to_vec()),
        UTF8BOM => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        GB18030 => string_to_gb18030(text),
        UTF16LE => {
            let mut out = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        UTF16BE => {
            let mut out = vec![0xFE, 0xFF];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(out)
        }
        other => Err(format!("未知编码：{other}")),
    }
}

fn detect_encoding(data: &[u8]) -> (String, bool, Vec<String>) {
    let mut warnings = Vec::new();
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (UTF8BOM.into(), true, warnings);
    }
    if data.starts_with(&[0xFF, 0xFE]) {
        return (UTF16LE.into(), true, warnings);
    }
    if data.starts_with(&[0xFE, 0xFF]) {
        return (UTF16BE.into(), true, warnings);
    }
    if std::str::from_utf8(data).is_ok() {
        return (UTF8.into(), true, warnings);
    }
    // 非 UTF-8：先按 GB18030 试探，但一律标记未确认，界面必须提示手动确认
    if gb18030_to_string(data).is_ok() {
        warnings.push("文件不是 UTF-8；已按 GB18030 试探解码，请确认或手动指定源编码".to_string());
        return (GB18030.into(), false, warnings);
    }
    warnings.push("编码未识别，需手动指定源编码后才能转换".to_string());
    ("unknown".into(), false, warnings)
}

pub fn detect(path: &str) -> Result<TextDetect, String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹不是文本文件".into());
    }
    if meta.len() > 64 * 1024 * 1024 {
        return Err("文件超过 64MB，文本编码转换已拒绝".into());
    }
    let data = fs::read(p).map_err(|e| format!("读取文件失败：{e}"))?;
    let (encoding, confirmed, warnings) = detect_encoding(&data);
    let decoded = decode(&data, &encoding).ok();
    let chars = decoded.as_ref().map(|t| t.chars().count()).unwrap_or(0);
    let lines = decoded.as_ref().map(|t| t.lines().count()).unwrap_or(0);
    let preview = decoded
        .as_ref()
        .and_then(|t| t.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(|l| l.chars().take(80).collect::<String>())
        .unwrap_or_default();
    Ok(TextDetect {
        path: path.to_string(),
        encoding_label: label(&encoding).to_string(),
        encoding,
        confirmed,
        bytes: meta.len(),
        chars,
        lines,
        preview,
        warnings,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSaveRequest {
    pub path: String,
    /// 目标编码 id（五种之一）
    pub target_encoding: String,
    /// None / "auto" = 按探测结果；其余为手动指定源编码
    #[serde(default)]
    pub source_encoding: Option<String>,
    /// 另存为路径；None 表示原地覆盖
    #[serde(default)]
    pub save_as: Option<String>,
    #[serde(default = "default_true")]
    pub backup: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSaveResult {
    pub path: String,
    pub output_path: String,
    pub source_encoding: String,
    pub source_encoding_label: String,
    pub target_encoding: String,
    pub target_encoding_label: String,
    pub backup: Option<String>,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub chars: usize,
    pub verified: bool,
    pub ok: bool,
    pub error: Option<String>,
}

fn backup_path(path: &Path) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法取得文件名，不能生成备份".to_string())?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    for attempt in 0..50 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let candidate = dir.join(format!("{name}.{stamp}{suffix}.bak"));
        if candidate.exists() {
            continue;
        }
        fs::copy(path, &candidate)
            .map_err(|e| format!("生成备份失败（{}）：{e}", candidate.display()))?;
        return Ok(candidate);
    }
    Err("生成备份失败：同名备份过多".into())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}.renomio-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败（{}）：{e}", tmp.display()))?;
    let result = fs::rename(&tmp, path).map_err(|e| format!("替换目标文件失败：{e}"));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn save(req: &TextSaveRequest) -> TextSaveResult {
    let mut out = TextSaveResult {
        path: req.path.clone(),
        output_path: req.save_as.clone().unwrap_or_else(|| req.path.clone()),
        source_encoding: String::new(),
        source_encoding_label: String::new(),
        target_encoding: req.target_encoding.clone(),
        target_encoding_label: label(&req.target_encoding).to_string(),
        backup: None,
        bytes_before: 0,
        bytes_after: 0,
        chars: 0,
        verified: false,
        ok: false,
        error: None,
    };
    match save_inner(req, &mut out) {
        Ok(()) => out.ok = true,
        Err(err) => out.error = Some(err),
    }
    out
}

fn save_inner(req: &TextSaveRequest, out: &mut TextSaveResult) -> Result<(), String> {
    if !is_known(&req.target_encoding) {
        return Err(format!(
            "目标编码 {} 不受支持（仅支持 UTF-8 / UTF-8 with BOM / GB18030 / UTF-16 LE / UTF-16 BE）",
            req.target_encoding
        ));
    }
    let source = Path::new(&req.path);
    let meta = fs::metadata(source).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹不是文本文件".into());
    }
    if meta.len() > 64 * 1024 * 1024 {
        return Err("文件超过 64MB，文本编码转换已拒绝".into());
    }
    out.bytes_before = meta.len();

    let data = fs::read(source).map_err(|e| format!("读取文件失败：{e}"))?;
    let manual = req
        .source_encoding
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "auto");
    let (detected, confirmed, warnings) = detect_encoding(&data);
    let mut warnings = warnings;

    let encoding = match manual {
        Some(id) if is_known(id) => id.to_string(),
        Some(other) => return Err(format!("源编码 {other} 不受支持")),
        None => {
            if detected == "unknown" {
                return Err("源编码未识别，需手动指定源编码".into());
            }
            detected.clone()
        }
    };
    if manual.is_none() && !confirmed {
        warnings.push("源编码由自动试探得出，未获人工确认".into());
    }

    let text = decode(&data, &encoding).map_err(|e| format!("按 {} 解码失败：{e}", label(&encoding)))?;
    out.source_encoding = encoding.clone();
    out.source_encoding_label = label(&encoding).to_string();
    out.chars = text.chars().count();

    let encoded = encode(&text, &req.target_encoding)?;
    out.bytes_after = encoded.len() as u64;

    if req.backup && req.save_as.is_none() {
        out.backup = Some(
            backup_path(source)
                .map_err(|e| format!("{e}；已中止，未改动文件"))?
                .to_string_lossy()
                .to_string(),
        );
    }

    let target = req
        .save_as
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| source.to_path_buf());
    if req.save_as.is_some() && target.exists() {
        return Err(format!(
            "另存为目标已存在，已拒绝覆盖：{}",
            target.display()
        ));
    }
    write_atomic(&target, &encoded)?;

    // 回读校验：按目标编码重新解码，逐字符比较；BOM 必须存在（utf8bom/utf16）
    let written = fs::read(&target).map_err(|e| format!("回读文件失败：{e}"))?;
    let back = decode(&written, &req.target_encoding)
        .map_err(|e| format!("写入后回读解码失败（已保留备份）：{e}"))?;
    if back != text {
        return Err("写入后回读内容与原内容不一致（已保留备份，可恢复）".into());
    }
    match req.target_encoding.as_str() {
        UTF8BOM if !written.starts_with(&[0xEF, 0xBB, 0xBF]) => {
            return Err("写入后回读未发现 UTF-8 BOM（已保留备份）".into())
        }
        UTF16LE if !written.starts_with(&[0xFF, 0xFE]) => {
            return Err("写入后回读未发现 UTF-16 LE BOM（已保留备份）".into())
        }
        UTF16BE if !written.starts_with(&[0xFE, 0xFF]) => {
            return Err("写入后回读未发现 UTF-16 BE BOM（已保留备份）".into())
        }
        _ => {}
    }
    out.verified = true;
    out.output_path = target.to_string_lossy().to_string();
    let _ = warnings;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, bytes: &[u8]) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("renomio-text-{stamp}-{name}"));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn detects_and_roundtrips_all_five() {
        let text = "第一行\n第二行 abc\n";
        for enc in [UTF8, UTF8BOM, GB18030, UTF16LE, UTF16BE] {
            // GB18030 依赖 Windows 系统代码页 54936；非 Windows 必须明确报「不支持」，
            // 不得静默降级，也不跳过该编码的检查
            let bytes = match encode(text, enc) {
                Ok(bytes) => bytes,
                Err(err) if enc == GB18030 && cfg!(not(windows)) => {
                    assert!(
                        err.contains("仅支持在 Windows"),
                        "GB18030 在非 Windows 上应明确报不支持，实际：{err}"
                    );
                    continue;
                }
                Err(err) => panic!("{enc} 编码失败：{err}"),
            };
            let path = temp(&format!("{enc}.txt"), &bytes);
            let d = detect(path.to_str().unwrap()).unwrap();
            assert_eq!(d.encoding, enc, "{enc} 探测失败：{}", d.encoding_label);
            assert!(d.confirmed || enc == GB18030);

            let target = path.with_file_name(format!("{enc}-out.txt"));
            let req = TextSaveRequest {
                path: path.to_string_lossy().to_string(),
                target_encoding: UTF8.to_string(),
                source_encoding: Some(enc.to_string()),
                save_as: Some(target.to_string_lossy().to_string()),
                backup: false,
            };
            let res = save(&req);
            assert!(res.ok, "{enc} 转换失败：{:?}", res.error);
            assert!(res.verified);
            assert_eq!(fs::read_to_string(&target).unwrap(), text);
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&target);
        }
    }

    #[test]
    fn non_utf8_is_not_silently_utf8() {
        // GBK「中文」在 UTF-8 下非法：Windows 可按 GB18030 试探解码并标记未确认，
        // 非 Windows 无该代码页，必须报「未识别」，两者都不做静默 UTF-8 猜测
        let path = temp("gbk.txt", &[0xD6, 0xBA, 0xB0, 0xCF]);
        let d = detect(path.to_str().unwrap()).unwrap();
        if cfg!(windows) {
            assert_eq!(d.encoding, GB18030);
            assert!(!d.confirmed);
            assert!(d.warnings.iter().any(|w| w.contains("手动")));
        } else {
            // 非 Windows 无系统 GB18030 代码页：不得静默当成 UTF-8，必须报「未识别」
            assert_eq!(d.encoding, "unknown");
            assert!(!d.confirmed);
            assert!(d.warnings.iter().any(|w| w.contains("手动指定源编码")));
            let decode_err = gb18030_to_string(&[0xD6, 0xBA, 0xB0, 0xCF]).unwrap_err();
            assert!(
                decode_err.contains("仅支持在 Windows"),
                "非 Windows 解码应明确报不支持，实际：{decode_err}"
            );
            let encode_err = string_to_gb18030("中文").unwrap_err();
            assert!(
                encode_err.contains("仅支持在 Windows"),
                "非 Windows 编码应明确报不支持，实际：{encode_err}"
            );
        }
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn in_place_creates_bak_and_verifies() {
        let path = temp("inplace.txt", "内容".as_bytes());
        let req = TextSaveRequest {
            path: path.to_string_lossy().to_string(),
            target_encoding: UTF16LE.to_string(),
            source_encoding: Some(UTF8.to_string()),
            save_as: None,
            backup: true,
        };
        let res = save(&req);
        assert!(res.ok, "{:?}", res.error);
        let backup = res.backup.expect("必须生成 .bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "内容");
        assert!(fs::read(&path).unwrap().starts_with(&[0xFF, 0xFE]));
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&backup);
    }
}
