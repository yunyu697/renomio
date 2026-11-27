//! 只读元数据读取：图片尺寸 / EXIF 摘要、音乐 ID3 关键字段、PDF / DOCX 文档属性。
//! 本模块不写任何文件，也不修改任何元数据。解析失败时返回警告而不是报错，
//! 让界面可以展示“已读取的基础信息 + 为什么没有更多”。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 最多读取 8MB 用于头部/尾部解析，避免把超大媒体文件整体读入内存。
const MAX_PARSE_BYTES: u64 = 8 * 1024 * 1024;

/// 文件超过头部上限时，再读一段尾部（标签常写在文件末尾：WAV 的 LIST/INFO、APEv2 footer）。
const TAIL_PARSE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataField {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInfo {
    /// image / audio / document / other
    pub kind: String,
    pub format: String,
    /// 恒为 true：本应用只读取元数据，不提供写入能力
    pub read_only: bool,
    pub fields: Vec<MetadataField>,
    pub warnings: Vec<String>,
}

impl MetadataInfo {
    fn new(kind: &str, format: &str) -> Self {
        Self {
            kind: kind.to_string(),
            format: format.to_string(),
            read_only: true,
            fields: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn push(&mut self, label: &str, value: String) {
        let value = value.trim().to_string();
        if value.is_empty() {
            return;
        }
        if self.fields.iter().any(|f| f.label == label) {
            return;
        }
        self.fields.push(MetadataField {
            label: label.to_string(),
            value,
        });
    }

    fn warn(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        if !self.warnings.iter().any(|w| w == &msg) {
            self.warnings.push(msg);
        }
    }
}

/// 供「按元数据取名」与「编号分组」共用的只读取值集合。
/// 全部字段都是**文件名安全**的：非法字符换成 `-`，两端空白去掉，缺失为空串。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFieldValues {
    pub taken: String,
    pub camera: String,
    pub iso: String,
    pub aperture: String,
    pub shutter: String,
    pub focal: String,
    pub lens: String,
    pub width: String,
    pub height: String,
    pub resolution: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track: String,
    pub year: String,
    pub genre: String,
    pub composer: String,
    pub font_family: String,
    pub font_style: String,
    pub font_version: String,
    pub file_version: String,
}

/// Windows / macOS / Linux 都拒绝的字符一律换成 `-`（`/` 在文件名里等同于路径分隔符）。
fn name_safe(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.trim().chars() {
        let bad = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control();
        if bad {
            if !last_dash {
                out.push('-');
            }
            last_dash = true;
        } else {
            out.push(ch);
            last_dash = false;
        }
    }
    out.trim_matches('-').trim().to_string()
}

/// 从 `read_metadata` 的字段里取某个标签（按候选顺序，先命中先用）。
fn field_of(info: &MetadataInfo, labels: &[&str]) -> String {
    labels
        .iter()
        .find_map(|label| {
            info.fields
                .iter()
                .find(|f| f.label == *label)
                .map(|f| f.value.clone())
        })
        .unwrap_or_default()
}

/// 「曝光时间 1/250 秒」→ `1-250`；「2 秒」→ `2`。去掉单位与空格。
fn shutter_token(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches("秒").trim();
    let token = trimmed.split_whitespace().next().unwrap_or("");
    name_safe(token)
}

/// `2.80` → `2.8`、`50.00` → `50`：元数据里 rational 固定两位小数，拼进文件名前收掉多余的 0。
fn tidy_number(raw: &str) -> String {
    let s = raw.trim();
    if !s.contains('.') {
        return s.to_string();
    }
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() { "0".to_string() } else { trimmed.to_string() }
}

/// 「f/2.8」→ `2.8`；「f/16」→ `16`。
fn aperture_token(raw: &str) -> String {
    let trimmed = raw.trim();
    let token = trimmed
        .strip_prefix('f')
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or(trimmed);
    name_safe(&tidy_number(token))
}

/// 「50 mm」→ `50mm`；「50」→ `50mm`（统一带单位，便于拼文件名）。
fn focal_token(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches("mm").trim();
    let token = trimmed.split_whitespace().next().unwrap_or("");
    let token = name_safe(&tidy_number(token));
    if token.is_empty() {
        String::new()
    } else {
        format!("{token}mm")
    }
}

/// 没有 EXIF 像素宽/高时（PNG / BMP / WebP / TIFF），从「尺寸」字段 `640 × 480 px` 拆出宽高。
fn dims_from_size(info: &MetadataInfo) -> (String, String) {
    let size = field_of(info, &["尺寸"]);
    match size.split_once('×') {
        Some((w, h)) => (size_part(w), size_part(h)),
        None => (String::new(), String::new()),
    }
}

/// `640 ` → `640`：只保留数字，去掉单位与空格。
fn size_part(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        String::new()
    } else {
        name_safe(&digits)
    }
}

pub fn rename_field_values(info: &MetadataInfo) -> RenameFieldValues {
    let (fallback_w, fallback_h) = dims_from_size(info);
    let width = {
        let w = name_safe(&field_of(info, &["像素宽"]));
        if w.is_empty() { fallback_w } else { w }
    };
    let height = {
        let h = name_safe(&field_of(info, &["像素高"]));
        if h.is_empty() { fallback_h } else { h }
    };
    let resolution = if width.is_empty() || height.is_empty() {
        String::new()
    } else {
        format!("{width}x{height}")
    };
    RenameFieldValues {
        taken: name_safe(&field_of(info, &["拍摄时间"]).replace(':', "-")),
        camera: name_safe(&field_of(info, &["相机型号", "相机品牌"])),
        iso: name_safe(&field_of(info, &["ISO"])),
        aperture: aperture_token(&field_of(info, &["光圈"])),
        shutter: shutter_token(&field_of(info, &["曝光时间"])),
        focal: focal_token(&field_of(info, &["焦距"])),
        lens: name_safe(&field_of(info, &["镜头"])),
        width,
        height,
        resolution,
        title: name_safe(&field_of(info, &["标题"])),
        artist: name_safe(&field_of(info, &["艺术家"])),
        album: name_safe(&field_of(info, &["专辑"])),
        track: name_safe(&field_of(info, &["音轨"])),
        year: name_safe(&field_of(info, &["年份"])),
        genre: name_safe(&field_of(info, &["流派"])),
        composer: name_safe(&field_of(info, &["作曲"])),
        font_family: name_safe(&field_of(info, &["字体名"])),
        font_style: name_safe(&field_of(info, &["字形"])),
        font_version: name_safe(&font_version_token(&field_of(info, &["字体版本"]))),
        file_version: name_safe(&field_of(info, &["文件版本"])),
    }
}

/// 「Version 1.02」→ `1.02`、「1.000;hotconv` → `1.000`：版本串里常带生成器尾巴，
/// 拼文件名只需要版本号本身。
fn font_version_token(raw: &str) -> String {
    let trimmed = raw.trim();
    let rest = trimmed
        .strip_prefix("Version ")
        .or_else(|| trimmed.strip_prefix("version "))
        .unwrap_or(trimmed);
    rest.split([';', ',', '(']).next().unwrap_or(rest).trim().to_string()
}

pub fn read_metadata(path: &str) -> Result<MetadataInfo, String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.is_dir() {
        return Err("文件夹没有可读取的文件元数据".into());
    }
    let mut data = Vec::new();
    let mut tail = Vec::new();
    {
        let mut file = fs::File::open(p).map_err(|e| format!("无法打开文件：{e}"))?;
        file.by_ref()
            .take(MAX_PARSE_BYTES)
            .read_to_end(&mut data)
            .map_err(|e| format!("读取文件失败：{e}"))?;
        // 只有头部被截断时才读尾部，否则尾部就是头部的后半段，重复解析没有意义
        if meta.len() > data.len() as u64 {
            let tail_len = TAIL_PARSE_BYTES.min(meta.len());
            file.seek(SeekFrom::Start(meta.len() - tail_len))
                .map_err(|e| format!("定位文件尾部失败：{e}"))?;
            file.by_ref()
                .take(tail_len)
                .read_to_end(&mut tail)
                .map_err(|e| format!("读取文件尾部失败：{e}"))?;
        }
    }

    let size = meta.len();
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let mut info = if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        image_jpeg(&data)
    } else if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        image_png(&data)
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP".as_ref()) {
        image_webp(&data)
    } else if let Some(probe) = crate::image_container::probe(&data) {
        // GIF / BMP / AVIF：容器参数（尺寸、帧数、位深、调色板、AVIF 结构）
        image_container_meta(probe)
    } else if let Some(probe) = crate::heif::probe(&data) {
        // HEIC / HEIF：ISOBMFF 里的主图参数 + Exif 项
        heif_meta(probe)
    } else if let Some(probe) = crate::audio_container::probe(&data, &tail) {
        audio_container_meta(probe)
    } else if let Some(probe) = crate::font::probe(&data) {
        // TTF / OTF / TTC：族名、字形、版本、字重、字形数与设计网格
        font_meta(probe)
    } else if let Some(probe) = crate::pe::probe(&data) {
        // EXE / DLL / SYS：PE 头 + VS_VERSIONINFO（文件版本 / 产品名 / 公司 / 版权）
        pe_meta(probe)
    } else if data.starts_with(b"ID3") || looks_like_mpeg(&data, 0) {
        audio_mp3(&data, size)
    } else if data.starts_with(b"fLaC") {
        audio_flac(&data, size)
    } else if data.starts_with(b"%PDF") {
        document_pdf(&data)
    } else if data.starts_with(b"PK\x03\x04") {
        document_docx(&data, &ext)
    } else if is_text_ext(&ext) {
        text_file(&data, &ext)
    } else if data.starts_with(b"\xD0\xCF\x11\xE0") {
        document_ole(&data)
    } else {
        MetadataInfo::new("other", "未识别的文件类型")
    };

    info.push("文件大小", format_bytes(size));
    if info.kind == "other" {
        info.warn("该类型暂无元数据解析器；不会尝试修改文件。");
    }
    Ok(info)
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut idx = 0;
    while value >= 1024.0 && idx < UNITS.len() - 1 {
        value /= 1024.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[idx])
    }
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn le_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn le_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn le_u24(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 3)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], 0]))
}

