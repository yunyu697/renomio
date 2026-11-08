//! 图片元数据（JPEG / PNG / WebP / TIFF）：读取与**只改选中字段**的写回。
//!
//! 写回策略：统一写入 XMP（Windows/常见软件优先读 XMP），EXIF 只改文本类标签，
//! 相机参数、GPS、ICC、MakerNotes、缩略图等一律不触碰；容器其余字节原样保留。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::util::*;
use super::{FieldMap, Rewrite};

/// EXIF 清除范围（分组勾选；Orientation 与 ICC 永远不在此列）
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifClearScopes {
    #[serde(default)]
    pub gps: bool,
    #[serde(default)]
    pub camera: bool,
    #[serde(default)]
    pub time: bool,
    #[serde(default)]
    pub thumbnail: bool,
    /// 全部 EXIF：清掉除 Orientation 以外的所有条目（含 GPS/相机/时间/缩略图）
    #[serde(default)]
    pub all: bool,
}

impl ExifClearScopes {
    pub fn any(&self) -> bool {
        self.gps || self.camera || self.time || self.thumbnail || self.all
    }
    fn label(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.all {
            out.push("all".into());
            return out;
        }
        if self.gps {
            out.push("gps".into());
        }
        if self.camera {
            out.push("camera".into());
        }
        if self.time {
            out.push("time".into());
        }
        if self.thumbnail {
            out.push("thumbnail".into());
        }
        out
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifGroup {
    pub id: String,
    pub label: String,
    pub items: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifInventory {
    pub path: String,
    pub format: String,
    pub groups: Vec<ExifGroup>,
    /// Orientation 原值；不存在则为 0
    pub orientation: u16,
    /// Orientation 是否会在清除后保留（本实现恒为 true，界面据此提示）
    pub orientation_kept: bool,
    pub has_icc: bool,
    pub has_exif: bool,
    pub has_xmp: bool,
    pub has_thumbnail: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Jpeg,
    Png,
    WebP,
    Tiff,
}

impl ImageFormat {
    pub fn name(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "JPEG",
            ImageFormat::Png => "PNG",
            ImageFormat::WebP => "WebP",
            ImageFormat::Tiff => "TIFF",
        }
    }
}

const XMP_JPEG_PREFIX: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
const NS_PHOTOSHOP: &str = "http://ns.adobe.com/photoshop/1.0/";
const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_TIFF: &str = "http://ns.adobe.com/tiff/1.0/";
const NS_EXIF: &str = "http://ns.adobe.com/exif/1.0/";
const NS_IPTC_CORE: &str = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";

/// 纬度/经度十进制 → XMP 的「度,分」写法（exiftool 可读回）
fn gps_dms(value: &str, latitude: bool) -> Option<(String, &'static str)> {
    let v: f64 = value.trim().parse().ok()?;
    if !(-180.0..=180.0).contains(&v) || !v.is_finite() {
        return None;
    }
    let (hemi, abs) = if v < 0.0 {
        (if latitude { "S" } else { "W" }, -v)
    } else {
        (if latitude { "N" } else { "E" }, v)
    };
    let deg = abs.floor();
    let minutes = (abs - deg) * 60.0;
    Some((format!("{},{}", deg as u32, format!("{minutes:.6}").trim_end_matches('0').trim_end_matches('.').to_string()) + hemi, hemi))
}

/// XMP 的「度,分[秒]半球」→ 十进制（统一 6 位小数）
fn gps_decimal(text: &str, ref_hemi: Option<&str>) -> Option<String> {
    let t = text.trim();
    let (body, hemi) = match t.chars().last() {
        Some(c) if "NSEWnsew".contains(c) => (&t[..t.len() - 1], Some(c.to_ascii_uppercase())),
        _ => (t, None),
    };
    let hemi = hemi.or_else(|| ref_hemi.and_then(|r| r.trim().chars().next()).map(|c| c.to_ascii_uppercase()));
    let parts: Vec<f64> = body
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut value = parts[0];
    if let Some(m) = parts.get(1) {
        value += m / 60.0;
    }
    if let Some(s) = parts.get(2) {
        value += s / 3600.0;
    }
    if matches!(hemi, Some('S') | Some('W')) {
        value = -value;
    }
    Some(format!("{value:.6}"))
}

/// 字段 → XMP 属性名
fn xmp_prop(id: &str) -> Option<&'static str> {
    Some(match id {
        "title" => "dc:title",
        "description" => "dc:description",
        "keywords" => "dc:subject",
        "author" => "dc:creator",
        "copyright" => "dc:rights",
        "software" => "xmp:CreatorTool",
        "takenAt" => "photoshop:DateCreated",
        "headline" => "photoshop:Headline",
        "bylineTitle" => "photoshop:AuthorsPosition",
        "credit" => "photoshop:Credit",
        "source" => "photoshop:Source",
        "model" => "tiff:Model",
        "city" => "photoshop:City",
        "location" => "Iptc4xmpCore:Location",
        "latitude" => "exif:GPSLatitude",
        "longitude" => "exif:GPSLongitude",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

pub fn read_into(
    path: &Path,
    format: ImageFormat,
    fields: &mut FieldMap,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| format!("读取图片失败：{e}"))?;
    let packet = match format {
        ImageFormat::Jpeg => jpeg_xmp(&data),
        ImageFormat::Png => png_xmp(&data, warnings),
        ImageFormat::WebP => webp_xmp(&data),
        ImageFormat::Tiff => tiff_xmp(&data, warnings),
    };
    let mut source = String::new();
    if let Some(packet) = &packet {
        read_xmp(packet, fields);
        source = "XMP".into();
    }
    // EXIF / 文本块兜底：只在 XMP 没给出该字段时使用
    let exif = match format {
        ImageFormat::Jpeg => jpeg_exif(&data),
        ImageFormat::Tiff => Some(data.clone()),
        _ => None,
    };
    if let Some(exif) = exif {
        read_exif(&exif, fields);
    }
    if format == ImageFormat::Png {
        read_png_text(&data, fields, warnings);
    }
    if fields.is_empty() {
        warnings.push("未发现可读的文本元数据（标题/作者等均为空）".into());
    } else if source.is_empty() {
        source = "EXIF/文本".into();
    }
    let _ = source;
    Ok(())
}

fn read_xmp(packet: &str, fields: &mut FieldMap) {
    let pairs = [
        ("title", "dc:title"),
        ("description", "dc:description"),
        ("copyright", "dc:rights"),
        ("software", "xmp:CreatorTool"),
        ("takenAt", "photoshop:DateCreated"),
        ("headline", "photoshop:Headline"),
        ("bylineTitle", "photoshop:AuthorsPosition"),
        ("credit", "photoshop:Credit"),
        ("source", "photoshop:Source"),
        ("model", "tiff:Model"),
        ("city", "photoshop:City"),
        ("location", "Iptc4xmpCore:Location"),
    ];
    for (id, prop) in pairs {
        if fields.contains_key(id) {
            continue;
        }
        if let Some(value) = xmp_first_li(packet, prop).or_else(|| xml_simple_text(packet, prop)) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                fields.insert(id.to_string(), value);
            }
        }
    }
    // GPS 坐标：优先读带半球后缀的值，Ref 只作兜底
    for (id, prop, ref_prop) in [
        ("latitude", "exif:GPSLatitude", "exif:GPSLatitudeRef"),
        ("longitude", "exif:GPSLongitude", "exif:GPSLongitudeRef"),
    ] {
        if fields.contains_key(id) {
            continue;
        }
        let Some(raw) = xml_simple_text(packet, prop).or_else(|| xmp_first_li(packet, prop)) else {
            continue;
        };
        let ref_value = xml_simple_text(packet, ref_prop);
        if let Some(decimal) = gps_decimal(&raw, ref_value.as_deref()) {
            fields.insert(id.to_string(), decimal);
        }
    }
    if !fields.contains_key("keywords") {
        let list = xmp_all_li(packet, "dc:subject");
        if !list.is_empty() {
            fields.insert("keywords".into(), join_keywords(&list));
        }
    }
    if !fields.contains_key("author") {
        let list = xmp_all_li(packet, "dc:creator");
        if !list.is_empty() {
            fields.insert("author".into(), join_keywords(&list));
        }
    }
}

fn read_exif(tiff: &[u8], fields: &mut FieldMap) {
    let Ok(hdr) = TiffHeader::parse(tiff) else {
        return;
    };
    let Ok((entries, _)) = hdr.entries(tiff) else {
        return;
    };
    // IFD0 之外，DateTimeOriginal/Digitized 等标签位于 ExifIFD（0x8769）
    let mut groups: Vec<Vec<IfdEntry>> = vec![entries];
    let exif_ifd_off = groups[0]
        .iter()
        .find(|e| e.tag == TAG_EXIF_IFD && e.typ == 4 && e.count == 1)
        .map(|e| raw_u32(&e.raw, hdr.be) as usize)
        .filter(|off| *off != 0);
    if let Some(off) = exif_ifd_off {
        if let Ok((sub, _)) = ifd_at(tiff, off, hdr.be) {
            groups.push(sub);
        }
    }
    let text = |tag: u16| -> Option<String> {
        groups
            .iter()
            .flat_map(|g| g.iter())
            .find(|e| e.tag == tag)
            .and_then(|e| e.ascii(tiff, hdr.be))
            .map(|s| s.trim_matches('\0').trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let utf16 = |tag: u16| -> Option<String> {
        groups
            .iter()
            .flat_map(|g| g.iter())
            .find(|e| e.tag == tag)
            .and_then(|e| e.as_utf16(tiff, hdr.be))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let map: &[(&str, Option<String>)] = &[
        ("title", utf16(0x9C9B)),
        ("description", text(0x010E).or_else(|| utf16(0x9C9F))),
        ("keywords", utf16(0x9C9E)),
        ("author", text(0x013B).or_else(|| utf16(0x9C9D))),
        ("copyright", text(0x8298)),
        ("software", text(0x0131)),
        ("model", text(0x0110)),
        (
            "takenAt",
            text(0x9003)
                .or_else(|| text(0x0132))
                .and_then(|v| exif_time_to_iso(&v)),
        ),
    ];
    for (id, value) in map {
        if let Some(v) = value {
            fields.entry(id.to_string()).or_insert_with(|| v.clone());
        }
    }
}

fn read_png_text(data: &[u8], fields: &mut FieldMap, warnings: &mut Vec<String>) {
    let Ok(chunks) = png_chunks(data) else {
        return;
    };
    let map: &[(&str, &[&str])] = &[
        ("title", &["Title", "title"]),
        ("author", &["Author", "author"]),
        ("description", &["Description", "description", "Comment"]),
        ("keywords", &["Keywords", "keywords"]),
        ("software", &["Software", "software"]),
        ("takenAt", &["Creation Time", "creation_time", "CreationTime"]),
    ];
    for chunk in &chunks {
        if chunk.typ != *b"tEXt" && chunk.typ != *b"iTXt" {
            continue;
        }
        let Some((keyword, text)) = png_text_chunk(chunk, warnings) else {
            continue;
        };
        for (id, keys) in map {
            if keys.iter().any(|k| *k == keyword) && !fields.contains_key(*id) {
                let value = text.trim().to_string();
                if !value.is_empty() {
                    let value = if *id == "takenAt" {
                        to_exif_time(&value)
                            .and_then(|v| exif_time_to_iso(&v))
                            .unwrap_or(value)
                    } else {
                        value
                    };
                    fields.insert(id.to_string(), value);
                }
            }
        }
    }
}

fn png_text_chunk(chunk: &PngChunk, warnings: &mut Vec<String>) -> Option<(String, String)> {
    let data = &chunk.data;
    let nul = data.iter().position(|b| *b == 0)?;
    let keyword = String::from_utf8_lossy(&data[..nul]).to_string();
    if chunk.typ == *b"tEXt" {
        return Some((keyword, String::from_utf8_lossy(&data[nul + 1..]).to_string()));
    }
    // iTXt: keyword \0 compflag compmethod lang \0 transkey \0 text
    let rest = &data[nul + 1..];
    let compressed = rest.first().copied().unwrap_or(0) == 1;
    let mut idx = 2;
    let lang_end = rest.get(idx..)?.iter().position(|b| *b == 0)? + idx;
    idx = lang_end + 1;
    let trans_end = rest.get(idx..)?.iter().position(|b| *b == 0)? + idx;
    idx = trans_end + 1;
    let text = rest.get(idx..).unwrap_or(&[]);
    if compressed {
        warnings.push(format!("PNG 文本块 {keyword} 为压缩格式，未解析"));
        return None;
    }
    Some((keyword, String::from_utf8_lossy(text).to_string()))
}

// ---------------------------------------------------------------------------
// 容器解析：JPEG
// ---------------------------------------------------------------------------

struct JpegSegment {
    marker: u8,
    start: usize,
    data_start: usize,
    end: usize,
}

fn jpeg_segments(data: &[u8]) -> Result<Vec<JpegSegment>, String> {
    let mut out = Vec::new();
    let mut pos = 2usize;
    if !data.starts_with(&[0xFF, 0xD8]) {
        return Err("不是有效的 JPEG（缺少 SOI）".into());
    }
    while pos + 1 < data.len() {
        if data[pos] != 0xFF {
            return Err(format!("JPEG 段结构异常（偏移 {pos} 不是 0xFF）"));
        }
        let marker = data[pos + 1];
        if marker == 0x00 || marker == 0xFF {
            pos += 1;
            continue;
        }
        if marker == 0xD9 {
            out.push(JpegSegment { marker, start: pos, data_start: pos + 2, end: pos + 2 });
            return Ok(out);
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            out.push(JpegSegment { marker, start: pos, data_start: pos + 2, end: pos + 2 });
            pos += 2;
            continue;
        }
        let len = be_u16(data, pos + 2).ok_or("JPEG 段长度越界")? as usize;
        if len < 2 || pos + 2 + len > data.len() {
            return Err(format!("JPEG 段长度非法（偏移 {pos}）"));
        }
        let end = pos + 2 + len;
        out.push(JpegSegment { marker, start: pos, data_start: pos + 4, end });
        pos = end;
        if marker == 0xDA {
            // SOS 之后是熵编码数据，整段保留到文件末尾
            return Ok(out);
        }
    }
    Ok(out)
}

fn jpeg_xmp(data: &[u8]) -> Option<String> {
    let segs = jpeg_segments(data).ok()?;
    for seg in &segs {
        if seg.marker != 0xE1 || seg.data_start >= seg.end {
            continue;
        }
        let payload = &data[seg.data_start..seg.end];
        if let Some(text) = payload.strip_prefix(XMP_JPEG_PREFIX) {
            return Some(String::from_utf8_lossy(text).to_string());
        }
    }
    None
}

fn jpeg_exif(data: &[u8]) -> Option<Vec<u8>> {
    let segs = jpeg_segments(data).ok()?;
    for seg in &segs {
        if seg.marker != 0xE1 {
            continue;
        }
        let payload = &data[seg.data_start..seg.end];
        if let Some(tiff) = payload.strip_prefix(b"Exif\0\0") {
            return Some(tiff.to_vec());
        }
    }
    None
}

fn jpeg_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let segs = jpeg_segments(data)?;
    let existing = jpeg_xmp(data);
    let (packet, xmp_warnings) = build_xmp(existing.as_deref(), fields);
    let app1 = xmp_app1(&packet)?;

    let mut out = Vec::with_capacity(data.len() + app1.len() + 256);
    out.extend_from_slice(&data[..2]);
    out.extend_from_slice(&app1);

    let mut written = Vec::new();
    let mut cleared = Vec::new();
    let mut warnings = xmp_warnings;
    collect_changes(fields, &mut written, &mut cleared);

    for seg in &segs {
        if seg.marker == 0xDA {
            // SOS 之后是熵编码数据 + EOI，整段原样保留
            out.extend_from_slice(&data[seg.start..]);
            break;
        }
        if seg.marker == 0xE1 && seg.data_start < seg.end
            && data[seg.data_start..seg.end].starts_with(XMP_JPEG_PREFIX)
        {
            continue; // 旧 XMP 段由新段取代
        }
        if seg.marker == 0xE1 && seg.data_start < seg.end {
            let payload = &data[seg.data_start..seg.end];
            if let Some(tiff) = payload.strip_prefix(b"Exif\0\0") {
                match exif_update(tiff, fields) {
                    Ok(Some(new_tiff)) => {
                        let mut new_payload = b"Exif\0\0".to_vec();
                        new_payload.extend_from_slice(&new_tiff);
                        if new_payload.len() + 2 > 0xFFFF {
                            return Err("EXIF 段超出 JPEG APP1 长度上限".into());
                        }
                        out.extend_from_slice(&[0xFF, 0xE1]);
                        out.extend_from_slice(&((new_payload.len() + 2) as u16).to_be_bytes());
                        out.extend_from_slice(&new_payload);
                        continue;
                    }
                    Ok(None) => {}
                    Err(err) => warnings.push(format!("EXIF 结构未能更新（已保留原样）：{err}")),
                }
            }
        }
        out.extend_from_slice(&data[seg.start..seg.end]);
    }
    Ok(Rewrite { bytes: out, written, cleared, warnings })
}

fn xmp_app1(packet: &str) -> Result<Vec<u8>, String> {
    let mut payload = XMP_JPEG_PREFIX.to_vec();
    payload.extend_from_slice(packet.as_bytes());
    if payload.len() + 2 > 0xFFFF {
        return Err("XMP 数据超过 JPEG APP1 段 64 KB 上限".into());
    }
    let mut seg = Vec::with_capacity(payload.len() + 4);
    seg.extend_from_slice(&[0xFF, 0xE1]);
    seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    seg.extend_from_slice(&payload);
    Ok(seg)
}

// ---------------------------------------------------------------------------
// 容器解析：PNG
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct PngChunk {
    typ: [u8; 4],
    data: Vec<u8>,
}

fn png_chunks(data: &[u8]) -> Result<Vec<PngChunk>, String> {
    if data.len() < 12 || !data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Err("不是有效的 PNG".into());
    }
    let mut out = Vec::new();
    let mut pos = 8usize;
    while pos + 8 <= data.len() {
        let len = be_u32(data, pos).ok_or("PNG 块长度越界")? as usize;
        let typ: [u8; 4] = data[pos + 4..pos + 8].try_into().map_err(|_| "PNG 块类型非法")?;
        let end = pos + 8 + len + 4;
        if end > data.len() {
            return Err(format!("PNG 块 {} 越界", String::from_utf8_lossy(&typ)));
        }
        out.push(PngChunk { typ, data: data[pos + 8..pos + 8 + len].to_vec() });
        pos = end;
        if typ == *b"IEND" {
            break;
        }
    }
    Ok(out)
}

fn png_chunk_bytes(chunk: &PngChunk) -> Vec<u8> {
    let mut out = Vec::with_capacity(chunk.data.len() + 12);
    out.extend_from_slice(&(chunk.data.len() as u32).to_be_bytes());
    out.extend_from_slice(&chunk.typ);
    out.extend_from_slice(&chunk.data);
    let mut crc_src = chunk.typ.to_vec();
    crc_src.extend_from_slice(&chunk.data);
    out.extend_from_slice(&crc32(&crc_src).to_be_bytes());
    out
}

fn png_xmp(data: &[u8], warnings: &mut Vec<String>) -> Option<String> {
    let chunks = png_chunks(data).ok()?;
    for chunk in &chunks {
        if chunk.typ != *b"iTXt" && chunk.typ != *b"tEXt" {
            continue;
        }
        if let Some((keyword, text)) = png_text_chunk(chunk, warnings) {
            if keyword == "XML:com.adobe.xmp" {
                return Some(text);
            }
        }
    }
    None
}

fn png_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let chunks = png_chunks(data)?;
    let existing = png_xmp(data, &mut Vec::new());
    let (packet, mut warnings) = build_xmp(existing.as_deref(), fields);
    let mut itxt = PngChunk {
        typ: *b"iTXt",
        data: png_itxt_payload("XML:com.adobe.xmp", &packet),
    };
    let new_chunk = png_chunk_bytes(&itxt);

    let mut out = Vec::with_capacity(data.len() + new_chunk.len());
    out.extend_from_slice(&data[..8]);
    let mut placed = false;
    for chunk in &chunks {
        if chunk.typ == *b"iTXt" {
            if let Some((keyword, _)) = png_text_chunk(chunk, &mut Vec::new()) {
                if keyword == "XML:com.adobe.xmp" {
                    if !placed {
                        out.extend_from_slice(&new_chunk);
                        placed = true;
                    }
                    continue;
                }
            }
        }
        if chunk.typ == *b"IEND" && !placed {
            out.extend_from_slice(&new_chunk);
            placed = true;
        }
        out.extend_from_slice(&png_chunk_bytes(chunk));
    }
    if !placed {
        warnings.push("PNG 缺少 IEND，XMP 追加在文件末尾".into());
        out.extend_from_slice(&new_chunk);
    }
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    collect_changes(fields, &mut written, &mut cleared);
    itxt.data.clear();
    Ok(Rewrite { bytes: out, written, cleared, warnings })
}

fn png_itxt_payload(keyword: &str, text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(keyword.as_bytes());
    out.push(0);
    out.push(0); // 未压缩
    out.push(0); // 压缩方法
    out.push(0); // 语言标签空
    out.push(0); // 翻译键空
    out.extend_from_slice(text.as_bytes());
    out
}

// ---------------------------------------------------------------------------
// 容器解析：WebP
// ---------------------------------------------------------------------------

struct WebpChunk {
    fourcc: [u8; 4],
    data: Vec<u8>,
}

fn webp_chunks(data: &[u8]) -> Result<Vec<WebpChunk>, String> {
    if data.len() < 12 || !data.starts_with(b"RIFF") || &data[8..12] != b"WEBP" {
        return Err("不是有效的 WebP".into());
    }
    let mut out = Vec::new();
    let mut pos = 12usize;
    while pos + 8 <= data.len() {
        let fourcc: [u8; 4] = data[pos..pos + 4].try_into().map_err(|_| "WebP 块类型非法")?;
        let size = u32_le(data, pos + 4).ok_or("WebP 块长度越界")? as usize;
        let end = pos + 8 + size;
        if end > data.len() {
            return Err(format!("WebP 块 {} 越界", String::from_utf8_lossy(&fourcc)));
        }
        out.push(WebpChunk { fourcc, data: data[pos + 8..end].to_vec() });
        pos = end + (size & 1);
    }
    Ok(out)
}

fn webp_chunk_bytes(fourcc: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 9);
    out.extend_from_slice(&fourcc);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    if payload.len() & 1 == 1 {
        out.push(0);
    }
    out
}

