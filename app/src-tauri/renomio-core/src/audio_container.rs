//! 音频容器只读解析：WAV（RIFF/RF64）、AIFF/AIFC、APE（Monkey's Audio）、ASF（WMA）。
//!
//! 这些容器此前一律被 `metadata.rs` 拒绝（缺口表 5.11「明确拒绝，不静默跳过」）。本模块把它们
//! 做成真能力：读出采样率、声道、位深、时长，以及容器自带的文本标签（标题/艺术家/专辑/年份/
//! 流派/音轨/作曲/备注）。
//!
//! 三条硬约束：
//! - **只读**：不写回、不改字节、不动文件。
//! - **不猜**：读不出来的量返回 `None` 并在 warnings 里写清原因（比如 APE 的头数据是压缩的，
//!   不解码就不假装知道采样率），绝不填默认值糊过去。
//! - **不 panic**：容器是外部输入，任何长度/偏移异常都按「读不到」处理。

use encoding_rs::WINDOWS_1252;

/// 探测并解析一个音频容器。不是本模块认识的容器时返回 `None`（交给别的解析器）。
///
/// `data` 是文件头部（最多 8MB），`tail` 是文件尾部（只在文件超过头部上限时非空，用于读
/// 写在文件末尾的标签，比如 WAV 的 `LIST/INFO` 与 APEv2 的 footer）。
pub fn probe(data: &[u8], tail: &[u8]) -> Option<AudioProbe> {
    if data.len() < 12 {
        return None;
    }
    if (data.starts_with(b"RIFF") || data.starts_with(b"RF64"))
        && data.get(8..12) == Some(b"WAVE".as_ref())
    {
        return Some(wav(data, tail, data.starts_with(b"RF64")));
    }
    if data.starts_with(b"FORM") && matches!(data.get(8..12), Some(b"AIFF") | Some(b"AIFC")) {
        return Some(aiff(data));
    }
    if data.starts_with(b"MAC ") {
        return Some(ape(data, tail));
    }
    if data.starts_with(&ASF_HEADER) {
        return Some(asf(data));
    }
    None
}

/// 一个音频容器的解析结果。字段用规范键名（`title`/`artist`/…），展示文案由调用方决定。
#[derive(Clone, Debug, Default)]
pub struct AudioProbe {
    /// 展示用格式名，例如「WAV 无损音频」。
    pub format: String,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub bits: Option<u16>,
    pub duration_ms: Option<u64>,
    /// 规范键名 + 值，按容器内出现顺序。
    pub tags: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

impl AudioProbe {
    fn new(format: &str) -> Self {
        Self {
            format: format.to_string(),
            ..Default::default()
        }
    }

    fn tag(&mut self, key: &str, value: String) {
        if value.trim().is_empty() {
            return;
        }
        if self.tags.iter().any(|(k, _)| k == key) {
            return;
        }
        self.tags.push((key.to_string(), value.trim().to_string()));
    }

    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.warnings.iter().any(|w| w == &message) {
            self.warnings.push(message);
        }
    }
}

// ---------------------------------------------------------------------------
// WAV（RIFF / RF64）
// ---------------------------------------------------------------------------

