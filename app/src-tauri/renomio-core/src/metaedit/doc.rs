//! 文档属性（DOCX / XLSX / PPTX 的 core.xml，PDF 的 Info + XMP）读取与写回。
//!
//! OOXML：只替换 `docProps/core.xml`，其余 ZIP 条目按原压缩数据逐字节复制；
//! PDF：增量更新（原始字节前缀保留），追加 Info / XMP / Catalog 三个对象。

use std::io::{Read, Write};
use std::path::Path;

use super::{util, FieldMap, Rewrite};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocFormat {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
}

impl DocFormat {
    pub fn name(self) -> &'static str {
        match self {
            DocFormat::Docx => "DOCX",
            DocFormat::Xlsx => "XLSX",
            DocFormat::Pptx => "PPTX",
            DocFormat::Pdf => "PDF",
        }
    }
}

/// 字段 → OOXML core.xml 的限定名与命名空间前缀。
const CORE_TAGS: &[(&str, &str, &str)] = &[
    ("title", "dc:title", "dc"),
    ("subject", "dc:subject", "dc"),
    ("author", "dc:creator", "dc"),
    ("lastModifiedBy", "cp:lastModifiedBy", "cp"),
    ("keywords", "cp:keywords", "cp"),
    ("comment", "dc:description", "dc"),
    ("category", "cp:category", "cp"),
];

const CORE_PATH: &[u8] = b"docProps/core.xml";

pub fn read_into(
    path: &Path,
    format: DocFormat,
    fields: &mut FieldMap,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| format!("读取文档失败：{e}"))?;
    match format {
        DocFormat::Docx | DocFormat::Xlsx | DocFormat::Pptx => {
            ooxml_read(&data, fields, warnings)
        }
        DocFormat::Pdf => pdf_read(&data, fields, warnings),
    }
}

pub fn rewrite(format: DocFormat, data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    match format {
        DocFormat::Docx | DocFormat::Xlsx | DocFormat::Pptx => ooxml_rewrite(data, fields),
        DocFormat::Pdf => pdf_rewrite(data, fields),
    }
}

// ---------------------------------------------------------------------------
// OOXML（ZIP + docProps/core.xml）
// ---------------------------------------------------------------------------

struct ZipEntry {
    name: Vec<u8>,
    made_version: u16,
    needed_version: u16,
    flags: u16,
    method: u16,
    time: u16,
    date: u16,
    crc: u32,
    comp_size: usize,
    uncomp_size: usize,
    internal_attr: u16,
    external_attr: u32,
    local_off: usize,
}

impl ZipEntry {
    fn name_str(&self) -> String {
        String::from_utf8_lossy(&self.name).to_string()
    }
}

fn eocd_offset(data: &[u8]) -> Result<usize, String> {
    if data.len() < 22 {
        return Err("ZIP 文件过短，缺少中央目录结束记录".into());
    }
    let start = data.len().saturating_sub(65557);
    for i in (start..=data.len() - 22).rev() {
        if data[i..i + 4] == [0x50, 0x4B, 0x05, 0x06] {
            return Ok(i);
        }
    }
    Err("不是有效的 ZIP/OOXML（找不到 EOCD）".into())
}

