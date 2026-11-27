//! IPTC 细分标签的只读解析（读侧唯一实现）。
//!
//! 与 `metaedit::image` 的写侧分工明确：写侧把 4 个 IPTC Core 字段写进 XMP + APP13，
//! 这里只负责**读**，覆盖「按元数据取名」真正用得上的细分标签：
//!
//! - XMP：`dc:subject`（关键词，rdf:Bag 列表）、`dc:description`（说明，rdf:Alt 取
//!   `x-default`）、`dc:rights`（版权）、`Iptc4xmpCore:Location`（拍摄地点）、
//!   `photoshop:City`（城市）、`Iptc4xmpCore:CountryName`（国家）；
//! - IPTC-IIM（JPEG 的 APP13 → `Photoshop 3.0` IRB → 资源 0x0404）：
//!   `2:25` 关键词（可重复）、`2:120` 说明、`2:116` 版权、`2:92` 拍摄地点、
//!   `2:90` 城市、`2:101` 国家。
//!
//! 合并规则：**逐字段 XMP 优先**，XMP 缺值时用 IIM 兜底；两边都有的字段不会被 IIM 覆盖。
//! 编码：IIM 里有 `1:90`（`ESC % G`）声明时按 UTF-8 解码，否则先试 UTF-8、失败按
//! Latin-1 近似解（不猜码页、不把字节静默当 UTF-8）。
//! 本模块只处理 JPEG；PNG / WebP / TIFF 的 XMP 仍走各自的容器解析，不在这里兜。

use std::str;

const XMP_JPEG_PREFIX: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const PHOTOSHOP_IRB_PREFIX: &[u8] = b"Photoshop 3.0\0";
const IRB_IIM: u16 = 0x0404;
const IIM_UTF8_MARKER: &[u8] = b"\x1b%G";

/// 说明 / 版权这类长文本给文件名用的截断上限，避免属性面板里出现整段散文。
const TEXT_LIMIT: usize = 512;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct IptcProbe {
    /// 关键词（XMP `dc:subject` 或 IIM `2:25`，保持文件里的顺序、去重）
    pub keywords: Vec<String>,
    /// 说明 / 描述（XMP `dc:description` 或 IIM `2:120`）
    pub caption: Option<String>,
    /// 版权（XMP `dc:rights` 或 IIM `2:116`）
    pub copyright: Option<String>,
    /// 拍摄地点（XMP `Iptc4xmpCore:Location` 或 IIM `2:92`）
    pub location: Option<String>,
    /// 城市（XMP `photoshop:City` 或 IIM `2:90`）
    pub city: Option<String>,
    /// 国家（XMP `Iptc4xmpCore:CountryName` 或 IIM `2:101`）
    pub country: Option<String>,
    /// 实际提供数据的通道：`XMP` / `IPTC-IIM` / `XMP + IPTC-IIM`
    pub source: String,
    /// 结构损坏、无法解码之类的非致命问题（不 panic、不伪造值）
    pub warnings: Vec<String>,
}

impl IptcProbe {
    pub fn is_empty(&self) -> bool {
        self.keywords.is_empty()
            && self.caption.is_none()
            && self.copyright.is_none()
            && self.location.is_none()
            && self.city.is_none()
            && self.country.is_none()
    }
}

