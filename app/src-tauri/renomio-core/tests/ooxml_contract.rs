//! OOXML（DOCX / XLSX / PPTX）文档属性读侧的契约测试。
//!
//! 全部夹具在测试里**现场构造最小 ZIP**（stored 与 deflate 各一套），
//! 不下载样本、不依赖本机 Office 文件；类型判定、`app.xml` 字段、
//! 扩展名与结构不一致的警告、坏 ZIP 的降级也都在这里钉住。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::{metadata, ooxml, ooxml::DocKind};

// ---------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------

struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str, bytes: &[u8]) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("renomio-ooxml-{stamp}-{name}"));
        fs::write(&path, bytes).unwrap();
        TempFile(path)
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// XML 文本 → 字节（Rust 字节串不能放非 ASCII，夹具统一走这里）。
fn xml_bytes(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

/// 条目：(路径, 内容, 是否 deflate)。
fn zip_of(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, content, deflate) in entries {
        let offset = out.len() as u32;
        let (method, body) = if *deflate {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(content).unwrap();
            (8u16, encoder.finish().unwrap())
        } else {
            (0u16, content.to_vec())
        };
        let name = name.as_bytes();
        // local file header：crc 填 0，读侧不校验
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&body);

        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    // EOCD
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn content_types(part: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{part}" ContentType="application/xml"/></Types>"#
    )
}

const CORE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>季度 &amp; 年度报告</dc:title><dc:subject>经营分析</dc:subject><dc:creator>张三</dc:creator>
<cp:keywords>预算、复盘</cp:keywords><dc:description>第 4 季度经营 &lt;终稿&gt;</dc:description>
<cp:lastModifiedBy>李四</cp:lastModifiedBy><cp:revision>7</cp:revision>
<dcterms:created>2026-11-01T08:00:00Z</dcterms:created><dcterms:modified>2026-11-20T09:30:00Z</dcterms:modified>
<cp:category>财务</cp:category><cp:contentStatus>已定稿</cp:contentStatus>
<cp:identifier>DOC-2026-04</cp:identifier><dc:language>zh-CN</dc:language><cp:version>1.2</cp:version>
</cp:coreProperties>"#;

const APP_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion>
<Company>示例科技</Company><Manager>王五</Manager><Template>Normal.dotm</Template>
<TotalTime>45</TotalTime><HyperlinkBase>https://example.com/</HyperlinkBase>
<SharedDoc>true</SharedDoc><LinksUpToDate>false</LinksUpToDate><ScaleCrop>false</ScaleCrop>
<Pages>12</Pages><Words>3456</Words><Characters>20000</Characters><Lines>300</Lines><Paragraphs>120</Paragraphs>
</Properties>"#;

fn docx_zip(deflate: bool) -> Vec<u8> {
    zip_of(&[
        ("[Content_Types].xml", content_types("word/document.xml").as_bytes(), deflate),
        ("_rels/.rels", b"<rels/>", deflate),
        ("word/document.xml", b"<w:document/>", deflate),
        ("docProps/core.xml", CORE_XML.as_bytes(), deflate),
        ("docProps/app.xml", APP_XML.as_bytes(), deflate),
    ])
}

fn field<'a>(info: &'a metadata::MetadataInfo, label: &str) -> &'a str {
    info.fields
        .iter()
        .find(|f| f.label == label)
        .map(|f| f.value.as_str())
        .unwrap_or("")
}

// ---------------------------------------------------------------------------
// 类型判定
// ---------------------------------------------------------------------------

#[test]
fn word_kind_from_main_part_even_without_content_types() {
    let zip = zip_of(&[("word/document.xml", b"<w:document/>", false)]);
    let probe = ooxml::probe(&zip).expect("应识别为 OOXML");
    assert_eq!(probe.kind, Some(DocKind::Word));
    assert_eq!(probe.detected_from, "MainPart");
}