fn zip_entries(data: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let eocd = eocd_offset(data)?;
    let disk = util::u16_le(data, eocd + 4).ok_or("EOCD 截断")?;
    let cd_disk = util::u16_le(data, eocd + 6).ok_or("EOCD 截断")?;
    let count_disk = util::u16_le(data, eocd + 8).ok_or("EOCD 截断")?;
    let count = util::u16_le(data, eocd + 10).ok_or("EOCD 截断")? as usize;
    let cd_size = util::u32_le(data, eocd + 12).ok_or("EOCD 截断")? as usize;
    let cd_off = util::u32_le(data, eocd + 16).ok_or("EOCD 截断")? as usize;
    if disk != 0 || cd_disk != 0 || count_disk != count as u16 {
        return Err("分卷 ZIP 不支持写入".into());
    }
    if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_off == 0xFFFF_FFFF {
        return Err("ZIP64 格式本版本不支持写入".into());
    }
    if cd_off >= data.len() || cd_off + cd_size > data.len() {
        return Err("ZIP 中央目录越界（文件可能已损坏）".into());
    }
    let mut out = Vec::with_capacity(count);
    let mut pos = cd_off;
    for _ in 0..count {
        if data.get(pos..pos + 4) != Some(b"PK\x01\x02".as_ref()) {
            return Err("ZIP 中央目录项签名不正确（文件可能已损坏）".into());
        }
        let made_version = util::u16_le(data, pos + 4).ok_or("目录项截断")?;
        let needed_version = util::u16_le(data, pos + 6).ok_or("目录项截断")?;
        let flags = util::u16_le(data, pos + 8).ok_or("目录项截断")?;
        let method = util::u16_le(data, pos + 10).ok_or("目录项截断")?;
        let time = util::u16_le(data, pos + 12).ok_or("目录项截断")?;
        let date = util::u16_le(data, pos + 14).ok_or("目录项截断")?;
        let crc = util::u32_le(data, pos + 16).ok_or("目录项截断")?;
        let comp_size = util::u32_le(data, pos + 20).ok_or("目录项截断")? as usize;
        let uncomp_size = util::u32_le(data, pos + 24).ok_or("目录项截断")? as usize;
        let name_len = util::u16_le(data, pos + 28).ok_or("目录项截断")? as usize;
        let extra_len = util::u16_le(data, pos + 30).ok_or("目录项截断")? as usize;
        let comment_len = util::u16_le(data, pos + 32).ok_or("目录项截断")? as usize;
        let internal_attr = util::u16_le(data, pos + 36).ok_or("目录项截断")?;
        let external_attr = util::u32_le(data, pos + 38).ok_or("目录项截断")?;
        let local_off = util::u32_le(data, pos + 42).ok_or("目录项截断")? as usize;
        let name = data
            .get(pos + 46..pos + 46 + name_len)
            .ok_or("目录项名称越界")?
            .to_vec();
        if comp_size == 0xFFFF_FFFF || uncomp_size == 0xFFFF_FFFF || local_off == 0xFFFF_FFFF {
            return Err("ZIP64 条目本版本不支持写入".into());
        }
        out.push(ZipEntry {
            name,
            made_version,
            needed_version,
            flags,
            method,
            time,
            date,
            crc,
            comp_size,
            uncomp_size,
            internal_attr,
            external_attr,
            local_off,
        });
        pos += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// 取条目原始数据起点（跳过本地头与 extra）。
fn zip_local_data_start(data: &[u8], entry: &ZipEntry) -> Result<usize, String> {
    let off = entry.local_off;
    if data.get(off..off + 4) != Some(b"PK\x03\x04".as_ref()) {
        return Err(format!(
            "ZIP 条目 {} 的本地头签名不正确（文件可能已损坏）",
            entry.name_str()
        ));
    }
    let name_len = util::u16_le(data, off + 26).ok_or("本地头截断")? as usize;
    let extra_len = util::u16_le(data, off + 28).ok_or("本地头截断")? as usize;
    Ok(off + 30 + name_len + extra_len)
}

fn zip_entry_content(data: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    let start = zip_local_data_start(data, entry)?;
    let end = start
        .checked_add(entry.comp_size)
        .filter(|e| *e <= data.len())
        .ok_or_else(|| format!("ZIP 条目 {} 数据越界", entry.name_str()))?;
    let raw = &data[start..end];
    match entry.method {
        0 => Ok(raw.to_vec()),
        8 => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(raw)
                .read_to_end(&mut out)
                .map_err(|e| format!("ZIP 条目 {} 解压失败：{e}", entry.name_str()))?;
            Ok(out)
        }
        m => Err(format!(
            "ZIP 条目 {} 使用了压缩方法 {m}（仅支持 stored/deflate）",
            entry.name_str()
        )),
    }
}

fn zip_deflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut enc = flate2::write::DeflateEncoder::new(
        &mut out,
        flate2::Compression::default(),
    );
    enc.write_all(bytes).map_err(|e| format!("压缩失败：{e}"))?;
    enc.finish().map_err(|e| format!("压缩失败：{e}"))?;
    Ok(out)
}

