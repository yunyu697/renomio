//! 音频标签（MP3 / FLAC / M4A / OGG-OPUS）的读取与写回。
//!
//! 写回原则：只改用户显式勾选的字段；未编辑的帧 / atom / metadata block / Ogg 页
//! 逐字节保留。空字符串表示删除对应标签；`cover` 表示封面（替换或删除）。
//! 编码策略：ID3v2.3 用 UTF-16（带 BOM），ID3v2.4 / FLAC / M4A / OGG 一律 UTF-8，
//! 保证中文、日文等非 ASCII 文本不乱码。
//!
//! 已知限制（会在 `warnings` 中明确告知）：
//! - OGG/Opus 只支持单一逻辑流（同一 serial）；头部页与首个音频页混排、
//!   或注释包与音频包共享同一页时无法安全重建，直接返回错误而不会静默写坏。
//! - OGG 封面使用标准的 `METADATA_BLOCK_PICTURE`（FLAC PICTURE 结构的 base64）。
//! - MP3 的 ID3v2.3 扩展头会在重编码时移除（其 CRC 已不适用于新内容）。

use std::path::Path;

use super::util::{be_u32, be_u64, u32_le};
use super::{CoverData, CoverInfo, FieldMap, Rewrite};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioFormat {
    Mp3,
    Flac,
    Mp4,
    Ogg,
}

impl AudioFormat {
    pub fn name(self) -> &'static str {
        match self {
            AudioFormat::Mp3 => "MP3",
            AudioFormat::Flac => "FLAC",
            AudioFormat::Mp4 => "M4A/MP4",
            AudioFormat::Ogg => "OGG (Vorbis/Opus)",
        }
    }
}

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

fn set_once(fields: &mut FieldMap, id: &str, value: Option<String>) {
    if fields.contains_key(id) {
        return;
    }
    if let Some(v) = value {
        let v = v.trim().to_string();
        if !v.is_empty() {
            fields.insert(id.to_string(), v);
        }
    }
}

fn cover_info(mime: String, bytes: &[u8]) -> CoverInfo {
    let (width, height) = image_dims(bytes).unwrap_or((0, 0));
    CoverInfo {
        present: true,
        mime,
        bytes: bytes.len() as u64,
        width,
        height,
    }
}

/// 从 JPEG/PNG 头解析像素尺寸；解析不到返回 None（调用方按 0 处理）。
fn image_dims(data: &[u8]) -> Option<(u32, u32)> {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return jpeg_dims(data);
    }
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        if data.len() >= 24 && &data[12..16] == b"IHDR" {
            return Some((be_u32(data, 16)?, be_u32(data, 20)?));
        }
    }
    None
}

fn jpeg_dims(data: &[u8]) -> Option<(u32, u32)> {
    let mut pos = 2usize;
    while pos + 4 <= data.len() {
        if data[pos] != 0xFF {
            pos += 1;
            continue;
        }
        let mut marker_pos = pos + 1;
        while marker_pos < data.len() && data[marker_pos] == 0xFF {
            marker_pos += 1;
        }
        let marker = *data.get(marker_pos)?;
        let len_pos = marker_pos + 1;
        if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            pos = len_pos;
            continue;
        }
        let seg_len = u16::from_be_bytes([*data.get(len_pos)?, *data.get(len_pos + 1)?]) as usize;
        if seg_len < 2 {
            return None;
        }
        let is_sof = (0xC0..=0xCF).contains(&marker)
            && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            let h = u16::from_be_bytes([*data.get(len_pos + 3)?, *data.get(len_pos + 4)?]) as u32;
            let w = u16::from_be_bytes([*data.get(len_pos + 5)?, *data.get(len_pos + 6)?]) as u32;
            if w > 0 && h > 0 {
                return Some((w, h));
            }
            return None;
        }
        pos = len_pos + seg_len;
    }
    None
}

fn latin1(raw: &[u8]) -> String {
    raw.iter().map(|b| char::from(*b)).collect()
}