#[test]
fn excel_kind_from_main_part() {
    let zip = zip_of(&[("xl/workbook.xml", b"<workbook/>", false)]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.kind, Some(DocKind::Excel));
    assert_eq!(DocKind::Excel.format_name(), "Excel 工作簿 (XLSX)");
    assert_eq!(DocKind::Excel.main_part(), "xl/workbook.xml");
}

#[test]
fn powerpoint_kind_from_content_types_only_reports_missing_main_part() {
    let zip = zip_of(&[(
        "[Content_Types].xml",
        content_types("ppt/presentation.xml").as_bytes(),
        false,
    )]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.kind, Some(DocKind::PowerPoint));
    assert_eq!(probe.detected_from, "ContentTypes");
    assert!(
        probe.warnings.iter().any(|w| w.contains("ppt/presentation.xml")),
        "缺主部件必须给警告：{:?}",
        probe.warnings
    );
}

#[test]
fn main_part_beats_content_types_and_no_guessing_by_content_type_string() {
    // ContentTypes 说 xl/，包里却有 word/document.xml：以主部件为准
    let zip = zip_of(&[
        ("[Content_Types].xml", content_types("xl/workbook.xml").as_bytes(), false),
        ("word/document.xml", b"<w:document/>", false),
    ]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.kind, Some(DocKind::Word));
    assert_eq!(probe.detected_from, "MainPart");
}

#[test]
fn macro_enabled_variants_share_the_family() {
    assert_eq!(ooxml::kind_from_ext("docm"), Some(DocKind::Word));
    assert_eq!(ooxml::kind_from_ext("XLSM"), Some(DocKind::Excel));
    assert_eq!(ooxml::kind_from_ext("potx"), Some(DocKind::PowerPoint));
    assert_eq!(ooxml::kind_from_ext("zip"), None);
    assert_eq!(ooxml::kind_from_ext(""), None);
}

#[test]
fn pack_without_any_ooxml_part_is_not_probe_able() {
    // 只有 docProps、没有 [Content_Types].xml 也没有主部件：按普通 ZIP 处理，不当中 OOXML
    let zip = zip_of(&[("docProps/core.xml", CORE_XML.as_bytes(), false)]);
    assert!(ooxml::probe(&zip).is_none());
}

#[test]
fn declared_types_without_word_xl_ppt_is_unknown_kind() {
    let types = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>"#;
    let zip = zip_of(&[
        ("[Content_Types].xml", types.as_bytes(), false),
        ("docProps/core.xml", CORE_XML.as_bytes(), false),
    ]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.kind, None);
    assert_eq!(probe.detected_from, "");
    assert!(probe.warnings.iter().any(|w| w.contains("未能判定")));
    // 类型判不出来时 core 仍然读得到
    assert_eq!(probe.core_value("dc:title"), Some("季度 & 年度报告"));
}

#[test]
fn non_zip_and_truncated_input_probe_none() {
    assert!(ooxml::probe(b"%PDF-1.7").is_none());
    assert!(ooxml::probe(b"PK\x03\x04").is_none());
    assert!(ooxml::probe(b"").is_none());
}

// ---------------------------------------------------------------------------
// core / app 字段
// ---------------------------------------------------------------------------

#[test]
fn core_reads_all_fourteen_tags_with_entities_decoded() {
    let zip = docx_zip(false);
    let probe = ooxml::probe(&zip).unwrap();
    for tag in ooxml::CORE_TAGS {
        assert!(probe.core_value(tag).is_some(), "缺 {tag}");
    }
    assert_eq!(probe.core_value("dc:title"), Some("季度 & 年度报告"));
    assert_eq!(probe.core_value("dc:description"), Some("第 4 季度经营 <终稿>"));
    assert_eq!(probe.core_value("cp:revision"), Some("7"));
    assert_eq!(probe.core_value("dc:language"), Some("zh-CN"));
}