/// 重建 ZIP：所有条目按原顺序重写；`replaced` 指定的条目用新内容（deflate）。
fn zip_rebuild(
    data: &[u8],
    entries: &[ZipEntry],
    target: &[u8],
    new_content: &[u8],
) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(data.len() + new_content.len() + 256);
    let mut central = Vec::with_capacity(entries.len() * 64);
    for entry in entries {
        let is_target = entry.name == target;
        let (method, crc, comp_len, uncomp_len, payload) = if is_target {
            let comp = zip_deflate(new_content)?;
            (8u16, util::crc32(new_content), comp.len(), new_content.len(), comp)
        } else {
            let start = zip_local_data_start(data, entry)?;
            let end = start
                .checked_add(entry.comp_size)
                .filter(|e| *e <= data.len())
                .ok_or_else(|| format!("ZIP 条目 {} 数据越界", entry.name_str()))?;
            (
                entry.method,
                entry.crc,
                entry.comp_size,
                entry.uncomp_size,
                data[start..end].to_vec(),
            )
        };
        let local_off = out.len();
        // 清掉 data descriptor 标志，写入真实尺寸
        let flags = entry.flags & !0x0008;
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&entry.needed_version.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&entry.time.to_le_bytes());
        out.extend_from_slice(&entry.date.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(comp_len as u32).to_le_bytes());
        out.extend_from_slice(&(uncomp_len as u32).to_le_bytes());
        out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&entry.name);
        out.extend_from_slice(&payload);

        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&entry.made_version.to_le_bytes());
        central.extend_from_slice(&entry.needed_version.to_le_bytes());
        central.extend_from_slice(&flags.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&entry.time.to_le_bytes());
        central.extend_from_slice(&entry.date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(comp_len as u32).to_le_bytes());
        central.extend_from_slice(&(uncomp_len as u32).to_le_bytes());
        central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&entry.internal_attr.to_le_bytes());
        central.extend_from_slice(&entry.external_attr.to_le_bytes());
        central.extend_from_slice(&(local_off as u32).to_le_bytes());
        central.extend_from_slice(&entry.name);
    }
    let cd_off = out.len();
    let cd_size = central.len();
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd_size as u32).to_le_bytes());
    out.extend_from_slice(&(cd_off as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

fn core_find_entry(entries: &[ZipEntry]) -> Option<usize> {
    entries.iter().position(|e| e.name == CORE_PATH)
}

fn ooxml_read(
    data: &[u8],
    fields: &mut FieldMap,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let entries = zip_entries(data)?;
    let idx = core_find_entry(&entries).ok_or_else(|| {
        "文件缺少 docProps/core.xml（本版本不新建属性部件，避免破坏包结构）".to_string()
    })?;
    let raw = zip_entry_content(data, &entries[idx])?;
    let xml = String::from_utf8(raw)
        .map_err(|_| "docProps/core.xml 不是 UTF-8 编码，本版本不支持写入".to_string())?;
    for (id, qname, _) in CORE_TAGS {
        if let Some(v) = util::xml_simple_text(&xml, qname) {
            let v = v.trim();
            if !v.is_empty() {
                fields.insert((*id).to_string(), v.to_string());
            }
        }
    }
    if entries.iter().any(|e| e.name_str() == "docProps/custom.xml") {
        warnings.push("文件带有自定义属性（docProps/custom.xml），本版本只改核心属性，未触碰自定义属性".into());
    }
    Ok(())
}

/// 找到元素范围（含自闭合），复用 util 的解析规则。
fn element_range(xml: &str, qname: &str) -> Option<(usize, usize, usize)> {
    // 返回 (元素起点, 开标签结束后的内容起点, 元素终点)
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
            return Some((start, gt + 1, gt + 1));
        }
        let close = format!("</{qname}>");
        let end = xml[gt + 1..].find(&close)? + gt + 1;
        return Some((start, gt + 1, end));
    }
    None
}

fn ensure_namespace(xml: &mut String, prefix: &str, uri: &str) {
    if xml.contains(&format!("xmlns:{prefix}")) {
        return;
    }
    // 跳过 XML 声明/注释，定位根元素（否则会把属性插进 <?xml ...?> 里）
    let mut from = 0usize;
    loop {
        let Some(rel) = xml[from..].find('<') else { return };
        let at = from + rel;
        let rest = &xml[at..];
        if rest.starts_with("<?") || rest.starts_with("<!") {
            let Some(gt) = rest.find('>') else { return };
            from = at + gt + 1;
            continue;
        }
        let Some(rel_gt) = rest.find('>') else { return };
        let mut insert_at = at + rel_gt;
        while insert_at > at && xml.as_bytes()[insert_at - 1] == b' ' {
            insert_at -= 1;
        }
        xml.insert_str(insert_at, &format!(" xmlns:{prefix}=\"{uri}\""));
        return;
    }
}