/// 解码 UTF-16；`with_bom=true` 时按 ID3 规则识别并跳过 BOM。
fn decode_utf16(raw: &[u8], with_bom: bool) -> String {
    let mut little = true;
    let mut start = 0usize;
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
    let units: Vec<u16> = raw[start..]
        .chunks_exact(2)
        .map(|c| {
            if little {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    std::char::decode_utf16(units)
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .collect()
}

fn utf16_with_bom(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + text.len() * 2);
    out.extend_from_slice(&[0xFF, 0xFE]);
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

fn text_trim_null(text: String) -> Option<String> {
    let text = text.split('\0').next().unwrap_or("").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ---------------------------------------------------------------------------
// Base64（OGG 的 METADATA_BLOCK_PICTURE 使用）
// ---------------------------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[((b0 & 0x03) << 4 | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((b1 & 0x0F) << 2 | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(b2 & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut cleaned = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii_whitespace() {
            continue;
        }
        cleaned.push(ch);
    }
    if cleaned.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    let bytes = cleaned.as_bytes();
    for chunk in bytes.chunks(4) {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            vals[i] = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    pad += 1;
                    0
                }
                _ => return None,
            };
        }
        out.push(vals[0] << 2 | vals[1] >> 4);
        if pad < 2 {
            out.push(vals[1] << 4 | vals[2] >> 2);
        }
        if pad < 1 {
            out.push(vals[2] << 6 | vals[3]);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// MP3 / ID3v2
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Id3Frame {
    id: [u8; 4],
    flags: u16,
    data: Vec<u8>,
}

fn id_bytes(id: &str) -> [u8; 4] {
    let mut out = *b"    ";
    let bytes = id.as_bytes();
    let n = bytes.len().min(4);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

fn frame_id(frame: &Id3Frame) -> String {
    String::from_utf8_lossy(&frame.id).to_string()
}

fn synchsafe(raw: &[u8]) -> Option<u32> {
    if raw.len() != 4 || raw.iter().any(|b| *b >= 0x80) {
        return None;
    }
    Some(
        ((raw[0] as u32) << 21)
            | ((raw[1] as u32) << 14)
            | ((raw[2] as u32) << 7)
            | raw[3] as u32,
    )
}

fn to_synchsafe(value: u32) -> [u8; 4] {
    [
        ((value >> 21) & 0x7F) as u8,
        ((value >> 14) & 0x7F) as u8,
        ((value >> 7) & 0x7F) as u8,
        (value & 0x7F) as u8,
    ]
}

/// 还原 ID3 的 unsynchronisation：`FF 00` -> `FF`。
fn deunsync(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0usize;
    while i < data.len() {
        out.push(data[i]);
        if data[i] == 0xFF && i + 1 < data.len() && data[i + 1] == 0x00 {
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

/// 解析 ID3v2 标签，返回（主版本号，帧列表，标签之后的音频偏移，警告）。
fn id3_parse(data: &[u8]) -> Result<(u8, Vec<Id3Frame>, usize, Vec<String>), String> {
    let mut warnings = Vec::new();
    if data.len() < 10 || &data[..3] != b"ID3" {
        return Err("不是有效的 ID3v2 标签".into());
    }
    let major = data[3];
    if major != 3 && major != 4 {
        return Err(format!(
            "不支持的 ID3v2.{major} 版本（仅支持 2.3 / 2.4）"
        ));
    }
    let v4 = major == 4;
    let flags = data[5];
    let size = synchsafe(&data[6..10])
        .ok_or_else(|| "ID3 标签大小字段不是合法的 synchsafe 编码".to_string())?;
    let tag_end = 10usize + size as usize;
    if tag_end > data.len() {
        return Err(format!(
            "ID3 标签被截断：声明 {size} 字节，文件仅 {} 字节",
            data.len()
        ));
    }
    let mut region_start = 10usize;
    let mut region_end = tag_end;
    if v4 && flags & 0x10 != 0 {
        if region_end >= 20 && &data[region_end - 10..region_end - 7] == b"3DI" {
            region_end -= 10;
        } else {
            warnings.push("ID3v2.4 页脚标记存在但缺少页脚签名，按无页脚处理".into());
        }
    }
    if flags & 0x40 != 0 {
        // 扩展头：重新编码后其 CRC 不再适用，直接丢弃并给出警告
        if v4 {
            let ext = synchsafe(data.get(region_start..region_start + 4).unwrap_or(b""))
                .unwrap_or(6);
            region_start += ext.max(6) as usize;
        } else {
            let ext = be_u32(data, region_start).unwrap_or(0) as usize;
            region_start += 4 + ext;
        }
        if region_start > region_end {
            return Err("ID3 扩展头越界，标签已损坏".into());
        }
        warnings.push("已移除旧的 ID3 扩展头（重新编码后其 CRC 不再适用）".into());
    }
    let unsynced = flags & 0x80 != 0;
    let decoded = if unsynced {
        deunsync(&data[region_start..region_end])
    } else {
        Vec::new()
    };
    let region: &[u8] = if unsynced {
        warnings.push("旧标签使用了 unsynchronisation，已还原内容并清除该标志".into());
        &decoded
    } else {
        &data[region_start..region_end]
    };

    let mut frames = Vec::new();
    let mut pos = 0usize;
    while pos + 10 <= region.len() {
        let id_slice = &region[pos..pos + 4];
        if id_slice[0] == 0 {
            break; // 填充开始
        }
        if !id_slice
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        {
            warnings.push(format!(
                "ID3 帧头出现非法标识（偏移 {pos}），剩余部分按填充忽略"
            ));
            break;
        }
        let size_field = &region[pos + 4..pos + 8];
        let fsize = if v4 {
            match synchsafe(size_field) {
                Some(v) => v as usize,
                None => {
                    warnings.push("ID3v2.4 帧大小不是 synchsafe 编码，按普通 32 位读取".into());
                    u32::from_be_bytes(size_field.try_into().unwrap()) as usize
                }
            }
        } else {
            u32::from_be_bytes(size_field.try_into().unwrap()) as usize
        };
        let fflags = u16::from_be_bytes([region[pos + 8], region[pos + 9]]);
        if pos + 10 + fsize > region.len() {
            warnings.push(format!(
                "ID3 帧越界（偏移 {pos}，声明 {fsize} 字节），后续帧未解析"
            ));
            break;
        }
        let id = [id_slice[0], id_slice[1], id_slice[2], id_slice[3]];
        let mut body = region[pos + 10..pos + 10 + fsize].to_vec();
        let mut out_flags = fflags;
        if v4 && fflags & 0x0002 != 0 {
            // 若标签级 unsynchronisation 已整体还原，帧数据已是逻辑字节，不能再次还原
            if !unsynced {
                body = deunsync(&body);
            }
            out_flags &= !0x0002;
            warnings.push("已还原 ID3v2.4 帧级 unsynchronisation".into());
        }
        frames.push(Id3Frame {
            id,
            flags: out_flags,
            data: body,
        });
        pos += 10 + fsize;
    }
    if pos < region.len() && !region[pos..].iter().all(|b| *b == 0) {
        warnings.push(format!("ID3 标签内剩余 {} 字节按填充忽略", region.len() - pos));
    }
    Ok((major, frames, tag_end, warnings))
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
        _ => latin1(raw),
    };
    text_trim_null(text)
}

fn id3_comm_text(body: &[u8]) -> Option<String> {
    if body.len() < 4 {
        return None;
    }
    let encoding = body[0];
    let mut pos = 4usize; // 跳过 encoding + 3 字节语言
    if encoding == 1 || encoding == 2 {
        while pos + 1 < body.len() {
            if body[pos] == 0 && body[pos + 1] == 0 {
                pos += 2;
                break;
            }
            pos += 2;
        }
    } else {
        while pos < body.len() {
            if body[pos] == 0 {
                pos += 1;
                break;
            }
            pos += 1;
        }
    }
    if pos >= body.len() {
        return None;
    }
    let raw = &body[pos..];
    let text = match encoding {
        1 => decode_utf16(raw, true),
        2 => decode_utf16(raw, false),
        3 => String::from_utf8_lossy(raw).to_string(),
        _ => latin1(raw),
    };
    text_trim_null(text)
}

fn id3_apic_parse(body: &[u8]) -> Option<(String, u8, Vec<u8>)> {
    if body.len() < 3 {
        return None;
    }
    let encoding = body[0];
    let mime_end = body[1..].iter().position(|b| *b == 0)? + 1;
    let mime = latin1(&body[1..mime_end]);
    let mut pos = mime_end + 1;
    let pic_type = *body.get(pos)?;
    pos += 1;
    if encoding == 1 || encoding == 2 {
        while pos + 1 < body.len() {
            if body[pos] == 0 && body[pos + 1] == 0 {
                pos += 2;
                break;
            }
            pos += 2;
        }
    } else {
        while pos < body.len() {
            if body[pos] == 0 {
                pos += 1;
                break;
            }
            pos += 1;
        }
    }
    if pos >= body.len() {
        return None;
    }
    Some((mime, pic_type, body[pos..].to_vec()))
}

fn id3_text_body(value: &str, v4: bool) -> Vec<u8> {
    if v4 {
        let mut out = vec![3u8]; // UTF-8
        out.extend_from_slice(value.as_bytes());
        out
    } else {
        let mut out = vec![1u8]; // UTF-16 带 BOM
        out.extend_from_slice(&utf16_with_bom(value));
        out
    }
}

fn id3_comm_body(value: &str, v4: bool) -> Vec<u8> {
    let mut out = Vec::new();
    if v4 {
        out.push(3u8);
        out.extend_from_slice(b"eng");
        out.push(0x00); // 空描述（UTF-8 终止符）
        out.extend_from_slice(value.as_bytes());
    } else {
        out.push(1u8);
        out.extend_from_slice(b"eng");
        out.extend_from_slice(&[0x00, 0x00]); // 空描述（UTF-16 终止符）
        out.extend_from_slice(&utf16_with_bom(value));
    }
    out
}

/// ffmpeg 等工具会把 comment 同时写进 `TXXX`（description=`comment`）。
/// 只替换 COMM 会导致播放器仍优先显示旧的 TXXX 值，因此两者必须一起替换。
fn id3_txxx_is_comment(frame: &Id3Frame) -> bool {
    if frame_id(frame) != "TXXX" || frame.data.is_empty() {
        return false;
    }
    let enc = frame.data[0];
    let rest = &frame.data[1..];
    let desc = match enc {
        0 | 3 => {
            let end = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
            String::from_utf8_lossy(&rest[..end]).to_string()
        }
        1 | 2 => {
            let start = if rest.len() >= 2 && (rest[0] == 0xFF || rest[0] == 0xFE) { 2 } else { 0 };
            let mut out = String::new();
            let mut i = start;
            while i + 1 < rest.len() {
                let unit = if enc == 1 {
                    u16::from_le_bytes([rest[i], rest[i + 1]])
                } else {
                    u16::from_be_bytes([rest[i], rest[i + 1]])
                };
                if unit == 0 {
                    break;
                }
                out.push(char::from_u32(unit as u32).unwrap_or('\u{fffd}'));
                i += 2;
            }
            out
        }
        _ => String::new(),
    };
    let desc = desc.trim().to_ascii_lowercase();
    desc == "comment" || desc == "description"
}

fn id3_apic_body(cd: &CoverData, v4: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(cd.bytes.len() + 16);
    out.push(if v4 { 3u8 } else { 0u8 });
    out.extend_from_slice(cd.mime.as_bytes());
    out.push(0x00);
    out.push(3u8); // front cover
    out.push(0x00); // 空描述
    out.extend_from_slice(&cd.bytes);
    out
}

fn id3_frame_bytes(frame: &Id3Frame, v4: bool) -> Vec<u8> {
    let size = if v4 {
        to_synchsafe(frame.data.len() as u32)
    } else {
        (frame.data.len() as u32).to_be_bytes()
    };
    let mut out = Vec::with_capacity(10 + frame.data.len());
    out.extend_from_slice(&frame.id);
    out.extend_from_slice(&size);
    out.extend_from_slice(&frame.flags.to_be_bytes());
    out.extend_from_slice(&frame.data);
    out
}

fn mp3_read(
    data: &[u8],
    fields: &mut FieldMap,
    cover: &mut Option<CoverInfo>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if !data.starts_with(b"ID3") {
        warnings.push("未发现 ID3v2 标签（ID3v1 / APE 标签本版本不读取）".into());
        return Ok(());
    }
    let (major, frames, _tag_end, mut parsed_warnings) = id3_parse(data)?;
    warnings.append(&mut parsed_warnings);
    let mut year_tyer: Option<String> = None;
    let mut year_tdrc: Option<String> = None;
    let mut first_pic: Option<(String, Vec<u8>)> = None;
    let mut chosen_cover: Option<CoverInfo> = None;
    for frame in &frames {
        let id = frame_id(frame);
        match id.as_str() {
            "TIT2" => set_once(fields, "title", id3_text(&frame.data)),
            "TPE1" => set_once(fields, "artist", id3_text(&frame.data)),
            "TALB" => set_once(fields, "album", id3_text(&frame.data)),
            "TRCK" => set_once(fields, "track", id3_text(&frame.data)),
            "TCON" => set_once(fields, "genre", id3_text(&frame.data)),
            "TPE2" => set_once(fields, "albumArtist", id3_text(&frame.data)),
            "TYER" => {
                if year_tyer.is_none() {
                    year_tyer = id3_text(&frame.data);
                }
            }
            "TDRC" => {
                if year_tdrc.is_none() {
                    year_tdrc = id3_text(&frame.data);
                }
            }
            "COMM" => set_once(fields, "comment", id3_comm_text(&frame.data)),
            "USLT" => set_once(fields, "lyrics", id3_comm_text(&frame.data)),
            "APIC" => {
                if let Some((mime, pic_type, bytes)) = id3_apic_parse(&frame.data) {
                    if pic_type == 3 && chosen_cover.is_none() {
                        chosen_cover = Some(cover_info(mime, &bytes));
                    } else if first_pic.is_none() {
                        first_pic = Some((mime, bytes));
                    }
                }
            }
            _ => {}
        }
    }
    let year = if major == 4 {
        year_tdrc.or(year_tyer)
    } else {
        year_tyer.or(year_tdrc)
    };
    set_once(fields, "year", year);
    if cover.is_none() {
        if let Some(info) = chosen_cover {
            *cover = Some(info);
        } else if let Some((mime, bytes)) = first_pic {
            *cover = Some(cover_info(mime, &bytes));
        }
    }
    Ok(())
}

fn mp3_rewrite(
    data: &[u8],
    fields: &FieldMap,
    cover: Option<&CoverData>,
    clear_cover: bool,
) -> Result<Rewrite, String> {
    let mut warnings = Vec::new();
    let (major, mut frames, tag_end) = if data.starts_with(b"ID3") {
        let (major, frames, tag_end, mut parsed_warnings) = id3_parse(data)?;
        warnings.append(&mut parsed_warnings);
        (major, frames, tag_end)
    } else {
        if data.len() > 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0 {
            warnings.push("原文件没有 ID3v2 标签，已新建 ID3v2.3 标签".into());
        } else if data.len() >= 4 {
            warnings.push("文件起始不是标准 MPEG 帧，但已按 MP3 写入 ID3v2.3 标签".into());
        }
        (3u8, Vec::new(), 0usize)
    };
    let v4 = major == 4;
    let mut written = Vec::new();
    let mut cleared = Vec::new();

    for (id, value) in fields {
        if id == "cover" {
            continue;
        }
        let target_ids: Vec<&str> = match id.as_str() {
            "comment" => vec!["COMM"],
            "lyrics" => vec!["USLT"],
            "year" => {
                if v4 {
                    vec!["TDRC", "TYER"]
                } else {
                    vec!["TYER", "TDRC"]
                }
            }
            "title" => vec!["TIT2"],
            "artist" => vec!["TPE1"],
            "album" => vec!["TALB"],
            "track" => vec!["TRCK"],
            "genre" => vec!["TCON"],
            "albumArtist" => vec!["TPE2"],
            _ => continue,
        };
        if value.is_empty() {
            frames.retain(|f| {
                !target_ids.contains(&frame_id(f).as_str())
                    && !(id == "comment" && id3_txxx_is_comment(f))
            });
            cleared.push(id.clone());
        } else {
            let body = if id == "comment" || id == "lyrics" {
                id3_comm_body(value, v4)
            } else {
                id3_text_body(value, v4)
            };
            let new_frame = Id3Frame {
                id: id_bytes(target_ids[0]),
                flags: 0,
                data: body,
            };
            let mut replaced = false;
            let mut rebuilt = Vec::with_capacity(frames.len() + 1);
            for frame in frames.drain(..) {
                if target_ids.contains(&frame_id(&frame).as_str())
                    || (id == "comment" && id3_txxx_is_comment(&frame))
                {
                    if !replaced {
                        rebuilt.push(new_frame.clone());
                        replaced = true;
                    }
                } else {
                    rebuilt.push(frame);
                }
            }
            if !replaced {
                rebuilt.push(new_frame);
            }
            frames = rebuilt;
            written.push(id.clone());
        }
    }

    // 封面：替换时清除全部 APIC 后写入一张 front cover；清空时移除全部 APIC
    let cover_requested = fields.contains_key("cover");
    if let Some(cd) = cover {
        frames.retain(|f| frame_id(f) != "APIC");
        frames.push(Id3Frame {
            id: *b"APIC",
            flags: 0,
            data: id3_apic_body(cd, v4),
        });
        written.push("cover".into());
    } else if clear_cover
        || (cover_requested && fields.get("cover").map(|v| v.is_empty()).unwrap_or(false))
    {
        let before = frames.len();
        frames.retain(|f| frame_id(f) != "APIC");
        if before != frames.len() || cover_requested || clear_cover {
            cleared.push("cover".into());
        }
    }

    if tag_end == 0 && frames.is_empty() {
        // 原本没有标签、也没有要写入的帧：保持原文件不变
        return Ok(Rewrite {
            bytes: data.to_vec(),
            written,
            cleared,
            warnings,
        });
    }

    let mut tag_body = Vec::new();
    for frame in &frames {
        tag_body.extend_from_slice(&id3_frame_bytes(frame, v4));
    }
    if tag_body.len() > 0x0FFF_FFFF {
        return Err("ID3v2 标签超过 256 MB 上限，无法写入".into());
    }
    let mut out = Vec::with_capacity(10 + tag_body.len() + data.len() - tag_end);
    out.extend_from_slice(b"ID3");
    out.push(if v4 { 4 } else { 3 });
    out.push(0); // 修订号
    out.push(0); // flags：清除 unsynchronisation / 扩展头 / 页脚
    out.extend_from_slice(&to_synchsafe(tag_body.len() as u32));
    out.extend_from_slice(&tag_body);
    out.extend_from_slice(&data[tag_end..]);
    Ok(Rewrite {
        bytes: out,
        written,
        cleared,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// Vorbis comment（FLAC / OGG 共用）
// ---------------------------------------------------------------------------

struct VorbisEntry {
    key: String,
    value: String,
    /// 原始 "KEY=VALUE" 字节；未编辑条目按原样写回
    raw: Vec<u8>,
}

struct VorbisComment {
    vendor: Vec<u8>,
    entries: Vec<VorbisEntry>,
}

fn vorbis_comment_parse(data: &[u8]) -> Result<VorbisComment, String> {
    if data.len() < 8 {
        return Err("Vorbis comment 数据过短".into());
    }
    let vendor_len = u32_le(data, 0).ok_or("Vorbis comment vendor 长度缺失")? as usize;
    let vendor = data
        .get(4..4 + vendor_len)
        .ok_or("Vorbis comment vendor 字符串越界")?
        .to_vec();
    let mut pos = 4 + vendor_len;
    let count = u32_le(data, pos).ok_or("Vorbis comment 条目数缺失")? as usize;
    pos += 4;
    if count > data.len() / 4 + 1 {
        return Err(format!("Vorbis comment 条目数异常（{count}）"));
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let len = u32_le(data, pos).ok_or("Vorbis comment 条目长度缺失")? as usize;
        pos += 4;
        let raw = data
            .get(pos..pos + len)
            .ok_or("Vorbis comment 条目内容越界")?
            .to_vec();
        pos += len;
        let split = raw.iter().position(|b| *b == b'=').unwrap_or(raw.len());
        let key = String::from_utf8_lossy(&raw[..split]).to_ascii_uppercase();
        let value = if split < raw.len() {
            String::from_utf8_lossy(&raw[split + 1..]).to_string()
        } else {
            String::new()
        };
        entries.push(VorbisEntry { key, value, raw });
    }
    Ok(VorbisComment { vendor, entries })
}

fn vorbis_comment_build(vc: &VorbisComment) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(vc.vendor.len() as u32).to_le_bytes());
    out.extend_from_slice(&vc.vendor);
    out.extend_from_slice(&(vc.entries.len() as u32).to_le_bytes());
    for entry in &vc.entries {
        out.extend_from_slice(&(entry.raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&entry.raw);
    }
    out
}

/// 新写入的 Vorbis 键统一用 ffmpeg / 播放器普遍识别的小写规范名。
fn vorbis_field_key(id: &str) -> Option<&'static str> {
    Some(match id {
        "title" => "title",
        "artist" => "artist",
        "album" => "album",
        "year" => "date",
        "track" => "tracknumber",
        "genre" => "genre",
        "comment" => "description",
        "lyrics" => "lyrics",
        "albumArtist" => "albumartist",
        _ => return None,
    })
}

fn vorbis_read_fields(vc: &VorbisComment, fields: &mut FieldMap) {
    for entry in &vc.entries {
        let key = entry.key.to_ascii_uppercase();
        let id = match key.as_str() {
            "TITLE" => "title",
            "ARTIST" => "artist",
            "ALBUM" => "album",
            "DATE" | "YEAR" => "year",
            "TRACKNUMBER" => "track",
            "GENRE" => "genre",
            "COMMENT" | "DESCRIPTION" => "comment",
            "LYRICS" => "lyrics",
            "ALBUMARTIST" => "albumArtist",
            _ => continue,
        };
        if fields.contains_key(id) {
            continue;
        }
        let value = entry.value.trim().to_string();
        if !value.is_empty() {
            fields.insert(id.to_string(), value);
        }
    }
}

/// 按 fields 修改 Vorbis 条目：同名键全部替换/删除，其余条目原样保留。
fn vorbis_apply(
    vc: &mut VorbisComment,
    fields: &FieldMap,
    written: &mut Vec<String>,
    cleared: &mut Vec<String>,
) {
    for (id, value) in fields {
        if id == "cover" {
            continue;
        }
        let Some(key) = vorbis_field_key(id) else {
            continue;
        };
        let keys: Vec<&str> = match id.as_str() {
            "year" => vec!["DATE", "YEAR"],
            "comment" => vec!["COMMENT", "DESCRIPTION"],
            _ => vec![key],
        };
        vc.entries
            .retain(|e| !keys.iter().any(|k| e.key.eq_ignore_ascii_case(*k)));
        if value.is_empty() {
            cleared.push(id.clone());
        } else {
            vc.entries.push(VorbisEntry {
                key: key.to_string(),
                value: value.clone(),
                raw: format!("{key}={value}").into_bytes(),
            });
            written.push(id.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// FLAC PICTURE（OGG 的 METADATA_BLOCK_PICTURE 复用同一结构）
// ---------------------------------------------------------------------------

struct FlacPicture {
    pic_type: u32,
    mime: String,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

fn flac_picture_parse(payload: &[u8]) -> Result<FlacPicture, String> {
    let take = |pos: usize, len: usize| -> Result<&[u8], String> {
        payload
            .get(pos..pos + len)
            .ok_or_else(|| "PICTURE 块长度不足".to_string())
    };
    let pic_type = be_u32(payload, 0).ok_or("PICTURE 块缺少图片类型")?;
    let mime_len = be_u32(payload, 4).ok_or("PICTURE 块缺少 MIME 长度")? as usize;
    let mime = String::from_utf8_lossy(take(8, mime_len)?).to_string();
    let mut pos = 8 + mime_len;
    let desc_len = be_u32(payload, pos).ok_or("PICTURE 块缺少描述长度")? as usize;
    pos += 4 + desc_len;
    let width = be_u32(payload, pos).ok_or("PICTURE 块缺少宽度")?;
    let height = be_u32(payload, pos + 4).ok_or("PICTURE 块缺少高度")?;
    pos += 16;
    let data_len = be_u32(payload, pos).ok_or("PICTURE 块缺少数据长度")? as usize;
    pos += 4;
    let data = take(pos, data_len)?.to_vec();
    Ok(FlacPicture {
        pic_type,
        mime,
        width,
        height,
        data,
    })
}

/// 生成 FLAC PICTURE 的负载（不含 4 字节 metadata block 头）。
fn flac_picture_payload(cd: &CoverData, pic_type: u32) -> Vec<u8> {
    let (width, height) = image_dims(&cd.bytes).unwrap_or((0, 0));
    let mut out = Vec::with_capacity(cd.bytes.len() + 64);
    out.extend_from_slice(&pic_type.to_be_bytes());
    out.extend_from_slice(&(cd.mime.len() as u32).to_be_bytes());
    out.extend_from_slice(cd.mime.as_bytes());
    out.extend_from_slice(&0u32.to_be_bytes()); // 空描述
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&24u32.to_be_bytes()); // 位深（提示用途）
    out.extend_from_slice(&0u32.to_be_bytes()); // 索引色数量
    out.extend_from_slice(&(cd.bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&cd.bytes);
    out
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

struct FlacBlock {
    typ: u8,
    data: Vec<u8>,
}

fn flac_parse(data: &[u8]) -> Result<(Vec<FlacBlock>, usize), String> {
    if !data.starts_with(b"fLaC") {
        return Err("不是有效的 FLAC 文件（缺少 fLaC 标识）".into());
    }
    let mut pos = 4usize;
    let mut blocks = Vec::new();
    loop {
        if pos + 4 > data.len() {
            return Err("FLAC metadata block 头被截断（缺少 last-block 标志）".into());
        }
        let head = data[pos];
        let last = head & 0x80 != 0;
        let typ = head & 0x7F;
        let len = ((data[pos + 1] as usize) << 16)
            | ((data[pos + 2] as usize) << 8)
            | data[pos + 3] as usize;
        let start = pos + 4;
        let end = start + len;
        if end > data.len() {
            return Err(format!(
                "FLAC metadata block 越界（类型 {typ}，长度 {len}）"
            ));
        }
        blocks.push(FlacBlock {
            typ,
            data: data[start..end].to_vec(),
        });
        pos = end;
        if last {
            break;
        }
        if blocks.len() > 4096 {
            return Err("FLAC metadata block 数量异常，疑似文件损坏".into());
        }
    }
    Ok((blocks, pos))
}

fn flac_read(
    data: &[u8],
    fields: &mut FieldMap,
    cover: &mut Option<CoverInfo>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let (blocks, _) = flac_parse(data)?;
    if blocks.first().map(|b| b.typ != 0).unwrap_or(true) {
        warnings.push("FLAC 首个 metadata block 不是 STREAMINFO".into());
    }
    let mut has_vc = false;
    let mut first_pic: Option<FlacPicture> = None;
    let mut chosen_pic: Option<FlacPicture> = None;
    for block in &blocks {
        match block.typ {
            4 => {
                let vc = vorbis_comment_parse(&block.data)?;
                vorbis_read_fields(&vc, fields);
                has_vc = true;
            }
            6 => {
                let pic = flac_picture_parse(&block.data)?;
                if pic.pic_type == 3 && chosen_pic.is_none() {
                    chosen_pic = Some(pic);
                } else if first_pic.is_none() {
                    first_pic = Some(pic);
                }
            }
            _ => {}
        }
    }
    if !has_vc {
        warnings.push("FLAC 没有 VORBIS_COMMENT 块（文本标签为空）".into());
    }
    if cover.is_none() {
        if let Some(pic) = chosen_pic.or(first_pic) {
            let (width, height) = if pic.width > 0 && pic.height > 0 {
                (pic.width, pic.height)
            } else {
                image_dims(&pic.data).unwrap_or((0, 0))
            };
            *cover = Some(CoverInfo {
                present: true,
                mime: pic.mime,
                bytes: pic.data.len() as u64,
                width,
                height,
            });
        }
    }
    Ok(())
}

fn flac_rewrite(
    data: &[u8],
    fields: &FieldMap,
    cover: Option<&CoverData>,
    clear_cover: bool,
) -> Result<Rewrite, String> {
    let (mut blocks, meta_end) = flac_parse(data)?;
    let mut warnings = Vec::new();
    let mut written = Vec::new();
    let mut cleared = Vec::new();

    // --- Vorbis comment ---
    let vc_index = blocks.iter().position(|b| b.typ == 4);
    let mut vc = match vc_index {
        Some(idx) => vorbis_comment_parse(&blocks[idx].data)?,
        None => {
            warnings.push("FLAC 没有 VORBIS_COMMENT 块，已新建".into());
            VorbisComment {
                vendor: b"renomio-core".to_vec(),
                entries: Vec::new(),
            }
        }
    };
    vorbis_apply(&mut vc, fields, &mut written, &mut cleared);
    let payload = vorbis_comment_build(&vc);
    if payload.len() > 0xFF_FFFF {
        return Err("Vorbis comment 超过 FLAC 单个 metadata block 的 16 MB 上限".into());
    }
    match vc_index {
        Some(idx) => blocks[idx].data = payload,
        None => {
            // STREAMINFO 必须是首块：正常文件插在它之后，异常文件则追加到块链末尾
            let at = if blocks.first().map(|b| b.typ == 0).unwrap_or(false) {
                1
            } else {
                blocks.len()
            };
            blocks.insert(
                at,
                FlacBlock {
                    typ: 4,
                    data: payload,
                },
            );
            warnings.push("原文件没有 VORBIS_COMMENT 块，已新建".into());
        }
    }

    // --- 封面（PICTURE）---
    // 读取侧把「type 3 优先，其次任意图片块」当作封面，写回侧必须用同一口径，
    // 否则会出现「界面说已清空、ffprobe 仍能看到封面」的假成功。
    // ffmpeg 写 FLAC 封面时 pic_type 常常是 0（Other），因此不能只认 type 3。
    let cover_requested = fields.contains_key("cover");
    let clear_requested = clear_cover
        || (cover_requested && fields.get("cover").map(|v| v.is_empty()).unwrap_or(false));
    let cover_idx = blocks
        .iter()
        .position(|b| b.typ == 6 && be_u32(&b.data, 0) == Some(3))
        .or_else(|| blocks.iter().position(|b| b.typ == 6));

    let mut insert_at: Option<usize> = None;
    let mut removed_cover = false;
    if let Some(idx) = cover_idx {
        if cover.is_some() || clear_requested {
            blocks.remove(idx);
            insert_at = Some(idx);
            removed_cover = true;
        }
    }
    if let Some(cd) = cover {
        let payload = flac_picture_payload(cd, 3);
        if payload.len() > 0xFF_FFFF {
            return Err("封面超过 FLAC 单个 metadata block 的 16 MB 上限".into());
        }
        blocks.insert(
            insert_at.unwrap_or(blocks.len()),
            FlacBlock {
                typ: 6,
                data: payload,
            },
        );
        written.push("cover".into());
    } else if clear_requested {
        if removed_cover || cover_requested || clear_cover {
            cleared.push("cover".into());
        }
        if blocks.iter().any(|b| b.typ == 6) {
            warnings.push("已移除封面图片块，其它图片块（如艺人照片）原样保留".into());
        }
    }
    let kept = blocks;

    // --- 重新序列化 metadata 链，音频帧字节原样保留 ---
    if kept.is_empty() {
        return Err("FLAC metadata 重写后为空，拒绝生成非法文件".into());
    }
    let mut out = Vec::with_capacity(meta_end + (data.len() - meta_end) + 256);
    out.extend_from_slice(b"fLaC");
    let count = kept.len();
    for (i, block) in kept.iter().enumerate() {
        if block.data.len() > 0xFF_FFFF {
            return Err(format!(
                "FLAC metadata block（类型 {}）超过 16 MB 上限",
                block.typ
            ));
        }
        let head = if i + 1 == count {
            0x80 | block.typ
        } else {
            block.typ
        };
        out.push(head);
        out.extend_from_slice(&(block.data.len() as u32).to_be_bytes()[1..]);
        out.extend_from_slice(&block.data);
    }
    out.extend_from_slice(&data[meta_end..]);
    Ok(Rewrite {
        bytes: out,
        written,
        cleared,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// M4A / MP4（iTunes ilst atoms）
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Mp4Atom {
    typ: [u8; 4],
    start: usize,
    data_start: usize,
    end: usize,
}

fn mp4_children(data: &[u8], start: usize, end: usize) -> Result<Vec<Mp4Atom>, String> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        if end - pos < 8 {
            // 尾部不足一个 atom 头：忽略（部分工具会追加对齐字节）
            break;
        }
        let size32 = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let typ = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];
        let mut header = 8usize;
        let size: u64 = match size32 {
            0 => (end - pos) as u64,
            1 => {
                if end - pos < 16 {
                    return Err("MP4 atom 使用 64 位长度但空间不足".into());
                }
                let large = be_u64(data, pos + 8).ok_or("MP4 atom 64 位长度字段缺失")?;
                if large < 16 {
                    return Err(format!(
                        "MP4 atom {} 的 64 位长度非法（{large}）",
                        String::from_utf8_lossy(&typ)
                    ));
                }
                header = 16;
                large
            }
            8..=u32::MAX => size32 as u64,
            _ => {
                return Err(format!(
                    "MP4 atom {} 大小非法（{size32}）",
                    String::from_utf8_lossy(&typ)
                ))
            }
        };
        let atom_end = pos
            .checked_add(size as usize)
            .ok_or("MP4 atom 长度溢出")?;
        if atom_end > end {
            return Err(format!(
                "MP4 atom {} 越界（声明到 {atom_end}，父级结束于 {end}）",
                String::from_utf8_lossy(&typ)
            ));
        }
        out.push(Mp4Atom {
            typ,
            start: pos,
            data_start: pos + header,
            end: atom_end,
        });
        pos = atom_end;
    }
    Ok(out)
}

fn mp4_find<'a>(atoms: &'a [Mp4Atom], typ: &[u8; 4]) -> Option<&'a Mp4Atom> {
    atoms.iter().find(|a| &a.typ == typ)
}

fn mp4_make_atom(typ: &[u8; 4], payload: &[u8]) -> Result<Vec<u8>, String> {
    let total = 8usize
        .checked_add(payload.len())
        .ok_or("MP4 atom 长度溢出")?;
    if total > u32::MAX as usize {
        return Err("MP4 atom 超过 4 GB 上限，无法写入".into());
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(payload);
    Ok(out)
}

fn mp4_data_atom(type_code: u32, value: &[u8]) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(value.len() + 8);
    payload.extend_from_slice(&(type_code & 0x00FF_FFFF).to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes()); // locale
    payload.extend_from_slice(value);
    mp4_make_atom(b"data", &payload)
}

fn mp4_item_atom(fourcc: &[u8; 4], data_atom: &[u8]) -> Result<Vec<u8>, String> {
    mp4_make_atom(fourcc, data_atom)
}

fn mp4_hdlr() -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(25);
    payload.extend_from_slice(&0u32.to_be_bytes()); // version / flags
    payload.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    payload.extend_from_slice(b"mdir"); // handler_type
    payload.extend_from_slice(b"appl"); // manufacturer
    payload.extend_from_slice(&[0u8; 8]);
    payload.push(0); // 空名称
    mp4_make_atom(b"hdlr", &payload)
}

fn mp4_field_fourcc(id: &str) -> Option<[u8; 4]> {
    Some(match id {
        "title" => *b"\xA9nam",
        "artist" => *b"\xA9ART",
        "album" => *b"\xA9alb",
        "year" => *b"\xA9day",
        "track" => *b"trkn",
        "genre" => *b"\xA9gen",
        "comment" => *b"\xA9cmt",
        "lyrics" => *b"\xA9lyr",
        "albumArtist" => *b"aART",
        "cover" => *b"covr",
        _ => return None,
    })
}

fn mp4_text(raw: &[u8]) -> Option<String> {
    let text = if raw.starts_with(&[0xFF, 0xFE]) || raw.starts_with(&[0xFE, 0xFF]) {
        decode_utf16(raw, true)
    } else {
        String::from_utf8_lossy(raw).to_string()
    };
    text_trim_null(text)
}

fn mp4_item_value(data: &[u8], item: &Mp4Atom) -> Option<(u32, Vec<u8>)> {
    let children = mp4_children(data, item.data_start, item.end).ok()?;
    let data_atom = children.iter().find(|a| &a.typ == b"data")?;
    if data_atom.data_start + 8 > data_atom.end {
        return None;
    }
    let type_code = be_u32(data, data_atom.data_start)? & 0x00FF_FFFF;
    Some((type_code, data[data_atom.data_start + 8..data_atom.end].to_vec()))
}

fn mp4_parse_track(value: &str) -> Result<(u16, u16), String> {
    let mut parts = value.splitn(2, '/');
    let track_text = parts.next().unwrap_or("").trim();
    let total_text = parts.next().unwrap_or("").trim();
    let track: u16 = track_text.parse().map_err(|_| {
        format!("track 需要是数字（例如 3 或 3/12），实际为「{value}」")
    })?;
    let total: u16 = if total_text.is_empty() {
        0
    } else {
        total_text.parse().map_err(|_| {
            format!("track 的总数需要是数字（例如 3/12），实际为「{value}」")
        })?
    };
    Ok((track, total))
}

fn mp4_new_item(fourcc: &[u8; 4], id: &str, value: &str) -> Result<Vec<u8>, String> {
    if id == "track" {
        let (track, total) = mp4_parse_track(value)?;
        let mut payload = Vec::with_capacity(8);
        payload.extend_from_slice(&0u16.to_be_bytes());
        payload.extend_from_slice(&track.to_be_bytes());
        payload.extend_from_slice(&total.to_be_bytes());
        payload.extend_from_slice(&0u16.to_be_bytes());
        let data_atom = mp4_data_atom(0, &payload)?;
        return mp4_item_atom(fourcc, &data_atom);
    }
    let data_atom = mp4_data_atom(1, value.as_bytes())?;
    mp4_item_atom(fourcc, &data_atom)
}

fn mp4_read(
    data: &[u8],
    fields: &mut FieldMap,
    cover: &mut Option<CoverInfo>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let top = mp4_children(data, 0, data.len())?;
    let moov = match mp4_find(&top, b"moov") {
        Some(atom) => *atom,
        None => return Err("M4A/MP4 缺少 moov atom".into()),
    };
    let moov_children = mp4_children(data, moov.data_start, moov.end)?;
    let Some(udta) = mp4_find(&moov_children, b"udta") else {
        warnings.push("M4A 没有 udta/meta/ilst（文本标签为空）".into());
        return Ok(());
    };
    let udta_children = mp4_children(data, udta.data_start, udta.end)?;
    let Some(meta) = mp4_find(&udta_children, b"meta") else {
        warnings.push("M4A 没有 meta/ilst（文本标签为空）".into());
        return Ok(());
    };
    let meta_children = mp4_children(data, meta.data_start + 4, meta.end)?;
    let Some(ilst) = mp4_find(&meta_children, b"ilst") else {
        warnings.push("M4A 没有 ilst（文本标签为空）".into());
        return Ok(());
    };
    let items = mp4_children(data, ilst.data_start, ilst.end)?;
    let mut first_pic: Option<(u32, Vec<u8>)> = None;
    for item in &items {
        let Some((type_code, value)) = mp4_item_value(data, item) else {
            continue;
        };
        if &item.typ == b"\xA9nam" {
            set_once(fields, "title", mp4_text(&value));
        } else if &item.typ == b"\xA9ART" {
            set_once(fields, "artist", mp4_text(&value));
        } else if &item.typ == b"\xA9alb" {
            set_once(fields, "album", mp4_text(&value));
        } else if &item.typ == b"\xA9day" {
            set_once(fields, "year", mp4_text(&value));
        } else if &item.typ == b"\xA9gen" {
            set_once(fields, "genre", mp4_text(&value));
        } else if &item.typ == b"\xA9cmt" {
            set_once(fields, "comment", mp4_text(&value));
        } else if &item.typ == b"\xA9lyr" {
            set_once(fields, "lyrics", mp4_text(&value));
        } else if &item.typ == b"aART" {
            set_once(fields, "albumArtist", mp4_text(&value));
        } else if &item.typ == b"trkn" {
            if value.len() >= 8 && !fields.contains_key("track") {
                let track = u16::from_be_bytes([value[2], value[3]]) as u32;
                let total = u16::from_be_bytes([value[4], value[5]]) as u32;
                if track > 0 {
                    fields.insert(
                        "track".into(),
                        if total > 0 {
                            format!("{track}/{total}")
                        } else {
                            track.to_string()
                        },
                    );
                }
            }
        } else if &item.typ == b"covr" {
            if first_pic.is_none() {
                first_pic = Some((type_code, value));
            }
        }
    }
    if cover.is_none() {
        if let Some((type_code, bytes)) = first_pic {
            let mime = match type_code {
                13 => "image/jpeg".to_string(),
                14 => "image/png".to_string(),
                _ => {
                    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                        "image/jpeg".to_string()
                    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                        "image/png".to_string()
                    } else {
                        warnings.push(format!("covr 的图片类型未知（data type {type_code}）"));
                        "application/octet-stream".to_string()
                    }
                }
            };
            *cover = Some(cover_info(mime, &bytes));
        }
    }
    Ok(())
}

fn mp4_rewrite(
    data: &[u8],
    fields: &FieldMap,
    cover: Option<&CoverData>,
    clear_cover: bool,
) -> Result<Rewrite, String> {
    let top = mp4_children(data, 0, data.len())?;
    let moov_idx = top
        .iter()
        .position(|a| &a.typ == b"moov")
        .ok_or_else(|| "M4A/MP4 缺少 moov atom，无法写入标签".to_string())?;
    let moov = top[moov_idx];
    let moov_children = mp4_children(data, moov.data_start, moov.end)?;
    let udta = mp4_find(&moov_children, b"udta").copied();
    let meta = match udta {
        Some(u) => {
            let kids = mp4_children(data, u.data_start, u.end)?;
            mp4_find(&kids, b"meta").copied()
        }
        None => None,
    };
    let ilst = match meta {
        Some(m) => {
            let kids = mp4_children(data, m.data_start + 4, m.end)?;
            mp4_find(&kids, b"ilst").copied()
        }
        None => None,
    };

    let mut written = Vec::new();
    let mut cleared = Vec::new();
    let mut warnings = Vec::new();

    // 现有 ilst 子项按原始字节保留
    let mut items: Vec<([u8; 4], Vec<u8>)> = match ilst {
        Some(atom) => mp4_children(data, atom.data_start, atom.end)?
            .iter()
            .map(|item| (item.typ, data[item.start..item.end].to_vec()))
            .collect(),
        None => Vec::new(),
    };

    for (id, value) in fields {
        if id == "cover" {
            continue;
        }
        let Some(fourcc) = mp4_field_fourcc(id) else {
            continue;
        };
        if value.is_empty() {
            items.retain(|(typ, _)| typ != &fourcc);
            cleared.push(id.clone());
        } else {
            let new_bytes = mp4_new_item(&fourcc, id, value)?;
            let mut replaced = false;
            let mut rebuilt = Vec::with_capacity(items.len() + 1);
            for (typ, bytes) in items.drain(..) {
                if typ == fourcc {
                    if !replaced {
                        rebuilt.push((fourcc, new_bytes.clone()));
                        replaced = true;
                    }
                } else {
                    rebuilt.push((typ, bytes));
                }
            }
            if !replaced {
                rebuilt.push((fourcc, new_bytes));
            }
            items = rebuilt;
            written.push(id.clone());
        }
    }

    // 封面：covr 内的 data type 13 = JPEG、14 = PNG
    let cover_requested = fields.contains_key("cover");
    if let Some(cd) = cover {
        let type_code = if cd.mime.contains("png") { 14u32 } else { 13u32 };
        let data_atom = mp4_data_atom(type_code, &cd.bytes)?;
        let new_bytes = mp4_item_atom(b"covr", &data_atom)?;
        items.retain(|(typ, _)| typ != b"covr");
        items.push((*b"covr", new_bytes));
        written.push("cover".into());
    } else if clear_cover
        || (cover_requested && fields.get("cover").map(|v| v.is_empty()).unwrap_or(false))
    {
        items.retain(|(typ, _)| typ != b"covr");
        cleared.push("cover".into());
    }

    let mut ilst_children = Vec::new();
    for (_, bytes) in &items {
        ilst_children.extend_from_slice(bytes);
    }
    let new_ilst = mp4_make_atom(b"ilst", &ilst_children)?;

    // --- 重建 meta（fullbox：version/flags + hdlr + ilst 等）---
    let (version_flags, meta_children) = match meta {
        Some(m) => {
            let vf = data
                .get(m.data_start..m.data_start + 4)
                .ok_or_else(|| "meta 全盒版本/标志字段被截断".to_string())?
                .to_vec();
            (vf, mp4_children(data, m.data_start + 4, m.end)?)
        }
        None => (vec![0u8; 4], Vec::new()),
    };
    let mut meta_payload = version_flags;
    let mut has_hdlr = false;
    let mut placed_ilst = false;
    let mut meta_parts: Vec<Vec<u8>> = Vec::new();
    for child in &meta_children {
        if &child.typ == b"ilst" {
            meta_parts.push(new_ilst.clone());
            placed_ilst = true;
        } else {
            if &child.typ == b"hdlr" {
                has_hdlr = true;
            }
            meta_parts.push(data[child.start..child.end].to_vec());
        }
    }
    if !has_hdlr {
        meta_parts.insert(0, mp4_hdlr()?);
        warnings.push("meta 缺少 hdlr，已补写 hdlr 'mdir'/'appl'".into());
    }
    if !placed_ilst {
        meta_parts.push(new_ilst.clone());
        warnings.push("缺少 ilst，已新建 iTunes 标签列表".into());
    }
    for part in meta_parts {
        meta_payload.extend_from_slice(&part);
    }
    let new_meta = mp4_make_atom(b"meta", &meta_payload)?;

    // --- 重建 udta ---
    let new_udta = match udta {
        Some(u) => {
            let kids = mp4_children(data, u.data_start, u.end)?;
            let mut payload = Vec::new();
            let mut replaced = false;
            for child in &kids {
                if &child.typ == b"meta" {
                    payload.extend_from_slice(&new_meta);
                    replaced = true;
                } else {
                    payload.extend_from_slice(&data[child.start..child.end]);
                }
            }
            if !replaced {
                payload.extend_from_slice(&new_meta);
            }
            mp4_make_atom(b"udta", &payload)?
        }
        None => mp4_make_atom(b"udta", &new_meta)?,
    };

    // --- 重建 moov（只替换 udta，其余 atom 字节原样保留）---
    let mut moov_payload = Vec::new();
    let mut moov_has_udta = false;
    for child in &moov_children {
        if &child.typ == b"udta" {
            moov_payload.extend_from_slice(&new_udta);
            moov_has_udta = true;
        } else {
            moov_payload.extend_from_slice(&data[child.start..child.end]);
        }
    }
    if !moov_has_udta {
        moov_payload.extend_from_slice(&new_udta);
    }
    let new_moov = mp4_make_atom(b"moov", &moov_payload)?;

    let mut out = Vec::with_capacity(data.len() + new_ilst.len() + 64);
    for atom in &top[..moov_idx] {
        out.extend_from_slice(&data[atom.start..atom.end]);
    }
    out.extend_from_slice(&new_moov);
    for atom in &top[moov_idx + 1..] {
        out.extend_from_slice(&data[atom.start..atom.end]);
    }
    Ok(Rewrite {
        bytes: out,
        written,
        cleared,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// OGG / Vorbis / Opus
// ---------------------------------------------------------------------------

const OGG_CRC_TABLE: [u32; 256] = ogg_crc_table();

/// Ogg 使用多项式 0x04C11DB7、初值 0、MSB first，与 PNG 的反射 CRC32 不同。
const fn ogg_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = (i as u32) << 24;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000_0000 != 0 {
                (c << 1) ^ 0x04C1_1DB7
            } else {
                c << 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

fn ogg_crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &b in data {
        let idx = (((crc >> 24) & 0xFF) as u8 ^ b) as usize;
        crc = (crc << 8) ^ OGG_CRC_TABLE[idx];
    }
    crc
}

struct OggPage {
    header_type: u8,
    granule: u64,
    serial: u32,
    seq: u32,
    crc: u32,
    lacing: Vec<u8>,
    body: Vec<u8>,
}

fn ogg_parse_pages(data: &[u8]) -> Result<Vec<OggPage>, String> {
    let mut pages = Vec::new();
    let mut pos = 0usize;
    while pos < data.len() {
        if data.len() - pos < 27 {
            return Err(format!("Ogg 页头被截断（偏移 {pos}）"));
        }
        if &data[pos..pos + 4] != b"OggS" {
            return Err(format!("Ogg 页缺少 OggS 标识（偏移 {pos}）"));
        }
        if data[pos + 4] != 0 {
            return Err(format!("不支持的 Ogg 页版本 {}", data[pos + 4]));
        }
        let nseg = data[pos + 26] as usize;
        if data.len() - pos < 27 + nseg {
            return Err(format!("Ogg 段表被截断（偏移 {pos}）"));
        }
        let lacing = data[pos + 27..pos + 27 + nseg].to_vec();
        let body_len: usize = lacing.iter().map(|v| *v as usize).sum();
        let body_start = pos + 27 + nseg;
        let end = body_start
            .checked_add(body_len)
            .ok_or("Ogg 页长度溢出")?;
        if end > data.len() {
            return Err(format!(
                "Ogg 页数据被截断（偏移 {pos}，需要 {body_len} 字节）"
            ));
        }
        pages.push(OggPage {
            header_type: data[pos + 5],
            granule: u64::from_le_bytes(data[pos + 6..pos + 14].try_into().unwrap()),
            serial: u32::from_le_bytes(data[pos + 14..pos + 18].try_into().unwrap()),
            seq: u32::from_le_bytes(data[pos + 18..pos + 22].try_into().unwrap()),
            crc: u32::from_le_bytes(data[pos + 22..pos + 26].try_into().unwrap()),
            lacing,
            body: data[body_start..end].to_vec(),
        });
        pos = end;
    }
    Ok(pages)
}

struct OggPacket {
    data: Vec<u8>,
    end_page: usize,
    /// 该包是否正好结束在页末（没有音频数据紧随其后）
    end_at_page_end: bool,
}

fn ogg_collect_packets(pages: &[OggPage]) -> Result<Vec<OggPacket>, String> {
    let mut packets = Vec::new();
    let mut current = Vec::new();
    for (page_idx, page) in pages.iter().enumerate() {
        let mut offset = 0usize;
        for (seg_idx, &lace) in page.lacing.iter().enumerate() {
            let n = lace as usize;
            let chunk = page
                .body
                .get(offset..offset + n)
                .ok_or_else(|| "Ogg 段表与实际页数据不一致".to_string())?;
            current.extend_from_slice(chunk);
            offset += n;
            if lace < 255 {
                let end_at_page_end = seg_idx + 1 == page.lacing.len();
                packets.push(OggPacket {
                    data: std::mem::take(&mut current),
                    end_page: page_idx,
                    end_at_page_end,
                });
            }
        }
        if offset != page.body.len() {
            return Err("Ogg 页数据与段表长度不一致".into());
        }
    }
    if !current.is_empty() {
        return Err("Ogg 最后一个包没有结束标记，文件被截断".into());
    }
    Ok(packets)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OggCodec {
    Vorbis,
    Opus,
}

fn ogg_codec(first_packet: &[u8]) -> Option<OggCodec> {
    if first_packet.starts_with(b"\x01vorbis") {
        Some(OggCodec::Vorbis)
    } else if first_packet.starts_with(b"OpusHead") {
        Some(OggCodec::Opus)
    } else {
        None
    }
}

fn ogg_comment_prefix(codec: OggCodec) -> &'static [u8] {
    match codec {
        OggCodec::Vorbis => b"\x03vorbis",
        OggCodec::Opus => b"OpusTags",
    }
}

fn ogg_comment_body<'a>(packet: &'a [u8], codec: OggCodec) -> Result<&'a [u8], String> {
    let prefix = ogg_comment_prefix(codec);
    if !packet.starts_with(prefix) {
        return Err(format!(
            "Ogg 注释包签名不正确（期望 {}）",
            String::from_utf8_lossy(prefix)
        ));
    }
    Ok(&packet[prefix.len()..])
}

fn ogg_page_bytes(
    header_type: u8,
    granule: u64,
    serial: u32,
    seq: u32,
    lacing: &[u8],
    body: &[u8],
) -> Result<Vec<u8>, String> {
    if lacing.len() > 255 {
        return Err("Ogg 单页段表超过 255 项".into());
    }
    let expected: usize = lacing.iter().map(|v| *v as usize).sum();
    if expected != body.len() {
        return Err("Ogg 段表长度与页数据不一致".into());
    }
    let mut page = Vec::with_capacity(27 + lacing.len() + body.len());
    page.extend_from_slice(b"OggS");
    page.push(0); // 版本
    page.push(header_type);
    page.extend_from_slice(&granule.to_le_bytes());
    page.extend_from_slice(&serial.to_le_bytes());
    page.extend_from_slice(&seq.to_le_bytes());
    page.extend_from_slice(&[0u8; 4]); // CRC 占位
    page.push(lacing.len() as u8);
    page.extend_from_slice(lacing);
    page.extend_from_slice(body);
    let crc = ogg_crc(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    Ok(page)
}

/// 把头部包重新铺到页：每个包从新页开始，必要时跨页并设置 continuation。
fn ogg_build_header_pages(
    start_seq: u32,
    serial: u32,
    packets: &[Vec<u8>],
) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut seq = start_seq;
    for (packet_idx, packet) in packets.iter().enumerate() {
        let mut pos = 0usize;
        let mut first_page_of_packet = true;
        loop {
            let mut lacing = Vec::with_capacity(256);
            let mut body = Vec::new();
            let mut packet_done = false;
            while lacing.len() < 255 {
                let left = packet.len() - pos;
                if left >= 255 {
                    lacing.push(255u8);
                    body.extend_from_slice(&packet[pos..pos + 255]);
                    pos += 255;
                } else {
                    lacing.push(left as u8);
                    body.extend_from_slice(&packet[pos..]);
                    pos = packet.len();
                    packet_done = true;
                    break;
                }
            }
            let mut header_type = 0u8;
            if packet_idx == 0 && first_page_of_packet {
                header_type |= 0x02; // BOS
            }
            if !first_page_of_packet {
                header_type |= 0x01; // continuation
            }
            out.push(ogg_page_bytes(
                header_type,
                0,
                serial,
                seq,
                &lacing,
                &body,
            )?);
            seq = seq.wrapping_add(1);
            first_page_of_packet = false;
            if packet_done {
                break;
            }
        }
    }
    Ok(out)
}

fn ogg_read(
    data: &[u8],
    fields: &mut FieldMap,
    cover: &mut Option<CoverInfo>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let pages = ogg_parse_pages(data)?;
    if pages.is_empty() {
        return Err("Ogg 文件没有任何页".into());
    }
    let serial = pages[0].serial;
    if let Some(bad) = pages.iter().find(|p| p.serial != serial) {
        return Err(format!(
            "Ogg 包含多个逻辑流（serial {serial} / {}），本版本不支持链式 Ogg",
            bad.serial
        ));
    }
    for (idx, page) in pages.iter().enumerate() {
        if let Ok(rebuilt) = ogg_page_bytes(
            page.header_type,
            page.granule,
            page.serial,
            page.seq,
            &page.lacing,
            &page.body,
        ) {
            let expect = u32::from_le_bytes(rebuilt[22..26].try_into().unwrap());
            if expect != page.crc {
                warnings.push(format!(
                    "第 {idx} 个 Ogg 页 CRC 不匹配（文件可能已损坏，写回时将重新计算）"
                ));
            }
        }
    }
    let packets = ogg_collect_packets(&pages)?;
    if packets.len() < 2 {
        return Err("Ogg 头部包不完整（缺少注释包）".into());
    }
    let codec = ogg_codec(&packets[0].data).ok_or_else(|| {
        "Ogg 编码不是 Vorbis/Opus（本版本只支持这两种）".to_string()
    })?;
    let body = ogg_comment_body(&packets[1].data, codec)?;
    let vc = vorbis_comment_parse(body)?;
    vorbis_read_fields(&vc, fields);
    if cover.is_none() {
        for entry in &vc.entries {
            if !entry.key.eq_ignore_ascii_case("METADATA_BLOCK_PICTURE") {
                continue;
            }
            match base64_decode(entry.value.trim()) {
                Some(raw) => match flac_picture_parse(&raw) {
                    Ok(pic) => {
                        let (width, height) = if pic.width > 0 && pic.height > 0 {
                            (pic.width, pic.height)
                        } else {
                            image_dims(&pic.data).unwrap_or((0, 0))
                        };
                        *cover = Some(CoverInfo {
                            present: true,
                            mime: pic.mime,
                            bytes: pic.data.len() as u64,
                            width,
                            height,
                        });
                        break;
                    }
                    Err(err) => warnings.push(format!(
                        "METADATA_BLOCK_PICTURE 无法解析，已忽略：{err}"
                    )),
                },
                None => warnings.push("METADATA_BLOCK_PICTURE 不是合法的 base64".into()),
            }
        }
    }
    Ok(())
}

/// 重写 Ogg 注释包并重建头部页。
///
/// 限制（不满足时返回明确错误，绝不静默写出坏文件）：
/// 1. 只支持单一逻辑流（所有页 serial 相同），链式 Ogg 会被拒绝；
/// 2. 最后一个头部包必须正好结束在页末；如果头部页里还夹着音频包，
///    无法在不改动音频数据的前提下重建，直接拒绝；
/// 3. 注释包允许跨页（会按段表重新分包并设置 continuation）。
///
/// 头部包之后的所有音频页只重编号 page sequence 并重算 CRC，页数据逐字节保留。
fn ogg_rewrite(
    data: &[u8],
    fields: &FieldMap,
    cover: Option<&CoverData>,
    clear_cover: bool,
) -> Result<Rewrite, String> {
    let pages = ogg_parse_pages(data)?;
    if pages.is_empty() {
        return Err("Ogg 文件没有任何页".into());
    }
    let serial = pages[0].serial;
    if pages.iter().any(|p| p.serial != serial) {
        return Err("Ogg 包含多个逻辑流（链式 Ogg），本版本无法安全重建".into());
    }
    let packets = ogg_collect_packets(&pages)?;
    if packets.len() < 2 {
        return Err("Ogg 头部包不完整（缺少注释包）".into());
    }
    let codec = ogg_codec(&packets[0].data).ok_or_else(|| {
        "Ogg 编码不是 Vorbis/Opus（本版本只支持这两种）".to_string()
    })?;
    let header_count = match codec {
        OggCodec::Vorbis => 3usize,
        OggCodec::Opus => 2usize,
    };
    if packets.len() < header_count {
        return Err("Ogg 头部包数量不足（文件可能被截断）".into());
    }
    let last_header = &packets[header_count - 1];
    if !last_header.end_at_page_end {
        return Err("OGG 头部页与首个音频页混排，本版本无法安全重建（不做静默损坏）".into());
    }

    let mut warnings = Vec::new();
    warnings.push(
        "OGG 限制：仅支持单一逻辑流；头部包必须与音频页分开；音频页只重编号并重算 CRC"
            .into(),
    );
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    let body = ogg_comment_body(&packets[1].data, codec)?;
    let mut vc = vorbis_comment_parse(body)?;
    vorbis_apply(&mut vc, fields, &mut written, &mut cleared);

    // 封面：METADATA_BLOCK_PICTURE（FLAC PICTURE 结构的 base64）
    let cover_requested = fields.contains_key("cover");
    if let Some(cd) = cover {
        vc.entries
            .retain(|e| !e.key.eq_ignore_ascii_case("METADATA_BLOCK_PICTURE"));
        let payload = flac_picture_payload(cd, 3);
        let encoded = base64_encode(&payload);
        vc.entries.push(VorbisEntry {
            key: "METADATA_BLOCK_PICTURE".into(),
            value: encoded.clone(),
            raw: format!("METADATA_BLOCK_PICTURE={encoded}").into_bytes(),
        });
        written.push("cover".into());
    } else if clear_cover
        || (cover_requested && fields.get("cover").map(|v| v.is_empty()).unwrap_or(false))
    {
        vc.entries
            .retain(|e| !e.key.eq_ignore_ascii_case("METADATA_BLOCK_PICTURE"));
        cleared.push("cover".into());
    }

    let new_comment_body = vorbis_comment_build(&vc);
    let mut new_comment = ogg_comment_prefix(codec).to_vec();
    new_comment.extend_from_slice(&new_comment_body);
    // Vorbis 注释头规范要求末尾 framing bit；缺它会丢失最后一条标签（ffprobe 只读到 8/9 条）。
    if codec == OggCodec::Vorbis {
        new_comment.push(0x01);
    }

    let mut header_packets: Vec<Vec<u8>> = packets[..header_count]
        .iter()
        .map(|p| p.data.clone())
        .collect();
    header_packets[1] = new_comment;

    let start_seq = pages[0].seq;
    let rebuilt = ogg_build_header_pages(start_seq, serial, &header_packets)?;
    let first_audio_page = last_header.end_page + 1;
    let mut seq = start_seq.wrapping_add(rebuilt.len() as u32);
    let mut out = Vec::with_capacity(data.len() + new_comment_body.len() + 128);
    for page in &rebuilt {
        out.extend_from_slice(page);
    }
    for (idx, page) in pages.iter().enumerate().skip(first_audio_page) {
        // 头部区已在页边界处结束，首个音频页不再延续任何包
        let header_type = if idx == first_audio_page {
            page.header_type & !0x01
        } else {
            page.header_type
        };
        out.extend_from_slice(&ogg_page_bytes(
            header_type,
            page.granule,
            page.serial,
            seq,
            &page.lacing,
            &page.body,
        )?);
        seq = seq.wrapping_add(1);
    }
    if rebuilt.len() != pages[..first_audio_page].len() {
        warnings.push(format!(
            "Ogg 头部页由 {} 页重建为 {} 页，后续音频页已重新编号",
            pages[..first_audio_page].len(),
            rebuilt.len()
        ));
    }
    Ok(Rewrite {
        bytes: out,
        written,
        cleared,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

pub fn read_into(
    path: &Path,
    format: AudioFormat,
    fields: &mut FieldMap,
    cover: &mut Option<CoverInfo>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| format!("读取音频文件失败：{e}"))?;
    match format {
        AudioFormat::Mp3 => mp3_read(&data, fields, cover, warnings),
        AudioFormat::Flac => flac_read(&data, fields, cover, warnings),
        AudioFormat::Mp4 => mp4_read(&data, fields, cover, warnings),
        AudioFormat::Ogg => ogg_read(&data, fields, cover, warnings),
    }
}

pub fn rewrite(
    format: AudioFormat,
    data: &[u8],
    fields: &FieldMap,
    cover: Option<&CoverData>,
    clear_cover: bool,
) -> Result<Rewrite, String> {
    if fields.is_empty() {
        return Err("没有勾选任何字段".into());
    }
    match format {
        AudioFormat::Mp3 => mp3_rewrite(data, fields, cover, clear_cover),
        AudioFormat::Flac => flac_rewrite(data, fields, cover, clear_cover),
        AudioFormat::Mp4 => mp4_rewrite(data, fields, cover, clear_cover),
        AudioFormat::Ogg => ogg_rewrite(data, fields, cover, clear_cover),
    }
}

// ---------------------------------------------------------------------------
// 单元测试（全部使用代码内构造的最小合法样本，不依赖外部文件）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn reqs(pairs: &[(&str, &str)]) -> FieldMap {
        let mut map = FieldMap::new();
        for (key, value) in pairs {
            map.insert(key.to_string(), value.to_string());
        }
        map
    }

    fn id3_frame_v23(id: &str, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(id.as_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(body);
        out
    }

    fn id3_frame_v24(id: &str, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(id.as_bytes());
        out.extend_from_slice(&to_synchsafe(body.len() as u32));
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(body);
        out
    }

    fn id3_text_v23(text: &str) -> Vec<u8> {
        let mut out = vec![1u8];
        out.extend_from_slice(&utf16_with_bom(text));
        out
    }

    fn id3_text_v24(text: &str) -> Vec<u8> {
        let mut out = vec![3u8];
        out.extend_from_slice(text.as_bytes());
        out
    }

    fn id3_apic_test(picture: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8];
        out.extend_from_slice(b"image/jpeg");
        out.push(0);
        out.push(3);
        out.push(0);
        out.extend_from_slice(picture);
        out
    }

    fn id3_build(version: u8, frames: &[Vec<u8>], tail: &[u8]) -> Vec<u8> {
        let body: Vec<u8> = frames.concat();
        let mut out = Vec::new();
        out.extend_from_slice(b"ID3");
        out.push(version);
        out.push(0);
        out.push(0);
        out.extend_from_slice(&to_synchsafe(body.len() as u32));
        out.extend_from_slice(&body);
        out.extend_from_slice(tail);
        out
    }

    fn fake_jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    fn fake_png(width: u32, height: u32) -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 2, 0, 0, 0]);
        out.extend_from_slice(&[0u8; 4]);
        out
    }

    fn vorbis_comment_test(entries: &[(&str, &str)]) -> VorbisComment {
        VorbisComment {
            vendor: b"renomio-test".to_vec(),
            entries: entries
                .iter()
                .map(|(key, value)| VorbisEntry {
                    key: key.to_ascii_uppercase(),
                    value: value.to_string(),
                    raw: format!("{key}={value}").into_bytes(),
                })
                .collect(),
        }
    }

    fn flac_block_bytes(typ: u8, last: bool, data: &[u8]) -> Vec<u8> {
        let mut out = vec![if last { 0x80 | typ } else { typ }];
        out.extend_from_slice(&(data.len() as u32).to_be_bytes()[1..]);
        out.extend_from_slice(data);
        out
    }

    fn flac_build(blocks: &[(u8, Vec<u8>)], audio: &[u8]) -> Vec<u8> {
        let mut out = b"fLaC".to_vec();
        let count = blocks.len();
        for (i, (typ, data)) in blocks.iter().enumerate() {
            out.extend_from_slice(&flac_block_bytes(*typ, i + 1 == count, data));
        }
        out.extend_from_slice(audio);
        out
    }

    fn ogg_packet_page(packet: &[u8], header_type: u8, granule: u64, seq: u32) -> Vec<u8> {
        assert!(packet.len() < 256);
        let lacing = vec![packet.len() as u8];
        ogg_page_bytes(header_type, granule, 0x1234, seq, &lacing, packet).unwrap()
    }

    fn assert_page_crc(bytes: &[u8]) -> Vec<OggPage> {
        let pages = ogg_parse_pages(bytes).unwrap();
        let mut pos = 0usize;
        for page in &pages {
            let expected = ogg_page_bytes(
                page.header_type,
                page.granule,
                page.serial,
                page.seq,
                &page.lacing,
                &page.body,
            )
            .unwrap();
            assert_eq!(&bytes[pos..pos + expected.len()], expected.as_slice());
            pos += expected.len();
        }
        assert_eq!(pos, bytes.len());
        pages
    }

    #[test]
    fn ogg_crc_matches_known_vector() {
        // CRC-32/MPEG-2 变体（init 0、非反射），Ogg 规范要求的多项式
        assert_eq!(ogg_crc(b"123456789"), 0x89A1_897F);
    }

    #[test]
    fn mp3_v23_chinese_roundtrip() {
        let audio = b"\xFF\xFB\x90\x00\x01\x02\x03\x04";
        let picture = fake_jpeg(8, 6);
        let frames = vec![
            id3_frame_v23("TIT2", &id3_text_v23("中文标题")),
            id3_frame_v23("TPE1", &id3_text_v23("原歌手")),
            id3_frame_v23("APIC", &id3_apic_test(&picture)),
        ];
        let data = id3_build(3, &frames, audio);

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        mp3_read(&data, &mut fields, &mut cover, &mut warnings).unwrap();
        assert_eq!(fields.get("title").map(String::as_str), Some("中文标题"));
        assert_eq!(fields.get("artist").map(String::as_str), Some("原歌手"));
        let cover = cover.expect("应能读出 APIC");
        assert_eq!(cover.mime, "image/jpeg");
        assert_eq!((cover.width, cover.height), (8, 6));

        let request = reqs(&[("title", "新的中文标题"), ("artist", "")]);
        let rewritten = mp3_rewrite(&data, &request, None, false).unwrap();
        assert!(rewritten.written.contains(&"title".to_string()));
        assert!(rewritten.cleared.contains(&"artist".to_string()));
        // 未编辑的音频尾部逐字节保留
        assert_eq!(&rewritten.bytes[rewritten.bytes.len() - audio.len()..], audio);

        let mut fields2 = FieldMap::new();
        let mut cover2 = None;
        let mut warnings2 = Vec::new();
        mp3_read(&rewritten.bytes, &mut fields2, &mut cover2, &mut warnings2).unwrap();
        assert_eq!(
            fields2.get("title").map(String::as_str),
            Some("新的中文标题")
        );
        assert!(fields2.get("artist").is_none());
        assert!(cover2.is_some(), "未编辑的封面应保留");
    }

    #[test]
    fn mp3_lyrics_uslt_roundtrip_keeps_other_frames() {
        let audio = b"\xFF\xFB\x90\x00\x01\x02\x03\x04";
        let frames = vec![
            id3_frame_v23("TIT2", &id3_text_v23("歌名")),
            id3_frame_v23("COMM", &id3_comm_body("旧注释", false)),
        ];
        let data = id3_build(3, &frames, audio);

        let request = reqs(&[("lyrics", "第一行\n第二行")]);
        let rewritten = mp3_rewrite(&data, &request, None, false).unwrap();
        assert!(rewritten.written.iter().any(|f| f == "lyrics"));

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        mp3_read(&rewritten.bytes, &mut fields, &mut cover, &mut warnings).unwrap();
        assert_eq!(fields.get("lyrics").map(String::as_str), Some("第一行\n第二行"));
        assert_eq!(fields.get("title").map(String::as_str), Some("歌名"));
        assert_eq!(fields.get("comment").map(String::as_str), Some("旧注释"));

        let request = reqs(&[("lyrics", "")]);
        let cleared = mp3_rewrite(&rewritten.bytes, &request, None, false).unwrap();
        assert!(cleared.cleared.iter().any(|f| f == "lyrics"));
        let mut fields2 = FieldMap::new();
        let mut cover2 = None;
        let mut warnings2 = Vec::new();
        mp3_read(&cleared.bytes, &mut fields2, &mut cover2, &mut warnings2).unwrap();
        assert!(fields2.get("lyrics").is_none());
        assert_eq!(fields2.get("title").map(String::as_str), Some("歌名"));
    }

    #[test]
    fn vorbis_lyrics_maps_to_lyrics_key() {
        let mut vc = VorbisComment {
            vendor: b"test".to_vec(),
            entries: Vec::new(),
        };
        let mut written = Vec::new();
        let mut cleared = Vec::new();
        let mut fields = FieldMap::new();
        fields.insert("lyrics".into(), "第一行\n第二行".into());
        vorbis_apply(&mut vc, &fields, &mut written, &mut cleared);
        assert!(written.iter().any(|f| f == "lyrics"));
        assert_eq!(
            vc.entries
                .iter()
                .find(|e| e.key.eq_ignore_ascii_case("LYRICS"))
                .map(|e| e.value.as_str()),
            Some("第一行\n第二行")
        );

        let mut read = FieldMap::new();
        vorbis_read_fields(&vc, &mut read);
        assert_eq!(read.get("lyrics").map(String::as_str), Some("第一行\n第二行"));

        let mut fields = FieldMap::new();
        fields.insert("lyrics".into(), String::new());
        vorbis_apply(&mut vc, &fields, &mut written, &mut cleared);
        assert!(cleared.iter().any(|f| f == "lyrics"));
        assert!(vc.entries.iter().all(|e| !e.key.eq_ignore_ascii_case("LYRICS")));
    }

    #[test]
    fn mp3_v24_japanese_roundtrip() {
        let tail = b"\xFF\xFB\x90\x64\x00\x00";
        let frames = vec![
            id3_frame_v24("TIT2", &id3_text_v24("日本語のタイトル")),
            id3_frame_v24("TDRC", &id3_text_v24("2024-04-01")),
            id3_frame_v24("TPE1", &id3_text_v24("アーティスト")),
        ];
        let data = id3_build(4, &frames, tail);

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        mp3_read(&data, &mut fields, &mut cover, &mut warnings).unwrap();
        assert_eq!(
            fields.get("title").map(String::as_str),
            Some("日本語のタイトル")
        );
        assert_eq!(fields.get("year").map(String::as_str), Some("2024-04-01"));

        let request = reqs(&[
            ("title", "新しい日本語タイトル"),
            ("artist", "新しいアーティスト"),
            ("year", "2025"),
        ]);
        let rewritten = mp3_rewrite(&data, &request, None, false).unwrap();
        assert_eq!(rewritten.bytes[3], 4, "应保持 ID3v2.4");
        assert_eq!(&rewritten.bytes[rewritten.bytes.len() - tail.len()..], tail);

        let (_, parsed_frames, _, _) = id3_parse(&rewritten.bytes).unwrap();
        let ids: Vec<String> = parsed_frames.iter().map(frame_id).collect();
        assert!(ids.contains(&"TDRC".to_string()));
        assert!(!ids.contains(&"TYER".to_string()));

        let mut fields2 = FieldMap::new();
        let mut warnings2 = Vec::new();
        mp3_read(&rewritten.bytes, &mut fields2, &mut None, &mut warnings2).unwrap();
        assert_eq!(
            fields2.get("title").map(String::as_str),
            Some("新しい日本語タイトル")
        );
        assert_eq!(fields2.get("year").map(String::as_str), Some("2025"));
    }

    #[test]
    fn flac_chinese_roundtrip_keeps_streaminfo() {
        let streaminfo: Vec<u8> = (0..34).map(|i| (i * 3) as u8).collect();
        let vc = vorbis_comment_test(&[("TITLE", "中文标题"), ("ARTIST", "原歌手")]);
        let vc_payload = vorbis_comment_build(&vc);
        let audio = b"\xFF\xF8\x69\x08\x00\x00\x00\x00";
        let data = flac_build(
            &[
                (0, streaminfo.clone()),
                (4, vc_payload),
                (1, vec![0u8; 16]),
            ],
            audio,
        );

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        flac_read(&data, &mut fields, &mut cover, &mut warnings).unwrap();
        assert_eq!(fields.get("title").map(String::as_str), Some("中文标题"));

        let request = reqs(&[
            ("title", "新的中文标题"),
            ("album", "我的专辑"),
            ("albumArtist", "乐队"),
        ]);
        let rewritten = flac_rewrite(&data, &request, None, false).unwrap();
        assert_eq!(&rewritten.bytes[rewritten.bytes.len() - audio.len()..], audio);

        let (blocks, _) = flac_parse(&rewritten.bytes).unwrap();
        let first = &blocks[0];
        assert_eq!(first.typ, 0, "STREAMINFO 必须仍是首块");
        assert_eq!(first.data, streaminfo, "STREAMINFO 必须逐字节不变");
        // flac_parse 只有在读到 last-block 标志后才会返回，长度变化后块链仍合法
        assert!(blocks.len() >= 3);

        let mut fields2 = FieldMap::new();
        let mut warnings2 = Vec::new();
        flac_read(&rewritten.bytes, &mut fields2, &mut None, &mut warnings2).unwrap();
        assert_eq!(
            fields2.get("title").map(String::as_str),
            Some("新的中文标题")
        );
        assert_eq!(fields2.get("album").map(String::as_str), Some("我的专辑"));
        assert_eq!(
            fields2.get("albumArtist").map(String::as_str),
            Some("乐队")
        );
        // 未出现在 fields 中的 ARTIST 必须原样保留
        assert_eq!(
            fields2.get("artist").map(String::as_str),
            Some("原歌手")
        );
    }

    #[test]
    fn m4a_creates_ilst_and_reads_back() {
        let ftyp = mp4_make_atom(b"ftyp", b"M4A \0\0\0\0").unwrap();
        let mvhd = mp4_make_atom(b"mvhd", &[7u8; 100]).unwrap();
        let moov = mp4_make_atom(b"moov", &mvhd).unwrap();
        let mut data = ftyp;
        data.extend_from_slice(&moov);

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        mp4_read(&data, &mut fields, &mut cover, &mut warnings).unwrap();
        assert!(fields.is_empty());

        let png = fake_png(32, 16);
        let cover_data = CoverData {
            bytes: png.clone(),
            mime: "image/png",
        };
        let request = reqs(&[
            ("title", "中文标题"),
            ("artist", "歌手"),
            ("track", "3/12"),
            ("albumArtist", "组合"),
            ("lyrics", "第一行\n第二行"),
        ]);
        let rewritten = mp4_rewrite(&data, &request, Some(&cover_data), false).unwrap();
        for id in ["title", "artist", "track", "albumArtist", "lyrics", "cover"] {
            assert!(
                rewritten.written.contains(&id.to_string()),
                "应记录写入字段 {id}"
            );
        }

        // 父 atom 尺寸正确、mvhd 原样保留
        let top = mp4_children(&rewritten.bytes, 0, rewritten.bytes.len()).unwrap();
        let moov = mp4_find(&top, b"moov").expect("moov 应存在");
        assert_eq!(moov.end, rewritten.bytes.len());
        assert!(rewritten
            .bytes
            .windows(mvhd.len())
            .any(|w| w == mvhd.as_slice()));

        let mut fields2 = FieldMap::new();
        let mut cover2 = None;
        let mut warnings2 = Vec::new();
        mp4_read(&rewritten.bytes, &mut fields2, &mut cover2, &mut warnings2).unwrap();
        assert_eq!(fields2.get("title").map(String::as_str), Some("中文标题"));
        assert_eq!(fields2.get("artist").map(String::as_str), Some("歌手"));
        assert_eq!(fields2.get("track").map(String::as_str), Some("3/12"));
        assert_eq!(
            fields2.get("albumArtist").map(String::as_str),
            Some("组合")
        );
        let cover2 = cover2.expect("应能读出 covr");
        assert_eq!(cover2.mime, "image/png");
        assert_eq!((cover2.width, cover2.height), (32, 16));
        assert_eq!(cover2.bytes, png.len() as u64);
    }

    #[test]
    fn clear_fields_and_cover() {
        let audio = b"\xFF\xFB\x90\x00\xAA";
        let frames = vec![
            id3_frame_v23("TIT2", &id3_text_v23("待删除标题")),
            id3_frame_v23("TPE1", &id3_text_v23("待删除歌手")),
            id3_frame_v23("APIC", &id3_apic_test(&fake_jpeg(4, 4))),
        ];
        let data = id3_build(3, &frames, audio);
        let request = reqs(&[("title", ""), ("artist", ""), ("cover", "")]);
        let rewritten = mp3_rewrite(&data, &request, None, true).unwrap();
        for id in ["title", "artist", "cover"] {
            assert!(
                rewritten.cleared.contains(&id.to_string()),
                "应记录清空字段 {id}"
            );
        }
        assert_eq!(&rewritten.bytes[rewritten.bytes.len() - audio.len()..], audio);

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        mp3_read(&rewritten.bytes, &mut fields, &mut cover, &mut warnings).unwrap();
        assert!(fields.is_empty(), "所有文本字段应已清空");
        assert!(cover.is_none(), "封面应已删除");
    }

    #[test]
    fn ogg_opus_comment_roundtrip_and_crc() {
        let head = b"OpusHead\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00\x00".to_vec();
        let tags_prefix = b"OpusTags";
        let vc = vorbis_comment_test(&[("TITLE", "中文标题"), ("ARTIST", "歌手")]);
        let mut tags = tags_prefix.to_vec();
        tags.extend_from_slice(&vorbis_comment_build(&vc));
        let audio1 = vec![0xAAu8; 6];
        let audio2 = vec![0xBBu8; 7];

        let mut data = ogg_packet_page(&head, 0x02, 0, 0);
        data.extend(ogg_packet_page(&tags, 0, 0, 1));
        data.extend(ogg_packet_page(&audio1, 0, 960, 2));
        data.extend(ogg_packet_page(&audio2, 0x04, 1920, 3));
        assert_page_crc(&data);

        let mut fields = FieldMap::new();
        let mut cover = None;
        let mut warnings = Vec::new();
        ogg_read(&data, &mut fields, &mut cover, &mut warnings).unwrap();
        assert_eq!(fields.get("title").map(String::as_str), Some("中文标题"));

        let png = fake_png(20, 10);
        let cover_data = CoverData {
            bytes: png.clone(),
            mime: "image/png",
        };
        let request = reqs(&[("title", "新的中文标题"), ("artist", "新歌手")]);
        let rewritten = ogg_rewrite(&data, &request, Some(&cover_data), false).unwrap();
        assert!(rewritten.written.contains(&"title".to_string()));
        assert!(rewritten.written.contains(&"cover".to_string()));

        let pages = assert_page_crc(&rewritten.bytes);
        assert_eq!(pages.len(), 4, "头部页数不变时音频页应保持");
        assert_eq!(pages[2].body, audio1, "音频页数据必须逐字节保留");
        assert_eq!(pages[3].body, audio2);
        assert_eq!(pages[2].seq, 2);
        assert_eq!(pages[3].seq, 3);
        assert_eq!(pages[3].header_type & 0x04, 0x04, "EOS 标志应保留");

        let mut fields2 = FieldMap::new();
        let mut cover2 = None;
        let mut warnings2 = Vec::new();
        ogg_read(&rewritten.bytes, &mut fields2, &mut cover2, &mut warnings2).unwrap();
        assert_eq!(
            fields2.get("title").map(String::as_str),
            Some("新的中文标题")
        );
        assert_eq!(fields2.get("artist").map(String::as_str), Some("新歌手"));
        let cover2 = cover2.expect("应能读出 METADATA_BLOCK_PICTURE");
        assert_eq!(cover2.mime, "image/png");
        assert_eq!((cover2.width, cover2.height), (20, 10));
    }

    #[test]
    fn invalid_or_truncated_data_returns_err_without_panic() {
        // MP3：标签声明长度超过文件
        let bad_mp3 = b"ID3\x03\x00\x00\x00\x00\x10\x00".to_vec();
        assert!(mp3_rewrite(&bad_mp3, &reqs(&[("title", "x")]), None, false).is_err());

        // FLAC：metadata block 声明长度越界
        let mut bad_flac = b"fLaC".to_vec();
        bad_flac.extend_from_slice(&[0x80, 0x00, 0x00, 0x32]);
        assert!(flac_rewrite(&bad_flac, &reqs(&[("title", "x")]), None, false).is_err());

        // M4A：atom 尺寸越界
        let bad_mp4 = b"\x00\x00\x00\x64moov".to_vec();
        assert!(mp4_rewrite(&bad_mp4, &reqs(&[("title", "x")]), None, false).is_err());

        // OGG：页头被截断
        let bad_ogg = b"OggS\x00\x00".to_vec();
        assert!(ogg_rewrite(&bad_ogg, &reqs(&[("title", "x")]), None, false).is_err());

        // 截断的 Ogg 页数据
        let mut short_page = b"OggS".to_vec();
        short_page.extend_from_slice(&[0, 0]);
        short_page.extend_from_slice(&[0u8; 8]); // granule
        short_page.extend_from_slice(&0x1234u32.to_le_bytes());
        short_page.extend_from_slice(&0u32.to_le_bytes());
        short_page.extend_from_slice(&0u32.to_le_bytes());
        short_page.push(1); // 段数
        short_page.push(20); // 声称 20 字节，实际没有
        assert!(ogg_parse_pages(&short_page).is_err());
    }
}
