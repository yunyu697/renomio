//! 字体容器只读解析：TrueType（`\x00\x01\x00\x00`）、Apple TrueType（`true`）、
//! CFF 轮廓的 OpenType（`OTTO`）与 TrueType 集合（`ttcf`）。
//!
//! 字体文件里的名字不在文件属性里，只在 `name` 表的编码记录中，因此此前这类文件一律落到
//! 「未识别的文件类型」，属性面板只剩文件大小。本模块把它们读成封面级信息：族名、字形、
//! 全名、PostScript 名、版本、设计者、授权、字重、字形数、设计网格，以及集合里装了几个字体。
//!
//! 三条硬约束（与其它容器模块一致）：
//! - **只读**：不写回、不改字节、不动文件。
//! - **不猜**：读不出来的量返回 `None` 并在 `warnings` 里写清原因（比如缺 `name` 表），
//!   绝不拿文件名或默认值顶上。
//! - **不 panic**：字体是外部输入，长度/偏移异常一律按「读不到」处理。

use encoding_rs::WINDOWS_1252;

/// 一个字体容器的解析结果。字段用规范名，展示文案由调用方决定。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FontProbe {
    /// 展示用格式名，例如「OpenType 字体（CFF 轮廓）」。
    pub format: String,
    /// TTC / OTC 集合里声明的字体数（单字体为 `None`）。
    pub faces: Option<usize>,
    pub family: Option<String>,
    pub subfamily: Option<String>,
    pub full_name: Option<String>,
    pub postscript: Option<String>,
    pub version: Option<String>,
    pub designer: Option<String>,
    pub license: Option<String>,
    /// `OS/2` 的 `usWeightClass`。
    pub weight: Option<u16>,
    /// `OS/2` 的 `fsSelection` 第 0 位（斜体）。
    pub italic: Option<bool>,
    /// `maxp` 的 `numGlyphs`。
    pub glyphs: Option<u16>,
    /// `head` 的 `unitsPerEm`。
    pub units_per_em: Option<u16>,
    pub warnings: Vec<String>,
}

impl FontProbe {
    fn new(format: &str) -> Self {
        Self {
            format: format.to_string(),
            ..Default::default()
        }
    }

    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.warnings.iter().any(|w| w == &message) {
            self.warnings.push(message);
        }
    }
}

/// 一张表目录项：标签、文件内偏移、长度。
struct Table {
    tag: [u8; 4],
    offset: usize,
    length: usize,
}

/// 探测并解析一个字体容器。不是字体时返回 `None`（交给别的解析器）。
pub fn probe(data: &[u8]) -> Option<FontProbe> {
    if data.len() < 12 {
        return None;
    }
    if data.starts_with(b"ttcf") {
        return Some(collection(data));
    }
    let format = flavor(data.get(0..4)?)?;
    Some(face(data, 0, format))
}

/// 单字体表头（sfnt version）→ 展示用格式名；不是字体版本号返回 `None`。
fn flavor(tag: &[u8]) -> Option<&'static str> {
    match tag {
        [0x00, 0x01, 0x00, 0x00] => Some("TrueType 字体（二次曲线）"),
        b"OTTO" => Some("OpenType 字体（CFF 轮廓）"),
        b"true" => Some("TrueType 字体（Apple 表头）"),
        b"typ1" => Some("Type 1 字体（sfnt 封装）"),
        _ => None,
    }
}

/// TrueType / OpenType 集合：`ttcf` + 版本 + 字体数 + 各字体表头的偏移数组。
fn collection(data: &[u8]) -> FontProbe {
    let mut probe = FontProbe::new("TrueType 集合（TTC / OTC）");
    let count = be_u32(data, 8).unwrap_or(0) as usize;
    if count == 0 {
        probe.warn("集合头声明字体数为 0：读不到任何字体");
        return probe;
    }
    probe.faces = Some(count);

    let mut first: Option<FontProbe> = None;
    let mut usable = 0usize;
    for index in 0..count {
        let offset = match be_u32(data, 12 + index * 4) {
            Some(offset) => offset as usize,
            None => {
                probe.warn(format!("集合只声明了 {index} 个字体偏移，第 {index} 个起读不到"));
                break;
            }
        };
        if offset + 12 > data.len() {
            probe.warn(format!("第 {index} 个字体表头偏移 {offset} 越过文件末尾，跳过"));
            continue;
        }
        let Some(format) = flavor(&data[offset..offset + 4]) else {
            probe.warn(format!("第 {index} 个字体表头不是已知的 sfnt 版本，跳过"));
            continue;
        };
        usable += 1;
        if first.is_none() {
            first = Some(face(data, offset, format));
        }
    }

    match first {
        Some(child) => {
            probe.family = child.family;
            probe.subfamily = child.subfamily;
            probe.full_name = child.full_name;
            probe.postscript = child.postscript;
            probe.version = child.version;
            probe.designer = child.designer;
            probe.license = child.license;
            probe.weight = child.weight;
            probe.italic = child.italic;
            probe.glyphs = child.glyphs;
            probe.units_per_em = child.units_per_em;
            for warning in child.warnings {
                probe.warn(warning);
            }
            if usable < count {
                probe.warn(format!(
                    "集合里 {count} 个字体只有 {usable} 个表头可解析，其余按「读不到」处理"
                ));
            }
        }
        None => probe.warn("集合里没有一个字体的表头可解析"),
    }
    probe
}