fn core_apply(
    xml: &str,
    fields: &FieldMap,
) -> Result<(String, Vec<String>, Vec<String>), String> {
    let mut out = xml.to_string();
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    for (id, qname, prefix) in CORE_TAGS {
        let Some(value) = fields.get(*id) else { continue };
        let value = value.trim();
        let found = element_range(&out, qname);
        if value.is_empty() {
            if found.is_some() {
                util::remove_element(&mut out, qname);
            }
            cleared.push((*id).to_string());
            continue;
        }
        let escaped = util::xml_escape(value);
        match found {
            Some((start, inner_start, inner_end)) => {
                let self_closing = inner_end == inner_start;
                if self_closing {
                    let end = out[start..]
                        .find('>')
                        .map(|i| start + i + 1)
                        .ok_or("core.xml 元素结构无法解析")?;
                    out.replace_range(start..end, &format!("<{qname}>{escaped}</{qname}>"));
                } else {
                    // 保留原有开标签（含属性），只替换文本内容
                    out.replace_range(inner_start..inner_end, &escaped);
                }
            }
            None => {
                let self_closed = format!("<{qname}/>");
                if let Some(at) = out.find(&self_closed) {
                    out.replace_range(at..at + self_closed.len(), &format!("<{qname}>{escaped}</{qname}>"));
                } else {
                    ensure_namespace(
                        &mut out,
                        prefix,
                        if *prefix == "dc" {
                            "http://purl.org/dc/elements/1.1/"
                        } else {
                            "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                        },
                    );
                    let insert_at = out.find("</cp:coreProperties>").unwrap_or(out.len());
                    out.insert_str(insert_at, &format!("<{qname}>{escaped}</{qname}>"));
                }
            }
        }
        written.push((*id).to_string());
    }
    Ok((out, written, cleared))
}

fn ooxml_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let entries = zip_entries(data)?;
    let idx = core_find_entry(&entries).ok_or_else(|| {
        "文件缺少 docProps/core.xml（本版本不新建属性部件，避免破坏包结构）".to_string()
    })?;
    let raw = zip_entry_content(data, &entries[idx])?;
    let xml = String::from_utf8(raw)
        .map_err(|_| "docProps/core.xml 不是 UTF-8 编码，本版本不支持写入".to_string())?;
    let (new_xml, written, cleared) = core_apply(&xml, fields)?;
    if new_xml == xml {
        return Ok(Rewrite {
            bytes: data.to_vec(),
            written: Vec::new(),
            cleared: Vec::new(),
            warnings: vec!["属性与写入前一致，未做改动".into()],
        });
    }
    let bytes = zip_rebuild(data, &entries, CORE_PATH, new_xml.as_bytes())?;
    let mut warnings = Vec::new();
    warnings.push("只替换 docProps/core.xml；其余包内条目按原压缩数据逐字节复制".into());
    if cleared.is_empty() && written.len() < fields.len() {
        warnings.push("部分字段在 core.xml 中没有对应元素，已新增标准元素".into());
    }
    Ok(Rewrite {
        bytes,
        written,
        cleared,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// PDF（增量更新：Info 字典 + XMP）
// ---------------------------------------------------------------------------

/// PDF 字段 → Info 字典键。
const PDF_KEYS: &[(&str, &str)] = &[
    ("title", "Title"),
    ("author", "Author"),
    ("subject", "Subject"),
    ("keywords", "Keywords"),
    ("comment", "Comments"),
    ("lastModifiedBy", "LastModifiedBy"),
    ("category", "Category"),
];

fn pdf_last_startxref(data: &[u8]) -> Result<usize, String> {
    let pos = data
        .windows(9)
        .rposition(|w| w == b"startxref")
        .ok_or("不是有效的 PDF（缺少 startxref）")?;
    let tail = &data[pos + 9..];
    let mut i = 0;
    while i < tail.len() && !tail[i].is_ascii_digit() {
        i += 1;
    }
    let digits: Vec<u8> = tail[i..].iter().copied().take_while(|b| b.is_ascii_digit()).collect();
    if digits.is_empty() {
        return Err("PDF 的 startxref 偏移无法解析".into());
    }
    Ok(digits
        .iter()
        .fold(0usize, |acc, b| acc * 10 + (b - b'0') as usize))
}

/// 从 `<<` 起找到配对的 `>>`，返回 (起点, 终点+2)。
fn pdf_dict_span(s: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = s.as_bytes();
    let mut i = from;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b')' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if b == b'(' {
            in_str = true;
            i += 1;
            continue;
        }
        if b == b'<' && i + 1 < bytes.len() && bytes[i + 1] == b'<' {
            depth += 1;
            i += 2;
            continue;
        }
        if b == b'>' && i + 1 < bytes.len() && bytes[i + 1] == b'>' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Some((from, i));
            }
            continue;
        }
        i += 1;
    }
    None
}

