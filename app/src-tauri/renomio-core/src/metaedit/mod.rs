//! 元数据写入框架：格式识别、字段白名单、备份、原子替换、回读校验与逐文件结果。
//! 设计原则：
//! 1. 只写用户显式勾选的字段（`fields` 里没有的键一律不动），空字符串表示清空；
//! 2. 写前必定生成独立备份文件（可一键还原），写失败不留下半成品；
//! 3. 不认识的容器如实返回「不支持」，绝不静默跳过；
//! 4. 写完立即回读校验，回读不一致即视为失败并保留备份。

pub mod audio;
pub mod dedupe;
pub mod doc;
pub mod image;
pub mod util;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub type FieldMap = BTreeMap<String, String>;

/// 图片可写字段（JPEG/PNG/WebP/TIFF）
pub const IMAGE_FIELDS: &[&str] = &[
    "title",
    "description",
    "keywords",
    "author",
    "copyright",
    "software",
    "takenAt",
];
/// 音频可写字段（MP3/FLAC/M4A/OGG）
pub const AUDIO_FIELDS: &[&str] = &[
    "title",
    "artist",
    "album",
    "year",
    "track",
    "genre",
    "comment",
    "albumArtist",
    "lyrics",
    "cover",
];
/// 文档可写字段（DOCX/XLSX/PPTX/PDF）
pub const DOC_FIELDS: &[&str] = &[
    "title",
    "subject",
    "author",
    "lastModifiedBy",
    "keywords",
    "comment",
    "category",
];

/// 写入大小上限（整个文件读入内存）；超过则明确拒绝，避免拖垮进程。
const MAX_WRITE_BYTES: u64 = 512 * 1024 * 1024;
/// 封面图片上限
const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Image,
    Audio,
    Document,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Image => "image",
            Kind::Audio => "audio",
            Kind::Document => "document",
        }
    }

    pub fn fields(self) -> &'static [&'static str] {
        match self {
            Kind::Image => IMAGE_FIELDS,
            Kind::Audio => AUDIO_FIELDS,
            Kind::Document => DOC_FIELDS,
        }
    }
}