fn webp_xmp(data: &[u8]) -> Option<String> {
    let chunks = webp_chunks(data).ok()?;
    chunks
        .iter()
        .find(|c| &c.fourcc == b"XMP ")
        .map(|c| String::from_utf8_lossy(&c.data).to_string())
}

fn webp_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let chunks = webp_chunks(data)?;
    let existing = webp_xmp(data);
    let (packet, mut warnings) = build_xmp(existing.as_deref(), fields);
    let xmp_chunk = webp_chunk_bytes(*b"XMP ", packet.as_bytes());

    let has_vp8x = chunks.iter().any(|c| &c.fourcc == b"VP8X");
    let has_alpha = chunks.iter().any(|c| &c.fourcc == b"ALPH");
    let mut out_chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    if !has_vp8x {
        let (w, h) = webp_canvas(&chunks)?;
        let flags = 0x04u8 | if has_alpha { 0x10 } else { 0 };
        let mut payload = Vec::new();
        payload.push(flags);
        payload.extend_from_slice(&[0, 0, 0]); // 保留字节
        payload.extend_from_slice(&(w.saturating_sub(1) & 0xFF_FFFF).to_le_bytes()[..3]);
        payload.extend_from_slice(&(h.saturating_sub(1) & 0xFF_FFFF).to_le_bytes()[..3]);
        out_chunks.push((0, webp_chunk_bytes(*b"VP8X", &payload)));
        warnings.push("WebP 无 VP8X 扩展头，已自动补建（不重编码像素）".into());
    }

    for chunk in &chunks {
        if &chunk.fourcc == b"XMP " {
            if out_chunks.iter().any(|(k, _)| *k == 1) {
                continue;
            }
            out_chunks.push((1, xmp_chunk.clone()));
            continue;
        }
        if &chunk.fourcc == b"VP8X" {
            let mut payload = chunk.data.clone();
            if payload.len() >= 9 {
                payload[0] |= 0x04; // XMP 标志位
            }
            out_chunks.push((2, webp_chunk_bytes(*b"VP8X", &payload)));
            continue;
        }
        out_chunks.push((2, webp_chunk_bytes(chunk.fourcc, &chunk.data)));
    }
    if !out_chunks.iter().any(|(k, _)| *k == 1) {
        out_chunks.push((1, xmp_chunk));
    }

    let mut body = Vec::new();
    body.extend_from_slice(b"WEBP");
    for (_, bytes) in out_chunks {
        body.extend_from_slice(&bytes);
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);

    let mut written = Vec::new();
    let mut cleared = Vec::new();
    collect_changes(fields, &mut written, &mut cleared);
    Ok(Rewrite { bytes: out, written, cleared, warnings })
}