struct PdfTrailer {
    dict: String,
    startxref: usize,
}

fn pdf_trailer(data: &[u8]) -> Result<PdfTrailer, String> {
    let startxref = pdf_last_startxref(data)?;
    if startxref >= data.len() {
        return Err("PDF startxref 指向越界".into());
    }
    let at = &data[startxref..];
    if !at.starts_with(b"xref") {
        return Err("PDF 使用交叉引用流（xref stream），本版本仅支持经典 xref 的增量更新".into());
    }
    let from = String::from_utf8_lossy(&data[startxref..]).to_string();
    let trailer_at = from
        .find("trailer")
        .ok_or("PDF 缺少 trailer 字典（可能使用了 xref 流）")?;
    let dict_at = from[trailer_at..]
        .find("<<")
        .map(|i| i + trailer_at)
        .ok_or("PDF trailer 字典格式无法解析")?;
    let (s, e) = pdf_dict_span(&from, dict_at).ok_or("PDF trailer 字典未闭合")?;
    Ok(PdfTrailer {
        dict: from[s..e].to_string(),
        startxref,
    })
}

fn pdf_dict_get(dict: &str, key: &str) -> Option<String> {
    pdf_dict_entries(dict)
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
}

/// 解析字典顶层条目；值保留原始字节（字符串/引用/数组都可原样搬回）。
fn pdf_dict_entries(dict: &str) -> Vec<(String, String)> {
    let bytes = dict.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'/' {
            i += 1;
            continue;
        }
        let name_start = i + 1;
        let mut j = name_start;
        while j < bytes.len() && !b" \t\r\n/<>[]()".contains(&bytes[j]) {
            j += 1;
        }
        let key = dict[name_start..j].to_string();
        i = j;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let Some((value, next)) = pdf_value(dict, i) else {
            break;
        };
        out.push((key, value));
        i = next;
    }
    out
}

/// 读取一个 PDF 值，返回 (值文本, 下一个位置)。
fn pdf_value(s: &str, start: usize) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut i = start;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= bytes.len() {
        return None;
    }
    let first = bytes[i];
    if first == b'(' {
        let mut depth = 0i32;
        let mut escaped = false;
        let mut j = i;
        while j < bytes.len() {
            let b = bytes[j];
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'(' {
                depth += 1;
            } else if b == b')' {
                depth -= 1;
                if depth == 0 {
                    return Some((s[i..=j].to_string(), j + 1));
                }
            }
            j += 1;
        }
        return None;
    }
    if first == b'<' && bytes.get(i + 1) == Some(&b'<') {
        let (from, to) = pdf_dict_span(s, i)?;
        return Some((s[from..to].to_string(), to));
    }
    if first == b'<' {
        let to = s[i..].find('>')? + i + 1;
        return Some((s[i..to].to_string(), to));
    }
    if first == b'[' {
        let mut depth = 0i32;
        let mut j = i;
        let mut in_str = false;
        while j < bytes.len() {
            let b = bytes[j];
            if in_str {
                if b == b')' {
                    in_str = false;
                } else if b == b'\\' {
                    j += 1;
                }
            } else if b == b'(' {
                in_str = true;
            } else if b == b'[' {
                depth += 1;
            } else if b == b']' {
                depth -= 1;
                if depth == 0 {
                    return Some((s[i..=j].to_string(), j + 1));
                }
            }
            j += 1;
        }
        return None;
    }
    let mut j = i;
    if first == b'/' {
        // 名称对象必须连同前导斜杠原样保留，否则重建字典会变成非法语法
        j = i + 1;
        while j < bytes.len() && !b" \t\r\n/<>[]()".contains(&bytes[j]) {
            j += 1;
        }
        return Some((s[i..j].to_string(), j));
    }
    while j < bytes.len() && !b" \t\r\n/<>[]()".contains(&bytes[j]) {
        j += 1;
    }
    if j == i {
        return None;
    }
    let token = s[i..j].to_string();
    // 间接引用：num num R
    let mut k = j;
    let mut extra = String::new();
    let mut count = 0;
    while count < 2 {
        let mut t = k;
        while t < bytes.len() && bytes[t].is_ascii_whitespace() {
            t += 1;
        }
        let mut u = t;
        while u < bytes.len() && !b" \t\r\n/<>[]()".contains(&bytes[u]) {
            u += 1;
        }
        if t == u {
            break;
        }
        let word = &s[t..u];
        if count == 1 && word == "R" {
            extra.push(' ');
            extra.push_str(word);
            k = u;
            count = 2;
            break;
        }
        if word.chars().all(|c| c.is_ascii_digit()) {
            extra.push(' ');
            extra.push_str(word);
            k = u;
            count += 1;
        } else {
            break;
        }
    }
    Some((format!("{token}{extra}"), k))
}