fn wav(data: &[u8], tail: &[u8], rf64: bool) -> AudioProbe {
    let mut p = AudioProbe::new(if rf64 { "WAV 大音频（RF64）" } else { "WAV 无损音频" });
    let mut pos = 12usize;
    let mut byte_rate = 0u64;
    let mut block_align = 0u64;
    let mut ds64_data: Option<u64> = None;
    let mut ds64_riff: Option<u64> = None;
    let mut declared_data: Option<u64> = None;
    let mut saw_fmt = false;

    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let raw_len = le_u32(data, pos + 4).unwrap_or(0);
        let body = pos + 8;
        let available = data.len().saturating_sub(body);
        match id {
            b"ds64" => {
                // ds64：riffSize(u64) dataSize(u64) sampleCount(u64) tableLength(u32)
                ds64_riff = le_u64(data, body);
                ds64_data = le_u64(data, body + 8);
            }
            b"fmt " => {
                if available >= 16 {
                    let channels = le_u16(data, body + 2).unwrap_or(0);
                    let rate = le_u32(data, body + 4).unwrap_or(0);
                    byte_rate = le_u32(data, body + 8).unwrap_or(0) as u64;
                    block_align = le_u16(data, body + 12).unwrap_or(0) as u64;
                    let bits = le_u16(data, body + 14).unwrap_or(0);
                    if rate > 0 {
                        p.sample_rate = Some(rate);
                    }
                    if channels > 0 {
                        p.channels = Some(channels);
                    }
                    if bits > 0 {
                        p.bits = Some(bits);
                    }
                    saw_fmt = true;
                } else {
                    p.warn("fmt 块短于 16 字节，音频参数无法读取");
                }
            }
            b"data" => {
                let len = if rf64 && raw_len == u32::MAX {
                    ds64_data.unwrap_or(0)
                } else {
                    raw_len as u64
                };
                declared_data = Some(len);
            }
            b"LIST" if data.get(body..body + 4) == Some(b"INFO".as_ref()) => {
                read_riff_info(&data[body + 4..], &mut p);
            }
            _ => {}
        }
        let step = if rf64 && raw_len == u32::MAX {
            ds64_riff.map(|v| v as usize).unwrap_or(raw_len as usize)
        } else {
            raw_len as usize
        };
        pos = body.saturating_add(step);
        if step % 2 == 1 {
            pos += 1;
        }
        if step == 0 {
            break;
        }
    }
    let _ = ds64_riff;

    if !saw_fmt {
        p.warn("没有找到 fmt 块（不是标准 WAV，音频参数未解析）");
    }
    if p.tags.is_empty() && !tail.is_empty() {
        // 标签常写在音频数据之后：头部读不到就到尾部找 LIST/INFO（"LIST" 之后是 4 字节长度，再是 "INFO"）
        if let Some(at) = find_subslice(tail, b"LIST") {
            let rest = &tail[at + 8..];
            if rest.get(..4) == Some(b"INFO".as_ref()) {
                read_riff_info(&rest[4..], &mut p);
            }
        }
    }
    if let (Some(bytes), true) = (declared_data, byte_rate > 0) {
        p.duration_ms = Some(bytes.saturating_mul(1000) / byte_rate);
    } else if let (Some(bytes), true) = (declared_data, block_align > 0) {
        if let Some(rate) = p.sample_rate {
            let frames = bytes / block_align;
            p.duration_ms = Some(frames.saturating_mul(1000) / rate as u64);
        }
    }
    if declared_data.is_none() {
        p.warn("没有找到 data 块，时长未解析");
    }
    p
}