#[test]
fn app_reads_company_manager_template_and_statistics() {
    let zip = docx_zip(false);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.app_value("Company"), Some("示例科技"));
    assert_eq!(probe.app_value("Manager"), Some("王五"));
    assert_eq!(probe.app_value("Template"), Some("Normal.dotm"));
    assert_eq!(probe.app_value("AppVersion"), Some("16.0000"));
    assert_eq!(probe.app_value("HyperlinkBase"), Some("https://example.com/"));
    assert_eq!(probe.app_value("TotalTime"), Some("45"));
    assert_eq!(probe.app_value("SharedDoc"), Some("true"));
    assert_eq!(probe.app_value("LinksUpToDate"), Some("false"));
    assert_eq!(probe.app_value("ScaleCrop"), Some("false"));
    // Word 专属统计
    assert_eq!(probe.app_value("Pages"), Some("12"));
    assert_eq!(probe.app_value("Words"), Some("3456"));
    assert_eq!(probe.app_value("Paragraphs"), Some("120"));
    // Excel 专属统计在 Word 包里不该出现
    assert_eq!(probe.app_value("Worksheets"), None);
}

#[test]
fn element_text_requires_tag_boundary() {
    let zip = zip_of(&[
        ("word/document.xml", b"<w:document/>", false),
        (
            "docProps/app.xml",
            xml_bytes(r#"<Properties><CompanyX>错</CompanyX><Company>对</Company></Properties>"#)
                .as_slice(),
            false,
        ),
    ]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.app_value("Company"), Some("对"));
}

#[test]
fn self_closing_tag_is_treated_as_missing() {
    let zip = zip_of(&[
        ("word/document.xml", b"<w:document/>", false),
        (
            "docProps/core.xml",
            xml_bytes(r#"<cp:coreProperties><dc:title/><dc:creator>张三</dc:creator></cp:coreProperties>"#)
                .as_slice(),
            false,
        ),
    ]);
    let probe = ooxml::probe(&zip).unwrap();
    assert_eq!(probe.core_value("dc:title"), None);
    assert_eq!(probe.core_value("dc:creator"), Some("张三"));
}

#[test]
fn deflate_entries_are_inflated() {
    let zip = docx_zip(true);
    let probe = ooxml::probe(&zip).expect("deflate 包也要能读");
    assert_eq!(probe.core_value("dc:title"), Some("季度 & 年度报告"));
    assert_eq!(probe.app_value("Company"), Some("示例科技"));
}

// ---------------------------------------------------------------------------
// metadata 接线
// ---------------------------------------------------------------------------

#[test]
fn metadata_labels_core_and_app_fields_in_chinese() {
    let file = TempFile::new("report.docx", &docx_zip(false));
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.kind, "document");
    assert_eq!(info.format, "Word 文档 (DOCX)");
    assert_eq!(field(&info, "标题"), "季度 & 年度报告");
    assert_eq!(field(&info, "主题"), "经营分析");
    assert_eq!(field(&info, "关键词"), "预算、复盘");
    assert_eq!(field(&info, "说明"), "第 4 季度经营 <终稿>");
    assert_eq!(field(&info, "最后修改者"), "李四");
    assert_eq!(field(&info, "类别"), "财务");
    assert_eq!(field(&info, "内容状态"), "已定稿");
    assert_eq!(field(&info, "公司"), "示例科技");
    assert_eq!(field(&info, "经理"), "王五");
    assert_eq!(field(&info, "模板"), "Normal.dotm");
    assert_eq!(field(&info, "编辑总时长"), "45 分钟");
    assert_eq!(field(&info, "共享文档"), "是");
    assert_eq!(field(&info, "链接已更新"), "否");
    assert_eq!(field(&info, "页数"), "12");
    assert!(info.warnings.is_empty(), "标准 DOCX 不该有警告：{:?}", info.warnings);
}

#[test]
fn excel_and_powerpoint_do_not_pretend_to_be_word() {
    let xlsx = zip_of(&[
        ("xl/workbook.xml", b"<workbook/>", false),
        (
            "docProps/app.xml",
            xml_bytes(r#"<Properties><Application>Microsoft Excel</Application><Worksheets>4</Worksheets><Company>示例科技</Company></Properties>"#).as_slice(),
            false,
        ),
    ]);
    let file = TempFile::new("budget.xlsx", &xlsx);
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.format, "Excel 工作簿 (XLSX)");
    assert_eq!(field(&info, "工作表数"), "4");
    assert_eq!(field(&info, "公司"), "示例科技");
    assert_eq!(field(&info, "页数"), "");

    let pptx = zip_of(&[
        ("ppt/presentation.xml", b"<presentation/>", false),
        (
            "docProps/app.xml",
            xml_bytes(r#"<Properties><Application>Microsoft Office PowerPoint</Application><Slides>9</Slides><Notes>2</Notes><HiddenSlides>1</HiddenSlides><PresentationFormat>全屏显示 (16:9)</PresentationFormat></Properties>"#).as_slice(),
            false,
        ),
    ]);
    let file = TempFile::new("deck.pptx", &pptx);
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.format, "PowerPoint 演示文稿 (PPTX)");
    assert_eq!(field(&info, "幻灯片数"), "9");
    assert_eq!(field(&info, "备注页数"), "2");
    assert_eq!(field(&info, "隐藏幻灯片"), "1");
    assert_eq!(field(&info, "放映格式"), "全屏显示 (16:9)");
}

#[test]
fn ext_mismatch_is_warned_and_structure_wins() {
    // 模拟「改错扩展名」：包里只有 xl/workbook.xml，文件名仍是 .docx
    let xlsx = zip_of(&[("xl/workbook.xml", b"<workbook/>", false)]);
    let file = TempFile::new("misnamed.docx", &xlsx);
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.format, "Excel 工作簿 (XLSX)");
    assert!(
        info.warnings
            .iter()
            .any(|w| w.contains(".docx") && w.contains("Excel 工作簿")),
        "扩展名不一致必须明确说明：{:?}",
        info.warnings
    );
}