fn webp_canvas(chunks: &[WebpChunk]) -> Result<(u32, u32), String> {
    for chunk in chunks {
        match &chunk.fourcc {
            b"VP8L" => {
                let d = &chunk.data;
                if d.len() >= 5 && d[0] == 0x2F {
                    let bits = u32_le(d, 1).ok_or("VP8L 头越界")?;
                    let w = 1 + (bits & 0x3FFF);
                    let h = 1 + ((bits >> 14) & 0x3FFF);
                    return Ok((w, h));
                }
            }
            b"VP8 " => {
                let d = &chunk.data;
                if d.len() >= 10 && d[3] == 0x9D && d[4] == 0x01 && d[5] == 0x2A {
                    let w = (d[6] as u32 | ((d[7] as u32) << 8)) & 0x3FFF;
                    let h = (d[8] as u32 | ((d[9] as u32) << 8)) & 0x3FFF;
                    return Ok((w, h));
                }
            }
            _ => {}
        }
    }
    Err("无法从 WebP 像素块解析画布尺寸，拒绝补建 VP8X（避免破坏文件）".into())
}

// ---------------------------------------------------------------------------
// 容器解析：TIFF
// ---------------------------------------------------------------------------

struct TiffHeader {
    be: bool,
    ifd0: usize,
}

struct IfdEntry {
    tag: u16,
    typ: u16,
    count: u32,
    raw: [u8; 12],
}

impl IfdEntry {
    fn bytes<'a>(&'a self, tiff: &'a [u8], be: bool) -> Option<&'a [u8]> {
        let unit = type_size(self.typ)?;
        let total = (self.count as usize).checked_mul(unit)?;
        if total <= 4 {
            let start = 8;
            return tiff_bytes_in_entry(&self.raw, start, total, be);
        }
        let off = if be {
            u32::from_be_bytes([self.raw[8], self.raw[9], self.raw[10], self.raw[11]]) as usize
        } else {
            u32::from_le_bytes([self.raw[8], self.raw[9], self.raw[10], self.raw[11]]) as usize
        };
        tiff.get(off..off + total)
    }

    fn ascii(&self, tiff: &[u8], be: bool) -> Option<String> {
        let bytes = self.bytes(tiff, be)?;
        Some(String::from_utf8_lossy(bytes).to_string())
    }

    fn as_utf16(&self, tiff: &[u8], be: bool) -> Option<String> {
        let bytes = self.bytes(tiff, be)?;
        let units = bytes
            .chunks_exact(2)
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect::<Vec<_>>();
        let mut s = String::new();
        for u in units {
            if u == 0 {
                break;
            }
            if let Some(ch) = char::from_u32(u as u32) {
                s.push(ch);
            }
        }
        Some(s)
    }
}

fn tiff_bytes_in_entry<'a>(raw: &'a [u8; 12], start: usize, total: usize, _be: bool) -> Option<&'a [u8]> {
    if total == 0 || start + total > 12 {
        return None;
    }
    raw.get(start..start + total)
}

fn type_size(typ: u16) -> Option<usize> {
    Some(match typ {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => return None,
    })
}

impl TiffHeader {
    fn parse(tiff: &[u8]) -> Result<Self, String> {
        if tiff.len() < 8 {
            return Err("TIFF 头长度不足".into());
        }
        let be = match (tiff[0], tiff[1]) {
            (0x49, 0x49) => false,
            (0x4D, 0x4D) => true,
            _ => return Err("TIFF 字节序标记非法".into()),
        };
        let magic = if be { be_u16(tiff, 2) } else { u16_le(tiff, 2) }.ok_or("TIFF 头越界")?;
        if magic != 42 {
            return Err(format!("不支持的 TIFF 变体（magic={magic}）"));
        }
        let ifd0 = if be { be_u32(tiff, 4) } else { u32_le(tiff, 4) }.ok_or("TIFF IFD0 越界")? as usize;
        Ok(Self { be, ifd0 })
    }

    fn entries(&self, tiff: &[u8]) -> Result<(Vec<IfdEntry>, usize), String> {
        let count = if self.be { be_u16(tiff, self.ifd0) } else { u16_le(tiff, self.ifd0) }
            .ok_or("TIFF IFD0 越界")? as usize;
        if count > 4096 {
            return Err("TIFF IFD0 条目过多，拒绝解析".into());
        }
        let start = self.ifd0 + 2;
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let at = start + i * 12;
            let raw_slice = tiff.get(at..at + 12).ok_or("TIFF IFD0 条目越界")?;
            let mut raw = [0u8; 12];
            raw.copy_from_slice(raw_slice);
            let tag = if self.be { be_u16(tiff, at) } else { u16_le(tiff, at) }.ok_or("TIFF 标签越界")?;
            let typ = if self.be { be_u16(tiff, at + 2) } else { u16_le(tiff, at + 2) }.ok_or("TIFF 类型越界")?;
            let cnt = if self.be { be_u32(tiff, at + 4) } else { u32_le(tiff, at + 4) }.ok_or("TIFF 计数越界")?;
            entries.push(IfdEntry { tag, typ, count: cnt, raw });
        }
        let next_at = start + count * 12;
        let next = if self.be { be_u32(tiff, next_at) } else { u32_le(tiff, next_at) }
            .ok_or("TIFF next-IFD 越界")? as usize;
        Ok((entries, next))
    }
}

fn tiff_xmp(data: &[u8], warnings: &mut Vec<String>) -> Option<String> {
    let hdr = TiffHeader::parse(data).ok()?;
    let (entries, _) = hdr.entries(data).ok()?;
    let entry = entries.iter().find(|e| e.tag == 700)?;
    let bytes = entry.bytes(data, hdr.be)?;
    if entry.typ != 1 && entry.typ != 7 {
        warnings.push(format!("TIFF XMP 标签类型异常（type={}），按字节读取", entry.typ));
    }
    Some(String::from_utf8_lossy(bytes).to_string())
}

/// TIFF/EXIF 的 IFD0 重建：把 IFD0 整体搬到文件末尾并追加新条目，
/// 其余数据（GPS 子 IFD、MakerNotes、像素条带）的绝对偏移保持有效。
struct PendingEntry {
    raw: [u8; 12],
    payload: Option<Vec<u8>>,
}

fn tiff_update(data: &[u8], edits: &[(u16, u16, Vec<u8>)]) -> Result<Option<Vec<u8>>, String> {
    let hdr = TiffHeader::parse(data)?;
    let (entries, next) = hdr.entries(data)?;
    if edits.is_empty() {
        return Ok(None);
    }
    let mut out = data.to_vec();
    if out.len() & 1 == 1 {
        out.push(0);
    }
    let ifd_off = out.len();
    if ifd_off > u32::MAX as usize {
        return Err("TIFF 过大，IFD0 偏移超出 32 位".into());
    }
    let block = build_ifd(entries, edits, hdr.be, ifd_off, next)?;
    out.extend_from_slice(&block);
    out[4..8].copy_from_slice(&u32_bytes(ifd_off as u32, hdr.be));
    Ok(Some(out))
}

/// 在 `base` 处生成一个新 IFD（条目 + 外部数据区），偏移均为文件内绝对值。
fn build_ifd(
    entries: Vec<IfdEntry>,
    edits: &[(u16, u16, Vec<u8>)],
    be: bool,
    base: usize,
    next: usize,
) -> Result<Vec<u8>, String> {
    let edited_tags: Vec<u16> = edits.iter().map(|(t, _, _)| *t).collect();
    let mut pending: Vec<PendingEntry> = entries
        .into_iter()
        .filter(|e| !edited_tags.contains(&e.tag))
        .map(|e| PendingEntry { raw: e.raw, payload: None })
        .collect();
    for (tag, typ, payload) in edits {
        if payload.is_empty() {
            continue; // 清空 = 移除条目
        }
        let unit = type_size(*typ).ok_or_else(|| format!("未知 TIFF 类型 {typ}"))?;
        let mut raw = [0u8; 12];
        write_u16(&mut raw[0..2], *tag, be);
        write_u16(&mut raw[2..4], *typ, be);
        // TIFF 的 count 是「元素个数」，不是字节数（RATIONAL 等类型必须换算）
        write_u32(&mut raw[4..8], (payload.len() / unit) as u32, be);
        if payload.len() <= 4 {
            raw[8..8 + payload.len()].copy_from_slice(payload);
        }
        let payload = if payload.len() > 4 { Some(payload.clone()) } else { None };
        pending.push(PendingEntry { raw, payload });
    }
    let tag_of = |raw: &[u8; 12]| {
        if be {
            u16::from_be_bytes([raw[0], raw[1]])
        } else {
            u16::from_le_bytes([raw[0], raw[1]])
        }
    };
    pending.sort_by_key(|e| tag_of(&e.raw));

    let data_start = base + 2 + pending.len() * 12 + 4;
    let mut data_off = data_start;
    let mut ifd = Vec::with_capacity(2 + pending.len() * 12 + 4);
    ifd.extend_from_slice(&u16_bytes(pending.len() as u16, be));
    let mut tail: Vec<u8> = Vec::new();
    for entry in &pending {
        let mut raw = entry.raw;
        if let Some(payload) = &entry.payload {
            write_u32(&mut raw[8..12], data_off as u32, be);
            data_off += payload.len();
            if payload.len() & 1 == 1 {
                data_off += 1;
            }
            tail.extend_from_slice(payload);
            if payload.len() & 1 == 1 {
                tail.push(0);
            }
        }
        ifd.extend_from_slice(&raw);
    }
    ifd.extend_from_slice(&u32_bytes(next as u32, be));
    ifd.extend_from_slice(&tail);
    Ok(ifd)
}

/// 更新子 IFD（ExifIFD 0x8769 / GPS IFD 0x8825）：在文件末尾重建子 IFD，
/// 再把新的绝对偏移写回 IFD0 的指针条目。
fn tiff_update_sub(
    data: &[u8],
    pointer_tag: u16,
    edits: &[(u16, u16, Vec<u8>)],
) -> Result<Option<Vec<u8>>, String> {
    if edits.is_empty() {
        return Ok(None);
    }
    let hdr = TiffHeader::parse(data)?;
    let (ifd0, _) = hdr.entries(data)?;
    let existing = ifd0
        .iter()
        .find(|e| e.tag == pointer_tag && e.typ == 4 && e.count == 1)
        .map(|e| raw_u32(&e.raw, hdr.be) as usize)
        .filter(|off| *off != 0)
        .and_then(|off| ifd_at(data, off, hdr.be).ok());
    let (entries, next) = existing.unwrap_or_default();

    let mut out = data.to_vec();
    if out.len() & 1 == 1 {
        out.push(0);
    }
    let sub_off = out.len();
    if sub_off > u32::MAX as usize {
        return Err("TIFF 过大，子 IFD 偏移超出 32 位".into());
    }
    let block = build_ifd(entries, edits, hdr.be, sub_off, next)?;
    out.extend_from_slice(&block);
    let pointer = [(pointer_tag, 4u16, u32_bytes(sub_off as u32, hdr.be).to_vec())];
    tiff_update(&out, &pointer)
}

fn write_u16(dst: &mut [u8], value: u16, be: bool) {
    let bytes = if be { value.to_be_bytes() } else { value.to_le_bytes() };
    dst.copy_from_slice(&bytes);
}

fn write_u32(dst: &mut [u8], value: u32, be: bool) {
    let bytes = if be { value.to_be_bytes() } else { value.to_le_bytes() };
    dst.copy_from_slice(&bytes);
}