fn pdf_decode_string(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('(') && t.ends_with(')') {
        let inner = &t[1..t.len() - 1];
        let mut bytes: Vec<u8> = Vec::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next() {
                    Some('n') => bytes.push(b'\n'),
                    Some('r') => bytes.push(b'\r'),
                    Some('t') => bytes.push(b'\t'),
                    Some('b') => bytes.push(0x08),
                    Some('f') => bytes.push(0x0C),
                    Some('(') => bytes.push(b'('),
                    Some(')') => bytes.push(b')'),
                    Some('\\') => bytes.push(b'\\'),
                    Some(d @ '0'..='7') => {
                        let mut n = d.to_digit(8).unwrap();
                        for _ in 0..2 {
                            if let Some(next) = chars.clone().next() {
                                if let Some(v) = next.to_digit(8) {
                                    chars.next();
                                    n = n * 8 + v;
                                } else {
                                    break;
                                }
                            }
                        }
                        bytes.push(n as u8);
                    }
                    Some(other) => bytes.extend_from_slice(other.to_string().as_bytes()),
                    None => {}
                },
                _ => bytes.extend_from_slice(c.to_string().as_bytes()),
            }
        }
        // 字面量字符串里也可能直接放 UTF-16BE（reportlab 等常用），按 BOM 判断
        if bytes.starts_with(&[0xFE, 0xFF]) {
            let mut utf16 = Vec::with_capacity(bytes.len() / 2);
            let mut k = 2;
            while k + 1 < bytes.len() {
                utf16.push(u16::from_be_bytes([bytes[k], bytes[k + 1]]));
                k += 2;
            }
            return String::from_utf16_lossy(&utf16);
        }
        return String::from_utf8_lossy(&bytes).to_string();
    }
    if t.starts_with('<') && t.ends_with('>') {
        let hex: String = t[1..t.len() - 1].chars().filter(|c| !c.is_whitespace()).collect();
        let mut bytes = Vec::with_capacity(hex.len() / 2);
        let mut i = 0;
        while i + 1 < hex.len() {
            if let Ok(v) = u8::from_str_radix(&hex[i..i + 2], 16) {
                bytes.push(v);
            }
            i += 2;
        }
        if bytes.starts_with(&[0xFE, 0xFF]) {
            let mut utf16 = Vec::with_capacity(bytes.len() / 2);
            let mut k = 2;
            while k + 1 < bytes.len() {
                utf16.push(u16::from_be_bytes([bytes[k], bytes[k + 1]]));
                k += 2;
            }
            return String::from_utf16_lossy(&utf16);
        }
        return String::from_utf8_lossy(&bytes).to_string();
    }
    raw.to_string()
}

fn pdf_encode_string(value: &str) -> String {
    let ascii = value.is_ascii();
    if ascii && !value.contains(['(', ')', '\\', '\r', '\n']) {
        return format!("({value})");
    }
    if ascii {
        let escaped = value
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)")
            .replace('\r', "\\r")
            .replace('\n', "\\n");
        return format!("({escaped})");
    }
    let mut hex = String::from("FEFF");
    for c in value.chars() {
        hex.push_str(&format!("{:04X}", c as u32));
    }
    format!("<{hex}>")
}

fn pdf_find_object(data: &[u8], num: usize) -> Option<(usize, usize)> {
    let pattern = format!("{num} 0 obj");
    let bytes = pattern.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = data[from..].windows(bytes.len()).position(|w| w == bytes) {
        let at = from + rel;
        let boundary = at == 0
            || data[at - 1].is_ascii_whitespace()
            || data[at - 1] == b'\n'
            || data[at - 1] == b'\r';
        if boundary {
            let end = data[at + bytes.len()..]
                .windows(6)
                .position(|w| w == b"endobj")
                .map(|i| at + bytes.len() + i)
                .unwrap_or(data.len());
            return Some((at + bytes.len(), end));
        }
        from = at + 1;
    }
    None
}