/// 读 JPEG 里的 IPTC 细分标签；没有任何相关数据时返回 `None`。
pub fn probe(data: &[u8]) -> Option<IptcProbe> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut xmp_packets: Vec<String> = Vec::new();
    let mut app13: Vec<&[u8]> = Vec::new();
    for (marker, payload) in segments(data) {
        if marker == 0xE1 {
            if let Some(packet) = payload.strip_prefix(XMP_JPEG_PREFIX) {
                // XMP 包是 UTF-8（规范要求），坏字节按替换处理而不是 panic
                xmp_packets.push(String::from_utf8_lossy(packet).to_string());
            }
        } else if marker == 0xED && payload.starts_with(PHOTOSHOP_IRB_PREFIX) {
            app13.push(&payload[PHOTOSHOP_IRB_PREFIX.len()..]);
        }
    }

    let mut output = IptcProbe::default();
    let mut xmp_won = false;
    let mut iim_won = false;

    if !xmp_packets.is_empty() {
        let xmp = read_xmp(&xmp_packets, &mut output.warnings);
        if xmp.is_empty() {
            // XMP 包在，但没有我们要的标签：不算「XMP 提供了数据」
        } else {
            xmp_won = true;
            apply_xmp(xmp, &mut output);
        }
    }

    if !app13.is_empty() {
        let iim = read_iim(&app13, &mut output.warnings);
        if !iim.is_empty() {
            iim_won = true;
            fill_from_iim(iim, &mut output);
        }
    }

    output.source = match (xmp_won, iim_won) {
        (true, true) => "XMP + IPTC-IIM",
        (true, false) => "XMP",
        (false, true) => "IPTC-IIM",
        (false, false) => "",
    }
    .to_string();

    if output.is_empty() && output.warnings.is_empty() {
        return None;
    }
    Some(output)
}

// ---------------------------------------------------------------------------
// JPEG 段扫描
// ---------------------------------------------------------------------------

