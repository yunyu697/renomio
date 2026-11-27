//! PDF 只读解析：经典 xref 表、PDF 1.5+ 的 xref 流（含 PNG 预测器）、对象流（`/ObjStm`）、
//! `/Info` 字典文本字段、页数与加密标识。
//!
//! 不做的部分明确拒绝：解密（需要密码）、LZW / 未支持的流编码、TIFF 预测器。
//! 写回路径仍只走经典 xref（`metaedit/doc.rs` 的增量更新），本模块只读。

use std::collections::HashMap;

/// 文本字段：Info 字典键 → 展示标签。
const TEXT_KEYS: [(&str, &str); 8] = [
    ("Title", "标题"),
    ("Author", "作者"),
    ("Subject", "主题"),
    ("Keywords", "关键词"),
    ("Creator", "创建工具"),
    ("Producer", "生成器"),
    ("CreationDate", "创建时间"),
    ("ModDate", "修改时间"),
];

/// PDF 只读探针结果。
#[derive(Debug, Default)]
pub struct PdfProbe {
    pub version: String,
    /// `xref 表` / `xref 流` / `xref 表 + 流`（增量更新后会两种并存）。
    pub xref: String,
    pub fields: Vec<(&'static str, String)>,
    /// Info 字典原文（键不带斜杠，值已解码），供 `metaedit/doc.rs` 复用。
    pub info: HashMap<String, String>,
    /// 加密描述（`RC4 40 位` / `AES-128` …），有值即代表没解密。
    pub encrypted: Option<String>,
    pub pages: Option<u32>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum Entry {
    /// 普通对象的文件偏移。
    Offset(u32),
    /// 位于对象流内（流号 + 序号）。
    InStream { stm: u32, index: u32 },
}

/// 一个间接对象：字典（或裸对象）文本 + 可选流字节范围。
struct Obj {
    dict: Vec<u8>,
    stream: Option<(usize, usize)>,
}

/// 认 PDF 并尽量把能读的都读出来。返回 None 表示不是 PDF。
pub fn probe(data: &[u8]) -> Option<PdfProbe> {
    if !data.starts_with(b"%PDF") {
        return None;
    }
    let mut p = PdfProbe {
        version: pdf_version(data),
        ..Default::default()
    };
    let mut warnings = Vec::new();
    let (xref, trailer, kinds) = match discover(data, &mut warnings) {
        Some(v) => v,
        None => {
            p.warnings = warnings;
            p.warnings
                .push("找不到 startxref 或 xref 段（文件可能被截断）".into());
            p.fields.push(("版本", format!("PDF {}", p.version)));
            return Some(p);
        }
    };
    let doc = Doc { data, xref, kinds };
    p.xref = doc.xref_kind();
    p.fields.push(("版本", format!("PDF {}", p.version)));
    p.fields.push(("交叉引用", p.xref.clone()));

    // 加密：结构能读，字符串一律读不到，别把密文当标题
    if let Some(enc) = doc.encryption(&trailer) {
        p.fields.push(("加密", enc.clone()));
        p.encrypted = Some(enc.clone());
        p.warnings = warnings;
        p.warnings.push(format!(
            "加密 PDF（{enc}）：没有密码读不到元数据字符串，本版本不尝试解密"
        ));
        return Some(p);
    }

    let info = doc.info(&trailer, &mut warnings);
    p.info = info.clone();
    for (key, label) in TEXT_KEYS {
        if let Some(value) = info.get(key) {
            let value = value.trim();
            if !value.is_empty() {
                p.fields.push((label, value.to_string()));
            }
        }
    }
    if info.values().all(|v| v.trim().is_empty()) {
        warnings.push("Info 字典缺失：导出工具没有写文档属性".into());
    }

    if let Some(pages) = doc.page_count(&trailer, &mut warnings) {
        p.pages = Some(pages);
        p.fields.push(("页数", pages.to_string()));
    }
    p.warnings = warnings;
    Some(p)
}

fn pdf_version(data: &[u8]) -> String {
    let rest = data.get(5..).unwrap_or_default();
    let take: Vec<u8> = rest
        .iter()
        .take(8)
        .copied()
        .take_while(|b| b.is_ascii_digit() || *b == b'.')
        .collect();
    let s = String::from_utf8_lossy(&take).trim_matches('.').to_string();
    if s.is_empty() {
        "1.x".to_string()
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// 交叉引用发现：从最后一个 startxref 出发，沿 /Prev 链合并
// ---------------------------------------------------------------------------

fn discover(
    data: &[u8],
    warnings: &mut Vec<String>,
) -> Option<(HashMap<u32, Entry>, Vec<u8>, (bool, bool))> {
    let mut start = last_startxref(data)?;
    let mut xref: HashMap<u32, Entry> = HashMap::new();
    let mut trailers: Vec<Vec<u8>> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    let mut classic_seen = false;
    let mut stream_seen = false;
    for _ in 0..16 {
        if start >= data.len() || seen.contains(&start) {
            break;
        }
        seen.push(start);
        let is_classic = data[start..].starts_with(b"xref")
            && data
                .get(start + 4)
                .map(|b| b.is_ascii_whitespace())
                .unwrap_or(true);
        let parsed = if is_classic {
            match classic_xref(data, start) {
                Some(v) => v,
                None => {
                    warnings.push("xref 表格式无法解析".into());
                    break;
                }
            }
        } else {
            match stream_xref(data, start, warnings) {
                Some(v) => v,
                None => break,
            }
        };
        if is_classic {
            classic_seen = true;
        } else {
            stream_seen = true;
        }
        let (entries, trailer, next) = parsed;
        for (num, entry) in entries {
            // 最新的段先写入，旧段（/Prev）只补缺
            xref.entry(num).or_insert(entry);
        }
        trailers.push(trailer);
        match next {
            Some(prev) => start = prev,
            None => break,
        }
    }
    if trailers.is_empty() {
        return None;
    }
    let mut merged = Vec::new();
    // trailers 是「新 → 旧」，合并后同样保持新段在前，dict_find 取到的就是最新值
    for trailer in &trailers {
        merged.extend_from_slice(trailer);
        merged.push(b' ');
    }
    Some((xref, merged, (classic_seen, stream_seen)))
}

fn last_startxref(data: &[u8]) -> Option<usize> {
    let pos = data.windows(9).rposition(|w| w == b"startxref")?;
    let mut i = pos + 9;
    while i < data.len() && data[i].is_ascii_whitespace() {
        i += 1;
    }
    let mut end = i;
    while end < data.len() && data[end].is_ascii_digit() {
        end += 1;
    }
    std::str::from_utf8(&data[i..end]).ok()?.parse().ok()
}

fn classic_xref(data: &[u8], at: usize) -> Option<(HashMap<u32, Entry>, Vec<u8>, Option<usize>)> {
    let mut i = at + 4;
    let mut out = HashMap::new();
    loop {
        while i < data.len() && data[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= data.len() {
            return None;
        }
        if data[i..].starts_with(b"trailer") {
            i += 7;
            break;
        }
        let (start, n) = read_two_ints(data, &mut i)?;
        while i < data.len() && data[i].is_ascii_whitespace() {
            i += 1;
        }
        for k in 0..n {
            let base = i + k as usize * 20;
            if base + 20 > data.len() {
                return None;
            }
            let off = std::str::from_utf8(&data[base..base + 10])
                .ok()?
                .trim()
                .parse::<u32>()
                .ok()?;
            let kind = data[base + 17];
            if kind == b'n' {
                out.insert(start + k, Entry::Offset(off));
            }
        }
        i += n as usize * 20;
    }
    while i < data.len() && data[i].is_ascii_whitespace() {
        i += 1;
    }
    let (s, e) = dict_span(data, i)?;
    let dict = data[s..e].to_vec();
    let next = dict_prev(&dict);
    Some((out, dict, next))
}

fn stream_xref(
    data: &[u8],
    at: usize,
    warnings: &mut Vec<String>,
) -> Option<(HashMap<u32, Entry>, Vec<u8>, Option<usize>)> {
    let (_, obj) = parse_object_at(data, at)?;
    let dict = obj.dict.clone();
    let range = obj.stream?;
    let entries = xref_stream_entries(data, &dict, range, warnings)?;
    let next = dict_prev(&dict);
    Some((entries, dict, next))
}

fn read_two_ints(data: &[u8], i: &mut usize) -> Option<(u32, u32)> {
    let mut a = 0u32;
    let mut got = false;
    while *i < data.len() && data[*i].is_ascii_whitespace() {
        *i += 1;
    }
    while *i < data.len() && data[*i].is_ascii_digit() {
        a = a * 10 + (data[*i] - b'0') as u32;
        *i += 1;
        got = true;
    }
    let mut b = 0u32;
    let mut got2 = false;
    while *i < data.len() && data[*i].is_ascii_whitespace() {
        *i += 1;
    }
    while *i < data.len() && data[*i].is_ascii_digit() {
        b = b * 10 + (data[*i] - b'0') as u32;
        *i += 1;
        got2 = true;
    }
    if got && got2 {
        Some((a, b))
    } else {
        None
    }
}

fn xref_stream_entries(
    data: &[u8],
    dict: &[u8],
    range: (usize, usize),
    warnings: &mut Vec<String>,
) -> Option<HashMap<u32, Entry>> {
    let w = dict_array_ints(dict, "W")?;
    if w.len() < 3 {
        warnings.push("xref 流缺少 /W，无法解析条目".into());
        return None;
    }
    let row: usize = w.iter().map(|v| *v as usize).sum();
    if row == 0 || row > 64 {
        warnings.push("xref 流 /W 长度不合理".into());
        return None;
    }
    let payload = stream_payload(data, dict, range, warnings)?;
    let index = dict_array_ints(dict, "Index");
    let size = dict_int(dict, "Size").unwrap_or(0) as u32;
    let mut chunks: Vec<(u32, u32)> = Vec::new();
    match index {
        Some(v) if !v.is_empty() => {
            let mut it = v.chunks(2);
            while let Some(c) = it.next() {
                let start = c[0] as u32;
                let count = if c.len() > 1 { c[1] as u32 } else { 0 };
                chunks.push((start, count));
            }
        }
        _ => chunks.push((0, size)),
    }
    let mut out = HashMap::new();
    let mut cursor = 0usize;
    for (start, count) in chunks {
        for k in 0..count {
            if cursor + row > payload.len() {
                break;
            }
            let row_bytes = &payload[cursor..cursor + row];
            cursor += row;
            let widths: [usize; 3] = [w[0] as usize, w[1] as usize, w[2] as usize];
            let mut at = 0usize;
            let mut f = [0u32; 3];
            for (idx, width) in widths.iter().enumerate() {
                if *width == 0 {
                    f[idx] = if idx == 0 { 1 } else { 0 };
                    continue;
                }
                let mut v = 0u32;
                for b in &row_bytes[at..at + *width] {
                    v = (v << 8) | *b as u32;
                }
                at += *width;
                f[idx] = v;
            }
            let num = start + k;
            match f[0] {
                1 => {
                    out.insert(num, Entry::Offset(f[1]));
                }
                2 => {
                    out.insert(
                        num,
                        Entry::InStream {
                            stm: f[1],
                            index: f[2],
                        },
                    );
                }
                _ => {}
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// 对象解析
// ---------------------------------------------------------------------------

struct Doc<'a> {
    data: &'a [u8],
    xref: HashMap<u32, Entry>,
    kinds: (bool, bool),
}

impl Doc<'_> {
    fn xref_kind(&self) -> String {
        match self.kinds {
            (true, true) => "xref 表 + 流".to_string(),
            (false, true) => "xref 流".to_string(),
            _ => "xref 表".to_string(),
        }
    }

    fn object(&self, num: u32, depth: usize) -> Option<Obj> {
        if depth > 4 {
            return None;
        }
        match self.xref.get(&num)? {
            Entry::Offset(off) => {
                let (n, obj) = parse_object_at(self.data, *off as usize)?;
                if n != num {
                    // 偏移偏差时退化为按对象号搜索（增量更新后的文件常见）
                    let (_, obj2) = find_object_by_scan(self.data, num)?;
                    return Some(obj2);
                }
                Some(obj)
            }
            Entry::InStream { stm, index } => {
                let payload = self.objstm_payload(*stm, depth + 1)?;
                let text = objstm_member(&payload, self.objstm_dict(*stm, depth + 1)?, *index)?;
                Some(Obj {
                    dict: text,
                    stream: None,
                })
            }
        }
    }

    fn objstm_dict(&self, stm: u32, _depth: usize) -> Option<Vec<u8>> {
        match self.xref.get(&stm)? {
            Entry::Offset(off) => {
                let (_, obj) = parse_object_at(self.data, *off as usize)?;
                Some(obj.dict)
            }
            Entry::InStream { .. } => None,
        }
    }

    fn objstm_payload(&self, stm: u32, _depth: usize) -> Option<Vec<u8>> {
        let off = match self.xref.get(&stm)? {
            Entry::Offset(off) => *off as usize,
            Entry::InStream { .. } => return None,
        };
        let (_, obj) = parse_object_at(self.data, off)?;
        let range = obj.stream?;
        let mut warnings = Vec::new();
        stream_payload(self.data, &obj.dict, range, &mut warnings)
    }

    fn dict_of(&self, value: &[u8], depth: usize) -> Option<Vec<u8>> {
        let v = trim_ws(value);
        if v.starts_with(b"<<") {
            let (s, e) = dict_span(v, 0)?;
            return Some(v[s..e].to_vec());
        }
        let (num, _) = as_ref(v)?;
        self.object(num, depth + 1).map(|o| o.dict)
    }

    fn encryption(&self, trailer: &[u8]) -> Option<String> {
        let value = dict_find(trailer, "Encrypt")?;
        let dict = self.dict_of(&value, 0)?;
        let v = dict_int(&dict, "V").unwrap_or(1);
        let r = dict_int(&dict, "R").unwrap_or(2);
        let length = dict_int(&dict, "Length").unwrap_or(40);
        let cfm = find_name_deep(&dict, "CFM", 0).unwrap_or_default();
        let label = match v {
            1 => "RC4 40 位".to_string(),
            2 => "RC4 128 位".to_string(),
            4 => match cfm.as_str() {
                "AESV2" => "AES-128".to_string(),
                "AESV3" => "AES-256".to_string(),
                "V2" => "RC4 128 位".to_string(),
                _ => format!("AES/RC4（{} 位，R{r}）", length),
            },
            5 => "AES-256".to_string(),
            _ => format!("算法未知（V={v}，R={r}）"),
        };
        Some(label)
    }

    fn info(&self, trailer: &[u8], warnings: &mut Vec<String>) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let Some(value) = dict_find(trailer, "Info") else {
            return out;
        };
        let dict = match self.dict_of(&value, 0) {
            Some(d) => d,
            None => {
                warnings.push("Info 引用指向的对象读不出来（可能在加密对象流内）".into());
                return out;
            }
        };
        for (key, _) in TEXT_KEYS {
            let Some(raw) = dict_find(&dict, key) else {
                continue;
            };
            if let Some(text) = self.string_value(&raw, 0) {
                let text = if key == "CreationDate" || key == "ModDate" {
                    format_pdf_date(&text)
                } else {
                    text
                };
                out.insert(key.to_string(), text);
            }
        }
        out
    }

    /// Info 值：直接字符串、或指向字符串对象的引用。
    fn string_value(&self, value: &[u8], depth: usize) -> Option<String> {
        if depth > 2 {
            return None;
        }
        let v = trim_ws(value);
        if let Some(bytes) = text_bytes(v) {
            return Some(decode_text(&bytes));
        }
        let (num, _) = as_ref(v)?;
        let obj = self.object(num, depth + 1)?;
        let body = trim_ws(&obj.dict);
        let bytes = text_bytes(body)?;
        Some(decode_text(&bytes))
    }

    fn page_count(&self, trailer: &[u8], warnings: &mut Vec<String>) -> Option<u32> {
        let root = dict_find(trailer, "Root")?;
        let cat = self.dict_of(&root, 0)?;
        let pages = dict_find(&cat, "Pages")?;
        let pages_dict = self.dict_of(&pages, 1);
        let Some(pd) = pages_dict else {
            warnings.push("未取到页数：Catalog 的 /Pages 读不出来".into());
            return None;
        };
        match dict_int(&pd, "Count") {
            Some(n) if n >= 0 => Some(n as u32),
            _ => {
                warnings.push("未取到页数：/Pages 没有 /Count".into());
                None
            }
        }
    }
}

fn parse_object_at(data: &[u8], off: usize) -> Option<(u32, Obj)> {
    if off >= data.len() {
        return None;
    }
    let mut i = off;
    while i < data.len() && data[i].is_ascii_whitespace() {
        i += 1;
    }
    let num = read_uint(data, &mut i)?;
    while i < data.len() && data[i].is_ascii_whitespace() {
        i += 1;
    }
    let _gen = read_uint(data, &mut i)?;
    while i < data.len() && data[i].is_ascii_whitespace() {
        i += 1;
    }
    if !data[i..].starts_with(b"obj") {
        return None;
    }
    i += 3;
    let body_start = i;
    let stream_kw = find_keyword(data, body_start, b"stream");
    let end_kw = find_keyword(data, body_start, b"endobj");
    match stream_kw {
        Some(kw) if kw < end_kw.unwrap_or(usize::MAX) => {
            let dict = data[body_start..kw].to_vec();
            let mut start = kw + 6;
            if data.get(start) == Some(&b'\r') {
                start += 1;
            }
            if data.get(start) == Some(&b'\n') {
                start += 1;
            }
            let end = data[start..]
                .windows(9)
                .position(|w| w == b"endstream")
                .map(|p| start + p)?;
            Some((
                num,
                Obj {
                    dict,
                    stream: Some((start, end)),
                },
            ))
        }
        _ => {
            let end = end_kw?;
            Some((
                num,
                Obj {
                    dict: data[body_start..end].to_vec(),
                    stream: None,
                },
            ))
        }
    }
}

fn find_object_by_scan(data: &[u8], num: u32) -> Option<(u32, Obj)> {
    let needle = format!("{num} ");
    let mut from = 0usize;
    while let Some(pos) = data[from..]
        .windows(needle.len())
        .position(|w| w == needle.as_bytes())
    {
        let at = from + pos;
        let ok_before = at == 0 || data[at - 1].is_ascii_whitespace();
        if ok_before {
            if let Some(v) = parse_object_at(data, at) {
                return Some(v);
            }
        }
        from = at + 1;
        if from >= data.len() {
            break;
        }
    }
    None
}

fn find_keyword(data: &[u8], from: usize, kw: &[u8]) -> Option<usize> {
    let mut i = from;
    while let Some(pos) = data[i..].windows(kw.len()).position(|w| w == kw) {
        let at = i + pos;
        let ok_before = at == 0 || data[at - 1].is_ascii_whitespace() || data[at - 1] == b'>';
        let ok_after = data
            .get(at + kw.len())
            .map(|b| b.is_ascii_whitespace() || *b == b'<' || *b == b'/' || *b == b'[')
            .unwrap_or(true);
        if ok_before && ok_after {
            return Some(at);
        }
        i = at + 1;
        if i >= data.len() {
            break;
        }
    }
    None
}

fn objstm_member(payload: &[u8], dict: Vec<u8>, index: u32) -> Option<Vec<u8>> {
    let n = dict_int(&dict, "N")? as usize;
    let first = dict_int(&dict, "First")? as usize;
    if first > payload.len() {
        return None;
    }
    let header = &payload[..first];
    let mut pairs: Vec<(u32, usize)> = Vec::new();
    let mut i = 0usize;
    while pairs.len() < n && i < header.len() {
        while i < header.len() && header[i].is_ascii_whitespace() {
            i += 1;
        }
        let Some(num) = read_uint(header, &mut i) else {
            break;
        };
        while i < header.len() && header[i].is_ascii_whitespace() {
            i += 1;
        }
        let Some(off) = read_uint(header, &mut i) else {
            break;
        };
        pairs.push((num, off as usize));
    }
    let idx = index as usize;
    let (_, off) = *pairs.get(idx)?;
    let start = first + off;
    let end = pairs
        .get(idx + 1)
        .map(|(_, next)| first + *next)
        .unwrap_or(payload.len())
        .min(payload.len());
    if start >= end {
        return None;
    }
    Some(payload[start..end].to_vec())
}

// ---------------------------------------------------------------------------
// 流解码（FlateDecode + PNG 预测器 / ASCIIHex / ASCII85）
// ---------------------------------------------------------------------------

fn stream_payload(
    data: &[u8],
    dict: &[u8],
    range: (usize, usize),
    warnings: &mut Vec<String>,
) -> Option<Vec<u8>> {
    let mut bytes = data.get(range.0..range.1)?.to_vec();
    for filter in dict_filter_names(dict) {
        match filter.as_str() {
            "FlateDecode" | "Fl" => {
                bytes = inflate(&bytes)?;
                let parms = dict_decode_parms(dict);
                bytes = apply_predictor(bytes, parms.as_deref(), warnings);
            }
            "ASCIIHexDecode" | "AHx" => bytes = ascii_hex(&bytes)?,
            "ASCII85Decode" | "A85" => bytes = ascii85(&bytes)?,
            other => {
                warnings.push(format!("PDF 流使用了不支持的编码 {other}，跳过该对象"));
                return None;
            }
        }
    }
    Some(bytes)
}

fn dict_filter_names(dict: &[u8]) -> Vec<String> {
    let Some(owned) = dict_find(dict, "Filter") else {
        return Vec::new();
    };
    let v = trim_ws(&owned);
    if v.starts_with(b"[") {
        let mut out = Vec::new();
        let mut i = 1usize;
        while i < v.len() {
            while i < v.len() && v[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= v.len() || v[i] == b']' {
                break;
            }
            if v[i] == b'/' {
                let s = i;
                i += 1;
                while i < v.len() && is_name_byte(v[i]) {
                    i += 1;
                }
                out.push(String::from_utf8_lossy(&v[s + 1..i]).to_string());
            } else {
                i += 1;
            }
        }
        out
    } else {
        dict_name(dict, "Filter").into_iter().collect()
    }
}

fn dict_decode_parms(dict: &[u8]) -> Option<Vec<u8>> {
    let owned = dict_find(dict, "DecodeParms")?;
    let v = trim_ws(&owned);
    if v.starts_with(b"<<") {
        let (s, e) = dict_span(v, 0)?;
        return Some(v[s..e].to_vec());
    }
    if v.starts_with(b"[") {
        let start = v[1..].iter().position(|b| *b == b'<')? + 1;
        let (s, e) = dict_span(v, start)?;
        return Some(v[s..e].to_vec());
    }
    None
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::{DeflateDecoder, ZlibDecoder};
    use std::io::Read;
    let mut out = Vec::new();
    if ZlibDecoder::new(bytes).read_to_end(&mut out).is_ok() && !out.is_empty() {
        return Some(out);
    }
    let mut out2 = Vec::new();
    if DeflateDecoder::new(bytes).read_to_end(&mut out2).is_ok() && !out2.is_empty() {
        return Some(out2);
    }
    None
}

fn apply_predictor(bytes: Vec<u8>, parms: Option<&[u8]>, warnings: &mut Vec<String>) -> Vec<u8> {
    let Some(parms) = parms else {
        return bytes;
    };
    let predictor = dict_int(parms, "Predictor").unwrap_or(1);
    if predictor <= 1 {
        return bytes;
    }
    let columns = dict_int(parms, "Columns").unwrap_or(1).max(1) as usize;
    let colors = dict_int(parms, "Colors").unwrap_or(1).max(1) as usize;
    let bpc = dict_int(parms, "BitsPerComponent").unwrap_or(8).max(1) as usize;
    let row_len = (columns * colors * bpc).div_ceil(8).max(1);
    if predictor == 2 {
        warnings.push("PDF 流使用 TIFF 预测器（Predictor=2），本版本不还原".into());
        return bytes;
    }
    if predictor < 10 {
        warnings.push(format!("PDF 流预测器 {predictor} 不认识，本版本不还原"));
        return bytes;
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut prev = vec![0u8; row_len];
    let mut i = 0usize;
    while i < bytes.len() {
        let kind = bytes[i];
        i += 1;
        let take = row_len.min(bytes.len().saturating_sub(i));
        let mut row = bytes[i..i + take].to_vec();
        row.resize(row_len, 0);
        i += take;
        match kind {
            0 => {}
            1 => {
                for x in 1..row.len() {
                    row[x] = row[x].wrapping_add(row[x - 1]);
                }
            }
            2 => {
                for x in 0..row.len() {
                    row[x] = row[x].wrapping_add(prev[x]);
                }
            }
            3 => {
                for x in 0..row.len() {
                    let left = if x == 0 { 0 } else { row[x - 1] as u16 };
                    row[x] = row[x].wrapping_add(((left + prev[x] as u16) / 2) as u8);
                }
            }
            4 => {
                for x in 0..row.len() {
                    let a = if x == 0 { 0 } else { row[x - 1] as i16 };
                    let b = prev[x] as i16;
                    let c = if x == 0 { 0 } else { prev[x - 1] as i16 };
                    let p = a + b - c;
                    let pa = (p - a).abs();
                    let pb = (p - b).abs();
                    let pc = (p - c).abs();
                    let pred = if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    };
                    row[x] = row[x].wrapping_add(pred as u8);
                }
            }
            other => {
                warnings.push(format!("PDF 预测器行类型 {other} 不认识，已按原样保留"));
                break;
            }
        }
        out.extend_from_slice(&row[..take.min(row.len())]);
        prev = row;
    }
    out
}

fn ascii_hex(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut nibbles = Vec::new();
    for b in bytes {
        if b.is_ascii_whitespace() {
            continue;
        }
        if *b == b'>' {
            break;
        }
        nibbles.push(hex_val(*b)?);
    }
    if nibbles.len() % 2 == 1 {
        nibbles.push(0);
    }
    Some(nibbles.chunks(2).map(|c| (c[0] << 4) | c[1]).collect())
}

fn ascii85(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut group = [0u8; 5];
    let mut n = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        i += 1;
        if b.is_ascii_whitespace() {
            continue;
        }
        if b == b'~' {
            break;
        }
        if b == b'z' && n == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if !(b'!'..=b'u').contains(&b) {
            return None;
        }
        group[n] = b - b'!';
        n += 1;
        if n == 5 {
            let mut v = 0u32;
            for g in group {
                v = v.checked_mul(85)?.checked_add(g as u32)?;
            }
            out.extend_from_slice(&v.to_be_bytes());
            n = 0;
        }
    }
    if n > 0 {
        for slot in group.iter_mut().skip(n) {
            *slot = 84;
        }
        let mut v = 0u32;
        for g in group {
            v = v.checked_mul(85)?.checked_add(g as u32)?;
        }
        let b = v.to_be_bytes();
        out.extend_from_slice(&b[..n - 1]);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// 字典 / 值小工具
// ---------------------------------------------------------------------------

fn dict_span(b: &[u8], start: usize) -> Option<(usize, usize)> {
    if !b[start..].starts_with(b"<<") {
        return None;
    }
    let mut i = start + 2;
    let mut depth = 1usize;
    while i + 1 < b.len() {
        match (b[i], b[i + 1]) {
            (b'<', b'<') => {
                depth += 1;
                i += 2;
            }
            (b'>', b'>') => {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return Some((start, i));
                }
            }
            (b'(', _) => {
                i = skip_literal(b, i)?;
            }
            (b'<', _) => {
                // 十六进制字符串
                i += 1;
                while i < b.len() && b[i] != b'>' {
                    i += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn skip_literal(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    let mut depth = 1usize;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => i += 1,
        }
    }
    None
}

fn dict_entries(dict: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let dict = trim_ws(dict);
    let Some((s, e)) = dict_span(dict, 0) else {
        return out;
    };
    let inner = &dict[s + 2..e - 2];
    let mut i = 0usize;
    while i < inner.len() {
        while i < inner.len() && inner[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= inner.len() {
            break;
        }
        if inner[i] != b'/' {
            // 不是键：跳过这个值，避免死循环
            match skip_value(inner, i) {
                Some(next) if next > i => i = next,
                _ => break,
            }
            continue;
        }
        let ks = i + 1;
        i += 1;
        while i < inner.len() && is_name_byte(inner[i]) {
            i += 1;
        }
        let key = String::from_utf8_lossy(&inner[ks..i]).to_string();
        while i < inner.len() && inner[i].is_ascii_whitespace() {
            i += 1;
        }
        let vs = i;
        match skip_value(inner, i) {
            Some(next) => {
                out.push((key, inner[vs..next].to_vec()));
                i = next;
            }
            None => {
                out.push((key, inner[vs..].to_vec()));
                break;
            }
        }
    }
    out
}

fn skip_value(b: &[u8], start: usize) -> Option<usize> {
    let i = start;
    if i >= b.len() {
        return None;
    }
    match b[i] {
        b'(' => skip_literal(b, i),
        b'<' => {
            if b.get(i + 1) == Some(&b'<') {
                dict_span(b, i).map(|(_, e)| e)
            } else {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'>' {
                    j += 1;
                }
                Some((j + 1).min(b.len()))
            }
        }
        b'[' => {
            let mut j = i + 1;
            let mut depth = 1usize;
            while j < b.len() {
                match b[j] {
                    b'[' => {
                        depth += 1;
                        j += 1;
                    }
                    b']' => {
                        depth -= 1;
                        j += 1;
                        if depth == 0 {
                            return Some(j);
                        }
                    }
                    b'(' => j = skip_literal(b, j)?,
                    b'<' => {
                        j = dict_span(b, j).map(|(_, e)| e).or_else(|| {
                            let mut k = j + 1;
                            while k < b.len() && b[k] != b'>' {
                                k += 1;
                            }
                            Some((k + 1).min(b.len()))
                        })?
                    }
                    _ => j += 1,
                }
            }
            Some(j)
        }
        b'/' => {
            let mut j = i + 1;
            while j < b.len() && is_name_byte(b[j]) {
                j += 1;
            }
            Some(j)
        }
        _ => {
            // 数字 / 关键字 / 间接引用 n g R
            let mut j = i;
            while j < b.len() && !is_delim(b[j]) {
                j += 1;
            }
            if j == i {
                return Some((j + 1).min(b.len()));
            }
            let mut k = j;
            let mut tokens = 0usize;
            while tokens < 2 {
                let mut t = k;
                while t < b.len() && b[t].is_ascii_whitespace() {
                    t += 1;
                }
                if t == k {
                    break;
                }
                let s = t;
                while t < b.len() && !is_delim(b[t]) {
                    t += 1;
                }
                if t == s {
                    break;
                }
                let tok = &b[s..t];
                let ok = if tokens == 0 {
                    tok.iter().all(|c| c.is_ascii_digit())
                } else {
                    tok == b"R"
                };
                if !ok {
                    break;
                }
                k = t;
                tokens += 1;
            }
            Some(k)
        }
    }
}

fn dict_find(dict: &[u8], key: &str) -> Option<Vec<u8>> {
    dict_entries(dict)
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

fn dict_name(dict: &[u8], key: &str) -> Option<String> {
    let owned = dict_find(dict, key)?;
    let v = trim_ws(&owned);
    if !v.starts_with(b"/") {
        return None;
    }
    let mut i = 1usize;
    while i < v.len() && is_name_byte(v[i]) {
        i += 1;
    }
    Some(String::from_utf8_lossy(&v[1..i]).to_string())
}

/// 在字典里递归找名字值：`/CFM` 这类键常被埋在 `/CF << /StdCF << … >> >>` 两层里。
fn find_name_deep(dict: &[u8], key: &str, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    if let Some(v) = dict_name(dict, key) {
        return Some(v);
    }
    for (_, value) in dict_entries(dict) {
        let v = trim_ws(&value);
        if v.starts_with(b"<<") {
            if let Some(found) = find_name_deep(v, key, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

fn dict_int(dict: &[u8], key: &str) -> Option<i64> {
    let owned = dict_find(dict, key)?;
    let v = trim_ws(&owned);
    let mut i = 0usize;
    let mut sign = 1i64;
    if v.first() == Some(&b'-') {
        sign = -1;
        i = 1;
    }
    let mut got = false;
    let mut n = 0i64;
    while i < v.len() && v[i].is_ascii_digit() {
        n = n * 10 + (v[i] - b'0') as i64;
        i += 1;
        got = true;
    }
    if got {
        Some(n * sign)
    } else {
        None
    }
}

fn dict_array_ints(dict: &[u8], key: &str) -> Option<Vec<i64>> {
    let owned = dict_find(dict, key)?;
    let v = trim_ws(&owned);
    if !v.starts_with(b"[") {
        return dict_int(dict, key).map(|n| vec![n]);
    }
    let mut out = Vec::new();
    let mut i = 1usize;
    while i < v.len() {
        while i < v.len() && v[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= v.len() || v[i] == b']' {
            break;
        }
        if v[i] == b'-' || v[i].is_ascii_digit() {
            let mut sign = 1i64;
            if v[i] == b'-' {
                sign = -1;
                i += 1;
            }
            let mut n = 0i64;
            while i < v.len() && v[i].is_ascii_digit() {
                n = n * 10 + (v[i] - b'0') as i64;
                i += 1;
            }
            out.push(n * sign);
        } else {
            i += 1;
        }
    }
    Some(out)
}

fn dict_prev(dict: &[u8]) -> Option<usize> {
    let key = b"/Prev";
    let mut i = 0usize;
    while let Some(pos) = dict[i..].windows(key.len()).position(|w| w == key) {
        let at = i + pos;
        let mut j = at + key.len();
        while j < dict.len() && dict[j].is_ascii_whitespace() {
            j += 1;
        }
        let mut n = 0usize;
        let mut got = false;
        while j < dict.len() && dict[j].is_ascii_digit() {
            n = n * 10 + (dict[j] - b'0') as usize;
            j += 1;
            got = true;
        }
        if got {
            return Some(n);
        }
        i = at + 1;
        if i >= dict.len() {
            break;
        }
    }
    None
}

fn as_ref(v: &[u8]) -> Option<(u32, u32)> {
    let mut i = 0usize;
    while i < v.len() && v[i].is_ascii_whitespace() {
        i += 1;
    }
    let num = read_uint(v, &mut i)?;
    while i < v.len() && v[i].is_ascii_whitespace() {
        i += 1;
    }
    let gen = read_uint(v, &mut i)?;
    while i < v.len() && v[i].is_ascii_whitespace() {
        i += 1;
    }
    if v[i..].starts_with(b"R") {
        Some((num, gen))
    } else {
        None
    }
}

fn read_uint(b: &[u8], i: &mut usize) -> Option<u32> {
    while *i < b.len() && b[*i].is_ascii_whitespace() {
        *i += 1;
    }
    let mut n = 0u32;
    let mut got = false;
    while *i < b.len() && b[*i].is_ascii_digit() {
        n = n * 10 + (b[*i] - b'0') as u32;
        *i += 1;
        got = true;
    }
    if got {
        Some(n)
    } else {
        None
    }
}

fn trim_ws(mut v: &[u8]) -> &[u8] {
    while v.first().map(|b| b.is_ascii_whitespace()).unwrap_or(false) {
        v = &v[1..];
    }
    while v.last().map(|b| b.is_ascii_whitespace()).unwrap_or(false) {
        v = &v[..v.len() - 1];
    }
    v
}

fn is_delim(b: u8) -> bool {
    b.is_ascii_whitespace()
        || matches!(
            b,
            b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
        )
}

fn is_name_byte(b: u8) -> bool {
    !is_delim(b) && b != b'#'
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 字符串与日期
// ---------------------------------------------------------------------------

/// 取出 PDF 字符串字面量 / 十六进制串的原始字节（已解转义）。
fn text_bytes(v: &[u8]) -> Option<Vec<u8>> {
    let v = trim_ws(v);
    match v.first()? {
        b'(' => {
            let mut out = Vec::new();
            let mut i = 1usize;
            let mut depth = 1usize;
            while i < v.len() {
                match v[i] {
                    b'\\' => {
                        let next = *v.get(i + 1)?;
                        match next {
                            b'n' => out.push(b'\n'),
                            b'r' => out.push(b'\r'),
                            b't' => out.push(b'\t'),
                            b'b' => out.push(0x08),
                            b'f' => out.push(0x0C),
                            b'(' | b')' | b'\\' => out.push(next),
                            b'\r' => {
                                if v.get(i + 2) == Some(&b'\n') {
                                    i += 1;
                                }
                            }
                            b'\n' => {}
                            b'0'..=b'7' => {
                                let mut val: u16 = (next - b'0') as u16;
                                let mut used = 1usize;
                                for k in 1..3 {
                                    match v.get(i + 1 + k) {
                                        Some(b @ b'0'..=b'7') => {
                                            val = (val * 8) + (*b - b'0') as u16;
                                            used += 1;
                                        }
                                        _ => break,
                                    }
                                }
                                out.push(val as u8);
                                // i += 2 还会再加一次，这里只补「数字个数 - 1」
                                i += used - 1;
                            }
                            other => out.push(other),
                        }
                        i += 2;
                    }
                    b'(' => {
                        depth += 1;
                        out.push(b'(');
                        i += 1;
                    }
                    b')' => {
                        depth -= 1;
                        i += 1;
                        if depth == 0 {
                            break;
                        }
                        out.push(b')');
                    }
                    other => {
                        out.push(other);
                        i += 1;
                    }
                }
            }
            Some(out)
        }
        b'<' => {
            let mut nibbles = Vec::new();
            let mut i = 1usize;
            while i < v.len() && v[i] != b'>' {
                if v[i].is_ascii_whitespace() {
                    i += 1;
                    continue;
                }
                nibbles.push(hex_val(v[i])?);
                i += 1;
            }
            if nibbles.len() % 2 == 1 {
                nibbles.push(0);
            }
            Some(nibbles.chunks(2).map(|c| (c[0] << 4) | c[1]).collect())
        }
        _ => None,
    }
}

fn decode_text(raw: &[u8]) -> String {
    if raw.starts_with(&[0xFE, 0xFF]) {
        return utf16_be(&raw[2..]);
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        return utf16_le(&raw[2..]);
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&raw[3..]).to_string();
    }
    // 不少导出工具直接写 UTF-8（无 BOM），能按 UTF-8 解出就用它
    if let Ok(text) = std::str::from_utf8(raw) {
        return text.to_string();
    }
    // PDFDocEncoding 与 latin-1 只在少数码位不同，按 latin-1 兜底并保留可读字符
    raw.iter().map(|b| *b as char).collect()
}

fn utf16_be(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn utf16_le(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// `D:20261127024900+08'00'` → `2026-11-27 02:49:00 (+08:00)`。
fn format_pdf_date(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix("D:").unwrap_or(t);
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return raw.trim().to_string();
    }
    let year = &digits[0..4];
    if digits.len() < 6 {
        return year.to_string();
    }
    let month = &digits[4..6];
    if digits.len() < 8 {
        return format!("{year}-{month}");
    }
    let day = &digits[6..8];
    if digits.len() < 14 {
        return format!("{year}-{month}-{day}");
    }
    let hour = &digits[8..10];
    let min = &digits[10..12];
    let sec = &digits[12..14];
    let rest = t
        .chars()
        .skip_while(|c| c.is_ascii_digit())
        .collect::<String>();
    let offset = rest.trim();
    if offset.is_empty() {
        format!("{year}-{month}-{day} {hour}:{min}:{sec}")
    } else {
        let sign = offset.chars().next().unwrap_or('+');
        if sign != '+' && sign != '-' {
            return format!("{year}-{month}-{day} {hour}:{min}:{sec}");
        }
        let body: String = offset
            .chars()
            .skip(1)
            .filter(|c| c.is_ascii_digit())
            .collect();
        let hh = body.get(0..2).unwrap_or("00");
        let mm = body.get(2..4).unwrap_or("00");
        format!("{year}-{month}-{day} {hour}:{min}:{sec} ({sign}{hh}:{mm})")
    }
}