/// 识别出的格式；`Unsupported` 带上具体原因，直接回传给界面。
#[derive(Clone, Debug)]
pub enum Format {
    Image(image::ImageFormat),
    Audio(audio::AudioFormat),
    Doc(doc::DocFormat),
    Unsupported { kind: &'static str, name: String, reason: String },
}

impl Format {
    pub fn name(&self) -> String {
        match self {
            Format::Image(f) => f.name().to_string(),
            Format::Audio(f) => f.name().to_string(),
            Format::Doc(f) => f.name().to_string(),
            Format::Unsupported { name, .. } => name.clone(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Format::Image(_) => "image",
            Format::Audio(_) => "audio",
            Format::Doc(_) => "document",
            Format::Unsupported { kind, .. } => kind,
        }
    }

    pub fn writable(&self) -> bool {
        !matches!(self, Format::Unsupported { .. })
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverInfo {
    pub present: bool,
    pub mime: String,
    pub bytes: u64,
    /// 图片像素尺寸（能解析时给出，解析不到为 0）
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSnapshot {
    pub path: String,
    pub kind: String,
    pub format: String,
    pub writable: bool,
    pub supported_fields: Vec<String>,
    pub fields: FieldMap,
    pub cover: Option<CoverInfo>,
    pub warnings: Vec<String>,
    /// 不支持时的具体原因（例如 HEIC / WMA / 旧版 OLE）
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaEditRequest {
    pub path: String,
    #[serde(default)]
    pub fields: FieldMap,
    /// 封面替换：本地图片路径（仅音频；JPEG/PNG，≤ 5 MB）
    #[serde(default)]
    pub cover_path: Option<String>,
    /// 移除现有封面
    #[serde(default)]
    pub clear_cover: bool,
    #[serde(default = "default_true")]
    pub backup: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaEditResult {
    pub path: String,
    pub kind: String,
    pub format: String,
    pub supported: bool,
    pub ok: bool,
    pub backup: Option<String>,
    pub written: Vec<String>,
    pub cleared: Vec<String>,
    pub ignored: Vec<String>,
    pub verified: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaCapability {
    pub kind: String,
    pub format: String,
    pub read: bool,
    pub write: bool,
    pub fields: Vec<String>,
    pub notes: String,
}

pub struct CoverData {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// 各格式支持矩阵：界面「支持格式」说明与拒绝路径都以这里为准。
pub fn capabilities() -> Vec<MetaCapability> {
    let f = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut out = Vec::new();
    for (format, notes) in [
        ("JPEG", "XMP + EXIF 文本字段；相机参数/GPS/ICC 原样保留"),
        ("PNG", "XMP（iTXt XML:com.adobe.xmp）；其余块原样保留"),
        ("WebP", "XMP 块；无 VP8X 时自动补建（不重编码像素）"),
        ("TIFF", "IFD0 文本字段 + XMP 标签 700；BigTIFF 不支持"),
    ] {
        out.push(MetaCapability {
            kind: "image".into(),
            format: format.into(),
            read: true,
            write: true,
            fields: f(IMAGE_FIELDS),
            notes: notes.into(),
        });
    }
    for (format, notes) in [
        ("HEIC/HEIF", "本版本不支持写入（也不解析内部元数据），不做假支持"),
        ("GIF", "仅支持读取基础信息，不支持写入"),
        ("BMP", "仅支持读取基础信息，不支持写入"),
        ("AVIF", "不支持写入"),
    ] {
        out.push(MetaCapability {
            kind: "image".into(),
            format: format.into(),
            read: false,
            write: false,
            fields: vec![],
            notes: notes.into(),
        });
    }
    for (format, notes) in [
        ("MP3 (ID3v2.3)", "UTF-16 编码写入；保留其它帧与 ID3v1"),
        ("MP3 (ID3v2.4)", "UTF-8 编码写入；保留其它帧"),
        ("FLAC", "Vorbis comment；保留音频帧与 PICTURE"),
        ("M4A/MP4", "iTunes ilst atoms；保留 moov 其它 atom"),
        ("OGG (Vorbis)", "Vorbis comment；重建头部页并重排页序号，补 framing bit"),
        ("Opus (Ogg)", "OpusTags 注释包；重建头部页并重排页序号（Opus 无 framing bit）"),
    ] {
        out.push(MetaCapability {
            kind: "audio".into(),
            format: format.into(),
            read: true,
            write: true,
            fields: f(AUDIO_FIELDS),
            notes: notes.into(),
        });
    }
    for (format, notes) in [
        ("WMA (ASF)", "不支持：ASF 容器需要另行解析，本版本如实拒绝"),
        ("APE", "不支持：Monkey's Audio 标签本版本未实现"),
        ("AIFF", "不支持写入"),
        ("WAV", "不支持写入（RIFF INFO 未实现）"),
    ] {
        out.push(MetaCapability {
            kind: "audio".into(),
            format: format.into(),
            read: false,
            write: false,
            fields: vec![],
            notes: notes.into(),
        });
    }
    for (format, notes) in [
        ("DOCX", "docProps/core.xml；改完 zip 结构与 CRC 重新校验"),
        ("XLSX", "docProps/core.xml；不触碰工作表内容"),
        ("PPTX", "docProps/core.xml；不触碰幻灯片内容"),
        ("PDF", "增量更新 Info 字典 + XMP；原页面对象逐字节保留"),
    ] {
        out.push(MetaCapability {
            kind: "document".into(),
            format: format.into(),
            read: true,
            write: true,
            fields: f(DOC_FIELDS),
            notes: notes.into(),
        });
    }
    for (format, notes) in [
        ("DOC/XLS/PPT (OLE)", "旧版二进制 Office 不支持写入"),
        ("ODT/ODS/ODP", "OpenDocument 不支持写入"),
    ] {
        out.push(MetaCapability {
            kind: "document".into(),
            format: format.into(),
            read: false,
            write: false,
            fields: vec![],
            notes: notes.into(),
        });
    }
    out
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 格式识别：优先看魔数，扩展名只用于区分 OOXML 子类型。
pub fn detect(path: &Path, head: &[u8]) -> Format {
    let ext = ext_of(path);
    let unsupported = |kind: &'static str, name: &str, reason: &str| Format::Unsupported {
        kind,
        name: name.to_string(),
        reason: reason.to_string(),
    };

    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Format::Image(image::ImageFormat::Jpeg);
    }
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Format::Image(image::ImageFormat::Png);
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP".as_ref()) {
        return Format::Image(image::ImageFormat::WebP);
    }
    if head.starts_with(&[0x49, 0x49, 0x2A, 0x00]) || head.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
        return Format::Image(image::ImageFormat::Tiff);
    }
    if head.starts_with(&[0x49, 0x49, 0x2B, 0x00]) || head.starts_with(&[0x4D, 0x4D, 0x00, 0x2B]) {
        return unsupported("image", "BigTIFF", "BigTIFF 变体本版本不支持写入（会破坏偏移表）");
    }
    if head.starts_with(b"GIF8") {
        return unsupported("image", "GIF", "GIF 无标准 XMP 容器，本版本只读基础信息，不支持写入");
    }
    if head.starts_with(b"BM") {
        return unsupported("image", "BMP", "BMP 无标准元数据容器，本版本不支持写入");
    }
    if head.len() >= 12 && head.get(4..8) == Some(b"ftyp".as_ref()) {
        let brand = String::from_utf8_lossy(head.get(8..12).unwrap_or(b"????"));
        let brand = brand.trim().to_ascii_lowercase();
        if ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].contains(&brand.as_str()) {
            return unsupported(
                "image",
                "HEIC/HEIF",
                "HEIC 需要 HEVC 解码与专用容器写入库，本版本明确不支持（不假装能读写）",
            );
        }
        if brand == "avif" || brand == "avis" {
            return unsupported("image", "AVIF", "AVIF 本版本不支持写入");
        }
        if ["m4a", "mp42", "mp41", "isom", "iso2", "dash", "M4A "].contains(&brand.as_str()) {
            return Format::Audio(audio::AudioFormat::Mp4);
        }
        return unsupported("other", "MP4 视频", "本版本只处理 M4A/MP4 音频标签，视频容器不支持");
    }
    if head.starts_with(b"ID3") || looks_like_mpeg(head) {
        return Format::Audio(audio::AudioFormat::Mp3);
    }
    if head.starts_with(b"fLaC") {
        return Format::Audio(audio::AudioFormat::Flac);
    }
    if head.starts_with(b"OggS") {
        return Format::Audio(audio::AudioFormat::Ogg);
    }
    if head.starts_with(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) {
        return unsupported("audio", "WMA (ASF)", "WMA/ASF 容器本版本不支持，未做静默跳过");
    }
    if head.starts_with(b"MAC ") || head.starts_with(b"MP+") {
        return unsupported("audio", "APE", "Monkey's Audio 标签本版本不支持");
    }
    if head.starts_with(b"FORM") && head.get(8..12) == Some(b"AIFF".as_ref()) {
        return unsupported("audio", "AIFF", "AIFF 标签本版本不支持写入");
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE".as_ref()) {
        return unsupported("audio", "WAV", "WAV 的 RIFF INFO 标签本版本不支持写入");
    }
    if head.starts_with(b"%PDF") {
        return Format::Doc(doc::DocFormat::Pdf);
    }
    if head.starts_with(b"PK\x03\x04") {
        return match ext.as_str() {
            "docx" | "docm" => Format::Doc(doc::DocFormat::Docx),
            "xlsx" | "xlsm" => Format::Doc(doc::DocFormat::Xlsx),
            "pptx" | "pptm" => Format::Doc(doc::DocFormat::Pptx),
            _ => unsupported("document", "ZIP/OOXML", "无法从扩展名判断 OOXML 子类型（需 .docx/.xlsx/.pptx）"),
        };
    }
    if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return unsupported("document", "DOC/XLS/PPT (OLE)", "旧版二进制 Office 格式不支持写入");
    }
    unsupported("other", "未识别格式", "没有匹配的元数据写入器")
}

fn looks_like_mpeg(head: &[u8]) -> bool {
    head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0
}

/// 读取快照：用于编辑对话框预填与写后校验。
pub fn snapshot(path: &str) -> Result<MetaSnapshot, String> {
    let p = Path::new(path);
    let head = util::read_head(p, 64 * 1024)?;
    let format = detect(p, &head);
    let name = format.name();
    let kind = format.kind();
    let writable = format.writable();
    let unsupported_reason = match &format {
        Format::Unsupported { reason, .. } => Some(reason.clone()),
        _ => None,
    };
    let mut snap = MetaSnapshot {
        path: path.to_string(),
        kind: kind.to_string(),
        format: name,
        writable,
        supported_fields: if writable {
            kind_fields(kind).iter().map(|s| s.to_string()).collect()
        } else {
            Vec::new()
        },
        fields: BTreeMap::new(),
        cover: None,
        warnings: Vec::new(),
        unsupported_reason,
    };
    match format {
        Format::Image(f) => image::read_into(p, f, &mut snap.fields, &mut snap.warnings)?,
        Format::Audio(f) => audio::read_into(p, f, &mut snap.fields, &mut snap.cover, &mut snap.warnings)?,
        Format::Doc(f) => doc::read_into(p, f, &mut snap.fields, &mut snap.warnings)?,
        Format::Unsupported { .. } => {}
    }
    Ok(snap)
}

fn kind_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "image" => IMAGE_FIELDS,
        "audio" => AUDIO_FIELDS,
        "document" => DOC_FIELDS,
        _ => &[],
    }
}

/// 字段值规范化：保证写入与回读比较使用同一口径。
pub fn normalize_field(id: &str, raw: &str) -> String {
    match id {
        "takenAt" => util::to_exif_time(raw)
            .and_then(|v| util::exif_time_to_iso(&v))
            .unwrap_or_default(),
        "keywords" => util::join_keywords(&util::split_keywords(raw)),
        _ => raw.trim().to_string(),
    }
}

struct Rewrite {
    bytes: Vec<u8>,
    written: Vec<String>,
    cleared: Vec<String>,
    warnings: Vec<String>,
}

/// 生成备份：同目录 `原文件名.<时间戳>.bak`，不覆盖已有备份。
pub fn create_backup(path: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
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
        fs::copy(path, &candidate).map_err(|e| format!("生成备份失败（{}）：{e}", candidate.display()))?;
        return Ok(candidate);
    }
    Err("生成备份失败：同名备份过多".into())
}

/// 原子替换：先写同目录临时文件，再 rename 覆盖；失败时原文件保持不变。
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            return Err("文件为只读，无法写入（请先取消只读属性）".into());
        }
    }
    let tmp = path.with_extension(format!(
        "{}.renomio-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败（{}）：{e}", tmp.display()))?;
    let result = fs::rename(&tmp, path).map_err(|e| format!("替换原文件失败：{e}"));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn cover_data(req: &MetaEditRequest) -> Result<Option<CoverData>, String> {
    let Some(cover_path) = &req.cover_path else {
        return Ok(None);
    };
    let p = Path::new(cover_path);
    let meta = fs::metadata(p).map_err(|e| format!("无法读取封面文件信息：{e}"))?;
    if meta.len() > MAX_COVER_BYTES {
        return Err(format!(
            "封面文件 {} 为 {}，超过 5 MB 上限",
            p.display(),
            meta.len()
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("读取封面文件失败：{e}"))?;
    let mime = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        return Err("封面仅支持 JPEG 或 PNG（按文件头识别）".into());
    };
    if bytes.len() > MAX_COVER_BYTES as usize {
        return Err("封面超过 5 MB 上限".into());
    }
    Ok(Some(CoverData { bytes, mime }))
}

/// 单文件编辑：备份 → 改写 → 原子替换 → 回读校验，全程逐文件给出结果。
pub fn edit(req: &MetaEditRequest) -> MetaEditResult {
    let started = Instant::now();
    let path = PathBuf::from(&req.path);
    let mut result = MetaEditResult {
        path: req.path.clone(),
        kind: String::new(),
        format: String::new(),
        supported: true,
        ok: false,
        backup: None,
        written: Vec::new(),
        cleared: Vec::new(),
        ignored: Vec::new(),
        verified: false,
        error: None,
        warnings: Vec::new(),
        elapsed_ms: 0,
    };
    match edit_inner(req, &path, &mut result) {
        Ok(()) => {
            result.ok = true;
        }
        Err(err) => {
            result.error = Some(err);
        }
    }
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    result
}

fn edit_inner(req: &MetaEditRequest, path: &Path, out: &mut MetaEditResult) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹没有可写的文件元数据".into());
    }
    if meta.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "文件 {} 字节，超过 {} 的写入上限；为避免损伤大文件，本版本拒绝写入",
            meta.len(),
            MAX_WRITE_BYTES
        ));
    }
    let head = util::read_head(path, 64 * 1024)?;
    let format = detect(path, &head);
    out.format = format.name();
    out.kind = format.kind().to_string();

    if let Format::Unsupported { reason, .. } = &format {
        out.supported = false;
        return Err(format!("{} 不支持写入：{reason}", out.format));
    }

    let allowed = format.kind_fields();
    // 未知/不适用字段直接拒绝整文件，避免“部分成功但界面说全成功”
    for id in req.fields.keys() {
        if id == "cover" {
            if format.kind() != "audio" {
                return Err(format!("字段 cover 不适用于 {} 格式", out.format));
            }
            continue;
        }
        if !allowed.contains(&id.as_str()) {
            return Err(format!(
                "字段 {id} 不适用于 {} 格式（可用：{}）",
                out.format,
                allowed.join(", ")
            ));
        }
    }
    out.supported = true;

    let cover = cover_data(req)?;
    let data = fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
    let mut fields: FieldMap = req
        .fields
        .iter()
        .filter(|(k, _)| k.as_str() != "cover")
        .map(|(k, v)| (k.clone(), normalize_field(k, v)))
        .collect();
    if req.clear_cover || cover.is_some() {
        fields.insert("cover".into(), String::new());
    }

    let rewritten = match &format {
        Format::Image(f) => image::rewrite(*f, &data, &fields)?,
        Format::Audio(f) => audio::rewrite(*f, &data, &fields, cover.as_ref(), req.clear_cover)?,
        Format::Doc(f) => doc::rewrite(*f, &data, &fields)?,
        Format::Unsupported { .. } => unreachable!(),
    };

    // 封面写入成功与否以音频模块的返回为准
    if format.kind() == "audio" {
        if cover.is_some() {
            if rewritten.written.iter().any(|f| f == "cover") {
                out.warnings.push("封面已替换（不缩放：建议源图 ≤ 1024×1024）".into());
            }
        }
    }

    if rewritten.bytes == data {
        out.warnings.push("内容与写入前一致，未做改动".into());
    }

    if req.backup {
        let backup = create_backup(path)?;
        out.backup = Some(backup.to_string_lossy().to_string());
    }
    replace_file(path, &rewritten.bytes)?;
    out.written = rewritten.written.clone();
    out.cleared = rewritten.cleared.clone();
    out.warnings.extend(rewritten.warnings.clone());

    // 回读校验：只核对本次写入/清空的字段
    let after = snapshot(&req.path)?;
    let mut mismatches = Vec::new();
    for id in &rewritten.written {
        let expected = fields.get(id).cloned().unwrap_or_default();
        let actual = after.fields.get(id).cloned().unwrap_or_default();
        if expected != actual {
            mismatches.push(format!("{id} 期望「{expected}」实际「{actual}」"));
        }
    }
    for id in &rewritten.cleared {
        let actual = after.fields.get(id).cloned().unwrap_or_default();
        if !actual.is_empty() {
            mismatches.push(format!("{id} 期望已清空，实际仍为「{actual}」"));
        }
    }
    if !mismatches.is_empty() {
        out.verified = false;
        return Err(format!(
            "写入后回读不一致（已保留备份，可一键还原）：{}",
            mismatches.join("；")
        ));
    }
    out.verified = true;
    Ok(())
}