/// 解析从 `base` 开始的单个 sfnt 字体。
fn face(data: &[u8], base: usize, format: &str) -> FontProbe {
    let mut probe = FontProbe::new(format);
    let Some(tables) = table_directory(data, base, &mut probe) else {
        return probe;
    };

    if let Some(name) = tables.iter().find(|t| &t.tag == b"name") {
        read_names(data, name, &mut probe);
    } else {
        probe.warn("没有 `name` 表：这个字体没写族名，属性面板只能给出结构与计数");
    }

    if let Some(maxp) = tables.iter().find(|t| &t.tag == b"maxp") {
        if let Some(glyphs) = data.get(maxp.offset + 4..maxp.offset + 6) {
            probe.glyphs = Some(u16::from_be_bytes([glyphs[0], glyphs[1]]));
        }
    }
    if let Some(head) = tables.iter().find(|t| &t.tag == b"head") {
        if let Some(upm) = data.get(head.offset + 18..head.offset + 20) {
            let upm = u16::from_be_bytes([upm[0], upm[1]]);
            if upm > 0 {
                probe.units_per_em = Some(upm);
            }
        }
    }
    if let Some(os2) = tables.iter().find(|t| &t.tag == b"OS/2") {
        if let Some(body) = data.get(os2.offset..os2.offset.saturating_add(os2.length)) {
            if let Some(weight) = be_u16(body, 4) {
                if weight > 0 {
                    probe.weight = Some(weight);
                }
            }
            if let Some(selection) = be_u16(body, 62) {
                probe.italic = Some(selection & 0b1 == 1);
            }
        }
    }
    probe
}

/// 表目录：`numTables` 个 16 字节项（标签 / 校验和 / 偏移 / 长度）。
fn table_directory(data: &[u8], base: usize, probe: &mut FontProbe) -> Option<Vec<Table>> {
    let num_tables = be_u16(data, base + 4)? as usize;
    if num_tables == 0 {
        probe.warn("表目录为空（numTables = 0）");
        return None;
    }
    let mut tables = Vec::with_capacity(num_tables);
    for index in 0..num_tables {
        let at = base + 12 + index * 16;
        let Some(tag) = data.get(at..at + 4) else {
            probe.warn(format!("表目录第 {index} 项越过文件末尾，后面的表都读不到"));
            break;
        };
        let offset = be_u32(data, at + 8).unwrap_or(0) as usize;
        let length = be_u32(data, at + 12).unwrap_or(0) as usize;
        if offset >= data.len() {
            probe.warn(format!(
                "表 `{}` 的偏移 {offset} 越过文件末尾，跳过",
                tag_text(tag)
            ));
            continue;
        }
        tables.push(Table {
            tag: [tag[0], tag[1], tag[2], tag[3]],
            offset,
            length: length.min(data.len() - offset),
        });
    }
    if tables.is_empty() {
        probe.warn("表目录里没有一项可用");
        return None;
    }
    Some(tables)
}

