//! OOXML（DOCX / XLSX / PPTX）文档属性的**唯一读侧实现**。
//!
//! 只做读取，不写任何字节；写回仍由 `metaedit::doc` 负责（只替换 `docProps/core.xml` 的 7 个字段）。
//!
//! 与旧实现（`metadata.rs` 里的 `document_docx`）的差别：
//! - **类型按内部结构判定**，不再一律叫「Word 文档」：`[Content_Types].xml` 的
//!   `/word/` `/xl/` `/ppt/` 主部件优先，其次看 `word/document.xml`、
//!   `xl/workbook.xml`、`ppt/presentation.xml` 是否存在；扩展名与实际结构不一致时给警告，
//!   而不是把 Excel 工作簿说成 Word 文档。
//! - **`docProps/app.xml` 的字段补齐**：公司、经理、模板、应用版本、编辑总时长、
//!   超链接基址、共享/链接已更新/缩放裁剪，以及按类型区分的页数·字数·段落数
//!   （Word）/ 工作表数（Excel）/ 幻灯片·备注·隐藏页数·放映格式（PowerPoint）。
//! - **`docProps/core.xml` 也补**：关键词、说明、类别、内容状态、标识、语言、版本。
//!
//! 解析失败只给中文警告，不 panic；ZIP 只支持 stored / deflate（Office 自身也只写这两种）。

use std::io::Read;

/// 由内部结构判定的文档类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    Word,
    Excel,
    PowerPoint,
}

impl DocKind {
    pub fn format_name(self) -> &'static str {
        match self {
            DocKind::Word => "Word 文档 (DOCX)",
            DocKind::Excel => "Excel 工作簿 (XLSX)",
            DocKind::PowerPoint => "PowerPoint 演示文稿 (PPTX)",
        }
    }

    pub fn short_name(self) -> &'static str {
        match self {
            DocKind::Word => "Word 文档",
            DocKind::Excel => "Excel 工作簿",
            DocKind::PowerPoint => "PowerPoint 演示文稿",
        }
    }

    /// 主文档部件：类型判定与「缺部件」警告共用。
    pub fn main_part(self) -> &'static str {
        match self {
            DocKind::Word => "word/document.xml",
            DocKind::Excel => "xl/workbook.xml",
            DocKind::PowerPoint => "ppt/presentation.xml",
        }
    }
}

/// 扩展名 → 期望的类型。只认常见的六种；其余（docm/xlsm/pptm 变体）按同一家族处理。
pub fn kind_from_ext(ext: &str) -> Option<DocKind> {
    match ext.to_ascii_lowercase().as_str() {
        "docx" | "docm" | "dotx" | "dotm" => Some(DocKind::Word),
        "xlsx" | "xlsm" | "xltx" | "xltm" => Some(DocKind::Excel),
        "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" => Some(DocKind::PowerPoint),
        _ => None,
    }
}

/// 读侧结果：`core` / `app` 的键都是 XML 里的原标签名（`dc:title`、`Company` 等），
/// 由 `metadata.rs` 决定中文标签——这一层只负责「原样取到值」。
#[derive(Clone, Debug, Default)]
pub struct OoxmlProbe {
    /// 由内部结构判定的类型；ZIP 里既没 `[Content_Types].xml` 也没主部件时为 None
    pub kind: Option<DocKind>,
    /// 判定依据：`ContentTypes` / `MainPart` / 空串
    pub detected_from: &'static str,
    pub core: Vec<(String, String)>,
    pub app: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

impl OoxmlProbe {
    pub fn core_value(&self, tag: &str) -> Option<&str> {
        self.core
            .iter()
            .find(|(k, _)| k == tag)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.trim().is_empty())
    }

    pub fn app_value(&self, tag: &str) -> Option<&str> {
        self.app
            .iter()
            .find(|(k, _)| k == tag)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.trim().is_empty())
    }
}

/// `docProps/core.xml` 里读的标签（顺序即界面顺序）。
pub const CORE_TAGS: &[&str] = &[
    "dc:title",
    "dc:subject",
    "dc:creator",
    "cp:keywords",
    "dc:description",
    "cp:lastModifiedBy",
    "cp:revision",
    "dcterms:created",
    "dcterms:modified",
    "cp:category",
    "cp:contentStatus",
    "cp:identifier",
    "dc:language",
    "cp:version",
];