fn read_riff_info(rest: &[u8], p: &mut AudioProbe) {
    let mut pos = 0usize;
    while pos + 8 <= rest.len() {
        let id = &rest[pos..pos + 4];
        let len = le_u32(rest, pos + 4).unwrap_or(0) as usize;
        let start = pos + 8;
        let Some(value) = rest.get(start..start.saturating_add(len).min(rest.len())) else {
            break;
        };
        let text = decode_text(value);
        match id {
            b"INAM" => p.tag("title", text),
            b"IART" => p.tag("artist", text),
            b"IPRD" => p.tag("album", text),
            b"ICRD" => p.tag("year", year_of(&text)),
            b"IGNR" => p.tag("genre", text),
            b"ICMT" => p.tag("comment", text),
            b"ITRK" | b"ITCH" => p.tag("track", text),
            b"ISFT" => p.tag("software", text),
            _ => {}
        }
        pos = start.saturating_add(len);
        if len % 2 == 1 {
            pos += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------

fn aiff(data: &[u8]) -> AudioProbe {
    let aifc = data.get(8..12) == Some(b"AIFC".as_ref());
    let mut p = AudioProbe::new(if aifc { "AIFC 音频" } else { "AIFF 音频" });
    let mut pos = 12usize;
    let mut frames: Option<u64> = None;
    let mut saw_comm = false;

    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let len = be_u32(data, pos + 4).unwrap_or(0) as usize;
        let body = pos + 8;
        let Some(chunk) = data.get(body..body.saturating_add(len).min(data.len())) else {
            break;
        };
        match id {
            b"COMM" => {
                saw_comm = true;
                let channels = be_u16(chunk, 0).unwrap_or(0);
                let sample_frames = be_u32(chunk, 2).unwrap_or(0) as u64;
                let bits = be_u16(chunk, 6).unwrap_or(0);
                if channels > 0 {
                    p.channels = Some(channels);
                }
                if bits > 0 {
                    p.bits = Some(bits);
                }
                if chunk.len() >= 18 {
                    if let Some(rate) = extended_80(&chunk[8..18]) {
                        if rate > 0.0 && rate.is_finite() {
                            p.sample_rate = Some(rate.round() as u32);
                        }
                    }
                }
                frames = Some(sample_frames);
                if aifc && chunk.len() >= 22 {
                    let compression = String::from_utf8_lossy(&chunk[18..22]).to_string();
                    if !compression.trim().is_empty() {
                        p.tag("codec", compression.trim().to_string());
                    }
                }
            }
            b"NAME" => p.tag("title", decode_text(chunk)),
            b"AUTH" => p.tag("artist", decode_text(chunk)),
            b"(c) " => p.tag("copyright", decode_text(chunk)),
            b"ANNO" => p.tag("comment", decode_text(chunk)),
            b"ID3 " => p.warn("内嵌 ID3 标签未解析（只读 AIFF 的 NAME / AUTH 文本块）"),
            _ => {}
        }
        pos = body.saturating_add(len);
        if len % 2 == 1 {
            pos += 1;
        }
    }

    if !saw_comm {
        p.warn("没有找到 COMM 块（不是标准 AIFF，音频参数未解析）");
    }
    if let (Some(frames), Some(rate)) = (frames, p.sample_rate) {
        if rate > 0 {
            p.duration_ms = Some(frames.saturating_mul(1000) / rate as u64);
        }
    }
    p
}

/// IFF 的 80 位扩展精度浮点（AIFF 的采样率就用这个存）。
fn extended_80(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 10 {
        return None;
    }
    let sign = bytes[0] & 0x80 != 0;
    let exponent = ((bytes[0] & 0x7F) as i32) << 8 | bytes[1] as i32;
    let mantissa = u64::from_be_bytes([
        bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
    ]);
    if exponent == 0 && mantissa == 0 {
        return Some(0.0);
    }
    if exponent == 0x7FFF {
        return None;
    }
    let value = (mantissa as f64) * 2f64.powi(exponent - 16383 - 63);
    Some(if sign { -value } else { value })
}

// ---------------------------------------------------------------------------
// APE（Monkey's Audio）
// ---------------------------------------------------------------------------

fn ape(data: &[u8], tail: &[u8]) -> AudioProbe {
    let mut p = AudioProbe::new("APE 无损音频（Monkey's Audio）");
    let version = le_u16(data, 4).unwrap_or(0);
    if version > 0 {
        p.tag("codec", format!("Monkey's Audio {version}"));
    }
    // APE 头（"MAC " 4 + version 2 + padding 2 = 8 字节），其后是 44 字节描述符字段：
    // descriptorBytes(8) headerBytes(12) seekTableBytes(16) headerDataBytes(20)
    // apeFrameDataBytes(24) apeFrameDataBytesHigh(28) terminatingDataBytes(32) md5(36..52)
    let descriptor = le_u32(data, 8).unwrap_or(0) as usize;
    let header_data_len = le_u32(data, 20).unwrap_or(0) as usize;
    let frame_bytes = le_u32(data, 24).unwrap_or(0) as u64 + (le_u32(data, 28).unwrap_or(0) as u64) << 32;

    if version < 3980 {
        p.warn("旧版 APE（3.98 之前）头结构不同，只读 APEv2 标签");
    }
    // 新版 APE 的「头数据」对 WAV 来源是未压缩的 WAV 头：能直接读 fmt 与 data 长度。
    if descriptor >= 52 && descriptor < data.len() {
        let end = descriptor
            .saturating_add(header_data_len)
            .saturating_add(8)
            .min(data.len());
        let header = &data[descriptor..end];
        if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WAVE".as_ref()) {
            let probe = wav(header, &[], false);
            p.sample_rate = probe.sample_rate;
            p.channels = probe.channels;
            p.bits = probe.bits;
            p.duration_ms = probe.duration_ms;
        } else {
            p.warn("APE 头数据已压缩，采样率/声道/时长需要解码器，未解析");
        }
    } else {
        p.warn("APE 描述符长度异常，音频参数未解析");
    }
    if frame_bytes == 0 {
        p.warn("APE 音频帧长度为 0，文件可能只有标签或已损坏");
    }

    // APEv2 标签一般在文件末尾：头部读不到就到尾部找。
    let mut tags = apev2_items(tail);
    if tags.is_empty() && tail.is_empty() {
        tags = apev2_items(data);
    }
    for (key, value) in tags {
        p.tag(&key, value);
    }
    if p.tags.iter().all(|(k, _)| k != "title") {
        p.warn("没有找到 APEv2 标题（标签可能写在文件末尾且超出了读取窗口）");
    }
    p
}

fn apev2_items(bytes: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if bytes.len() < 32 {
        return out;
    }
    let footer = &bytes[bytes.len() - 32..];
    if footer.get(..8) != Some(b"APETAGEX".as_ref()) {
        return out;
    }
    let tag_size = le_u32(footer, 12).unwrap_or(0) as usize;
    let item_count = le_u32(footer, 16).unwrap_or(0);
    let flags = le_u32(footer, 20).unwrap_or(0);
    if tag_size < 32 || tag_size > bytes.len() {
        return out;
    }
    let start = bytes.len() - tag_size;
    // 带标签头时（flags 最高位）标签头正好落在 start 处；但不同写入工具对 size 是否含标签头
    // 并不一致，所以看字节本身：start 处真是 "APETAGEX" 才跳过 32 字节。
    let body_start = if flags & 0x8000_0000 != 0
        && bytes.get(start..start + 8) == Some(b"APETAGEX".as_ref())
    {
        start.saturating_add(32)
    } else {
        start
    };
    let body_end = bytes.len() - 32;
    let mut pos = body_start;
    for _ in 0..item_count.min(128) {
        let Some(len) = le_u32(bytes, pos) else {
            break;
        };
        let Some(item_flags) = le_u32(bytes, pos + 4) else {
            break;
        };
        let data_start = pos + 8;
        let data_len = len as usize;
        if data_start + data_len > body_end {
            break;
        }
        let item = &bytes[data_start..data_start + data_len];
        let Some(nul) = item.iter().position(|b| *b == 0) else {
            pos = data_start + data_len;
            continue;
        };
        let key = String::from_utf8_lossy(&item[..nul]).to_ascii_lowercase();
        // 位 1（0x2）表示值是二进制（不支持的类型），跳过
        if item_flags & 0x2 == 0 {
            let value = decode_text(&item[nul + 1..]);
            let mapped = match key.as_str() {
                "title" => Some("title"),
                "artist" => Some("artist"),
                "album" => Some("album"),
                "year" => Some("year"),
                "genre" => Some("genre"),
                "comment" => Some("comment"),
                "track" => Some("track"),
                "composer" => Some("composer"),
                _ => None,
            };
            if let Some(mapped) = mapped {
                out.push((mapped.to_string(), value));
            }
        }
        pos = data_start + data_len;
    }
    out
}

// ---------------------------------------------------------------------------
// ASF / WMA
// ---------------------------------------------------------------------------

const ASF_HEADER: [u8; 16] = [
    0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
const ASF_FILE_PROPERTIES: [u8; 16] = [
    0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
const ASF_STREAM_PROPERTIES: [u8; 16] = [
    0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
const ASF_CONTENT_DESCRIPTION: [u8; 16] = [
    0x33, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
const ASF_EXTENDED_CONTENT: [u8; 16] = [
    0x40, 0xA4, 0xD0, 0xD2, 0x07, 0xE3, 0xD2, 0x11, 0x97, 0xF0, 0x00, 0xA0, 0xC9, 0x5E, 0xA8, 0x50,
];
const ASF_AUDIO_MEDIA: [u8; 16] = [
    0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];

fn asf(data: &[u8]) -> AudioProbe {
    let mut p = AudioProbe::new("WMA 音频（ASF 容器）");
    let header_size = le_u64(data, 16).unwrap_or(0) as usize;
    let object_count = le_u32(data, 24).unwrap_or(0);
    if header_size < 30 || header_size > data.len() {
        p.warn("ASF 头对象长度异常，文件可能被截断");
    }
    let limit = header_size.min(data.len());
    let mut pos = 30usize;
    let mut seen_file_props = false;
    let mut seen_stream = false;
    let mut preroll_ms = 0u64;

    for _ in 0..object_count.min(256) {
        if pos + 24 > limit {
            break;
        }
        let guid = &data[pos..pos + 16];
        let size = le_u64(data, pos + 16).unwrap_or(0) as usize;
        if size < 24 {
            p.warn("ASF 子对象长度小于头部，停止解析");
            break;
        }
        let end = pos.saturating_add(size).min(limit);
        let body = &data[pos + 24..end];
        if guid == ASF_FILE_PROPERTIES {
            seen_file_props = true;
            let play_duration = le_u64(body, 40).unwrap_or(0); // 100ns
            preroll_ms = le_u64(body, 56).unwrap_or(0);
            if play_duration > 0 {
                let total_ms = play_duration / 10_000;
                p.duration_ms = Some(total_ms.saturating_sub(preroll_ms));
            }
        } else if guid == ASF_STREAM_PROPERTIES {
            if body.len() >= 54 {
                let stream_type = &body[..16];
                let type_len = le_u32(body, 40).unwrap_or(0) as usize;
                let type_data = body.get(54..54 + type_len);
                if stream_type == ASF_AUDIO_MEDIA {
                    if let Some(wfx) = type_data {
                        if wfx.len() >= 16 {
                            seen_stream = true;
                            let channels = le_u16(wfx, 2).unwrap_or(0);
                            let rate = le_u32(wfx, 4).unwrap_or(0);
                            let bits = le_u16(wfx, 14).unwrap_or(0);
                            if channels > 0 {
                                p.channels = Some(channels);
                            }
                            if rate > 0 {
                                p.sample_rate = Some(rate);
                            }
                            if bits > 0 {
                                p.bits = Some(bits);
                            }
                        }
                    }
                }
            }
        } else if guid == ASF_CONTENT_DESCRIPTION {
            if body.len() >= 10 {
                let mut offset = 10usize;
                for (label, key) in [
                    (le_u16(body, 0).unwrap_or(0) as usize, "title"),
                    (le_u16(body, 2).unwrap_or(0) as usize, "artist"),
                    (le_u16(body, 4).unwrap_or(0) as usize, "copyright"),
                    (le_u16(body, 6).unwrap_or(0) as usize, "comment"),
                    (le_u16(body, 8).unwrap_or(0) as usize, "rating"),
                ] {
                    let Some(raw) = body.get(offset..offset.saturating_add(label)) else {
                        break;
                    };
                    if label > 0 {
                        p.tag(key, utf16le_text(raw));
                    }
                    offset = offset.saturating_add(label);
                }
            }
        } else if guid == ASF_EXTENDED_CONTENT {
            read_extended_content(body, &mut p);
        }
        pos = pos.saturating_add(size);
        if pos <= 30 {
            break;
        }
    }

    if !seen_file_props {
        p.warn("没有找到 ASF 文件属性对象，时长未解析");
    }
    if !seen_stream {
        p.warn("没有找到音频流属性对象，采样率/声道/位深未解析");
    }
    p
}

fn read_extended_content(body: &[u8], p: &mut AudioProbe) {
    let count = le_u16(body, 0).unwrap_or(0);
    let mut pos = 2usize;
    for _ in 0..count.min(128) {
        let name_len = le_u16(body, pos).unwrap_or(0) as usize;
        let value_type = le_u16(body, pos + 2).unwrap_or(0);
        let value_len = le_u16(body, pos + 4).unwrap_or(0) as usize;
        if name_len == 0 {
            break;
        }
        let Some(name_raw) = body.get(pos + 6..pos + 6 + name_len) else {
            break;
        };
        let name = utf16le_text(name_raw).to_ascii_lowercase();
        let value_start = pos + 6 + name_len;
        let Some(value_raw) = body.get(value_start..value_start + value_len) else {
            break;
        };
        let text = match value_type {
            0 => utf16le_text(value_raw),
            1 => decode_text(value_raw),
            2 => (le_u32(value_raw, 0).unwrap_or(0) != 0)
                .then(|| "true".to_string())
                .unwrap_or_else(|| "false".to_string()),
            3 => le_u32(value_raw, 0).unwrap_or(0).to_string(),
            4 => le_u64(value_raw, 0).unwrap_or(0).to_string(),
            5 => le_u16(value_raw, 0).unwrap_or(0).to_string(),
            _ => String::new(),
        };
        let key = name.strip_prefix("wm/").unwrap_or(&name).to_string();
        let mapped = match key.as_str() {
            "title" => Some("title"),
            "author" => Some("artist"),
            "albumtitle" => Some("album"),
            "genre" => Some("genre"),
            "year" => Some("year"),
            "tracknumber" => Some("track"),
            "composer" => Some("composer"),
            "description" => Some("comment"),
            _ => None,
        };
        if let Some(mapped) = mapped {
            p.tag(mapped, text);
        }
        pos = value_start.saturating_add(value_len);
    }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn le_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn le_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn le_u64(b: &[u8], off: usize) -> Option<u64> {
    let s = b.get(off..off.checked_add(8)?)?;
    Some(u64::from_le_bytes([
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    ]))
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// 去掉结尾的 NUL 与空白，能按 UTF-8 就按 UTF-8，否则按 Windows-1252（RIFF/APE 的常见码页）。
fn decode_text(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .rposition(|b| *b != 0 && *b != b' ')
        .map(|i| i + 1)
        .unwrap_or(0);
    let trimmed = &bytes[..end];
    match std::str::from_utf8(trimmed) {
        Ok(text) => text.to_string(),
        Err(_) => WINDOWS_1252.decode(trimmed).0.into_owned(),
    }
}

fn utf16le_text(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let end = units
        .iter()
        .rposition(|u| *u != 0 && *u != 0x20)
        .map(|i| i + 1)
        .unwrap_or(0);
    String::from_utf16_lossy(&units[..end])
}

/// 「2026-05-04」这种整日期只留年份，标签里「年份」不该带月日。
fn year_of(text: &str) -> String {
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        digits[..4].to_string()
    } else {
        text.to_string()
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_80_decodes_common_sample_rates() {
        // 44100 = 0x400E AC44 0000 0000 0000
        let rate = extended_80(&[0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]).unwrap();
        assert!((rate - 44100.0).abs() < 0.01, "{rate}");
        let rate = extended_80(&[0x40, 0x0E, 0xBB, 0x80, 0, 0, 0, 0, 0, 0]).unwrap();
        assert!((rate - 48000.0).abs() < 0.01, "{rate}");
        assert_eq!(extended_80(&[0; 10]), Some(0.0));
        assert_eq!(extended_80(&[0x7F, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0]), None);
    }

    #[test]
    fn year_only_keeps_four_digits() {
        assert_eq!(year_of("2026-05-04"), "2026");
        assert_eq!(year_of("2026"), "2026");
        assert_eq!(year_of("初夏"), "初夏");
    }

    #[test]
    fn text_decoding_prefers_utf8_then_cp1252() {
        assert_eq!(decode_text(b"Hello\0\0"), "Hello");
        // 0xE9 在 cp1252 里是 é，单独一个字节不是合法 UTF-8
        assert_eq!(decode_text(&[b'C', b'a', b'f', 0xE9, 0]), "Café");
    }
}