#[test]
fn plain_zip_is_reported_as_zip_not_docx() {
    let zip = zip_of(&[("readme.txt", b"hello", false)]);
    let file = TempFile::new("archive.zip", &zip);
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.format, "ZIP 压缩包（非 OOXML）");
    assert!(info.warnings.iter().any(|w| w.contains("OOXML")));
    assert_eq!(field(&info, "标题"), "");
}

#[test]
fn missing_core_and_app_are_warned_not_fatal() {
    let zip = zip_of(&[("word/document.xml", b"<w:document/>", false)]);
    let file = TempFile::new("bare.docx", &zip);
    let info = metadata::read_metadata(file.path()).unwrap();
    assert_eq!(info.format, "Word 文档 (DOCX)");
    assert!(info.warnings.iter().any(|w| w.contains("core.xml")));
    assert!(info.warnings.iter().any(|w| w.contains("app.xml")));
}

#[test]
fn rename_fields_include_company_and_template() {
    let file = TempFile::new("rename.docx", &docx_zip(false));
    let info = metadata::read_metadata(file.path()).unwrap();
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.company, "示例科技");
    assert_eq!(values.template, "Normal.dotm");
    assert_eq!(values.title, "季度 & 年度报告");
    // 文件名安全化：不得出现路径/保留字符
    assert!(!values.template.contains('/') && !values.company.contains('\\'));
}

#[test]
fn total_time_is_labelled_in_minutes_and_flags_become_yes_no() {
    let zip = zip_of(&[
        ("word/document.xml", b"<w:document/>", false),
        (
            "docProps/app.xml",
            xml_bytes(r#"<Properties><TotalTime>abc</TotalTime><SharedDoc>TRUE</SharedDoc><ScaleCrop>0</ScaleCrop></Properties>"#).as_slice(),
            false,
        ),
    ]);
    let file = TempFile::new("odd.docx", &zip);
    let info = metadata::read_metadata(file.path()).unwrap();
    // 非数字不猜语义，原样展示
    assert_eq!(field(&info, "编辑总时长"), "abc");
    // 只认小写 true/false 与 1/0，其余原样
    assert_eq!(field(&info, "共享文档"), "TRUE");
    assert_eq!(field(&info, "缩放裁剪"), "否");
}
