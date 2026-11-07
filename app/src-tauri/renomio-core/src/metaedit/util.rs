//! 元数据写入用的小工具：CRC32（PNG/OGG）、SHA-256（去重）、XML 转义与取值。
//! 不引入额外依赖，全部为纯 Rust 实现，便于在受限环境离线编译。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，PNG / Ogg 使用）
// ---------------------------------------------------------------------------

const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = CRC_TABLE[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

// ---------------------------------------------------------------------------
// SHA-256（流式；用于「内容完全相同」判定，先按大小分组再算哈希）
// ---------------------------------------------------------------------------

const SHA_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    block: [u8; 64],
    filled: usize,
    len: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            block: [0; 64],
            filled: 0,
            len: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        if self.filled > 0 {
            let need = 64 - self.filled;
            let take = need.min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
        while data.len() >= 64 {
            let (head, rest) = data.split_at(64);
            let mut block = [0u8; 64];
            block.copy_from_slice(head);
            self.compress(&block);
            data = rest;
        }
        if !data.is_empty() {
            self.block[..data.len()].copy_from_slice(data);
            self.filled = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }

    pub fn finish(self) -> [u8; 32] {
        let len = self.len;
        let mut tail: Vec<u8> = Vec::with_capacity(72);
        tail.push(0x80u8);
        let rem = ((len + 1) % 64) as usize;
        let zeros = if rem <= 56 { 56 - rem } else { 120 - rem };
        tail.extend(std::iter::repeat(0u8).take(zeros));
        tail.extend_from_slice(&len.wrapping_mul(8).to_be_bytes());
        // 用克隆体把补齐数据喂进缓冲区，长度字段已经确定，不再依赖 self.len
        let mut h = self;
        h.len = 0;
        h.update(&tail);
        let mut out = [0u8; 32];
        for (i, v) in h.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finish()
}

/// 流式哈希文件；读取失败返回错误。
pub fn sha256_file(path: &Path) -> Result<[u8; 32], String> {
    let mut file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finish())
}

/// 逐字节比较两个文件是否完全相同（先比大小，再分块比对）。
pub fn files_equal(a: &Path, b: &Path) -> Result<bool, String> {
    let ma = std::fs::metadata(a).map_err(|e| format!("无法读取文件信息：{e}"))?;
    let mb = std::fs::metadata(b).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if ma.len() != mb.len() {
        return Ok(false);
    }
    let mut fa = File::open(a).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut fb = File::open(b).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut ba = vec![0u8; 64 * 1024];
    let mut bb = vec![0u8; 64 * 1024];
    loop {
        let na = fa.read(&mut ba).map_err(|e| format!("读取文件失败：{e}"))?;
        let nb = fb.read(&mut bb).map_err(|e| format!("读取文件失败：{e}"))?;
        if na != nb {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
        if ba[..na] != bb[..nb] {
            return Ok(false);
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn read_head(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut out = Vec::new();
    file.take(max as u64)
        .read_to_end(&mut out)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    Ok(out)
}

/// 读取文件尾部若干字节（PDF 找 startxref / MP3 找 ID3v1 用）。
pub fn read_tail(path: &Path, max: usize) -> Result<(Vec<u8>, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息：{e}"))?
        .len();
    let start = len.saturating_sub(max as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位文件失败：{e}"))?;
    let mut out = Vec::new();
    file.read_to_end(&mut out)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    Ok((out, start))
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn xml_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        let end = match tail.find(';') {
            Some(e) if e <= 12 => e,
            _ => {
                out.push('&');
                rest = &tail[1..];
                continue;
            }
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => None,
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &tail[end + 1..];
            }
            None if entity.starts_with("#x") || entity.starts_with("#X") => {
                if let Ok(code) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                    }
                }
                rest = &tail[end + 1..];
            }
            None if entity.starts_with('#') => {
                if let Ok(code) = entity[1..].parse::<u32>() {
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                    }
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 取简单元素（无子元素）的文本内容，如 `<xmp:CreatorTool>值</xmp:CreatorTool>`。
pub fn xml_simple_text(xml: &str, qname: &str) -> Option<String> {
    let open = format!("<{qname}");
    let start = xml.find(&open)?;
    let after = &xml[start + open.len()..];
    if !(after.starts_with('>') || after.starts_with(' ') || after.starts_with('\t')) {
        return None;
    }
    let gt = xml[start..].find('>')? + start;
    if xml[start..].ends_with("/>") {
        return None;
    }
    let close = format!("</{qname}>");
    let end = xml[gt + 1..].find(&close)? + gt + 1;
    let inner = &xml[gt + 1..end];
    if inner.contains('<') {
        // 含子元素的属性交给 xml_first_li 处理
        return Some(xml_unescape(&strip_tags_text(inner)));
    }
    Some(xml_unescape(inner.trim()))
}

fn strip_tags_text(inner: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    let mut chars = inner.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if ch == '<' {
            let rest = &inner[i..];
            if rest.starts_with("<!--") {
                if let Some(end) = inner[i..].find("-->") {
                    for _ in 0..(end + 3) {
                        chars.next();
                    }
                    continue;
                }
            }
            depth += 1;
            if rest.starts_with("</") {
                depth = depth.saturating_sub(1);
            }
            continue;
        }
        if ch == '>' && depth > 0 {
            depth -= 1;
            continue;
        }
        if depth == 0 {
            out.push(ch);
        }
    }
    out
}

/// 取数组/结构属性的第一个 `<rdf:li>` 文本（XMP 的 Alt/Seq/Bag 通用）。
pub fn xmp_first_li(xml: &str, qname: &str) -> Option<String> {
    let open = format!("<{qname}");
    let start = xml.find(&open)?;
    let gt = xml[start..].find('>')? + start;
    let close = format!("</{qname}>");
    let end = xml[gt + 1..].find(&close)? + gt + 1;
    let inner = &xml[gt + 1..end];
    let li = inner.find("<rdf:li")?;
    let li_gt = inner[li..].find('>')? + li;
    let li_end = inner[li_gt + 1..].find("</rdf:li>")? + li_gt + 1;
    Some(xml_unescape(inner[li_gt + 1..li_end].trim()))
}

/// 取 Alt/Seq/Bag 的全部 `<rdf:li>` 文本。
pub fn xmp_all_li(xml: &str, qname: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{qname}");
    let Some(start) = xml.find(&open) else {
        return out;
    };
    let Some(gt) = xml[start..].find('>') else {
        return out;
    };
    let gt = gt + start;
    let close = format!("</{qname}>");
    let Some(end_rel) = xml[gt + 1..].find(&close) else {
        return out;
    };
    let inner = &xml[gt + 1..gt + 1 + end_rel];
    let mut rest = inner;
    while let Some(li) = rest.find("<rdf:li") {
        let Some(li_gt) = rest[li..].find('>') else {
            break;
        };
        let li_gt = li_gt + li;
        let Some(li_end) = rest[li_gt + 1..].find("</rdf:li>") else {
            break;
        };
        let li_end = li_end + li_gt + 1;
        out.push(xml_unescape(rest[li_gt + 1..li_end].trim()));
        rest = &rest[li_end + "</rdf:li>".len()..];
    }
    out
}

/// 删除 XML 中的某个元素（含子元素）；找不到返回 false。
pub fn remove_element(xml: &mut String, qname: &str) -> bool {
    let Some((start, end)) = element_range(xml, qname) else {
        return false;
    };
    xml.replace_range(start..end, "");
    true
}

fn element_range(xml: &str, qname: &str) -> Option<(usize, usize)> {
    let open = format!("<{qname}");
    let mut search = 0usize;
    while let Some(rel) = xml[search..].find(&open) {
        let start = search + rel;
        let after = xml.get(start + open.len()..)?;
        if !(after.starts_with('>') || after.starts_with(' ') || after.starts_with('\t')) {
            search = start + 1;
            continue;
        }
        let gt = xml[start..].find('>')? + start;
        if xml[start..gt].ends_with('/') {
            return Some((start, gt + 1));
        }
        // 扫描配对标签
        let mut pos = gt + 1;
        let mut depth = 1usize;
        loop {
            let next_open = xml[pos..].find(&open).map(|i| pos + i);
            let next_close = xml[pos..].find(&format!("</{qname}>")).map(|i| pos + i);
            if let Some(close) = next_close {
                if next_open.map(|o| o > close).unwrap_or(true) {
                    depth -= 1;
                    if depth == 0 {
                        return Some((start, close + qname.len() + 3));
                    }
                    pos = close + qname.len() + 3;
                    continue;
                }
            }
            if let Some(o) = next_open {
                let o_gt = xml[o..].find('>')? + o;
                if !xml[o..o_gt].ends_with('/') {
                    depth += 1;
                }
                pos = o_gt + 1;
                continue;
            }
            return None;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 时间与文本
// ---------------------------------------------------------------------------

/// 把用户输入统一成 EXIF 时间（YYYY:MM:DD HH:MM:SS）。
pub fn to_exif_time(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let date = &digits[..8];
    let (y, m, d) = (&date[..4], &date[4..6], &date[6..8]);
    if digits.len() >= 14 {
        let t = &digits[8..14];
        Some(format!("{y}:{m}:{d} {}:{}:{}", &t[0..2], &t[2..4], &t[4..6]))
    } else {
        Some(format!("{y}:{m}:{d} 00:00:00"))
    }
}

/// EXIF 时间（YYYY:MM:DD HH:MM:SS）转 ISO 8601（XMP 用）。
pub fn exif_time_to_iso(value: &str) -> Option<String> {
    let v = value.trim();
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let (y, m, d) = (&digits[..4], &digits[4..6], &digits[6..8]);
    if digits.len() >= 14 {
        let t = &digits[8..14];
        Some(format!("{y}-{m}-{d}T{}:{}:{}", &t[0..2], &t[2..4], &t[4..6]))
    } else {
        Some(format!("{y}-{m}-{d}T00:00:00"))
    }
}

/// 关键词统一分隔符为 "; "。
pub fn join_keywords(list: &[String]) -> String {
    list.iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn split_keywords(value: &str) -> Vec<String> {
    value
        .split([';', '；', ',', '，', '|'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn u16_le(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

pub fn u32_le(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

pub fn be_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

pub fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

pub fn be_u64(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(data.get(at..at + 8)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let long = vec![b'a'; 1000];
        assert_eq!(
            hex(&sha256(&long)),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        );
    }

    #[test]
    fn xml_helpers() {
        assert_eq!(xml_unescape("a&amp;b&lt;c"), "a&b<c");
        let xml = r#"<dc:title><rdf:Alt><rdf:li xml:lang="x-default">旅行 &amp; 照片</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>张三</rdf:li><rdf:li>李四</rdf:li></rdf:Seq></dc:creator>"#;
        assert_eq!(xmp_first_li(xml, "dc:title").as_deref(), Some("旅行 & 照片"));
        assert_eq!(xmp_all_li(xml, "dc:creator"), vec!["张三", "李四"]);
        let mut copy = xml.to_string();
        assert!(remove_element(&mut copy, "dc:title"));
        assert!(!copy.contains("旅行"));
        assert!(copy.contains("李四"));
        assert!(!remove_element(&mut copy, "dc:title"));
    }

    #[test]
    fn exif_time_roundtrip() {
        assert_eq!(
            to_exif_time("2024-05-01T08:30:00").as_deref(),
            Some("2024:05:01 08:30:00")
        );
        assert_eq!(
            exif_time_to_iso("2024:05:01 08:30:00").as_deref(),
            Some("2024-05-01T08:30:00")
        );
        assert_eq!(to_exif_time("2024-05"), None);
    }
}