fn u16_bytes(value: u16, be: bool) -> [u8; 2] {
    if be { value.to_be_bytes() } else { value.to_le_bytes() }
}

fn u32_bytes(value: u32, be: bool) -> [u8; 4] {
    if be { value.to_be_bytes() } else { value.to_le_bytes() }
}

fn push_ascii(edits: &mut Vec<(u16, u16, Vec<u8>)>, tag: u16, value: &str) {
    let mut bytes = value.as_bytes().to_vec();
    if !bytes.is_empty() {
        bytes.push(0);
    }
    edits.push((tag, 2, bytes));
}

fn push_utf16(edits: &mut Vec<(u16, u16, Vec<u8>)>, tag: u16, value: &str) {
    let mut bytes = Vec::new();
    for ch in value.chars() {
        if ch == '\0' {
            continue;
        }
        let mut u16buf = [0u16; 2];
        for u in ch.encode_utf16(&mut u16buf) {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
    }
    edits.push((tag, 1, bytes));
}

fn exif_update(tiff: &[u8], fields: &FieldMap) -> Result<Option<Vec<u8>>, String> {
    let edits = exif_edits_for(fields, tiff);
    let mut data: Option<Vec<u8>> = None;
    if !edits.exif.is_empty() {
        let base = data.as_deref().unwrap_or(tiff);
        if let Some(next) = tiff_update_sub(base, TAG_EXIF_IFD, &edits.exif)? {
            data = Some(next);
        }
    }
    if !edits.gps.is_empty() {
        let base = data.as_deref().unwrap_or(tiff);
        if let Some(next) = tiff_update_sub(base, TAG_GPS_IFD, &edits.gps)? {
            data = Some(next);
        }
    }
    if !edits.ifd0.is_empty() {
        let base = data.as_deref().unwrap_or(tiff);
        if let Some(next) = tiff_update(base, &edits.ifd0)? {
            data = Some(next);
        }
    }
    Ok(data)
}

fn tiff_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let existing = tiff_xmp(data, &mut Vec::new());
    let (packet, mut warnings) = build_xmp(existing.as_deref(), fields);
    let edits = exif_edits_for(fields, data);
    let mut base = data.to_vec();
    if !edits.exif.is_empty() {
        if let Some(next) = tiff_update_sub(&base, TAG_EXIF_IFD, &edits.exif)? {
            base = next;
        }
    }
    if !edits.gps.is_empty() {
        if let Some(next) = tiff_update_sub(&base, TAG_GPS_IFD, &edits.gps)? {
            base = next;
        }
    }
    let mut ifd0 = edits.ifd0;
    ifd0.push((700, 1, packet.into_bytes()));
    let new_data = tiff_update(&base, &ifd0)?
        .ok_or_else(|| "TIFF IFD0 未产生变化".to_string())?;
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    collect_changes(fields, &mut written, &mut cleared);
    if !warnings.iter().any(|w| w.contains("XMP")) {
        warnings.push("TIFF 的 XMP 写入 IFD0 标签 700（多页 TIFF 的其余页不动）".into());
    }
    Ok(Rewrite { bytes: new_data, written, cleared, warnings })
}

/// EXIF 写入的三组条目：IFD0 / ExifIFD（0x8769）/ GPS IFD（0x8825）。
#[derive(Default)]
struct ExifEdits {
    ifd0: Vec<(u16, u16, Vec<u8>)>,
    exif: Vec<(u16, u16, Vec<u8>)>,
    gps: Vec<(u16, u16, Vec<u8>)>,
}

/// 型号 → 厂商的规范 Make 值；只认明确的厂商前缀与常见机型族，认不出返回 None。
fn vendor_for_model(model: &str) -> Option<&'static str> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() {
        return None;
    }
    const RULES: &[(&[&str], &str)] = &[
        (&["canon", "eos"], "Canon"),
        (&["nikon", "coolpix"], "NIKON CORPORATION"),
        (&["sony", "ilce-", "nex-", "dsc-"], "SONY"),
        (&["fujifilm", "x-t", "x100", "x-pro", "x-h", "x-s", "gfx"], "FUJIFILM"),
        (&["om system", "om-1", "om-5"], "OM Digital Solutions"),
        (&["olympus", "e-m", "e-p", "pen-"], "OLYMPUS CORPORATION"),
        (&["panasonic", "lumix"], "Panasonic"),
        (&["leica"], "Leica Camera AG"),
        (&["pentax", "ricoh"], "RICOH IMAGING COMPANY, LTD."),
        (&["dji"], "DJI"),
        (&["hasselblad"], "Hasselblad"),
        (&["apple", "iphone", "ipad"], "Apple"),
        (&["sigma"], "SIGMA"),
        (&["gopro"], "GoPro"),
        (&["samsung"], "SAMSUNG"),
        (&["xiaomi"], "Xiaomi"),
        (&["huawei"], "HUAWEI"),
        (&["google", "pixel"], "Google"),
    ];
    RULES
        .iter()
        .find(|(prefixes, _)| prefixes.iter().any(|p| m.starts_with(p)))
        .map(|(_, make)| *make)
}

fn exif_edits_for(fields: &FieldMap, tiff: &[u8]) -> ExifEdits {
    let be = TiffHeader::parse(tiff).map(|h| h.be).unwrap_or(false);
    let mut edits = ExifEdits::default();
    if let Some(v) = fields.get("title") {
        push_utf16(&mut edits.ifd0, 0x9C9B, v);
    }
    if let Some(v) = fields.get("description") {
        push_ascii(&mut edits.ifd0, 0x010E, v);
        push_utf16(&mut edits.ifd0, 0x9C9F, v);
    }
    if let Some(v) = fields.get("keywords") {
        push_utf16(&mut edits.ifd0, 0x9C9E, v);
    }
    if let Some(v) = fields.get("author") {
        push_ascii(&mut edits.ifd0, 0x013B, v);
        push_utf16(&mut edits.ifd0, 0x9C9D, v);
    }
    if let Some(v) = fields.get("copyright") {
        push_ascii(&mut edits.ifd0, 0x8298, v);
    }
    if let Some(v) = fields.get("software") {
        push_ascii(&mut edits.ifd0, 0x0131, v);
    }
    if let Some(v) = fields.get("model") {
        push_ascii(&mut edits.ifd0, 0x0110, v);
        // 型号能明确认出厂商时同步 Make，避免"Canon + Fujifilm X-T5"式自相矛盾
        if let Some(make) = vendor_for_model(v) {
            push_ascii(&mut edits.ifd0, 0x010F, make);
        }
    }
    if let Some(v) = fields.get("takenAt") {
        if let Some(t) = to_exif_time(v) {
            // DateTime 在 IFD0；DateTimeOriginal/Digitized 在 ExifIFD
            push_ascii(&mut edits.ifd0, 0x0132, &t);
            push_ascii(&mut edits.exif, 0x9003, &t);
            push_ascii(&mut edits.exif, 0x9004, &t);
        }
    }
    let gps_written = ["latitude", "longitude"]
        .iter()
        .any(|id| fields.get(*id).is_some_and(|v| !v.trim().is_empty()));
    if gps_written {
        // GPSVersionID = 2.3.0.0（BYTE×4）
        edits.gps.push((0x0000, 1, vec![2, 3, 0, 0]));
    }
    for (id, latitude) in [("latitude", true), ("longitude", false)] {
        let Some(v) = fields.get(id) else { continue };
        let (ref_tag, value_tag) = if latitude { (0x0001u16, 0x0002u16) } else { (0x0003, 0x0004) };
        if v.trim().is_empty() {
            edits.gps.push((ref_tag, 2, Vec::new()));
            edits.gps.push((value_tag, 5, Vec::new()));
            continue;
        }
        match gps_rationals(v, latitude, be) {
            Some((rationals, hemi)) => {
                push_ascii(&mut edits.gps, ref_tag, hemi);
                edits.gps.push((value_tag, 5, rationals.to_vec()));
            }
            None => {}
        }
    }
    edits
}

/// 十进制坐标 → EXIF GPS 的 3 个 RATIONAL（度/分/秒），秒精确到 1/10000。
fn gps_rationals(value: &str, latitude: bool, be: bool) -> Option<([u8; 24], &'static str)> {
    let v: f64 = value.trim().parse().ok()?;
    if !v.is_finite() || !(-180.0..=180.0).contains(&v) {
        return None;
    }
    let (hemi, abs) = if v < 0.0 {
        (if latitude { "S" } else { "W" }, -v)
    } else {
        (if latitude { "N" } else { "E" }, v)
    };
    let mut deg = abs.floor() as u32;
    let minutes_f = (abs - abs.floor()) * 60.0;
    let mut min = minutes_f.floor() as u32;
    let mut sec = ((minutes_f - minutes_f.floor()) * 60.0 * 10000.0).round() as u32;
    if sec >= 600000 {
        sec -= 600000;
        min += 1;
    }
    if min >= 60 {
        min -= 60;
        deg += 1;
    }
    let mut out = [0u8; 24];
    for (i, (num, den)) in [(deg, 1u32), (min, 1u32), (sec, 10000u32)].iter().enumerate() {
        write_u32(&mut out[i * 8..i * 8 + 4], *num, be);
        write_u32(&mut out[i * 8 + 4..i * 8 + 8], *den, be);
    }
    Some((out, hemi))
}

// ---------------------------------------------------------------------------
// XMP 包生成/合并
// ---------------------------------------------------------------------------

fn build_xmp(existing: Option<&str>, fields: &FieldMap) -> (String, Vec<String>) {
    let mut warnings = Vec::new();
    let mut packet = match existing {
        Some(text) if text.contains("<rdf:Description") => text.to_string(),
        _ => fresh_packet(),
    };
    if existing.is_some() && !existing.unwrap().contains("<rdf:Description") {
        warnings.push("原有 XMP 结构异常，已重建（未知属性可能丢失）".into());
    }
    let mut additions: Vec<String> = Vec::new();
    for (id, value) in fields {
        // 经纬度需要同时写坐标与半球 Ref，单独处理
        if id == "latitude" || id == "longitude" {
            let (prop, ref_prop) = if id == "latitude" {
                ("exif:GPSLatitude", "exif:GPSLatitudeRef")
            } else {
                ("exif:GPSLongitude", "exif:GPSLongitudeRef")
            };
            remove_element(&mut packet, prop);
            remove_element(&mut packet, ref_prop);
            if value.trim().is_empty() {
                continue;
            }
            match gps_dms(value, id == "latitude") {
                Some((dms, hemi)) => {
                    additions.push(format!("<{prop}>{}</{prop}>", xml_escape(&dms)));
                    additions.push(format!("<{ref_prop}>{hemi}</{ref_prop}>"));
                }
                None => warnings.push(format!("{id} 不是合法十进制坐标（范围 ±180），已跳过")),
            }
            continue;
        }
        let Some(prop) = xmp_prop(id) else {
            continue;
        };
        remove_element(&mut packet, prop);
        if value.trim().is_empty() {
            continue;
        }
        additions.push(property_xml(id, prop, value));
        // 型号能明确认出厂商时，XMP 的 tiff:Make 跟 EXIF 一起同步
        if id == "model" {
            if let Some(make) = vendor_for_model(value) {
                remove_element(&mut packet, "tiff:Make");
                additions.push(format!("<tiff:Make>{}</tiff:Make>", xml_escape(make)));
            }
        }
    }
    if additions.is_empty() {
        return (packet, warnings);
    }
    ensure_namespaces(&mut packet);
    if let Some(pos) = packet.find("</rdf:Description>") {
        let insert = format!("\n{}\n", additions.join("\n"));
        packet.insert_str(pos, &insert);
    } else {
        warnings.push("XMP 中没有 rdf:Description，新增属性被丢弃".into());
    }
    (packet, warnings)
}