fn segments(data: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out = Vec::new();
    let mut i = 2usize;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        i += 2;
        if marker == 0xD8
            || marker == 0x01
            || (0xD0..=0xD7).contains(&marker)
            || marker == 0xD9
            || marker == 0xDA
        {
            if marker == 0xD9 || marker == 0xDA {
                break;
            }
            continue;
        }
        let Some(len) = be_u16(data, i) else {
            break;
        };
        let len = len as usize;
        if len < 2 || i + len > data.len() {
            break;
        }
        out.push((marker, &data[i + 2..i + len]));
        i += len;
    }
    out
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    let end = off + 2;
    b.get(off..end).map(|s| u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(b: &[u8], off: usize) -> Option<u32> {
    let end = off + 4;
    b.get(off..end)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

/// XMP 里我们关心的六项；`Default` 表示这一项在 XMP 里没出现。
#[derive(Default)]
struct XmpFields {
    keywords: Vec<String>,
    caption: Option<String>,
    copyright: Option<String>,
    location: Option<String>,
    city: Option<String>,
    country: Option<String>,
}

impl XmpFields {
    fn is_empty(&self) -> bool {
        self.keywords.is_empty()
            && self.caption.is_none()
            && self.copyright.is_none()
            && self.location.is_none()
            && self.city.is_none()
            && self.country.is_none()
    }
}

fn read_xmp(packets: &[String], warnings: &mut Vec<String>) -> XmpFields {
    let mut out = XmpFields::default();
    for packet in packets {
        // 关键词是列表：多段 XMP 直接累加（同一张图理论上只有一段）
        for value in list_values(packet, "dc:subject", warnings) {
            push_keyword(&mut out.keywords, value);
        }
        if out.caption.is_none() {
            out.caption = preferred_text(packet, "dc:description", warnings);
        }
        if out.copyright.is_none() {
            out.copyright = preferred_text(packet, "dc:rights", warnings);
        }
        if out.location.is_none() {
            out.location = preferred_text(packet, "Iptc4xmpCore:Location", warnings);
        }
        if out.city.is_none() {
            out.city = preferred_text(packet, "photoshop:City", warnings);
        }
        if out.country.is_none() {
            out.country = preferred_text(packet, "Iptc4xmpCore:CountryName", warnings)
                .or_else(|| preferred_text(packet, "photoshop:Country", warnings));
        }
    }
    out
}

fn apply_xmp(xmp: XmpFields, output: &mut IptcProbe) {
    output.keywords = xmp.keywords;
    output.caption = xmp.caption;
    output.copyright = xmp.copyright;
    output.location = xmp.location;
    output.city = xmp.city;
    output.country = xmp.country;
}

/// 取属性元素的**内容**（`<tag ...>…</tag>`）；自闭合或无内容返回空串。
/// 找不到标签返回 `None`，标签开了没闭返回 `None` 并记一条警告。
fn element_body<'a>(packet: &'a str, tag: &str) -> (Option<&'a str>, bool) {
    let mut from = 0usize;
    let mut found_open = false;
    while let Some(rel) = packet[from..].find(&format!("<{tag}")) {
        let start = from + rel;
        let after = &packet[start + 1..];
        // 确认标签名后面紧跟 `>`、空白或 `/`，避免 `<dc:subjectX>` 误命中
        let ch = after.chars().nth(tag.len());
        let boundary = match ch {
            Some('>') | Some('/') => true,
            Some(c) if c.is_whitespace() => true,
            _ => false,
        };
        if !boundary {
            from = start + 1;
            continue;
        }
        found_open = true;
        let Some(gt_rel) = packet[start..].find('>') else {
            return (None, found_open);
        };
        let gt = start + gt_rel;
        if packet[start..=gt].trim_end().ends_with("/>") {
            return (Some(""), found_open);
        }
        let body_start = gt + 1;
        let close = format!("</{tag}>");
        match packet[body_start..].find(&close) {
            Some(rel_end) => return (Some(&packet[body_start..body_start + rel_end]), found_open),
            None => return (None, found_open),
        }
    }
    (None, false)
}

/// 列表属性的全部 `<rdf:li>`（Bag / Seq / Alt 都按这个读）。
fn list_values(packet: &str, tag: &str, warnings: &mut Vec<String>) -> Vec<String> {
    let (body, found) = element_body(packet, tag);
    let Some(body) = body else {
        if found {
            warnings.push(format!("XMP 的 {tag} 没有闭合标签，已忽略"));
        }
        return Vec::new();
    };
    if body.trim().is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = body[from..].find("<rdf:li") {
        let start = from + rel;
        let Some(gt_rel) = body[start..].find('>') else {
            break;
        };
        let gt = start + gt_rel;
        if body[start..=gt].trim_end().ends_with("/>") {
            from = gt + 1;
            continue;
        }
        let Some(end_rel) = body[gt + 1..].find("</rdf:li>") else {
            warnings.push(format!("XMP 的 {tag} 里有一段 <rdf:li> 没闭合，已忽略"));
            break;
        };
        let text = xml_unescape(body[gt + 1..gt + 1 + end_rel].trim());
        if !text.is_empty() {
            out.push(text);
        }
        from = gt + 1 + end_rel + "</rdf:li>".len();
    }
    out
}

/// 文本属性：优先 `xml:lang="x-default"` 的那条 `<rdf:li>`，否则第一条；
/// 没有 `<rdf:li>` 时按简单文本元素读。
fn preferred_text(packet: &str, tag: &str, warnings: &mut Vec<String>) -> Option<String> {
    let (body, found) = element_body(packet, tag);
    let Some(body) = body else {
        if found {
            warnings.push(format!("XMP 的 {tag} 没有闭合标签，已忽略"));
        }
        return None;
    };
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !body.contains("<rdf:li") {
        let text = xml_unescape(trimmed);
        return non_empty(text);
    }

    let mut first: Option<String> = None;
    let mut default_lang: Option<String> = None;
    let mut from = 0usize;
    while let Some(rel) = body[from..].find("<rdf:li") {
        let start = from + rel;
        let Some(gt_rel) = body[start..].find('>') else {
            break;
        };
        let gt = start + gt_rel;
        let header = &body[start..=gt];
        let Some(end_rel) = body[gt + 1..].find("</rdf:li>") else {
            warnings.push(format!("XMP 的 {tag} 里有一段 <rdf:li> 没闭合，已忽略"));
            break;
        };
        let text = xml_unescape(body[gt + 1..gt + 1 + end_rel].trim());
        if first.is_none() {
            first = non_empty(text.clone());
        }
        if header.contains("x-default") && default_lang.is_none() {
            default_lang = non_empty(text);
        }
        from = gt + 1 + end_rel + "</rdf:li>".len();
    }
    default_lang.or(first)
}

fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn push_keyword(list: &mut Vec<String>, value: String) {
    let value = value.trim().to_string();
    if value.is_empty() || list.iter().any(|k| k == &value) {
        return;
    }
    if list.len() < TEXT_LIMIT {
        list.push(value);
    }
}

fn xml_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            return truncate(out);
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    truncate(out)
}

