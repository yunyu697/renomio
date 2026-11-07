//! 图片元数据（JPEG / PNG / WebP / TIFF）：读取与**只改选中字段**的写回。
//!
//! 写回策略：统一写入 XMP（Windows/常见软件优先读 XMP），EXIF 只改文本类标签，
//! 相机参数、GPS、ICC、MakerNotes、缩略图等一律不触碰；容器其余字节原样保留。

use std::collections::BTreeMap;
use std::path::Path;

use super::util::*;
use super::{FieldMap, Rewrite};

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
    let text = |tag: u16| -> Option<String> {
        entries
            .iter()
            .find(|e| e.tag == tag)
            .and_then(|e| e.ascii(tiff, hdr.be))
            .map(|s| s.trim_matches('\0').trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let utf16 = |tag: u16| -> Option<String> {
        entries
            .iter()
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
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
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
        let _ = be;
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

    let edited_tags: Vec<u16> = edits.iter().map(|(t, _, _)| *t).collect();
    let mut pending: Vec<PendingEntry> = entries
        .into_iter()
        .filter(|e| !edited_tags.contains(&e.tag))
        .map(|e| PendingEntry { raw: e.raw, payload: None })
        .collect();
    let mut changed = false;
    for (tag, typ, payload) in edits {
        if payload.is_empty() {
            changed = true; // 清空 = 移除条目
            continue;
        }
        changed = true;
        let mut raw = [0u8; 12];
        write_u16(&mut raw[0..2], *tag, hdr.be);
        write_u16(&mut raw[2..4], *typ, hdr.be);
        write_u32(&mut raw[4..8], payload.len() as u32, hdr.be);
        if payload.len() <= 4 {
            raw[8..8 + payload.len()].copy_from_slice(payload);
        }
        let payload = if payload.len() > 4 { Some(payload.clone()) } else { None };
        pending.push(PendingEntry { raw, payload });
    }
    if !changed {
        return Ok(None);
    }
    let tag_of = |raw: &[u8; 12]| {
        if hdr.be {
            u16::from_be_bytes([raw[0], raw[1]])
        } else {
            u16::from_le_bytes([raw[0], raw[1]])
        }
    };
    pending.sort_by_key(|e| tag_of(&e.raw));

    let mut out = data.to_vec();
    if out.len() & 1 == 1 {
        out.push(0);
    }
    let ifd_off = out.len();
    if ifd_off > u32::MAX as usize {
        return Err("TIFF 过大，IFD0 偏移超出 32 位".into());
    }
    let data_start = ifd_off + 2 + pending.len() * 12 + 4;
    let mut data_off = data_start;
    let mut ifd = Vec::with_capacity(2 + pending.len() * 12 + 4);
    ifd.extend_from_slice(&u16_bytes(pending.len() as u16, hdr.be));
    let mut tail: Vec<u8> = Vec::new();
    for entry in &pending {
        let mut raw = entry.raw;
        if let Some(payload) = &entry.payload {
            write_u32(&mut raw[8..12], data_off as u32, hdr.be);
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
    ifd.extend_from_slice(&u32_bytes(next as u32, hdr.be));
    out.extend_from_slice(&ifd);
    out.extend_from_slice(&tail);
    let off_bytes = u32_bytes(ifd_off as u32, hdr.be);
    out[4..8].copy_from_slice(&off_bytes);
    Ok(Some(out))
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
    let edits = exif_edits_for(fields);
    if edits.is_empty() {
        return Ok(None);
    }
    tiff_update(tiff, &edits)
}

fn tiff_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let existing = tiff_xmp(data, &mut Vec::new());
    let (packet, mut warnings) = build_xmp(existing.as_deref(), fields);
    let mut edits: Vec<(u16, u16, Vec<u8>)> = Vec::new();
    edits.push((700, 1, packet.into_bytes()));
    edits.extend(exif_edits_for(fields));
    let new_data = tiff_update(data, &edits)?
        .ok_or_else(|| "TIFF IFD0 未产生变化".to_string())?;
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    collect_changes(fields, &mut written, &mut cleared);
    if !warnings.iter().any(|w| w.contains("XMP")) {
        warnings.push("TIFF 的 XMP 写入 IFD0 标签 700（多页 TIFF 的其余页不动）".into());
    }
    Ok(Rewrite { bytes: new_data, written, cleared, warnings })
}

fn exif_edits_for(fields: &FieldMap) -> Vec<(u16, u16, Vec<u8>)> {
    let mut edits = Vec::new();
    if let Some(v) = fields.get("title") {
        push_utf16(&mut edits, 0x9C9B, v);
    }
    if let Some(v) = fields.get("description") {
        push_ascii(&mut edits, 0x010E, v);
        push_utf16(&mut edits, 0x9C9F, v);
    }
    if let Some(v) = fields.get("keywords") {
        push_utf16(&mut edits, 0x9C9E, v);
    }
    if let Some(v) = fields.get("author") {
        push_ascii(&mut edits, 0x013B, v);
        push_utf16(&mut edits, 0x9C9D, v);
    }
    if let Some(v) = fields.get("copyright") {
        push_ascii(&mut edits, 0x8298, v);
    }
    if let Some(v) = fields.get("software") {
        push_ascii(&mut edits, 0x0131, v);
    }
    if let Some(v) = fields.get("takenAt") {
        if let Some(t) = to_exif_time(v) {
            push_ascii(&mut edits, 0x9003, &t);
            push_ascii(&mut edits, 0x0132, &t);
        }
    }
    edits
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
        let Some(prop) = xmp_prop(id) else {
            continue;
        };
        remove_element(&mut packet, prop);
        if value.trim().is_empty() {
            continue;
        }
        additions.push(property_xml(id, prop, value));
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
  <rdf:Description rdf:about=\"\" xmlns:dc=\"{NS_DC}\" xmlns:xmp=\"{NS_XMP}\" xmlns:photoshop=\"{NS_PHOTOSHOP}\">\n\
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
}