/// 批量编辑：逐文件独立结果，单个失败不影响其它文件。
pub fn edit_batch(requests: Vec<MetaEditRequest>) -> Vec<MetaEditResult> {
    requests.iter().map(edit).collect()
}

/// 从备份还原目标文件（覆盖前再做一次独立备份，避免还原本身破坏当前文件）。
pub fn restore_backup(backup: &str, target: &str) -> Result<String, String> {
    let b = Path::new(backup);
    let t = Path::new(target);
    if !b.exists() {
        return Err(format!("备份文件不存在：{backup}"));
    }
    if !t.exists() {
        return Err(format!("目标文件不存在：{target}"));
    }
    let safety = create_backup(t)?;
    fs::copy(b, t).map_err(|e| format!("还原失败：{e}"))?;
    Ok(safety.to_string_lossy().to_string())
}

impl Format {
    fn kind_fields(&self) -> &'static [&'static str] {
        match self {
            Format::Image(_) => IMAGE_FIELDS,
            Format::Audio(_) => AUDIO_FIELDS,
            Format::Doc(_) => DOC_FIELDS,
            Format::Unsupported { .. } => &[],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-metaedit-{stamp}-{name}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detect_and_reject_unsupported() {
        let dir = temp_dir("detect");
        let heic = dir.join("a.heic");
        let mut bytes = vec![0u8; 16];
        bytes[4..8].copy_from_slice(b"ftyp");
        bytes[8..12].copy_from_slice(b"heic");
        fs::write(&heic, &bytes).unwrap();
        let snap = snapshot(heic.to_str().unwrap()).unwrap();
        assert!(!snap.writable);
        assert_eq!(snap.kind, "image");
        assert!(snap.unsupported_reason.unwrap().contains("HEIC"));

        let res = edit(&MetaEditRequest {
            path: heic.to_string_lossy().to_string(),
            fields: BTreeMap::from([("title".to_string(), "x".to_string())]),
            cover_path: None,
            clear_cover: false,
            backup: true,
        });
        assert!(!res.ok);
        assert!(!res.supported);
        assert!(res.error.unwrap().contains("不支持"));
    }

    #[test]
    fn backup_and_replace_keeps_original_on_failure() {
        let dir = temp_dir("backup");
        let file = dir.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let backup = create_backup(&file).unwrap();
        assert!(backup.exists());
        replace_file(&file, b"world").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"world");
        assert_eq!(fs::read(&backup).unwrap(), b"hello");
        let safety = restore_backup(
            backup.to_str().unwrap(),
            file.to_str().unwrap(),
        )
        .unwrap();
        assert!(Path::new(&safety).exists());
        assert_eq!(fs::read(&file).unwrap(), b"hello");
    }

    #[test]
    fn normalize_fields() {
        assert_eq!(normalize_field("takenAt", "2024-05-01T08:30:00"), "2024-05-01T08:30:00");
        assert_eq!(normalize_field("keywords", "a, b；c"), "a; b; c");
        assert_eq!(normalize_field("title", "  x  "), "x");
    }
}