fn truncate(text: String) -> String {
    if text.chars().count() <= TEXT_LIMIT {
        return text;
    }
    text.chars().take(TEXT_LIMIT).collect()
}

// ---------------------------------------------------------------------------
// IPTC-IIM（APP13 → Photoshop IRB → 0x0404）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct IimFields {
    keywords: Vec<String>,
    caption: Option<String>,
    copyright: Option<String>,
    location: Option<String>,
    city: Option<String>,
    country: Option<String>,
}

impl IimFields {
    fn is_empty(&self) -> bool {
        self.keywords.is_empty()
            && self.caption.is_none()
            && self.copyright.is_none()
            && self.location.is_none()
            && self.city.is_none()
            && self.country.is_none()
    }
}

fn read_iim(app13: &[&[u8]], warnings: &mut Vec<String>) -> IimFields {
    let mut out = IimFields::default();
    for payload in app13 {
        let resources = match parse_irb(payload, warnings) {
            Some(resources) => resources,
            None => continue,
        };
        let mut utf8_declared = false;
        let mut datasets: Vec<(u8, u8, Vec<u8>)> = Vec::new();
        for resource in resources {
            if resource.id != IRB_IIM {
                continue;
            }
            match parse_iim(&resource.data, warnings) {
                Some(parsed) => datasets.extend(parsed),
                None => continue,
            }
        }
        for (record, dataset, value) in &datasets {
            if *record == 1 && *dataset == 90 && value == IIM_UTF8_MARKER {
                utf8_declared = true;
            }
        }
        for (record, dataset, value) in datasets {
            let text = decode_iim(&value, utf8_declared);
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            match (record, dataset) {
                (2, 25) => push_keyword(&mut out.keywords, text),
                (2, 120) => out.caption = out.caption.or(Some(text)),
                (2, 116) => out.copyright = out.copyright.or(Some(text)),
                (2, 92) => out.location = out.location.or(Some(text)),
                (2, 90) => out.city = out.city.or(Some(text)),
                (2, 101) => out.country = out.country.or(Some(text)),
                _ => {}
            }
        }
    }
    out
}

/// 逐字段用 IIM 补 XMP 的空位（不覆盖已有值）。
fn fill_from_iim(iim: IimFields, output: &mut IptcProbe) {
    if output.keywords.is_empty() {
        output.keywords = iim.keywords;
    }
    if output.caption.is_none() {
        output.caption = iim.caption;
    }
    if output.copyright.is_none() {
        output.copyright = iim.copyright;
    }
    if output.location.is_none() {
        output.location = iim.location;
    }
    if output.city.is_none() {
        output.city = iim.city;
    }
    if output.country.is_none() {
        output.country = iim.country;
    }
}

struct IirResource {
    id: u16,
    data: Vec<u8>,
}

fn parse_irb(payload: &[u8], warnings: &mut Vec<String>) -> Option<Vec<IirResource>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= payload.len() {
        if &payload[pos..pos + 4] != b"8BIM" {
            if payload[pos] == 0 {
                pos += 1;
                continue;
            }
            warnings.push(format!("APP13 的 Photoshop 资源块标识异常（偏移 {pos}），已跳过后续资源"));
            return if out.is_empty() { None } else { Some(out) };
        }
        let id = be_u16(payload, pos + 4)?;
        pos += 6;
        let name_len = *payload.get(pos)? as usize;
        let name_end = pos + 1 + name_len;
        if name_end > payload.len() {
            warnings.push("APP13 的 Photoshop 资源名越界，已跳过后续资源".into());
            return if out.is_empty() { None } else { Some(out) };
        }
        pos = name_end;
        if (1 + name_len) % 2 != 0 {
            pos += 1;
        }
        let size = be_u32(payload, pos)? as usize;
        pos += 4;
        if pos + size > payload.len() {
            warnings.push("APP13 的 Photoshop 资源数据越界，已跳过后续资源".into());
            return if out.is_empty() { None } else { Some(out) };
        }
        let data = payload[pos..pos + size].to_vec();
        pos += size;
        if size % 2 != 0 {
            pos += 1;
        }
        out.push(IirResource { id, data });
    }
    Some(out)
}