fn property_xml(id: &str, prop: &str, value: &str) -> String {
    let escaped = xml_escape(value.trim());
    match id {
        "keywords" => {
            let items = split_keywords(value)
                .into_iter()
                .map(|v| format!("<rdf:li>{}</rdf:li>", xml_escape(&v)))
                .collect::<Vec<_>>()
                .join("");
            format!("<{prop}><rdf:Bag>{items}</rdf:Bag></{prop}>")
        }
        "author" => format!("<{prop}><rdf:Seq><rdf:li>{escaped}</rdf:li></rdf:Seq></{prop}>"),
        "title" | "description" | "copyright" => format!(
            "<{prop}><rdf:Alt><rdf:li xml:lang=\"x-default\">{escaped}</rdf:li></rdf:Alt></{prop}>"
        ),
        "takenAt" => {
            let iso = exif_time_to_iso(value).unwrap_or_else(|| value.to_string());
            format!("<{prop}>{}</{prop}>", xml_escape(&iso))
        }
        _ => format!("<{prop}>{escaped}</{prop}>"),
    }
}

fn ensure_namespaces(packet: &mut String) {
    let Some(start) = packet.find("<rdf:Description") else {
        return;
    };
    let Some(gt_rel) = packet[start..].find('>') else {
        return;
    };
    let tag_end = start + gt_rel;
    let open_tag = &packet[start..tag_end];
    let mut needed = Vec::new();
    if !open_tag.contains("xmlns:dc=") {
        needed.push(format!("xmlns:dc=\"{NS_DC}\""));
    }
    if !open_tag.contains("xmlns:xmp=") {
        needed.push(format!("xmlns:xmp=\"{NS_XMP}\""));
    }
    if !open_tag.contains("xmlns:photoshop=") {
        needed.push(format!("xmlns:photoshop=\"{NS_PHOTOSHOP}\""));
    }
    if !open_tag.contains("xmlns:tiff=") {
        needed.push(format!("xmlns:tiff=\"{NS_TIFF}\""));
    }
    if !open_tag.contains("xmlns:exif=") {
        needed.push(format!("xmlns:exif=\"{NS_EXIF}\""));
    }
    if !open_tag.contains("xmlns:Iptc4xmpCore=") {
        needed.push(format!("xmlns:Iptc4xmpCore=\"{NS_IPTC_CORE}\""));
    }
    if !open_tag.contains("xmlns:rdf=") {
        needed.push(format!("xmlns:rdf=\"{NS_RDF}\""));
    }
    if needed.is_empty() {
        return;
    }
    let at = tag_end;
    let insert_at = if packet[start..tag_end].trim_end().ends_with('/') { at - 1 } else { at };
    let insert = format!(" {}", needed.join(" "));
    packet.insert_str(insert_at, &insert);
}

fn fresh_packet() -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Renomio\">\n\
 <rdf:RDF xmlns:rdf=\"{NS_RDF}\">\n\
  <rdf:Description rdf:about=\"\" xmlns:dc=\"{NS_DC}\" xmlns:xmp=\"{NS_XMP}\" xmlns:photoshop=\"{NS_PHOTOSHOP}\" xmlns:tiff=\"{NS_TIFF}\" xmlns:exif=\"{NS_EXIF}\" xmlns:Iptc4xmpCore=\"{NS_IPTC_CORE}\">\n\
  </rdf:Description>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>"
    )
}

fn collect_changes(fields: &FieldMap, written: &mut Vec<String>, cleared: &mut Vec<String>) {
    for (id, value) in fields {
        if id == "cover" {
            continue;
        }
        if value.is_empty() {
            cleared.push(id.clone());
        } else {
            written.push(id.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// EXIF 清除（分组；Orientation 与 ICC 永不清除）
// ---------------------------------------------------------------------------

const TAG_ORIENTATION: u16 = 0x0112;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;
const TAG_XMP: u16 = 700;
const TAG_ICC: u16 = 34675;

fn raw_u32(raw: &[u8; 12], be: bool) -> u32 {
    if be {
        u32::from_be_bytes([raw[8], raw[9], raw[10], raw[11]])
    } else {
        u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]])
    }
}

fn raw_u16(raw: &[u8; 12], be: bool) -> u16 {
    if be {
        u16::from_be_bytes([raw[8], raw[9]])
    } else {
        u16::from_le_bytes([raw[8], raw[9]])
    }
}

fn ifd_at(tiff: &[u8], off: usize, be: bool) -> Result<(Vec<IfdEntry>, usize), String> {
    let count = if be { be_u16(tiff, off) } else { u16_le(tiff, off) }
        .ok_or("EXIF 子 IFD 越界")? as usize;
    if count > 4096 {
        return Err("EXIF 子 IFD 条目过多，拒绝解析".into());
    }
    let start = off + 2;
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let at = start + i * 12;
        let slice = tiff.get(at..at + 12).ok_or("EXIF 子 IFD 条目越界")?;
        let mut raw = [0u8; 12];
        raw.copy_from_slice(slice);
        let tag = if be { be_u16(tiff, at) } else { u16_le(tiff, at) }.ok_or("EXIF 标签越界")?;
        let typ = if be { be_u16(tiff, at + 2) } else { u16_le(tiff, at + 2) }.ok_or("EXIF 类型越界")?;
        let cnt = if be { be_u32(tiff, at + 4) } else { u32_le(tiff, at + 4) }.ok_or("EXIF 计数越界")?;
        entries.push(IfdEntry { tag, typ, count: cnt, raw });
    }
    let next_at = start + count * 12;
    let next = if be { be_u32(tiff, next_at) } else { u32_le(tiff, next_at) }.ok_or("EXIF next-IFD 越界")? as usize;
    Ok((entries, next))
}

fn tag_label(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x010F => "Make",
        0x0110 => "Model",
        0x0112 => "Orientation",
        0x011A => "XResolution",
        0x0131 => "Software",
        0x0132 => "DateTime",
        0x9003 => "DateTimeOriginal",
        0x9004 => "DateTimeDigitized",
        0x9010 => "OffsetTime",
        0x9011 => "OffsetTimeOriginal",
        0x9012 => "OffsetTimeDigitized",
        0x9291 => "SubSecTimeOriginal",
        0x9292 => "SubSecTimeDigitized",
        0x927C => "MakerNote",
        0xA430 => "CameraOwnerName",
        0xA431 => "BodySerialNumber",
        0xA432 => "LensSpecification",
        0xA433 => "LensMake",
        0xA434 => "LensModel",
        0xA435 => "LensSerialNumber",
        0x0001 => "GPSLatitudeRef",
        0x0002 => "GPSLatitude",
        0x0003 => "GPSLongitudeRef",
        0x0004 => "GPSLongitude",
        0x0005 => "GPSAltitudeRef",
        0x0006 => "GPSAltitude",
        0x0007 => "GPSTimeStamp",
        0x001D => "GPSDateStamp",
        0x0201 => "ThumbnailOffset",
        0x0202 => "ThumbnailLength",
        _ => return None,
    })
}

/// 该标签是否属于某个可清除分组（不属于任何分组的一律保留）
fn group_of(tag: u16) -> Option<&'static str> {
    match tag {
        TAG_GPS_IFD | 0x0001..=0x001F => Some("gps"),
        0x010F | 0x0110 | 0x927C | 0xA430..=0xA435 => Some("camera"),
        0x0132 | 0x9003 | 0x9004 | 0x9010..=0x9012 | 0x9291 | 0x9292 => Some("time"),
        0x0201 | 0x0202 => Some("thumbnail"),
        _ => None,
    }
}

fn tiff_inventory(tiff: &[u8], out: &mut ExifInventory) {
    let Ok(hdr) = TiffHeader::parse(tiff) else {
        out.warnings.push("EXIF 结构无法解析，按无 EXIF 处理".into());
        return;
    };
    let Ok((entries, next)) = hdr.entries(tiff) else {
        out.warnings.push("EXIF IFD0 无法解析，按无 EXIF 处理".into());
        return;
    };
    out.has_exif = true;
    out.has_thumbnail = next != 0;
    let collect = |tag: u16, groups: &mut Vec<ExifGroup>| {
        let Some(id) = group_of(tag) else { return };
        if let Some(label) = tag_label(tag) {
            push_item(groups, id, label);
        }
    };
    for entry in &entries {
        if entry.tag == TAG_ORIENTATION {
            out.orientation = raw_u16(&entry.raw, hdr.be);
            continue;
        }
        if entry.tag == TAG_ICC {
            out.has_icc = true;
            continue;
        }
        if entry.tag == TAG_XMP {
            out.has_xmp = true;
            continue;
        }
        if entry.tag == TAG_EXIF_IFD {
            let off = raw_u32(&entry.raw, hdr.be) as usize;
            if let Ok((sub, _)) = ifd_at(tiff, off, hdr.be) {
                for e in &sub {
                    if e.tag == TAG_ICC {
                        out.has_icc = true;
                    }
                    collect(e.tag, &mut out.groups);
                }
            }
            continue;
        }
        if entry.tag == TAG_GPS_IFD {
            let off = raw_u32(&entry.raw, hdr.be) as usize;
            if let Ok((sub, _)) = ifd_at(tiff, off, hdr.be) {
                if !sub.is_empty() {
                    // 有 GPS IFD 即视为存在定位信息
                    push_item(&mut out.groups, "gps", "GPS IFD");
                }
                for e in &sub {
                    collect(e.tag, &mut out.groups);
                }
            }
            continue;
        }
        collect(entry.tag, &mut out.groups);
    }
    if out.has_thumbnail {
        push_item(&mut out.groups, "thumbnail", "IFD1 缩略图");
    }
}

fn push_item(groups: &mut Vec<ExifGroup>, id: &str, item: &str) {
    let label = match id {
        "gps" => "GPS 定位信息",
        "camera" => "相机与镜头信息",
        "time" => "拍摄时间",
        "thumbnail" => "缩略图",
        _ => id,
    };
    if !groups.iter().any(|g| g.id == id) {
        groups.push(ExifGroup { id: id.into(), label: label.into(), items: Vec::new() });
    }
    let group = groups.iter_mut().find(|g| g.id == id).expect("刚插入");
    if !group.items.iter().any(|i| i == item) {
        group.items.push(item.to_string());
    }
}

/// 清除 EXIF 时是否保留该 IFD0 条目（Orientation 永远保留）
fn keep_ifd0(tag: u16, scopes: &ExifClearScopes) -> bool {
    if tag == TAG_ORIENTATION {
        return true;
    }
    if scopes.all {
        return false;
    }
    match group_of(tag) {
        Some("gps") => !scopes.gps,
        Some("camera") => !scopes.camera,
        Some("time") => !scopes.time,
        Some("thumbnail") => !scopes.thumbnail,
        _ => true,
    }
}

fn keep_exif(tag: u16, scopes: &ExifClearScopes) -> bool {
    if scopes.all {
        return false;
    }
    match group_of(tag) {
        Some("camera") => !scopes.camera,
        Some("time") => !scopes.time,
        _ => true,
    }
}