/// `name` 表：同一字段有多个平台/语言版本，按「Windows 英文 → Unicode 平台 →
/// Windows 其它语言 → Mac 平台」偏好取一条。
fn read_names(data: &[u8], table: &Table, probe: &mut FontProbe) {
    let body = match data.get(table.offset..table.offset.saturating_add(table.length)) {
        Some(body) if body.len() >= 6 => body,
        _ => {
            probe.warn("`name` 表被截断，读不到名字记录");
            return;
        }
    };
    let count = be_u16(body, 2).unwrap_or(0) as usize;
    let strings = be_u16(body, 4).unwrap_or(0) as usize;
    if count == 0 {
        probe.warn("`name` 表里没有名字记录");
        return;
    }

    // nameID → (偏好分, 文本)：同一个 nameID 只保留偏好最高的一条。
    let mut best: Vec<(u16, u8, String)> = Vec::new();
    let mut mac_used = false;

    for index in 0..count {
        let at = 6 + index * 12;
        let Some(record) = body.get(at..at + 12) else {
            probe.warn(format!("`name` 表第 {index} 条记录越过表尾，后面读不到"));
            break;
        };
        let platform = u16::from_be_bytes([record[0], record[1]]);
        let language = u16::from_be_bytes([record[4], record[5]]);
        let name_id = u16::from_be_bytes([record[6], record[7]]);
        let length = u16::from_be_bytes([record[8], record[9]]) as usize;
        let offset = u16::from_be_bytes([record[10], record[11]]) as usize;

        let start = strings.saturating_add(offset);
        let Some(raw) = body.get(start..start.saturating_add(length)) else {
            continue; // 单条记录越界只丢这条，不影响其它名字
        };

        let score = match (platform, language) {
            (3, 0x0409) => 4u8, // Windows，英文（美国）
            (0, _) => 3,        // Unicode 平台
            (3, _) => 2,        // Windows，其它语言
            (1, _) => 1,        // Macintosh
            _ => 0,
        };
        if platform == 1 {
            mac_used = true;
        }
        if score == 0 {
            continue;
        }
        let text = match platform {
            0 | 3 => utf16be(raw),
            _ => mac_text(raw),
        };
        match best.iter_mut().find(|(id, _, _)| *id == name_id) {
            Some(slot) => {
                if slot.1 < score {
                    slot.1 = score;
                    slot.2 = text;
                }
            }
            None => best.push((name_id, score, text)),
        }
    }

    for (id, _, text) in best {
        let text = clean_text(&text);
        if text.is_empty() {
            continue;
        }
        let slot = match id {
            1 => &mut probe.family,
            2 => &mut probe.subfamily,
            4 => &mut probe.full_name,
            5 => &mut probe.version,
            6 => &mut probe.postscript,
            9 => &mut probe.designer,
            13 => &mut probe.license,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(text);
        }
    }

    if probe.family.is_none() && probe.full_name.is_none() {
        probe.warn("`name` 表里没有族名记录（nameID 1/4），这个字体可能只写了 PostScript 名");
    }
    if mac_used {
        probe.warn(
            "`name` 表含 Mac 平台记录：按 UTF-8 / Windows-1252 近似解码（未内置 MacRoman 码表）",
        );
    }
}

/// `name` 表的 UTF-16BE 字符串；长度为奇数时丢掉最后一个孤立字节。
fn utf16be(raw: &[u8]) -> String {
    let usable = raw.len() - raw.len() % 2;
    let units: Vec<u16> = raw[..usable]
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Mac 平台记录：MacRoman 没有内置码表，能按 UTF-8 读就按 UTF-8，否则按 Windows-1252。
fn mac_text(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = WINDOWS_1252.decode(raw);
            text.into_owned()
        }
    }
}

/// 名字里偶有 `\0` 与多余空白（部分字体把名字补到定长），读出来统一清掉。
fn clean_text(raw: &str) -> String {
    let trimmed: String = raw.chars().filter(|c| *c != '\0').collect();
    trimmed.trim().to_string()
}

fn tag_text(tag: &[u8]) -> String {
    tag.iter()
        .map(|b| if b.is_ascii_graphic() { *b as char } else { '?' })
        .collect()
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// 字重编号 → 人话（与 CSS `font-weight` 命名一致）。
pub fn weight_name(weight: u16) -> &'static str {
    match weight {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_font_bytes_are_rejected() {
        assert!(probe(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).is_none());
        assert!(probe(b"%PDF-1.7\n").is_none());
        assert!(probe(&[]).is_none());
        // `ttcf` 但太短
        assert!(probe(b"ttcf").is_none());
    }

    #[test]
    fn utf16_and_mac_decoders_are_bounded() {
        assert_eq!(utf16be(&[0x00, 0x41, 0x00]), "A");
        assert_eq!(mac_text("Acme".as_bytes()), "Acme");
    }

    #[test]
    fn weight_names_cover_the_common_ten() {
        assert_eq!(weight_name(400), "Regular");
        assert_eq!(weight_name(700), "Bold");
        assert_eq!(weight_name(1234), "");
    }
}