/// `0x1C record dataset 长度 数据`，长度高字节置 1 表示「后面 N 个字节是长度」。
fn parse_iim(bytes: &[u8], warnings: &mut Vec<String>) -> Option<Vec<(u8, u8, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        if bytes[pos] != 0x1C {
            if bytes[pos] == 0 {
                pos += 1;
                continue;
            }
            warnings.push(format!("IIM 数据集标识异常（偏移 {pos}），已跳过后续数据集"));
            return if out.is_empty() { None } else { Some(out) };
        }
        if pos + 5 > bytes.len() {
            warnings.push("IIM 数据集头越界，已跳过后续数据集".into());
            return if out.is_empty() { None } else { Some(out) };
        }
        let record = bytes[pos + 1];
        let dataset = bytes[pos + 2];
        let b0 = bytes[pos + 3];
        let (len, head) = if b0 & 0x80 != 0 {
            let n = (b0 & 0x7F) as usize;
            if n == 0 || n > 4 || pos + 4 + n > bytes.len() {
                warnings.push("IIM 扩展长度字段非法，已跳过后续数据集".into());
                return if out.is_empty() { None } else { Some(out) };
            }
            let mut value = 0usize;
            for i in 0..n {
                value = (value << 8) | bytes[pos + 4 + i] as usize;
            }
            (value, 1 + n)
        } else {
            (((b0 as usize) << 8) | bytes[pos + 4] as usize, 2)
        };
        let start = pos + 3 + head;
        if start + len > bytes.len() {
            warnings.push("IIM 数据集长度越过文件尾，已跳过后续数据集".into());
            return if out.is_empty() { None } else { Some(out) };
        }
        out.push((record, dataset, bytes[start..start + len].to_vec()));
        pos = start + len;
    }
    Some(out)
}

fn decode_iim(bytes: &[u8], utf8_declared: bool) -> String {
    if utf8_declared {
        return String::from_utf8_lossy(bytes).to_string();
    }
    if let Ok(text) = str::from_utf8(bytes) {
        return text.to_string();
    }
    // 没有声明又不是合法 UTF-8：按 Latin-1 近似解（每字节映射一个码位），不丢字节
    bytes.iter().map(|b| char::from(*b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_unescape_handles_entities() {
        assert_eq!(xml_unescape("A &amp; B &lt;C&gt; &#39;D&#x27;"), "A & B <C> 'D'");
        assert_eq!(xml_unescape("100% &copy; 2025"), "100% &copy; 2025");
    }

    #[test]
    fn latin1_fallback_keeps_bytes_visible() {
        assert_eq!(decode_iim(b"Caf\xe9", false), "Café");
        assert_eq!(decode_iim(b"Caf\xe9", true), "Caf\u{fffd}");
    }

    #[test]
    fn element_body_rejects_prefix_lookalike() {
        let packet = "<dc:subjectX>no</dc:subjectX><dc:subject><rdf:Bag><rdf:li>真</rdf:li></rdf:Bag></dc:subject>";
        let (body, found) = element_body(packet, "dc:subject");
        assert!(found);
        assert_eq!(body, Some("<rdf:Bag><rdf:li>真</rdf:li></rdf:Bag>"));
    }

    #[test]
    fn empty_probe_is_reported_as_empty() {
        let probe = IptcProbe::default();
        assert!(probe.is_empty());
        assert_eq!(probe.source, "");
    }
}