fn normalize_date(value: &str) -> String {
    // EXIF: 2020:01:02 03:04:05 → 2020-01-02 03:04:05
    if value.len() >= 10
        && value.as_bytes().get(4) == Some(&b':')
        && value.as_bytes().get(7) == Some(&b':')
    {
        let mut out = value.to_string();
        out.replace_range(7..8, "-");
        out.replace_range(4..5, "-");
        out
    } else {
        value.to_string()
    }
}

fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        rest = &rest[idx..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        let entity = &rest[..=end];
        let decoded: Option<String> = match entity {
            "&amp;" => Some("&".to_string()),
            "&lt;" => Some("<".to_string()),
            "&gt;" => Some(">".to_string()),
            "&quot;" => Some("\"".to_string()),
            "&apos;" => Some("'".to_string()),
            _ => {
                if let Some(num) = entity.strip_prefix("&#x").and_then(|e| e.strip_suffix(';')) {
                    u32::from_str_radix(num, 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                } else if let Some(num) =
                    entity.strip_prefix("&#").and_then(|e| e.strip_suffix(';'))
                {
                    num.parse::<u32>()
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(text) => out.push_str(&text),
            None => out.push_str(entity),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml_unescape(xml[start..end].trim()))
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

fn image_jpeg(data: &[u8]) -> MetadataInfo {
    let mut info = MetadataInfo::new("image", "JPEG 图像");
    let mut dims: Option<(u32, u32)> = None;
    let mut exif: Vec<MetadataField> = Vec::new();

    let mut i = 2usize;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        i += 2;
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let Some(len) = be_u16(data, i) else {
            break;
        };
        let len = len as usize;
        if len < 2 || i + len > data.len() {
            break;
        }
        let seg = &data[i + 2..i + len];
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            if seg.len() >= 5 {
                let h = u16::from_be_bytes([seg[1], seg[2]]) as u32;
                let w = u16::from_be_bytes([seg[3], seg[4]]) as u32;
                if w > 0 && h > 0 {
                    dims = Some((w, h));
                }
            }
        } else if marker == 0xE1 && seg.starts_with(b"Exif\0\0") {
            exif = exif_fields(&seg[6..]);
        }
        i += len;
    }

    if let Some((w, h)) = dims {
        info.push("尺寸", format!("{w} × {h} px"));
    } else {
        info.warn("未在 JPEG 头部找到尺寸信息");
    }
    if exif.is_empty() {
        info.warn("未发现 EXIF 信息（可能是截图、导出图或已剥离元数据）");
    }
    for field in exif {
        info.push(&field.label, field.value);
    }
    info
}

fn image_png(data: &[u8]) -> MetadataInfo {
    let mut info = MetadataInfo::new("image", "PNG 图像");
    if data.len() >= 29 && data.get(12..16) == Some(b"IHDR".as_ref()) {
        let w = be_u32(data, 16).unwrap_or(0);
        let h = be_u32(data, 20).unwrap_or(0);
        let depth = data[24];
        let color = data[25];
        let color_name = match color {
            0 => "灰度",
            2 => "RGB",
            3 => "索引色",
            4 => "灰度 + Alpha",
            6 => "RGBA",
            _ => "未知",
        };
        info.push("尺寸", format!("{w} × {h} px"));
        info.push("位深", format!("{depth} bit"));
        info.push("颜色类型", color_name.to_string());
    } else {
        info.warn("PNG IHDR 头解析失败");
    }

    let mut offset = 8usize;
    while offset + 8 <= data.len() {
        let Some(len) = be_u32(data, offset) else {
            break;
        };
        let len = len as usize;
        let kind = &data[offset + 4..offset + 8];
        let body_start = offset + 8;
        let body_end = body_start.saturating_add(len).min(data.len());
        let body = &data[body_start..body_end];
        if kind == b"tEXt" {
            if let Some(pos) = body.iter().position(|b| *b == 0) {
                let key = String::from_utf8_lossy(&body[..pos]).to_string();
                let value = String::from_utf8_lossy(&body[pos + 1..]).to_string();
                let label = match key.as_str() {
                    "Title" => "标题",
                    "Author" => "作者",
                    "Software" => "软件",
                    "Comment" | "Description" => "说明",
                    _ => continue,
                };
                info.push(label, value);
            }
        } else if kind == b"iTXt" && body.len() > 5 && body[1] == 0 {
            // keyword \0 compression(0) \0 language \0 translated \0 text
            let mut parts = body.splitn(6, |b| *b == 0);
            let key = parts
                .next()
                .map(|s| String::from_utf8_lossy(s).to_string())
                .unwrap_or_default();
            let _flag = parts.next();
            let _method = parts.next();
            let _language = parts.next();
            let _translated = parts.next();
            if let Some(text) = parts.next() {
                let label = match key.as_str() {
                    "Title" => "标题",
                    "Author" => "作者",
                    "Software" => "软件",
                    "Comment" | "Description" => "说明",
                    _ => "",
                };
                if !label.is_empty() {
                    info.push(label, String::from_utf8_lossy(text).to_string());
                }
            }
        }
        if kind == b"IEND" {
            break;
        }
        offset = body_end + 4;
    }
    info
}

/// GIF / BMP / AVIF 的容器解析结果转成属性面板字段。
fn image_container_meta(probe: crate::image_container::ImageProbe) -> MetadataInfo {
    let mut info = MetadataInfo::new("image", probe.format);
    for (label, value) in probe.fields {
        info.push(label, value);
    }
    if let Some(ms) = probe.duration_ms {
        // 不足 1 秒按秒带小数展示（GIF 的单帧延时常常只有几十毫秒，整秒会读成 0:00）
        let text = if ms < 1000 {
            let secs = format!("{:.2}", ms as f64 / 1000.0);
            let secs = secs.trim_end_matches('0').trim_end_matches('.').to_string();
            format!("{secs} 秒")
        } else {
            format_duration_ms(ms)
        };
        info.push("总时长", text);
    }
    for warning in probe.warnings {
        info.warn(warning);
    }
    info
}

/// HEIC / HEIF：容器参数 + Exif 项里的 EXIF 摘要（复用 JPEG 那套 TIFF 解析）。
fn heif_meta(probe: crate::heif::HeifProbe) -> MetadataInfo {
    let mut info = MetadataInfo::new("image", probe.format);
    for (label, value) in probe.fields {
        info.push(label, value);
    }
    if let Some(tiff) = probe.exif_tiff {
        let exif = exif_fields(&tiff);
        if exif.is_empty() {
            info.warn("Exif 项存在，但 TIFF 结构解析不出任何字段（可能是压缩或私有格式）");
        } else {
            for field in exif {
                info.push(&field.label, field.value);
            }
        }
    }
    for warning in probe.warnings {
        info.warn(warning);
    }
    info
}

fn image_webp(data: &[u8]) -> MetadataInfo {    let mut info = MetadataInfo::new("image", "WebP 图像");
    let mut dims: Option<(u32, u32)> = None;
    let mut offset = 12usize;
    while offset + 8 <= data.len() {
        let kind = &data[offset..offset + 4];
        let Some(size) = le_u32(data, offset + 4) else {
            break;
        };
        let body = offset + 8;
        match kind {
            b"VP8X" if data.len() >= body + 10 => {
                let w = le_u24(data, body + 4).map(|v| v + 1).unwrap_or(0);
                let h = le_u24(data, body + 7).map(|v| v + 1).unwrap_or(0);
                dims = Some((w, h));
            }
            b"VP8 " if data.len() >= body + 10 => {
                let w = le_u16(data, body + 6)
                    .map(|v| (v & 0x3FFF) as u32)
                    .unwrap_or(0);
                let h = le_u16(data, body + 8)
                    .map(|v| (v & 0x3FFF) as u32)
                    .unwrap_or(0);
                dims = Some((w, h));
            }
            b"VP8L" if data.len() >= body + 5 => {
                let bits = le_u32(data, body + 1).unwrap_or(0);
                let w = (bits & 0x3FFF) + 1;
                let h = ((bits >> 14) & 0x3FFF) + 1;
                dims = Some((w, h));
            }
            _ => {}
        }
        offset = body + size as usize + (size as usize & 1);
    }
    match dims {
        Some((w, h)) if w > 0 && h > 0 => info.push("尺寸", format!("{w} × {h} px")),
        _ => info.warn("WebP 尺寸解析失败（可能是少见的编码变体）"),
    }
    info
}

// --------------------------- EXIF（手写 TIFF IFD 解析） ---------------------------

struct ExifEntry {
    tag: u16,
    kind: u16,
    count: u32,
    value_off: u32,
}

fn exif_fields(tiff: &[u8]) -> Vec<MetadataField> {
    if tiff.len() < 8 {
        return Vec::new();
    }
    let little = match &tiff[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return Vec::new(),
    };
    let read_u16 = |off: usize| -> Option<u16> {
        let s = tiff.get(off..off + 2)?;
        Some(if little {
            u16::from_le_bytes([s[0], s[1]])
        } else {
            u16::from_be_bytes([s[0], s[1]])
        })
    };
    let read_u32 = |off: usize| -> Option<u32> {
        let s = tiff.get(off..off + 4)?;
        Some(if little {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        })
    };
    if read_u16(2) != Some(42) {
        return Vec::new();
    }
    let Some(ifd0) = read_u32(4) else {
        return Vec::new();
    };

    let mut fields: Vec<MetadataField> = Vec::new();
    let mut push = |label: &str, value: String| {
        let value = value.trim().trim_matches('\0').trim().to_string();
        if value.is_empty() || fields.iter().any(|f| f.label == label) {
            return;
        }
        fields.push(MetadataField {
            label: label.to_string(),
            value,
        });
    };

    let read_ifd = |offset: u32| -> Vec<ExifEntry> {
        let mut out = Vec::new();
        let Some(count) = read_u16(offset as usize) else {
            return out;
        };
        for idx in 0..count as usize {
            let base = offset as usize + 2 + idx * 12;
            let (Some(tag), Some(kind), Some(cnt), Some(val)) = (
                read_u16(base),
                read_u16(base + 2),
                read_u32(base + 4),
                read_u32(base + 8),
            ) else {
                break;
            };
            out.push(ExifEntry {
                tag,
                kind,
                count: cnt,
                value_off: val,
            });
        }
        out
    };

    // 内联值需要用 entry 的原始 field 偏移，简化：只解析 ASCII / SHORT 偏移值。
    // 绝大多数相机写入的 Make/Model/DateTime 都是 ASCII 且长度 > 4。
    let entry_string = |entry: &ExifEntry| -> Option<String> {
        if entry.kind != 2 && entry.kind != 7 && entry.kind != 1 {
            return None;
        }
        let total = entry.count as usize;
        if total == 0 || total > 4096 {
            return None;
        }
        let bytes = if total <= 4 {
            let raw = if little {
                entry.value_off.to_le_bytes()
            } else {
                entry.value_off.to_be_bytes()
            };
            raw[..total].to_vec()
        } else {
            let start = entry.value_off as usize;
            tiff.get(start..start.checked_add(total)?)?.to_vec()
        };
        Some(String::from_utf8_lossy(&bytes).to_string())
    };
    let entry_num = |entry: &ExifEntry| -> Option<u32> {
        match entry.kind {
            // SHORT 的值内联在 4 字节字段里：大端在高 2 字节、小端在低 2 字节。
            // 早期实现无视文件字节序按小端读，导致大端相机（多数单反）的 ISO / 方向读错。
            3 => Some(if little {
                entry.value_off & 0xFFFF
            } else {
                entry.value_off >> 16
            }),
            4 | 9 => Some(entry.value_off),
            _ => None,
        }
    };

    let ifd0_entries = read_ifd(ifd0);
    let mut exif_offset: Option<u32> = None;
    for entry in &ifd0_entries {
        match entry.tag {
            0x010F => {
                if let Some(v) = entry_string(entry) {
                    push("相机品牌", v);
                }
            }
            0x0110 => {
                if let Some(v) = entry_string(entry) {
                    push("相机型号", v);
                }
            }
            0x0132 => {
                if let Some(v) = entry_string(entry) {
                    push("修改时间（EXIF）", normalize_date(&v));
                }
            }
            0x0112 => {
                if let Some(v) = entry_num(entry) {
                    let text = match v {
                        1 => "正常",
                        3 => "旋转 180°",
                        6 => "顺时针 90°",
                        8 => "逆时针 90°",
                        _ => "镜像 / 翻转",
                    };
                    push("方向", text.to_string());
                }
            }
            0x010E => {
                if let Some(v) = entry_string(entry) {
                    push("图像说明", v);
                }
            }
            0x8769 => exif_offset = entry_num(entry),
            _ => {}
        }
    }

    if let Some(off) = exif_offset {
        let sub = read_ifd(off);
        for entry in &sub {
            match entry.tag {
                0x9003 => {
                    if let Some(v) = entry_string(entry) {
                        push("拍摄时间", normalize_date(&v));
                    }
                }
                0xA002 => {
                    if let Some(v) = entry_num(entry) {
                        push("像素宽", v.to_string());
                    }
                }
                0xA003 => {
                    if let Some(v) = entry_num(entry) {
                        push("像素高", v.to_string());
                    }
                }
                0x8827 => {
                    if let Some(v) = entry_num(entry) {
                        push("ISO", v.to_string());
                    }
                }
                0x829A => {
                    if let Some(v) = rational(tiff, entry.value_off, entry.count, little) {
                        push("曝光时间", format!("{v} 秒"));
                    }
                }
                0x829D => {
                    if let Some(v) = rational(tiff, entry.value_off, entry.count, little) {
                        push("光圈", format!("f/{v}"));
                    }
                }
                0x920A => {
                    if let Some(v) = rational(tiff, entry.value_off, entry.count, little) {
                        push("焦距", format!("{v} mm"));
                    }
                }
                0xA434 => {
                    if let Some(v) = entry_string(entry) {
                        push("镜头", v);
                    }
                }
                _ => {}
            }
        }
    }

    fields
}

fn rational(tiff: &[u8], offset: u32, count: u32, little: bool) -> Option<String> {
    if count == 0 {
        return None;
    }
    let start = offset as usize;
    let read = |o: usize| -> Option<u32> {
        let s = tiff.get(o..o + 4)?;
        Some(if little {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        })
    };
    let num = read(start)?;
    let den = read(start + 4)?;
    if den == 0 {
        return None;
    }
    if num == 1 && den > 1 {
        return Some(format!("1/{den}"));
    }
    if num > den && den > 0 && num % den == 0 {
        return Some((num / den).to_string());
    }
    Some(format!("{:.2}", num as f64 / den as f64))
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

/// 把字体容器的解析结果转成展示信息（TTF / OTF / TTC）。
fn font_meta(probe: crate::font::FontProbe) -> MetadataInfo {
    let mut info = MetadataInfo::new("font", &probe.format);
    if let Some(faces) = probe.faces {
        info.push("集合内字体数", format!("{faces} 个"));
    }
    if let Some(family) = probe.family {
        info.push("字体名", family);
    }
    if let Some(subfamily) = probe.subfamily {
        info.push("字形", subfamily);
    }
    if let Some(full_name) = probe.full_name {
        info.push("字体全名", full_name);
    }
    if let Some(postscript) = probe.postscript {
        info.push("PostScript 名", postscript);
    }
    if let Some(version) = probe.version {
        info.push("字体版本", version);
    }
    if let Some(weight) = probe.weight {
        let name = crate::font::weight_name(weight);
        let text = if name.is_empty() {
            format!("{weight}")
        } else {
            format!("{weight}（{name}）")
        };
        info.push("字重", text);
    }
    if let Some(italic) = probe.italic {
        info.push("斜体", if italic { "是".to_string() } else { "否".to_string() });
    }
    if let Some(glyphs) = probe.glyphs {
        info.push("字形数", format!("{glyphs} 个"));
    }
    if let Some(upm) = probe.units_per_em {
        info.push("设计网格", format!("{upm} units/em"));
    }
    if let Some(designer) = probe.designer {
        info.push("设计者", designer);
    }
    if let Some(license) = probe.license {
        info.push("授权", license);
    }
    for warning in probe.warnings {
        info.warn(warning);
    }
    info
}

/// PE（EXE / DLL / SYS）：头信息 + 版本资源。
fn pe_meta(probe: crate::pe::PeProbe) -> MetadataInfo {
    let mut info = MetadataInfo::new("exe", &probe.format);
    if let Some(bitness) = probe.bitness {
        info.push(
            "位数",
            format!("{bitness} 位（PE32{}）", if bitness == 64 { "+" } else { "" }),
        );
    }
    if let Some(machine) = probe.machine {
        info.push("目标架构", machine);
    }
    if let Some(subsystem) = probe.subsystem {
        info.push("子系统", subsystem);
    }
    if let Some(built) = probe.built {
        info.push("编译时间", built);
    }
    if let Some(version) = probe.file_version {
        info.push("文件版本", version);
    }
    if let Some(version) = probe.product_version {
        info.push("产品版本", version);
    }
    // 版本资源里的字符串：常见键翻成中文标签，其余按原键名展示（不丢信息）
    for entry in &probe.strings {
        let label = match entry.key.as_str() {
            "CompanyName" => "公司名",
            "ProductName" => "产品名",
            "FileDescription" => "文件说明",
            "LegalCopyright" => "版权",
            "OriginalFilename" => "原始文件名",
            "InternalName" => "内部名",
            "LegalTrademarks" => "商标",
            "Comments" => "注释",
            "PrivateBuild" => "私有构建",
            "SpecialBuild" => "特殊构建",
            "FileVersion" => "版本资源·文件版本",
            "ProductVersion" => "版本资源·产品版本",
            other => other,
        };
        info.push(label, entry.value.clone());
    }
    if let Some(language) = probe.language {
        info.push("版本资源语言", language);
    }
    for warning in probe.warnings {
        info.warn(warning);
    }
    info
}

// ---------------------------------------------------------------------------
// 音乐
// ---------------------------------------------------------------------------

/// 把音频容器的解析结果转成展示信息（WAV / AIFF / APE / WMA）。
fn audio_container_meta(probe: crate::audio_container::AudioProbe) -> MetadataInfo {
    let mut info = MetadataInfo::new("audio", &probe.format);
    if let Some(rate) = probe.sample_rate {
        info.push("采样率", format!("{:.1} kHz", rate as f64 / 1000.0));
    }
    if let Some(channels) = probe.channels {
        let text = match channels {
            1 => "1（单声道）".to_string(),
            2 => "2（立体声）".to_string(),
            n => n.to_string(),
        };
        info.push("声道", text);
    }
    if let Some(bits) = probe.bits {
        info.push("位深", format!("{bits} bit"));
    }
    if let Some(ms) = probe.duration_ms {
        info.push("时长", format_duration_ms(ms));
    }
    for (key, value) in probe.tags {
        let label = match key.as_str() {
            "title" => "标题",
            "artist" => "艺术家",
            "album" => "专辑",
            "year" => "年份",
            "genre" => "流派",
            "track" => "音轨",
            "composer" => "作曲",
            "comment" => "备注",
            "copyright" => "版权",
            "rating" => "评分",
            "software" => "生成软件",
            "codec" => "编码",
            _ => continue,
        };
        info.push(label, value);
    }
    for warning in probe.warnings {
        info.warn(warning);
    }
    info
}

fn format_duration_ms(ms: u64) -> String {
    let seconds = ms / 1000;
    let (hours, minutes, secs) = (seconds / 3600, (seconds / 60) % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

fn looks_like_mpeg(data: &[u8], start: usize) -> bool {
    data.get(start) == Some(&0xFF)
        && data
            .get(start + 1)
            .map(|b| b & 0xE0 == 0xE0)
            .unwrap_or(false)
}

fn audio_mp3(data: &[u8], size: u64) -> MetadataInfo {
    let mut info = MetadataInfo::new("audio", "MP3 音频");
    let mut start = 0usize;
    if data.starts_with(b"ID3") && data.len() >= 10 {
        let version = data[3];
        let flags = data[5];
        let size_marker = ((data[6] as usize & 0x7F) << 21)
            | ((data[7] as usize & 0x7F) << 14)
            | ((data[8] as usize & 0x7F) << 7)
            | (data[9] as usize & 0x7F);
        let tag_end = (10 + size_marker).min(data.len());
        info.push("ID3 版本", format!("v2.{version}"));
        parse_id3_frames(&data[10..tag_end], version, &mut info);
        start = tag_end;
        if flags & 0x10 != 0 {
            info.push("页脚", "存在 ID3 页脚".to_string());
        }
    } else {
        info.warn("未发现 ID3 标签（可能使用其他标签格式或为纯音频流）");
    }

    if let Some((bitrate, sample, channels)) = mpeg_frame_info(data, start) {
        info.push("采样率", format!("{:.1} kHz", sample as f64 / 1000.0));
        info.push(
            "声道",
            if channels == 1 {
                "单声道"
            } else {
                "立体声"
            }
            .to_string(),
        );
        info.push("码率", format!("{bitrate} kbps"));
        if bitrate > 0 {
            let seconds = (size as f64 * 8.0) / (bitrate as f64 * 1000.0);
            let mins = (seconds / 60.0).floor() as u64;
            let secs = (seconds % 60.0).round() as u64;
            info.push("时长（按码率估算）", format!("{mins}:{secs:02}"));
        }
    }
    info
}

fn parse_id3_frames(tag: &[u8], version: u8, info: &mut MetadataInfo) {
    let mut offset = 0usize;
    while offset + 10 <= tag.len() {
        let id_bytes = &tag[offset..offset + 4];
        if !id_bytes.iter().all(|b| b.is_ascii_alphanumeric()) {
            break;
        }
        let id = String::from_utf8_lossy(id_bytes).to_string();
        let frame_size = if version == 4 {
            ((tag[offset + 4] as usize & 0x7F) << 21)
                | ((tag[offset + 5] as usize & 0x7F) << 14)
                | ((tag[offset + 6] as usize & 0x7F) << 7)
                | (tag[offset + 7] as usize & 0x7F)
        } else {
            u32::from_be_bytes([
                tag[offset + 4],
                tag[offset + 5],
                tag[offset + 6],
                tag[offset + 7],
            ]) as usize
        };
        if frame_size == 0 || offset + 10 + frame_size > tag.len() {
            break;
        }
        let body = &tag[offset + 10..offset + 10 + frame_size];
        let label = match id.as_str() {
            "TIT2" => Some("标题"),
            "TPE1" => Some("艺术家"),
            "TALB" => Some("专辑"),
            "TDRC" | "TYER" => Some("年份"),
            "TRCK" => Some("音轨"),
            "TCON" => Some("流派"),
            "TCOM" => Some("作曲"),
            _ => None,
        };
        if let Some(label) = label {
            if let Some(text) = id3_text(body) {
                info.push(label, text);
            }
        }
        if id == "APIC" {
            info.push("内嵌封面", "有（只读显示，不提取）".to_string());
        }
        offset += 10 + frame_size;
    }
}

fn id3_text(body: &[u8]) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let encoding = body[0];
    let raw = &body[1..];
    let text = match encoding {
        1 => decode_utf16(raw, true),
        2 => decode_utf16(raw, false),
        3 => String::from_utf8_lossy(raw).to_string(),
        _ => raw.iter().map(|b| *b as char).collect::<String>(),
    };
    let cleaned = text.trim_matches('\0').trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn decode_utf16(raw: &[u8], with_bom: bool) -> String {
    let mut little = true;
    let mut start = 0;
    if with_bom {
        match raw.get(..2) {
            Some([0xFF, 0xFE]) => {
                little = true;
                start = 2;
            }
            Some([0xFE, 0xFF]) => {
                little = false;
                start = 2;
            }
            _ => {}
        }
    }
    let mut out = String::new();
    for chunk in raw[start..].chunks(2) {
        if chunk.len() < 2 {
            break;
        }
        let code = if little {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        if code == 0 {
            break;
        }
        if let Some(c) = char::from_u32(code as u32) {
            out.push(c);
        }
    }
    out
}

fn mpeg_frame_info(data: &[u8], start: usize) -> Option<(u32, u32, u8)> {
    let limit = data
        .len()
        .saturating_sub(4)
        .min(start.saturating_add(65536));
    for i in start..limit {
        if !looks_like_mpeg(data, i) {
            continue;
        }
        let b1 = data[i + 1];
        let b2 = data[i + 2];
        let b3 = data[i + 3];
        let version = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
        let layer = (b1 >> 1) & 0x03; // 1=III, 2=II, 3=I
        let bitrate_index = (b2 >> 4) & 0x0F;
        let sample_index = (b2 >> 2) & 0x03;
        let channel_mode = (b3 >> 6) & 0x03;
        if version == 1
            || layer == 0
            || bitrate_index == 0
            || bitrate_index == 15
            || sample_index == 3
        {
            continue;
        }
        let bitrate = match (version, layer) {
            (3, 1) => [
                0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
            ][bitrate_index as usize],
            (3, 2) => [
                0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
            ][bitrate_index as usize],
            (3, 3) => [
                0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
            ][bitrate_index as usize],
            (_, 1) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
                [bitrate_index as usize],
            (_, 2) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
                [bitrate_index as usize],
            _ => [
                0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
            ][bitrate_index as usize],
        };
        let sample = match version {
            3 => [44100, 48000, 32000][sample_index as usize],
            2 => [22050, 24000, 16000][sample_index as usize],
            _ => [11025, 12000, 8000][sample_index as usize],
        };
        let channels = if channel_mode == 3 { 1 } else { 2 };
        return Some((bitrate, sample, channels));
    }
    None
}

fn audio_flac(data: &[u8], size: u64) -> MetadataInfo {
    let mut info = MetadataInfo::new("audio", "FLAC 无损音频");
    let mut offset = 4usize;
    let mut last = false;
    while !last && offset + 4 <= data.len() {
        let header = data[offset];
        last = header & 0x80 != 0;
        let kind = header & 0x7F;
        let len = ((data[offset + 1] as usize) << 16)
            | ((data[offset + 2] as usize) << 8)
            | (data[offset + 3] as usize);
        let body_start = offset + 4;
        let body = data.get(body_start..body_start.saturating_add(len).min(data.len()));
        if let Some(body) = body {
            match kind {
                0 if body.len() >= 18 => {
                    let sample_rate =
                        (body[10] as u32) << 12 | (body[11] as u32) << 4 | (body[12] as u32) >> 4;
                    let channels = ((body[12] >> 1) & 0x07) + 1;
                    let bits = ((body[12] & 0x01) << 4) | (body[13] >> 4);
                    let total = ((body[13] as u64 & 0x0F) << 32)
                        | (body[14] as u64) << 24
                        | (body[15] as u64) << 16
                        | (body[16] as u64) << 8
                        | body[17] as u64;
                    info.push("采样率", format!("{:.1} kHz", sample_rate as f64 / 1000.0));
                    info.push("声道", channels.to_string());
                    info.push("位深", format!("{bits} bit"));
                    if sample_rate > 0 {
                        let seconds = total as f64 / sample_rate as f64;
                        let mins = (seconds / 60.0).floor() as u64;
                        let secs = (seconds % 60.0).round() as u64;
                        info.push("时长", format!("{mins}:{secs:02}"));
                    }
                }
                4 if body.len() >= 8 => {
                    let vendor_len = le_u32(body, 0).unwrap_or(0) as usize;
                    let count_off = 4 + vendor_len;
                    if let Some(count) = le_u32(body, count_off) {
                        let mut pos = count_off + 4;
                        for _ in 0..count.min(128) {
                            let Some(len) = le_u32(body, pos) else {
                                break;
                            };
                            let len = len as usize;
                            let Some(comment) = body.get(pos + 4..pos + 4 + len) else {
                                break;
                            };
                            let text = String::from_utf8_lossy(comment);
                            if let Some((key, value)) = text.split_once('=') {
                                let up = key.to_ascii_uppercase();
                                let label = match up.as_str() {
                                    "TITLE" => "标题",
                                    "ARTIST" => "艺术家",
                                    "ALBUM" => "专辑",
                                    "DATE" => "年份",
                                    "TRACKNUMBER" => "音轨",
                                    "GENRE" => "流派",
                                    _ => "",
                                };
                                if !label.is_empty() {
                                    info.push(label, value.to_string());
                                }
                            }
                            pos += 4 + len;
                        }
                    }
                }
                _ => {}
            }
        }
        offset = body_start + len;
    }
    if info.fields.iter().all(|f| f.label != "采样率") {
        info.warn("FLAC STREAMINFO 解析失败");
    }
    let _ = size;
    info
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

/// 旧版 Office 与其它 OLE 复合文档：先认类型，再读摘要流；读不了的明确拒绝并给原因。
///
/// 这些格式的文件头完全一样（`D0 CF 11 E0 A1 B1 1A E1`），只按文件头判断会把
/// Windows 安装包、Outlook 邮件、加密的 Office 包全都报成「旧版 Office 文档」。
/// 现在按根存储 CLSID 与流名分开认，并在拒绝时写清**为什么**读不了。
fn document_ole(data: &[u8]) -> MetadataInfo {
    let file = match crate::cfb::CompoundFile::parse(data) {
        Ok(file) => file,
        Err(reason) => {
            let mut info = MetadataInfo::new("other", "OLE 复合文档（结构无法解析）");
            info.warn(format!("文件头声明是 OLE 复合文档，但结构读取失败：{reason}"));
            info.warn("该文件不会被尝试修改；需要属性请用原应用打开。");
            return info;
        }
    };
    let kind = file.kind();
    let mut info = MetadataInfo::new(kind.metadata_kind(), kind.label());
    if let Some(reason) = kind.refusal_reason() {
        info.warn(reason);
        return info;
    }
    match file
        .stream("SummaryInformation")
        .and_then(|bytes| crate::cfb::read_property_set(&bytes).ok())
    {
        Some(set) => {
            for (id, label) in [
                (2, "标题"),
                (3, "主题"),
                (4, "作者"),
                (5, "关键词"),
                (6, "备注"),
                (7, "模板"),
                (8, "最后修改者"),
                (9, "修订号"),
            ] {
                if let Some(value) = set.text(id) {
                    info.push(label, value.to_string());
                }
            }
            for (id, label) in [(12, "创建时间（UTC）"), (13, "最后保存（UTC）")] {
                if let Some(ms) = set.time(id) {
                    let text = crate::cfb::utc_text_from_unix_ms(ms);
                    if !text.is_empty() {
                        info.push(label, text);
                    }
                }
            }
            for (id, label) in [(14, "页数"), (15, "字数"), (16, "字符数")] {
                if let Some(n) = set.int(id) {
                    if n > 0 {
                        info.push(label, n.to_string());
                    }
                }
            }
            if let Some(app) = set.text(18) {
                info.push("生成应用", app.to_string());
            }
        }
        None => info.warn("这个文件没有可读的摘要流（可能由非 Office 工具生成，或摘要已被删除）"),
    }
    if let Some(set) = file
        .stream("DocumentSummaryInformation")
        .and_then(|bytes| crate::cfb::read_property_set(&bytes).ok())
    {
        for (id, label) in [(2, "类别"), (4, "经理"), (15, "公司")] {
            if let Some(value) = set.text(id) {
                info.push(label, value.to_string());
            }
        }
    }
    info
}

fn document_pdf(data: &[u8]) -> MetadataInfo {
    let mut info = MetadataInfo::new("document", "PDF 文档");
    let Some(probe) = crate::pdf::probe(data) else {
        info.warn("不是可识别的 PDF 文件头");
        return info;
    };
    for (label, value) in &probe.fields {
        info.push(*label, value.clone());
    }
    for warning in &probe.warnings {
        info.warn(warning.clone());
    }
    info
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "tsv"
            | "log"
            | "json"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "cjs"
            | "ts"
            | "tsx"
            | "jsx"
            | "ini"
            | "cfg"
            | "conf"
            | "yaml"
            | "yml"
            | "toml"
            | "rs"
            | "py"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "sh"
            | "bat"
            | "ps1"
            | "sql"
            | "srt"
            | "lrc"
    )
}

/// 文本文件：识别 BOM / UTF-8，统计行数与字符数并给出内容摘要。
/// 不做编码自动猜测：非 UTF-8 时明确降级为「未识别」，避免把 GBK 当 UTF-8 误读。
fn text_file(data: &[u8], ext: &str) -> MetadataInfo {
    let mut info = MetadataInfo::new("text", "文本文件");
    if !ext.is_empty() {
        info.push("扩展名", format!(".{ext}"));
    }
    let (encoding, decoded): (&str, Option<String>) = if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (
            "UTF-8（BOM）",
            std::str::from_utf8(&data[3..]).ok().map(|s| s.to_string()),
        )
    } else if data.starts_with(&[0xFF, 0xFE]) {
        ("UTF-16 LE（BOM）", Some(decode_utf16(data, true)))
    } else if data.starts_with(&[0xFE, 0xFF]) {
        ("UTF-16 BE（BOM）", Some(decode_utf16(data, true)))
    } else {
        match std::str::from_utf8(data) {
            Ok(text) => ("UTF-8", Some(text.to_string())),
            Err(_) => ("非 UTF-8（GBK/ANSI 未自动识别）", None),
        }
    };
    info.push("编码", encoding.to_string());
    match decoded {
        Some(text) => {
            info.push("行数", text.lines().count().to_string());
            info.push("字符数", text.chars().count().to_string());
            if let Some(line) = text.lines().map(|l| l.trim()).find(|l| !l.is_empty()) {
                let preview: String = line.chars().take(80).collect();
                info.push("内容摘要", preview);
            }
        }
        None => info.warn("内容不是有效的 UTF-8：行数 / 字符数未统计，本版不做编码自动识别"),
    }
    info
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetadata {
    pub path: String,
    pub info: Option<MetadataInfo>,
    pub error: Option<String>,
}

/// 批量读取只读元数据：单条失败只影响该条，不中断整批（供九类列表页签使用）。
pub fn read_metadata_batch(paths: &[String]) -> Vec<BatchMetadata> {
    paths
        .iter()
        .map(|path| match read_metadata(path) {
            Ok(info) => BatchMetadata {
                path: path.clone(),
                info: Some(info),
                error: None,
            },
            Err(err) => BatchMetadata {
                path: path.clone(),
                info: None,
                error: Some(err),
            },
        })
        .collect()
}

fn document_docx(data: &[u8], ext: &str) -> MetadataInfo {
    let mut info = MetadataInfo::new("document", "Word 文档 (DOCX)");
    let core = zip_entry(data, "docProps/core.xml").and_then(|bytes| String::from_utf8(bytes).ok());
    match core {
        Some(xml) => {
            for (tag, label) in [
                ("dc:title", "标题"),
                ("dc:creator", "作者"),
                ("dc:subject", "主题"),
                ("cp:lastModifiedBy", "最后修改者"),
                ("cp:revision", "修订号"),
                ("dcterms:created", "创建时间"),
                ("dcterms:modified", "修改时间"),
            ] {
                if let Some(value) = extract_xml_tag(&xml, tag) {
                    info.push(label, value);
                }
            }
        }
        None => info.warn("未能读取 docProps/core.xml（文档可能损坏或不是标准 DOCX）"),
    }
    if let Some(app) = zip_entry(data, "docProps/app.xml").and_then(|b| String::from_utf8(b).ok()) {
        for (tag, label) in [
            ("Pages", "页数"),
            ("Words", "字数"),
            ("Application", "生成应用"),
        ] {
            if let Some(value) = extract_xml_tag(&app, tag) {
                info.push(label, value);
            }
        }
    }
    if !ext.is_empty() && ext != "docx" {
        info.warn(format!("扩展名为 .{ext}，内部结构按 DOCX 读取"));
    }
    info
}

/// 最小 ZIP 读取器（仅支持 stored / deflate），避免引入完整 zip 依赖。
fn zip_entry(data: &[u8], target: &str) -> Option<Vec<u8>> {
    let eocd = find_eocd(data)?;
    let count = le_u16(data, eocd + 10)? as usize;
    let mut offset = le_u32(data, eocd + 16)? as usize;
    for _ in 0..count {
        if data.get(offset..offset + 4) != Some(b"PK\x01\x02".as_ref()) {
            return None;
        }
        let method = le_u16(data, offset + 10)?;
        let comp_size = le_u32(data, offset + 20)? as usize;
        let name_len = le_u16(data, offset + 28)? as usize;
        let extra_len = le_u16(data, offset + 30)? as usize;
        let comment_len = le_u16(data, offset + 32)? as usize;
        let local_off = le_u32(data, offset + 42)? as usize;
        let name_bytes = data.get(offset + 46..offset + 46 + name_len)?;
        let name = String::from_utf8_lossy(name_bytes).to_string();
        if name == target {
            let local_name_len = le_u16(data, local_off + 26)? as usize;
            let local_extra_len = le_u16(data, local_off + 28)? as usize;
            let start = local_off + 30 + local_name_len + local_extra_len;
            let end = start.checked_add(comp_size)?;
            let raw = data.get(start..end)?;
            return match method {
                0 => Some(raw.to_vec()),
                8 => {
                    use flate2::read::DeflateDecoder;
                    let mut out = Vec::new();
                    let mut decoder = DeflateDecoder::new(raw);
                    decoder.read_to_end(&mut out).ok()?;
                    Some(out)
                }
                _ => None,
            };
        }
        offset += 46 + name_len + extra_len + comment_len;
    }
    None
}

fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let start = data.len().saturating_sub(65557);
    (start..=data.len() - 22)
        .rev()
        .find(|&i| data[i..i + 4] == [0x50, 0x4B, 0x05, 0x06])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempFile(PathBuf);

    impl TempFile {
        fn new(name: &str, bytes: &[u8]) -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!("renomio-meta-{stamp}-{name}"));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn png_dimensions_and_text() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        // IHDR
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&[0u8; 4]); // 占位 CRC
                                          // tEXt：长度必须等于“关键字 + 0 + 文本”的字节数
        let text_body = "Title\0相册封面";
        png.extend_from_slice(&(text_body.len() as u32).to_be_bytes());
        png.extend_from_slice(b"tEXt");
        png.extend_from_slice(text_body.as_bytes());
        png.extend_from_slice(&[0u8; 4]);
        // IEND
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0u8; 4]);

        let file = TempFile::new("sample.png", &png);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "image");
        assert!(info.read_only);
        let dims = info.fields.iter().find(|f| f.label == "尺寸").unwrap();
        assert_eq!(dims.value, "640 × 480 px");
        let title = info.fields.iter().find(|f| f.label == "标题").unwrap();
        assert_eq!(title.value, "相册封面");
    }

    #[test]
    fn jpeg_dimensions() {
        let mut jpeg = vec![0xFF, 0xD8];
        // SOF0: len=17 (8 precision + 2 h + 2 w + 3*3 components)
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&600u16.to_be_bytes());
        jpeg.extend_from_slice(&800u16.to_be_bytes());
        jpeg.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);

        let file = TempFile::new("sample.jpg", &jpeg);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        let dims = info.fields.iter().find(|f| f.label == "尺寸").unwrap();
        assert_eq!(dims.value, "800 × 600 px");
    }

    /// 手写一个带完整 EXIF 的 JPEG：IFD0 放相机品牌/型号 + ExifIFD 指针，
    /// ExifIFD 放拍摄时间、像素宽高、ISO、曝光时间、光圈、焦距、镜头。
    /// 全部使用大端（"MM"），偏移量按本函数内的固定布局推算。
    fn build_exif_jpeg(little: bool) -> Vec<u8> {
        let make = b"RenomioCam\0";
        let model = b"RC-1\0";
        let taken = b"2025:01:04 08:00:00\0";
        let lens = b"RF24-70mm F2.8\0";

        let u16b = |v: u16| -> Vec<u8> {
            if little {
                v.to_le_bytes().to_vec()
            } else {
                v.to_be_bytes().to_vec()
            }
        };
        let u32b = |v: u32| -> Vec<u8> {
            if little {
                v.to_le_bytes().to_vec()
            } else {
                v.to_be_bytes().to_vec()
            }
        };

        // TIFF 头部 8 字节，IFD0 紧接其后
        let ifd0_off: u32 = 8;
        let ifd0_count = 3u16;
        let ifd0_data: u32 = ifd0_off + 2 + 3 * 12 + 4; // 50
        let make_off = ifd0_data; // 50
        let model_off = make_off + make.len() as u32; // 61
        let exif_off = model_off + model.len() as u32; // 66
        let exif_data = exif_off + 2 + 8 * 12 + 4; // 168
        let taken_off = exif_data;
        let exp_off = taken_off + taken.len() as u32; // 188
        let fnum_off = exp_off + 8; // 196
        let focal_off = fnum_off + 8; // 204
        let lens_off = focal_off + 8; // 212

        let entry = |tag: u16, kind: u16, count: u32, value: Vec<u8>| -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(&u16b(tag));
            out.extend_from_slice(&u16b(kind));
            out.extend_from_slice(&u32b(count));
            out.extend_from_slice(&value);
            out
        };

        let mut t: Vec<u8> = Vec::new();
        t.extend_from_slice(if little { b"II" } else { b"MM" });
        t.extend_from_slice(&u16b(42));
        t.extend_from_slice(&u32b(ifd0_off));

        // ---- IFD0 ----
        t.extend_from_slice(&u16b(ifd0_count));
        t.extend_from_slice(&entry(0x010F, 2, make.len() as u32, u32b(make_off)));
        t.extend_from_slice(&entry(0x0110, 2, model.len() as u32, u32b(model_off)));
        t.extend_from_slice(&entry(0x8769, 4, 1, u32b(exif_off)));
        t.extend_from_slice(&[0u8; 4]);
        t.extend_from_slice(make);
        t.extend_from_slice(model);

        // ---- ExifIFD ----
        t.extend_from_slice(&u16b(8));
        t.extend_from_slice(&entry(0x9003, 2, taken.len() as u32, u32b(taken_off)));
        // ISO 是 SHORT，值内联在 4 字节字段：大端占高 2 字节、小端占低 2 字节
        let mut iso_inline = Vec::new();
        if little {
            iso_inline.extend_from_slice(&3200u16.to_le_bytes());
        } else {
            iso_inline.extend_from_slice(&3200u16.to_be_bytes());
        }
        iso_inline.extend_from_slice(&[0, 0]);
        t.extend_from_slice(&entry(0x8827, 3, 1, iso_inline));
        t.extend_from_slice(&entry(0x829A, 5, 1, u32b(exp_off)));
        t.extend_from_slice(&entry(0x829D, 5, 1, u32b(fnum_off)));
        t.extend_from_slice(&entry(0x920A, 5, 1, u32b(focal_off)));
        t.extend_from_slice(&entry(0xA002, 4, 1, u32b(6000)));
        t.extend_from_slice(&entry(0xA003, 4, 1, u32b(4000)));
        t.extend_from_slice(&entry(0xA434, 2, lens.len() as u32, u32b(lens_off)));
        t.extend_from_slice(&[0u8; 4]);
        t.extend_from_slice(taken);
        for (num, den) in [(1u32, 250u32), (28, 10), (50, 1)] {
            t.extend_from_slice(&u32b(num));
            t.extend_from_slice(&u32b(den));
        }
        t.extend_from_slice(lens);

        let mut jpeg = vec![0xFF, 0xD8];
        let app1_len = 2 + 6 + t.len();
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&(app1_len as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&t);
        // SOF0：真实相机也会有，用来验证像素宽高优先取 EXIF
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&4000u16.to_be_bytes());
        jpeg.extend_from_slice(&6000u16.to_be_bytes());
        jpeg.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        jpeg
    }

    fn assert_camera_values(vals: &RenameFieldValues) {
        assert_eq!(vals.taken, "2025-01-04 08-00-00");
        assert_eq!(vals.camera, "RC-1");
        assert_eq!(vals.iso, "3200");
        assert_eq!(vals.aperture, "2.8");
        assert_eq!(vals.shutter, "1-250");
        assert_eq!(vals.focal, "50mm");
        assert_eq!(vals.lens, "RF24-70mm F2.8");
        assert_eq!(vals.width, "6000");
        assert_eq!(vals.height, "4000");
        assert_eq!(vals.resolution, "6000x4000");
        // 该文件没有音频/文档标签，其余字段必须是空串（界面据此隐藏/回退）
        for empty in [
            vals.title.as_str(),
            vals.artist.as_str(),
            vals.album.as_str(),
            vals.track.as_str(),
            vals.year.as_str(),
            vals.genre.as_str(),
            vals.composer.as_str(),
        ] {
            assert!(empty.is_empty());
        }
    }

    #[test]
    fn rename_fields_cover_exif_shooting_params_both_byte_orders() {
        let be = TempFile::new("exif-be.jpg", &build_exif_jpeg(false));
        let info = read_metadata(be.0.to_str().unwrap()).unwrap();
        assert_camera_values(&rename_field_values(&info));

        // 小端 TIFF（"II"）：早期实现把 SHORT 按固定字节序读，这里固定两种字节序都对
        let le = TempFile::new("exif-le.jpg", &build_exif_jpeg(true));
        let info = read_metadata(le.0.to_str().unwrap()).unwrap();
        assert_camera_values(&rename_field_values(&info));
    }

    #[test]
    fn rename_fields_fall_back_to_size_and_audio_tags() {
        // PNG 没有 EXIF 像素宽高，应回退到「尺寸」并拆成宽高
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&[0u8; 4]);
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0u8; 4]);
        let file = TempFile::new("size.png", &png);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        let vals = rename_field_values(&info);
        assert_eq!((vals.width.as_str(), vals.height.as_str()), ("640", "480"));
        assert_eq!(vals.resolution, "640x480");

        // 缺少元数据时全部为空，不能出现 "undefined"/默认值
        assert!(vals.camera.is_empty() && vals.iso.is_empty() && vals.shutter.is_empty());
    }

    #[test]
    fn name_safe_strips_path_and_reserved_chars() {
        assert_eq!(name_safe("AC/DC: Live*2025?.jpg"), "AC-DC- Live-2025-.jpg");
        assert_eq!(name_safe("  title  "), "title");
        assert_eq!(name_safe("<a>|b\\c"), "a-b-c");
        assert_eq!(name_safe(""), "");
    }

    #[test]
    fn mp3_id3_fields() {
        let title = "夜曲";
        let artist = "周杰伦";
        let mut frames = Vec::new();
        for (id, value) in [("TIT2", title), ("TPE1", artist)] {
            frames.extend_from_slice(id.as_bytes());
            let size = 1 + value.len();
            frames.extend_from_slice(&(size as u32).to_be_bytes());
            frames.extend_from_slice(&[0, 0]);
            frames.push(3); // UTF-8
            frames.extend_from_slice(value.as_bytes());
        }
        let mut mp3 = b"ID3\x03\x00\x00".to_vec();
        let size = frames.len();
        mp3.extend_from_slice(&[
            ((size >> 21) & 0x7F) as u8,
            ((size >> 14) & 0x7F) as u8,
            ((size >> 7) & 0x7F) as u8,
            (size & 0x7F) as u8,
        ]);
        mp3.extend_from_slice(&frames);

        let file = TempFile::new("sample.mp3", &mp3);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "audio");
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "标题")
                .unwrap()
                .value,
            title
        );
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "艺术家")
                .unwrap()
                .value,
            artist
        );
    }

    #[test]
    fn docx_core_properties() {
        let core = r#"<?xml version="1.0"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title>季度报告</dc:title><dc:creator>张三</dc:creator></cp:coreProperties>"#;
        let zip = build_stored_zip(&[("docProps/core.xml", core.as_bytes())]);
        let file = TempFile::new("sample.docx", &zip);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "document");
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "标题")
                .unwrap()
                .value,
            "季度报告"
        );
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "作者")
                .unwrap()
                .value,
            "张三"
        );
    }

    #[test]
    fn text_file_stats_and_bom() {
        let body = "第一行\n第二行\n".as_bytes();
        let file = TempFile::new("sample.txt", body);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "text");
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "编码")
                .unwrap()
                .value,
            "UTF-8"
        );
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "行数")
                .unwrap()
                .value,
            "2"
        );
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "字符数")
                .unwrap()
                .value,
            "8"
        );
        assert_eq!(
            info.fields
                .iter()
                .find(|f| f.label == "内容摘要")
                .unwrap()
                .value,
            "第一行"
        );

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"a\nb\n");
        let bom_file = TempFile::new("bom.txt", &bom);
        let bom_info = read_metadata(bom_file.0.to_str().unwrap()).unwrap();
        assert_eq!(
            bom_info
                .fields
                .iter()
                .find(|f| f.label == "编码")
                .unwrap()
                .value,
            "UTF-8（BOM）"
        );
        assert_eq!(
            bom_info
                .fields
                .iter()
                .find(|f| f.label == "行数")
                .unwrap()
                .value,
            "2"
        );
    }

    #[test]
    fn text_file_non_utf8_is_degraded() {
        // GBK 编码的「中文」在 UTF-8 下无效，应明确降级而不是误读
        let file = TempFile::new("gbk.txt", &[0xD6, 0xBA, 0xB0, 0xCF]);
        let info = read_metadata(file.0.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "text");
        assert!(info
            .fields
            .iter()
            .find(|f| f.label == "编码")
            .unwrap()
            .value
            .contains("非 UTF-8"));
        assert!(info.warnings.iter().any(|w| w.contains("不做编码自动识别")));
        assert!(info.fields.iter().all(|f| f.label != "行数"));
    }

    #[test]
    fn metadata_batch_isolates_failures() {
        let good = TempFile::new("batch.txt", b"hello");
        let missing = std::env::temp_dir().join("renomio-meta-not-exist-xyz.txt");
        let _ = std::fs::remove_file(&missing);
        let paths = vec![
            good.0.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        let out = read_metadata_batch(&paths);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, paths[0]);
        assert!(out[0].info.is_some());
        assert!(out[0].error.is_none());
        assert!(out[1].info.is_none());
        assert!(out[1]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("无法读取文件信息"));
    }

    fn build_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in entries {
            let local_off = out.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // method = stored
            out.extend_from_slice(&0u16.to_le_bytes()); // time
            out.extend_from_slice(&0u16.to_le_bytes()); // date
            out.extend_from_slice(&0u32.to_le_bytes()); // crc32（读取器不校验）
            out.extend_from_slice(&(body.len() as u32).to_le_bytes()); // comp size
            out.extend_from_slice(&(body.len() as u32).to_le_bytes()); // uncomp size
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(body);

            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&20u16.to_le_bytes()); // version made
            central.extend_from_slice(&20u16.to_le_bytes()); // version needed
            central.extend_from_slice(&0u16.to_le_bytes()); // flags
            central.extend_from_slice(&0u16.to_le_bytes()); // method
            central.extend_from_slice(&0u16.to_le_bytes()); // time
            central.extend_from_slice(&0u16.to_le_bytes()); // date
            central.extend_from_slice(&0u32.to_le_bytes()); // crc
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra
            central.extend_from_slice(&0u16.to_le_bytes()); // comment
            central.extend_from_slice(&0u16.to_le_bytes()); // disk
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&local_off.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_off = out.len() as u32;
        let central_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }
}