/// 在 TIFF（EXIF 数据块）上按分组剥离条目：原字节保留，重建 IFD0/ExifIFD/GPS IFD 追加到末尾。
fn tiff_strip(
    tiff: &[u8],
    scopes: &ExifClearScopes,
    drop_xmp: bool,
) -> Result<Option<Vec<u8>>, String> {
    let hdr = TiffHeader::parse(tiff)?;
    let (entries, next) = hdr.entries(tiff)?;

    let mut exif_off: Option<usize> = None;
    let mut gps_off: Option<usize> = None;
    for entry in &entries {
        if entry.tag == TAG_EXIF_IFD {
            exif_off = Some(raw_u32(&entry.raw, hdr.be) as usize);
        } else if entry.tag == TAG_GPS_IFD {
            gps_off = Some(raw_u32(&entry.raw, hdr.be) as usize);
        }
    }
    let exif_sub = match exif_off {
        Some(off) => ifd_at(tiff, off, hdr.be)?.0,
        None => Vec::new(),
    };
    let gps_sub = match gps_off {
        Some(off) => ifd_at(tiff, off, hdr.be)?.0,
        None => Vec::new(),
    };

    let mut changed = false;
    let mut kept0: Vec<[u8; 12]> = Vec::new();
    for entry in &entries {
        if entry.tag == TAG_EXIF_IFD || entry.tag == TAG_GPS_IFD {
            changed = true;
            continue;
        }
        if drop_xmp && entry.tag == TAG_XMP {
            changed = true;
            continue;
        }
        if !keep_ifd0(entry.tag, scopes) {
            changed = true;
            continue;
        }
        kept0.push(entry.raw);
    }

    let clear_gps = scopes.gps || scopes.all;
    let mut kept_exif: Vec<[u8; 12]> = Vec::new();
    for entry in &exif_sub {
        if keep_exif(entry.tag, scopes) {
            kept_exif.push(entry.raw);
        } else {
            changed = true;
        }
    }
    let mut kept_gps: Vec<[u8; 12]> = Vec::new();
    for entry in &gps_sub {
        if !clear_gps {
            kept_gps.push(entry.raw);
        } else {
            changed = true;
        }
    }
    if (scopes.thumbnail || scopes.all) && next != 0 {
        changed = true;
    }
    if !changed {
        return Ok(None);
    }

    let new_next = if scopes.thumbnail || scopes.all { 0usize } else { next };
    let mut out = tiff.to_vec();
    if out.len() & 1 == 1 {
        out.push(0);
    }
    let ifd0_off = out.len();
    if ifd0_off > u32::MAX as usize {
        return Err("TIFF 过大，IFD0 偏移超出 32 位".into());
    }
    let mut n0 = kept0.len();
    if !kept_exif.is_empty() {
        n0 += 1;
    }
    if !kept_gps.is_empty() {
        n0 += 1;
    }
    let ifd0_size = 2 + n0 * 12 + 4;
    let exif_new_off = if kept_exif.is_empty() { None } else { Some(ifd0_off + ifd0_size) };
    let exif_size = if kept_exif.is_empty() { 0 } else { 2 + kept_exif.len() * 12 + 4 };
    let gps_new_off = if kept_gps.is_empty() {
        None
    } else {
        Some(ifd0_off + ifd0_size + exif_size)
    };

    let pointer = |tag: u16, off: usize| -> [u8; 12] {
        let mut raw = [0u8; 12];
        write_u16(&mut raw[0..2], tag, hdr.be);
        write_u16(&mut raw[2..4], 4, hdr.be);
        write_u32(&mut raw[4..8], 1, hdr.be);
        write_u32(&mut raw[8..12], off as u32, hdr.be);
        raw
    };
    if let Some(off) = exif_new_off {
        kept0.push(pointer(TAG_EXIF_IFD, off));
    }
    if let Some(off) = gps_new_off {
        kept0.push(pointer(TAG_GPS_IFD, off));
    }
    kept0.sort_by_key(|raw| {
        if hdr.be {
            u16::from_be_bytes([raw[0], raw[1]])
        } else {
            u16::from_le_bytes([raw[0], raw[1]])
        }
    });

    let mut ifd0 = Vec::with_capacity(ifd0_size);
    ifd0.extend_from_slice(&u16_bytes(kept0.len() as u16, hdr.be));
    for raw in &kept0 {
        ifd0.extend_from_slice(raw);
    }
    ifd0.extend_from_slice(&u32_bytes(new_next as u32, hdr.be));
    out.extend_from_slice(&ifd0);

    if !kept_exif.is_empty() {
        out.extend_from_slice(&u16_bytes(kept_exif.len() as u16, hdr.be));
        for raw in &kept_exif {
            out.extend_from_slice(raw);
        }
        out.extend_from_slice(&u32_bytes(0, hdr.be));
    }
    if !kept_gps.is_empty() {
        out.extend_from_slice(&u16_bytes(kept_gps.len() as u16, hdr.be));
        for raw in &kept_gps {
            out.extend_from_slice(raw);
        }
        out.extend_from_slice(&u32_bytes(0, hdr.be));
    }
    out[4..8].copy_from_slice(&u32_bytes(ifd0_off as u32, hdr.be));
    Ok(Some(out))
}

/// 只移除 XMP 中与所选分组对应的属性（不整段丢弃 XMP）
fn strip_xmp(packet: &str, scopes: &ExifClearScopes) -> String {
    let mut out = packet.to_string();
    let mut props: Vec<&str> = Vec::new();
    if scopes.gps || scopes.all {
        props.extend([
            "exif:GPSLatitude",
            "exif:GPSLatitudeRef",
            "exif:GPSLongitude",
            "exif:GPSLongitudeRef",
            "exif:GPSAltitude",
            "exif:GPSAltitudeRef",
            "exif:GPSTimeStamp",
            "exif:GPSDateStamp",
            "photoshop:City",
            "Iptc4xmpCore:Location",
        ]);
    }
    if scopes.camera || scopes.all {
        props.extend([
            "tiff:Model",
            "tiff:Make",
            "exif:LensModel",
            "exif:LensMake",
            "exif:BodySerialNumber",
            "exif:LensSerialNumber",
            "exif:CameraOwnerName",
        ]);
    }
    if scopes.time || scopes.all {
        props.extend([
            "photoshop:DateCreated",
            "exif:DateTimeOriginal",
            "exif:DateTimeDigitized",
            "xmp:CreateDate",
            "xmp:ModifyDate",
        ]);
    }
    for prop in props {
        remove_element(&mut out, prop);
    }
    out
}

fn jpeg_has_icc(data: &[u8]) -> bool {
    jpeg_segments(data)
        .map(|segs| {
            segs.iter().any(|s| {
                s.marker == 0xE2
                    && s.data_start < s.end
                    && data[s.data_start..s.end].starts_with(b"ICC_PROFILE\0")
            })
        })
        .unwrap_or(false)
}

fn png_has_icc(data: &[u8]) -> bool {
    png_chunks(data)
        .map(|chunks| chunks.iter().any(|c| c.typ == *b"iCCP"))
        .unwrap_or(false)
}

fn webp_has_icc(data: &[u8]) -> bool {
    webp_chunks(data)
        .map(|chunks| chunks.iter().any(|c| &c.fourcc == b"ICCP"))
        .unwrap_or(false)
}

fn jpeg_pixels(data: &[u8]) -> Option<Vec<u8>> {
    let segs = jpeg_segments(data).ok()?;
    let sos = segs.iter().find(|s| s.marker == 0xDA)?;
    Some(data[sos.start..].to_vec())
}

fn png_pixels(data: &[u8]) -> Option<Vec<u8>> {
    let chunks = png_chunks(data).ok()?;
    let mut out = Vec::new();
    for chunk in &chunks {
        if chunk.typ == *b"IDAT" {
            out.extend_from_slice(&chunk.data);
        }
    }
    Some(out)
}

fn webp_pixels(data: &[u8]) -> Option<Vec<u8>> {
    let chunks = webp_chunks(data).ok()?;
    let mut out = Vec::new();
    for chunk in &chunks {
        if &chunk.fourcc == b"VP8 " || &chunk.fourcc == b"VP8L" || &chunk.fourcc == b"ALPH" {
            out.extend_from_slice(&chunk.data);
        }
    }
    Some(out)
}

pub fn pixel_bytes(format: ImageFormat, data: &[u8]) -> Option<Vec<u8>> {
    match format {
        ImageFormat::Jpeg => jpeg_pixels(data),
        ImageFormat::Png => png_pixels(data),
        ImageFormat::WebP => webp_pixels(data),
        ImageFormat::Tiff => None,
    }
}

fn jpeg_clear(data: &[u8], scopes: &ExifClearScopes, clear_xmp: bool) -> Result<Rewrite, String> {
    let segs = jpeg_segments(data)?;
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..2]);
    let mut warnings = Vec::new();
    let mut changed = false;
    let mut exif_seen = false;

    for seg in &segs {
        if seg.marker == 0xDA {
            out.extend_from_slice(&data[seg.start..]);
            break;
        }
        if seg.marker == 0xE1 && seg.data_start < seg.end {
            let payload = &data[seg.data_start..seg.end];
            if let Some(tiff) = payload.strip_prefix(b"Exif\0\0") {
                exif_seen = true;
                match tiff_strip(tiff, scopes, false) {
                    Ok(Some(new_tiff)) => {
                        let mut new_payload = b"Exif\0\0".to_vec();
                        new_payload.extend_from_slice(&new_tiff);
                        if new_payload.len() + 2 > 0xFFFF {
                            return Err("清除后 EXIF 段超出 JPEG APP1 长度上限".into());
                        }
                        out.extend_from_slice(&[0xFF, 0xE1]);
                        out.extend_from_slice(&((new_payload.len() + 2) as u16).to_be_bytes());
                        out.extend_from_slice(&new_payload);
                        changed = true;
                        continue;
                    }
                    Ok(None) => {}
                    Err(err) => return Err(format!("EXIF 结构无法安全重建，已中止：{err}")),
                }
            } else if payload.starts_with(XMP_JPEG_PREFIX) {
                if clear_xmp {
                    let packet = String::from_utf8_lossy(&payload[XMP_JPEG_PREFIX.len()..]).to_string();
                    let stripped = strip_xmp(&packet, scopes);
                    out.extend_from_slice(&xmp_app1(&stripped)?);
                    changed = true;
                    continue;
                }
            }
        }
        out.extend_from_slice(&data[seg.start..seg.end]);
    }
    if !exif_seen {
        warnings.push("JPEG 中未发现 EXIF 段".into());
    }
    if !changed {
        warnings.push("所选范围没有可清除项，文件未改动".into());
    }
    Ok(Rewrite {
        bytes: out,
        written: Vec::new(),
        cleared: scopes.label(),
        warnings,
    })
}

fn png_clear(data: &[u8], scopes: &ExifClearScopes, clear_xmp: bool) -> Result<Rewrite, String> {
    let chunks = png_chunks(data)?;
    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..8]);
    let mut warnings = Vec::new();
    let mut changed = false;
    let mut exif_seen = false;
    for chunk in &chunks {
        if chunk.typ == *b"eXIf" {
            exif_seen = true;
            match tiff_strip(&chunk.data, scopes, false) {
                Ok(Some(new_tiff)) => {
                    out.extend_from_slice(&png_chunk_bytes(&PngChunk { typ: *b"eXIf", data: new_tiff }));
                    changed = true;
                    continue;
                }
                Ok(None) => {}
                Err(err) => return Err(format!("eXIf 结构无法安全重建，已中止：{err}")),
            }
        }
        if chunk.typ == *b"iTXt" && clear_xmp {
            if let Some((keyword, text)) = png_text_chunk(chunk, &mut Vec::new()) {
                if keyword == "XML:com.adobe.xmp" {
                    let stripped = strip_xmp(&text, scopes);
                    let body = png_itxt_payload(&keyword, &stripped);
                    out.extend_from_slice(&png_chunk_bytes(&PngChunk { typ: *b"iTXt", data: body }));
                    changed = true;
                    continue;
                }
            }
        }
        out.extend_from_slice(&png_chunk_bytes(chunk));
    }
    if !exif_seen {
        warnings.push("PNG 中未发现 eXIf 块".into());
    }
    if !changed {
        warnings.push("所选范围没有可清除项，文件未改动".into());
    }
    Ok(Rewrite { bytes: out, written: Vec::new(), cleared: scopes.label(), warnings })
}