fn pdf_info_entries(data: &[u8], num: usize) -> Option<Vec<(String, String)>> {
    let (s, e) = pdf_find_object(data, num)?;
    let text = std::str::from_utf8(&data[s..e]).ok()?;
    let text = text.split("stream").next().unwrap_or(text);
    let at = text.find("<<")?;
    let (ds, de) = pdf_dict_span(text, at)?;
    Some(pdf_dict_entries(&text[ds..de]))
}

fn pdf_xmp_text(data: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(data).ok()?;
    let start = s.find("<x:xmpmeta")?;
    let end = s[start..].find("</x:xmpmeta>")? + start + "</x:xmpmeta>".len();
    Some(s[start..end].to_string())
}

fn pdf_read(data: &[u8], fields: &mut FieldMap, warnings: &mut Vec<String>) -> Result<(), String> {
    let trailer = pdf_trailer(data)?;
    if trailer.dict.contains("/Encrypt") {
        return Err("加密 PDF 本版本不支持读取/写入属性".into());
    }
    let mut values: Vec<(String, String)> = Vec::new();
    if let Some(info_ref) = pdf_dict_get(&trailer.dict, "Info") {
        if let Some(num) = info_ref.split_whitespace().next().and_then(|n| n.parse::<usize>().ok()) {
            match pdf_info_entries(data, num) {
                Some(entries) => values = entries,
                None => warnings.push("Info 对象在对象流内或结构特殊，改用 XMP 读取".into()),
            }
        }
    }
    let xmp = pdf_xmp_text(data);
    for (id, key) in PDF_KEYS {
        let from_info = values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| pdf_decode_string(v))
            .filter(|v| !v.trim().is_empty());
        let from_xmp = || -> Option<String> {
            let xml = xmp.as_deref()?;
            match *id {
                "title" => util::xmp_first_li(xml, "dc:title"),
                "author" => util::xmp_first_li(xml, "dc:creator"),
                "subject" => util::xmp_first_li(xml, "dc:description"),
                "keywords" => util::xml_simple_text(xml, "pdf:Keywords"),
                _ => None,
            }
        };
        if let Some(v) = from_info.or_else(from_xmp) {
            fields.insert((*id).to_string(), v.trim().to_string());
        }
    }
    Ok(())
}