/// `docProps/app.xml` 里读的标签（类型专属的在 `app_kind_tags`）。
pub const APP_COMMON_TAGS: &[&str] = &[
    "Application",
    "AppVersion",
    "Company",
    "Manager",
    "Template",
    "TotalTime",
    "HyperlinkBase",
    "SharedDoc",
    "LinksUpToDate",
    "ScaleCrop",
];

pub fn app_kind_tags(kind: DocKind) -> &'static [&'static str] {
    match kind {
        DocKind::Word => &["Pages", "Words", "Characters", "Lines", "Paragraphs"],
        DocKind::Excel => &["Worksheets"],
        DocKind::PowerPoint => &["Slides", "Notes", "HiddenSlides", "PresentationFormat", "Words"],
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// `None` 表示这不是 OOXML 包（没有 `docProps/`、没有 `[Content_Types].xml`、也没有主部件）。
pub fn probe(data: &[u8]) -> Option<OoxmlProbe> {
    if data.len() < 22 || !data.starts_with(b"PK\x03\x04") {
        return None;
    }
    let types_xml = zip_entry(data, "[Content_Types].xml");
    let has_any_main = [
        DocKind::Word,
        DocKind::Excel,
        DocKind::PowerPoint,
    ]
    .iter()
    .any(|k| zip_has(data, k.main_part()));
    if types_xml.is_none() && !has_any_main {
        return None;
    }

    let mut probe = OoxmlProbe::default();

    // 1) 类型判定：主部件存在优先，其次 [Content_Types].xml 的 Override 前缀
    let by_main = [
        DocKind::Word,
        DocKind::Excel,
        DocKind::PowerPoint,
    ]
    .into_iter()
    .find(|k| zip_has(data, k.main_part()));
    let by_types = types_xml
        .as_deref()
        .and_then(|xml| String::from_utf8(xml.to_vec()).ok())
        .and_then(|xml| kind_from_content_types(&xml));
    match (by_main, by_types) {
        (Some(kind), _) => {
            probe.kind = Some(kind);
            probe.detected_from = "MainPart";
        }
        (None, Some(kind)) => {
            probe.kind = Some(kind);
            probe.detected_from = "ContentTypes";
            probe.warnings.push(format!(
                "内容类型声明为{}，但包内缺少主文档部件 {}",
                kind.short_name(),
                kind.main_part()
            ));
        }
        (None, None) => {
            probe.detected_from = "";
            probe
                .warnings
                .push("未能判定 OOXML 文档类型（缺少 [Content_Types].xml 与主文档部件）".to_string());
        }
    }

    // 2) core / app
    match zip_entry(data, "docProps/core.xml") {
        Some(bytes) => match String::from_utf8(bytes) {
            Ok(xml) => {
                for tag in CORE_TAGS {
                    if let Some(value) = element_text(&xml, tag) {
                        probe.core.push((tag.to_string(), value));
                    }
                }
            }
            Err(_) => probe
                .warnings
                .push("docProps/core.xml 不是 UTF-8 文本，已跳过".to_string()),
        },
        None => probe
            .warnings
            .push("未找到 docProps/core.xml（文档可能被精简或不是标准 OOXML）".to_string()),
    }

    match zip_entry(data, "docProps/app.xml") {
        Some(bytes) => match String::from_utf8(bytes) {
            Ok(xml) => {
                for tag in APP_COMMON_TAGS {
                    if let Some(value) = element_text(&xml, tag) {
                        probe.app.push((tag.to_string(), value));
                    }
                }
                if let Some(kind) = probe.kind {
                    for tag in app_kind_tags(kind) {
                        if let Some(value) = element_text(&xml, tag) {
                            probe.app.push((tag.to_string(), value));
                        }
                    }
                }
            }
            Err(_) => probe
                .warnings
                .push("docProps/app.xml 不是 UTF-8 文本，已跳过".to_string()),
        },
        None => probe
            .warnings
            .push("未找到 docProps/app.xml（公司 / 经理 / 模板与统计信息不可用）".to_string()),
    }

    Some(probe)
}

/// `[Content_Types].xml` → 类型：只在 `/word/` `/xl/` `/ppt/` 的 Override 前缀里找，
/// 不按内容类型串猜（宏启用文档（`docm` 等）的类型串里没有 `wordprocessingml`）。
fn kind_from_content_types(xml: &str) -> Option<DocKind> {
    let candidates = [
        ("/word/", DocKind::Word),
        ("/xl/", DocKind::Excel),
        ("/ppt/", DocKind::PowerPoint),
    ];
    // 取最早出现的那个 Override，避免把内嵌的其它家族部件当成主类型
    let mut best: Option<(usize, DocKind)> = None;
    for (prefix, kind) in candidates {
        let needle = format!("PartName=\"{prefix}");
        if let Some(pos) = xml.find(&needle) {
            if best.map(|(at, _)| pos < at).unwrap_or(true) {
                best = Some((pos, kind));
            }
        }
    }
    best.map(|(_, kind)| kind)
}

// ---------------------------------------------------------------------------
// XML 取值
// ---------------------------------------------------------------------------

/// `<tag>值</tag>` 或 `<tag 属性="…">值</tag>`；自闭合与空值返回 None。
fn element_text(xml: &str, tag: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(open_rel) = xml[from..].find(&format!("<{tag}")) {
        let open = from + open_rel;
        let after_name = open + 1 + tag.len();
        // 边界：`<CompanyX>` 不能命中 `<Company>`
        let boundary = xml[after_name..].chars().next();
        if !matches!(boundary, Some('>') | Some('/') | Some(' ') | Some('\t') | Some('\r') | Some('\n')) {
            from = after_name;
            continue;
        }
        let tag_end = xml[after_name..].find('>')? + after_name;
        if xml[..tag_end + 1].ends_with("/>") {
            return None;
        }
        let close = format!("</{tag}>");
        let body_start = tag_end + 1;
        let body_end = xml[body_start..].find(&close)? + body_start;
        return Some(xml_unescape(xml[body_start..body_end].trim()));
    }
    None
}

/// OOXML 属性值里的实体：五个命名实体 + 十进制/十六进制字符引用。
fn xml_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            return out;
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
            _ if entity.starts_with('#') => entity[1..]
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// ZIP（stored / deflate），与 apk.rs / metadata.rs 的读法一致，只服务本模块
// ---------------------------------------------------------------------------

fn zip_has(data: &[u8], target: &str) -> bool {
    zip_entry(data, target).is_some()
}

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
        if String::from_utf8_lossy(name_bytes) == target {
            let local_name_len = le_u16(data, local_off + 26)? as usize;
            let local_extra_len = le_u16(data, local_off + 28)? as usize;
            let start = local_off.checked_add(30 + local_name_len + local_extra_len)?;
            let end = start.checked_add(comp_size)?;
            let raw = data.get(start..end)?;
            return match method {
                0 => Some(raw.to_vec()),
                8 => {
                    use flate2::read::DeflateDecoder;
                    let mut out = Vec::new();
                    DeflateDecoder::new(raw).read_to_end(&mut out).ok()?;
                    Some(out)
                }
                _ => None,
            };
        }
        offset = offset.checked_add(46 + name_len + extra_len + comment_len)?;
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

fn le_u16(data: &[u8], at: usize) -> Option<u16> {
    let bytes = data.get(at..at + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn le_u32(data: &[u8], at: usize) -> Option<u32> {
    let bytes = data.get(at..at + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_including_numeric() {
        assert_eq!(xml_unescape("A &amp; B &lt;C&gt; &#39;q&quot;"), "A & B <C> 'q\"");
        assert_eq!(xml_unescape("&amp; 未知 &foo; 保留"), "& 未知 &foo; 保留");
        assert_eq!(xml_unescape("&#x4E2D;&#25991;"), "中文");
    }

    #[test]
    fn element_text_requires_boundary_and_handles_attributes() {
        let xml = r#"<Properties><Company>Renomio</Company><CompanyX>no</CompanyX><Pages pages="2">3</Pages><Empty/></Properties>"#;
        assert_eq!(element_text(xml, "Company").as_deref(), Some("Renomio"));
        assert_eq!(element_text(xml, "CompanyX").as_deref(), Some("no"));
        assert_eq!(element_text(xml, "Pages").as_deref(), Some("3"));
        assert_eq!(element_text(xml, "Empty"), None);
        assert_eq!(element_text(xml, "Missing"), None);
    }

    #[test]
    fn content_types_prefix_maps_to_kind() {
        let docx = r#"<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
        assert_eq!(kind_from_content_types(docx), Some(DocKind::Word));
        let docm = r#"<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>"#;
        assert_eq!(kind_from_content_types(docm), Some(DocKind::Word));
        let pptx = r#"<Override PartName="/ppt/presentation.xml" ContentType="x"/>"#;
        assert_eq!(kind_from_content_types(pptx), Some(DocKind::PowerPoint));
        assert_eq!(kind_from_content_types("<Types></Types>"), None);
    }
}