fn webp_clear(data: &[u8], scopes: &ExifClearScopes, clear_xmp: bool) -> Result<Rewrite, String> {
    let chunks = webp_chunks(data)?;
    let mut warnings = Vec::new();
    let mut changed = false;
    let mut exif_seen = false;
    let mut out_chunks: Vec<(u8, Vec<u8>)> = Vec::new();
    for chunk in &chunks {
        if &chunk.fourcc == b"EXIF" || &chunk.fourcc == b"Exif" {
            exif_seen = true;
            match tiff_strip(&chunk.data, scopes, false) {
                Ok(Some(new_tiff)) => {
                    out_chunks.push((2, webp_chunk_bytes(*b"EXIF", &new_tiff)));
                    changed = true;
                    continue;
                }
                Ok(None) => {}
                Err(err) => return Err(format!("WebP EXIF 块无法安全重建，已中止：{err}")),
            }
        }
        if &chunk.fourcc == b"XMP " && clear_xmp {
            let stripped = strip_xmp(&String::from_utf8_lossy(&chunk.data), scopes);
            out_chunks.push((2, webp_chunk_bytes(*b"XMP ", stripped.as_bytes())));
            changed = true;
            continue;
        }
        out_chunks.push((2, webp_chunk_bytes(chunk.fourcc, &chunk.data)));
    }
    if !exif_seen {
        warnings.push("WebP 中未发现 EXIF 块".into());
    }
    if !changed {
        warnings.push("所选范围没有可清除项，文件未改动".into());
    }
    let mut body = Vec::new();
    body.extend_from_slice(b"WEBP");
    for (_, bytes) in out_chunks {
        body.extend_from_slice(&bytes);
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(Rewrite { bytes: out, written: Vec::new(), cleared: scopes.label(), warnings })
}

fn tiff_clear(data: &[u8], scopes: &ExifClearScopes, clear_xmp: bool) -> Result<Rewrite, String> {
    let mut warnings = Vec::new();
    let new_data = tiff_strip(data, scopes, clear_xmp)?;
    match new_data {
        Some(bytes) => {
            if clear_xmp {
                warnings.push("已同时移除 TIFF IFD0 中的 XMP 标签 700".into());
            }
            Ok(Rewrite { bytes, written: Vec::new(), cleared: scopes.label(), warnings })
        }
        None => {
            warnings.push("所选范围没有可清除项，文件未改动".into());
            Ok(Rewrite { bytes: data.to_vec(), written: Vec::new(), cleared: scopes.label(), warnings })
        }
    }
}

pub fn clear_exif(
    format: ImageFormat,
    data: &[u8],
    scopes: &ExifClearScopes,
    clear_xmp: bool,
) -> Result<Rewrite, String> {
    if !scopes.any() {
        return Err("没有勾选任何清除范围".into());
    }
    match format {
        ImageFormat::Jpeg => jpeg_clear(data, scopes, clear_xmp),
        ImageFormat::Png => png_clear(data, scopes, clear_xmp),
        ImageFormat::WebP => webp_clear(data, scopes, clear_xmp),
        ImageFormat::Tiff => tiff_clear(data, scopes, clear_xmp),
    }
}

/// 清除前预览：按文件实际存在的条目列出，不套用固定清单。
pub fn inventory(path: &str, format: ImageFormat, data: &[u8]) -> ExifInventory {
    let mut out = ExifInventory {
        path: path.to_string(),
        format: format.name().to_string(),
        groups: Vec::new(),
        orientation: 0,
        orientation_kept: true,
        has_icc: false,
        has_exif: false,
        has_xmp: false,
        has_thumbnail: false,
        warnings: Vec::new(),
    };
    match format {
        ImageFormat::Jpeg => {
            out.has_icc = jpeg_has_icc(data);
            out.has_xmp = jpeg_xmp(data).is_some();
            if let Some(tiff) = jpeg_exif(data) {
                tiff_inventory(&tiff, &mut out);
            } else {
                out.warnings.push("未发现 EXIF 段（可能只有 XMP/ICC）".into());
            }
        }
        ImageFormat::Png => {
            out.has_icc = png_has_icc(data);
            out.has_xmp = png_xmp(data, &mut Vec::new()).is_some();
            let chunks = png_chunks(data).unwrap_or_default();
            if let Some(chunk) = chunks.iter().find(|c| c.typ == *b"eXIf") {
                tiff_inventory(&chunk.data, &mut out);
            } else {
                out.warnings.push("未发现 eXIf 块".into());
            }
        }
        ImageFormat::WebP => {
            out.has_icc = webp_has_icc(data);
            out.has_xmp = webp_xmp(data).is_some();
            let chunks = webp_chunks(data).unwrap_or_default();
            if let Some(chunk) = chunks.iter().find(|c| &c.fourcc == b"EXIF" || &c.fourcc == b"Exif") {
                tiff_inventory(&chunk.data, &mut out);
            } else {
                out.warnings.push("未发现 EXIF 块".into());
            }
        }
        ImageFormat::Tiff => {
            out.has_xmp = tiff_xmp(data, &mut Vec::new()).is_some();
            let hdr = TiffHeader::parse(data);
            if let Ok(hdr) = hdr {
                if let Ok((entries, _)) = hdr.entries(data) {
                    out.has_icc = entries.iter().any(|e| e.tag == TAG_ICC);
                }
            }
            tiff_inventory(data, &mut out);
        }
    }
    // 分组顺序固定，便于界面稳定展示
    let order = ["gps", "camera", "time", "thumbnail"];
    out.groups.sort_by_key(|g| order.iter().position(|id| *id == g.id).unwrap_or(9));
    // EXIF 里存在 Orientation ≠ 1 时把值保留在预览上，提示用户不会被清
    if out.orientation > 0 {
        out.warnings.push(format!(
            "Orientation={} 将在清除后保留（避免照片方向躺倒）",
            out.orientation
        ));
    }
    if out.has_icc {
        out.warnings.push("ICC 色彩配置将保留（不影响颜色）".into());
    }
    out.warnings
        .push("XMP 默认保留；如需同时清除对应项，请在界面上显式勾选".into());
    out
}

// ---------------------------------------------------------------------------
// 写回入口
// ---------------------------------------------------------------------------

pub fn rewrite(format: ImageFormat, data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    if fields.is_empty() {
        return Err("没有勾选任何字段".into());
    }
    match format {
        ImageFormat::Jpeg => jpeg_rewrite(data, fields),
        ImageFormat::Png => png_rewrite(data, fields),
        ImageFormat::WebP => webp_rewrite(data, fields),
        ImageFormat::Tiff => tiff_rewrite(data, fields),
    }
}

/// 供测试与验证脚本使用：读取图片文本字段。
pub fn read_fields(format: ImageFormat, data: &[u8]) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut warnings = Vec::new();
    let packet = match format {
        ImageFormat::Jpeg => jpeg_xmp(data),
        ImageFormat::Png => png_xmp(data, &mut warnings),
        ImageFormat::WebP => webp_xmp(data),
        ImageFormat::Tiff => tiff_xmp(data, &mut warnings),
    };
    if let Some(packet) = packet {
        read_xmp(&packet, &mut fields);
    }
    let exif = match format {
        ImageFormat::Jpeg => jpeg_exif(data),
        ImageFormat::Tiff => Some(data.to_vec()),
        _ => None,
    };
    if let Some(exif) = exif {
        read_exif(&exif, &mut fields);
    }
    if format == ImageFormat::Png {
        read_png_text(data, &mut fields, &mut warnings);
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png() -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&png_chunk_bytes(&PngChunk {
            typ: *b"IHDR",
            data: {
                let mut d = Vec::new();
                d.extend_from_slice(&640u32.to_be_bytes());
                d.extend_from_slice(&480u32.to_be_bytes());
                d.extend_from_slice(&[8, 2, 0, 0, 0]);
                d
            },
        }));
        png.extend_from_slice(&png_chunk_bytes(&PngChunk { typ: *b"IDAT", data: vec![1, 2, 3, 4] }));
        png.extend_from_slice(&png_chunk_bytes(&PngChunk { typ: *b"IEND", data: vec![] }));
        png
    }

    #[test]
    fn iptc_core_fields_written_to_xmp_and_read_back() {
        let mut fields = FieldMap::new();
        fields.insert("headline".into(), "春游".into());
        fields.insert("bylineTitle".into(), "摄影记者".into());
        fields.insert("credit".into(), "某通讯社".into());
        fields.insert("source".into(), "素材库".into());

        let (packet, warnings) = build_xmp(None, &fields);
        assert!(warnings.is_empty());
        for prop in [
            "photoshop:Headline",
            "photoshop:AuthorsPosition",
            "photoshop:Credit",
            "photoshop:Source",
        ] {
            assert!(packet.contains(prop), "应写入 {prop}");
        }

        let mut read = FieldMap::new();
        read_xmp(&packet, &mut read);
        assert_eq!(read.get("headline").map(String::as_str), Some("春游"));
        assert_eq!(read.get("bylineTitle").map(String::as_str), Some("摄影记者"));
        assert_eq!(read.get("credit").map(String::as_str), Some("某通讯社"));
        assert_eq!(read.get("source").map(String::as_str), Some("素材库"));

        // 清空即移除对应属性
        let mut cleared = FieldMap::new();
        cleared.insert("credit".into(), String::new());
        let (packet2, _) = build_xmp(Some(&packet), &cleared);
        assert!(!packet2.contains("photoshop:Credit"));
    }

    fn sample_jpeg() -> Vec<u8> {
        let mut jpeg = vec![0xFF, 0xD8];
        // SOF0
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&600u16.to_be_bytes());
        jpeg.extend_from_slice(&800u16.to_be_bytes());
        jpeg.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        // SOS
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
        jpeg.extend_from_slice(&[0x11, 0x22, 0x33]);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        jpeg
    }

    #[test]
    fn png_roundtrip_only_selected_fields() {
        let data = sample_png();
        let fields = BTreeMap::from([
            ("title".to_string(), "专辑封面".to_string()),
            ("author".to_string(), "张三".to_string()),
        ]);
        let rw = png_rewrite(&data, &fields).unwrap();
        let read = read_fields(ImageFormat::Png, &rw.bytes);
        assert_eq!(read.get("title").map(|s| s.as_str()), Some("专辑封面"));
        assert_eq!(read.get("author").map(|s| s.as_str()), Some("张三"));
        assert!(!read.contains_key("software"));
        // IHDR / IDAT / IEND 仍完整
        let chunks = png_chunks(&rw.bytes).unwrap();
        assert!(chunks.iter().any(|c| c.typ == *b"IHDR"));
        assert!(chunks.iter().any(|c| c.typ == *b"IDAT"));
        assert_eq!(chunks.last().unwrap().typ, *b"IEND");
    }

    #[test]
    fn png_merge_keeps_unknown_xmp_property() {
        let existing = format!(
            "<?xpacket begin=\"\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"{NS_RDF}\"><rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"><xmp:Rating>5</xmp:Rating><dc:title xmlns:dc=\"{NS_DC}\"><rdf:Alt><rdf:li xml:lang=\"x-default\">旧标题</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>"
        );
        let fields = BTreeMap::from([("title".to_string(), "新标题".to_string())]);
        let (packet, _) = build_xmp(Some(&existing), &fields);
        assert!(packet.contains("xmp:Rating>5"));
        assert!(packet.contains("新标题"));
        assert!(!packet.contains("旧标题"));
    }

    #[test]
    fn png_clear_field_removes_property() {
        let data = sample_png();
        let set = png_rewrite(
            &data,
            &BTreeMap::from([("title".to_string(), "标题".to_string())]),
        )
        .unwrap();
        let back = read_fields(ImageFormat::Png, &set.bytes);
        assert_eq!(back.get("title").map(|s| s.as_str()), Some("标题"));
        let cleared = png_rewrite(&set.bytes, &BTreeMap::from([("title".to_string(), String::new())])).unwrap();
        let after = read_fields(ImageFormat::Png, &cleared.bytes);
        assert!(!after.contains_key("title"));
    }

    #[test]
    fn jpeg_roundtrip_and_structure() {
        let data = sample_jpeg();
        let rw = jpeg_rewrite(
            &data,
            &BTreeMap::from([
                ("title".to_string(), "旅行".to_string()),
                ("keywords".to_string(), "a; b".to_string()),
            ]),
        )
        .unwrap();
        let read = read_fields(ImageFormat::Jpeg, &rw.bytes);
        assert_eq!(read.get("title").map(|s| s.as_str()), Some("旅行"));
        assert_eq!(read.get("keywords").map(|s| s.as_str()), Some("a; b"));
        let segs = jpeg_segments(&rw.bytes).unwrap();
        assert!(segs.iter().any(|s| s.marker == 0xC0));
        assert!(rw.bytes.ends_with(&[0xFF, 0xD9]));
    }

    #[test]
    fn webp_adds_vp8x_and_xmp() {
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(b"WEBP");
        let mut vp8 = vec![0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a];
        vp8.extend_from_slice(&0x10u16.to_le_bytes());
        vp8.extend_from_slice(&0x10u16.to_le_bytes());
        vp8.extend_from_slice(&[0u8; 8]);
        data.extend_from_slice(&webp_chunk_bytes(*b"VP8 ", &vp8));
        let riff_len = (data.len() - 8) as u32;
        data[4..8].copy_from_slice(&riff_len.to_le_bytes());

        let rw = webp_rewrite(&data, &BTreeMap::from([("title".to_string(), "封面".to_string())])).unwrap();
        let chunks = webp_chunks(&rw.bytes).unwrap();
        assert_eq!(&chunks[0].fourcc, b"VP8X");
        assert_eq!(chunks[0].data[0] & 0x04, 0x04);
        assert!(chunks.iter().any(|c| &c.fourcc == b"XMP "));
        let read = read_fields(ImageFormat::WebP, &rw.bytes);
        assert_eq!(read.get("title").map(|s| s.as_str()), Some("封面"));
    }

    #[test]
    fn tiff_roundtrip_keeps_other_ifd() {
        // 小端 TIFF：IFD0 有 ImageDescription（ASCII），另有 IFD1(缩略图)指针
        let mut tiff = vec![0x49, 0x49, 0x2A, 0x00];
        let ifd0 = 8u32;
        tiff.extend_from_slice(&ifd0.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 entry
        tiff.extend_from_slice(&0x010Eu16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&6u32.to_le_bytes());
        let desc_off = 8 + 2 + 12 + 4;
        tiff.extend_from_slice(&(desc_off as u32).to_le_bytes());
        tiff.extend_from_slice(&26u32.to_le_bytes()); // next IFD（不存在的偏移，仅验证保留）
        tiff.extend_from_slice(b"hello\0");

        let rw = tiff_rewrite(
            &tiff,
            &BTreeMap::from([
                ("title".to_string(), "相片".to_string()),
                ("author".to_string(), "李四".to_string()),
            ]),
        )
        .unwrap();
        let read = read_fields(ImageFormat::Tiff, &rw.bytes);
        assert_eq!(read.get("title").map(|s| s.as_str()), Some("相片"));
        assert_eq!(read.get("author").map(|s| s.as_str()), Some("李四"));
        assert_eq!(read.get("description").map(|s| s.as_str()), Some("hello"));
        let hdr = TiffHeader::parse(&rw.bytes).unwrap();
        let (_, next) = hdr.entries(&rw.bytes).unwrap();
        assert_eq!(next, 26);
    }

    #[test]
    fn tiff_clear_removes_description_but_keeps_xmp() {
        let mut tiff = vec![0x49, 0x49, 0x2A, 0x00];
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x010Eu16.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&6u32.to_le_bytes());
        let desc_off = 8 + 2 + 12 + 4;
        tiff.extend_from_slice(&(desc_off as u32).to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        tiff.extend_from_slice(b"hello\0");

        let set = tiff_rewrite(
            &tiff,
            &BTreeMap::from([("description".to_string(), "描述".to_string())]),
        )
        .unwrap();
        assert_eq!(read_fields(ImageFormat::Tiff, &set.bytes).get("description").map(|s| s.as_str()), Some("描述"));
        let cleared = tiff_rewrite(&set.bytes, &BTreeMap::from([("description".to_string(), String::new())])).unwrap();
        assert!(read_fields(ImageFormat::Tiff, &cleared.bytes).get("description").is_none());
        assert!(read_fields(ImageFormat::Tiff, &cleared.bytes).contains_key("title") == false);
    }

    /// 最小 TIFF 构造器（小端），用于生成带 ExifIFD / GPS IFD 的样本。
    struct TiffFixture {
        data: Vec<u8>,
    }

    impl TiffFixture {
        fn new() -> Self {
            let mut data = vec![0x49, 0x49, 0x2A, 0x00, 0, 0, 0, 0];
            Self { data }
        }

        fn ifd(&mut self, entries: &[(u16, u16, Vec<u8>)]) -> usize {
            let off = self.data.len();
            let mut pos = off + 2 + entries.len() * 12 + 4;
            let mut tail = Vec::new();
            let mut table = vec![0u8; 2];
            table.copy_from_slice(&u16_bytes(entries.len() as u16, false));
            for (tag, typ, payload) in entries {
                let unit = type_size(*typ).unwrap();
                table.extend_from_slice(&u16_bytes(*tag, false));
                table.extend_from_slice(&u16_bytes(*typ, false));
                table.extend_from_slice(&u32_bytes((payload.len() / unit) as u32, false));
                if payload.len() <= 4 {
                    let mut inline = [0u8; 4];
                    inline[..payload.len()].copy_from_slice(payload);
                    table.extend_from_slice(&inline);
                } else {
                    table.extend_from_slice(&u32_bytes(pos as u32, false));
                    tail.extend_from_slice(payload);
                    if payload.len() & 1 == 1 {
                        tail.push(0);
                        pos += 1;
                    }
                    pos += payload.len();
                }
            }
            table.extend_from_slice(&u32_bytes(0, false));
            self.data.extend_from_slice(&table);
            self.data.extend_from_slice(&tail);
            off
        }

        fn finish_ifd0(&mut self, off: usize) {
            self.data[4..8].copy_from_slice(&u32_bytes(off as u32, false));
        }
    }

    fn rationals_bytes(pairs: &[(u32, u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (num, den) in pairs {
            out.extend_from_slice(&num.to_le_bytes());
            out.extend_from_slice(&den.to_le_bytes());
        }
        out
    }

    /// IFD0（仅 Model + 两个子 IFD 指针）、ExifIFD（DateTimeOriginal）、GPS IFD（旧坐标）。
    fn sample_exif_tiff() -> Vec<u8> {
        let mut b = TiffFixture::new();
        let exif_off = b.ifd(&[(0x9003, 2, b"2024:05:01 10:20:30\0".to_vec())]);
        let gps_off = b.ifd(&[
            (0x0000, 1, vec![2, 3, 0, 0]),
            (0x0001, 2, b"S\0".to_vec()),
            (0x0002, 5, rationals_bytes(&[(31, 1), (14, 1), (229200, 10000)])),
            (0x0003, 2, b"W\0".to_vec()),
            (0x0004, 5, rationals_bytes(&[(121, 1), (29, 1), (592800, 10000)])),
        ]);
        let ifd0_off = b.ifd(&[
            (0x010F, 2, b"Canon\0".to_vec()),
            (0x0110, 2, b"Canon EOS R6\0".to_vec()),
            (0x8769, 4, u32_bytes(exif_off as u32, false).to_vec()),
            (0x8825, 4, u32_bytes(gps_off as u32, false).to_vec()),
        ]);
        b.finish_ifd0(ifd0_off);
        b.data
    }

    fn jpeg_with_exif(tiff: &[u8]) -> Vec<u8> {
        let base = sample_jpeg();
        let mut out = base[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(tiff);
        out.extend_from_slice(&base[2..]);
        out
    }

    fn entry_of<'a>(group: &'a [IfdEntry], tag: u16) -> &'a IfdEntry {
        group.iter().find(|e| e.tag == tag).unwrap_or_else(|| panic!("缺少标签 {tag:#06x}"))
    }

    fn rationals_to_decimal(entry: &IfdEntry, tiff: &[u8], be: bool) -> f64 {
        let bytes = entry.bytes(tiff, be).unwrap();
        let mut parts = Vec::new();
        for chunk in bytes.chunks_exact(8).take(3) {
            let num = if be {
                u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
            } else {
                u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
            };
            let den = if be {
                u32::from_be_bytes([chunk[4], chunk[5], chunk[6], chunk[7]])
            } else {
                u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]])
            };
            parts.push(num as f64 / den as f64);
        }
        parts[0] + parts[1] / 60.0 + parts[2] / 3600.0
    }

    #[test]
    fn read_exif_reads_datetime_original_from_exif_ifd() {
        let mut fields = FieldMap::new();
        read_exif(&sample_exif_tiff(), &mut fields);
        assert_eq!(
            fields.get("takenAt").map(String::as_str),
            Some("2024-05-01T10:20:30"),
            "DateTimeOriginal 位于 ExifIFD，应能被读到"
        );
        assert_eq!(fields.get("model").map(String::as_str), Some("Canon EOS R6"));
    }

    #[test]
    fn exif_write_keeps_xmp_and_sub_ifds_consistent() {
        let data = jpeg_with_exif(&sample_exif_tiff());
        let fields = BTreeMap::from([
            ("model".to_string(), "Fujifilm X-T5".to_string()),
            ("takenAt".to_string(), "2024-07-08T06:12:33".to_string()),
            ("latitude".to_string(), "31.239700".to_string()),
            ("longitude".to_string(), "121.499800".to_string()),
        ]);
        let rw = jpeg_rewrite(&data, &fields).unwrap();
        let xmp = jpeg_xmp(&rw.bytes).unwrap();
        let tiff = jpeg_exif(&rw.bytes).unwrap();
        let hdr = TiffHeader::parse(&tiff).unwrap();
        let (ifd0, _) = hdr.entries(&tiff).unwrap();

        // IFD0:Model 与 XMP tiff:Model 一致，Make 随型号联动为厂商规范值
        let model = entry_of(&ifd0, 0x0110).ascii(&tiff, hdr.be).unwrap();
        assert_eq!(model.trim_matches('\0'), "Fujifilm X-T5");
        let make = entry_of(&ifd0, 0x010F).ascii(&tiff, hdr.be).unwrap();
        assert_eq!(make.trim_matches('\0'), "FUJIFILM");
        assert!(xmp.contains("<tiff:Model>Fujifilm X-T5</tiff:Model>"), "{xmp}");
        assert!(xmp.contains("<tiff:Make>FUJIFILM</tiff:Make>"), "{xmp}");

        // IFD0:DateTime 与 ExifIFD:DateTimeOriginal / DateTimeDigitized 同步
        let dt = entry_of(&ifd0, 0x0132).ascii(&tiff, hdr.be).unwrap();
        assert_eq!(dt.trim_matches('\0'), "2024:07:08 06:12:33");
        let exif_off = raw_u32(&entry_of(&ifd0, 0x8769).raw, hdr.be) as usize;
        let (exif, _) = ifd_at(&tiff, exif_off, hdr.be).unwrap();
        for tag in [0x9003u16, 0x9004] {
            let v = entry_of(&exif, tag).ascii(&tiff, hdr.be).unwrap();
            assert_eq!(v.trim_matches('\0'), "2024:07:08 06:12:33", "标签 {tag:#06x}");
        }

        // GPS IFD 与 XMP 坐标一致（误差 ≤ 1e-6 度）
        let gps_off = raw_u32(&entry_of(&ifd0, 0x8825).raw, hdr.be) as usize;
        let (gps, _) = ifd_at(&tiff, gps_off, hdr.be).unwrap();
        let lat = rationals_to_decimal(entry_of(&gps, 0x0002), &tiff, hdr.be);
        let lon = rationals_to_decimal(entry_of(&gps, 0x0004), &tiff, hdr.be);
        assert!((lat - 31.2397).abs() < 1e-6, "lat={lat}");
        assert!((lon - 121.4998).abs() < 1e-6, "lon={lon}");
        assert_eq!(entry_of(&gps, 0x0001).ascii(&tiff, hdr.be).unwrap().trim_matches('\0'), "N");
        assert_eq!(entry_of(&gps, 0x0003).ascii(&tiff, hdr.be).unwrap().trim_matches('\0'), "E");
        assert!(xmp.contains("exif:GPSLatitude>31,14.382"), "{xmp}");

        let read = read_fields(ImageFormat::Jpeg, &rw.bytes);
        assert_eq!(read.get("model").map(String::as_str), Some("Fujifilm X-T5"));
        assert_eq!(read.get("takenAt").map(String::as_str), Some("2024-07-08T06:12:33"));
    }

    #[test]
    fn vendor_only_rewrites_make_when_model_is_recognized() {
        for (model, expected) in [
            ("Canon EOS R6", Some("Canon")),
            ("NIKON Z 6_2", Some("NIKON CORPORATION")),
            ("ILCE-7M3", Some("SONY")),
            ("X-T5", Some("FUJIFILM")),
            ("iPhone 15 Pro", Some("Apple")),
            ("Unknown Camera 2000", None),
        ] {
            assert_eq!(vendor_for_model(model), expected, "型号 {model}");
        }

        // 认不出厂商时保留原 Make，不清空也不猜测
        let data = jpeg_with_exif(&sample_exif_tiff());
        let fields = BTreeMap::from([("model".to_string(), "Unknown Camera 2000".to_string())]);
        let rw = jpeg_rewrite(&data, &fields).unwrap();
        let tiff = jpeg_exif(&rw.bytes).unwrap();
        let hdr = TiffHeader::parse(&tiff).unwrap();
        let (ifd0, _) = hdr.entries(&tiff).unwrap();
        assert_eq!(
            entry_of(&ifd0, 0x0110).ascii(&tiff, hdr.be).unwrap().trim_matches('\0'),
            "Unknown Camera 2000"
        );
        assert_eq!(
            entry_of(&ifd0, 0x010F).ascii(&tiff, hdr.be).unwrap().trim_matches('\0'),
            "Canon"
        );
    }
}