fn pdf_rewrite(data: &[u8], fields: &FieldMap) -> Result<Rewrite, String> {
    let trailer = pdf_trailer(data)?;
    if trailer.dict.contains("/Encrypt") {
        return Err("加密 PDF 本版本不支持读取/写入属性".into());
    }
    if !data.starts_with(b"%PDF") {
        return Err("不是有效的 PDF（缺少 %PDF 头）".into());
    }
    let root_ref = pdf_dict_get(&trailer.dict, "Root")
        .ok_or("PDF trailer 缺少 /Root，无法安全写入")?;
    let root_num = root_ref
        .split_whitespace()
        .next()
        .and_then(|n| n.parse::<usize>().ok())
        .ok_or("PDF /Root 引用无法解析")?;
    let (cs, ce) = pdf_find_object(data, root_num).ok_or("找不到 PDF Catalog 对象（可能位于对象流）")?;
    let catalog_text = std::str::from_utf8(&data[cs..ce]).map_err(|_| "Catalog 对象不是 ASCII")?;
    let cat_dict_at = catalog_text.find("<<").ok_or("Catalog 不是字典")?;
    let (ds, de) = pdf_dict_span(catalog_text, cat_dict_at).ok_or("Catalog 字典未闭合")?;
    let mut cat_entries = pdf_dict_entries(&catalog_text[ds..de]);
    cat_entries.retain(|(k, _)| k != "Metadata" && k != "Prev");

    // 合并旧 Info（保留 Producer/CreationDate 等），再覆盖我们的字段
    let mut info_entries: Vec<(String, String)> = Vec::new();
    let old_info_num = pdf_dict_get(&trailer.dict, "Info")
        .and_then(|r| r.split_whitespace().next().map(|s| s.to_string()))
        .and_then(|n| n.parse::<usize>().ok());
    if let Some(num) = old_info_num {
        if let Some(entries) = pdf_info_entries(data, num) {
            info_entries = entries;
        }
    }
    let mut written = Vec::new();
    let mut cleared = Vec::new();
    let mut warnings = Vec::new();
    for (id, key) in PDF_KEYS {
        let Some(value) = fields.get(*id) else { continue };
        let value = value.trim();
        info_entries.retain(|(k, _)| k != key);
        if value.is_empty() {
            cleared.push((*id).to_string());
        } else {
            info_entries.push(((*key).to_string(), pdf_encode_string(value)));
            written.push((*id).to_string());
        }
    }
    if fields.contains_key("comment") || fields.contains_key("lastModifiedBy") || fields.contains_key("category") {
        warnings.push("PDF 的备注/最后修改者/类别没有标准 XMP 字段，写入的是 Info 字典扩展键（部分阅读器不显示）".into());
    }
    let info_value = |key: &str| -> String {
        info_entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| pdf_decode_string(v))
            .unwrap_or_default()
    };
    let title = info_value("Title");
    let author = info_value("Author");
    let subject = info_value("Subject");
    let keywords = info_value("Keywords");
    let xmp = pdf_xmp(&title, &author, &subject, &keywords);

    let dir_size = pdf_dict_get(&trailer.dict, "Size")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if dir_size == 0 {
        return Err("PDF trailer 缺少 /Size，无法分配新对象号".into());
    }
    let info_num = dir_size;
    let meta_num = dir_size + 1;
    let cat_num = dir_size + 2;

    let mut info_dict = String::from("<<");
    for (k, v) in &info_entries {
        info_dict.push_str(&format!(" /{k} {v}"));
    }
    info_dict.push_str(" >>");

    cat_entries.push(("Metadata".to_string(), format!("{meta_num} 0 R")));
    let mut cat_dict = String::from("<<");
    for (k, v) in &cat_entries {
        cat_dict.push_str(&format!(" /{k} {v}"));
    }
    cat_dict.push_str(" >>");

    let mut out = Vec::with_capacity(data.len() + xmp.len() + 512);
    out.extend_from_slice(data);
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    let info_off = out.len();
    out.extend_from_slice(format!("{info_num} 0 obj\n{info_dict}\nendobj\n").as_bytes());
    let meta_off = out.len();
    out.extend_from_slice(
        format!(
            "{meta_num} 0 obj\n<< /Type /Metadata /Subtype /XML /Length {} >>\nstream\n",
            xmp.len() + 1
        )
        .as_bytes(),
    );
    out.extend_from_slice(xmp.as_bytes());
    out.extend_from_slice(b"\nendstream\nendobj\n");
    let cat_off = out.len();
    out.extend_from_slice(format!("{cat_num} 0 obj\n{cat_dict}\nendobj\n").as_bytes());

    let xref_off = out.len();
    out.extend_from_slice(b"xref\n");
    out.extend_from_slice(format!("{info_num} 3\n").as_bytes());
    out.extend_from_slice(format!("{info_off:010} 00000 n \n").as_bytes());
    out.extend_from_slice(format!("{meta_off:010} 00000 n \n").as_bytes());
    out.extend_from_slice(format!("{cat_off:010} 00000 n \n").as_bytes());
    let id_raw = pdf_dict_get(&trailer.dict, "ID");
    let id_part = id_raw.map(|v| format!(" /ID {v}")).unwrap_or_default();
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root {cat_num} 0 R /Info {info_num} 0 R /Prev {}{id_part} >>\nstartxref\n{xref_off}\n%%EOF\n",
            cat_num + 1,
            trailer.startxref
        )
        .as_bytes(),
    );
    Ok(Rewrite {
        bytes: out,
        written,
        cleared,
        warnings,
    })
}

fn pdf_xmp(title: &str, author: &str, subject: &str, keywords: &str) -> String {
    fn esc(s: &str) -> String {
        util::xml_escape(s)
    }
    let mut out = String::from(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
         <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
         <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
         <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:pdf=\"http://ns.adobe.com/pdf/1.3/\">\n",
    );
    if !title.is_empty() {
        out.push_str(&format!(
            "  <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:title>\n",
            esc(title)
        ));
    }
    if !author.is_empty() {
        out.push_str(&format!(
            "  <dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>\n",
            esc(author)
        ));
    }
    if !subject.is_empty() {
        out.push_str(&format!(
            "  <dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>\n",
            esc(subject)
        ));
        out.push_str(&format!(
            "  <dc:subject><rdf:Bag><rdf:li>{}</rdf:li></rdf:Bag></dc:subject>\n",
            esc(subject)
        ));
    }
    if !keywords.is_empty() {
        out.push_str(&format!(
            "  <pdf:Keywords>{}</pdf:Keywords>\n",
            esc(keywords)
        ));
    }
    out.push_str(
        "</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>",
    );
    out
}
