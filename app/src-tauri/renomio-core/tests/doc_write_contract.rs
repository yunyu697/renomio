//! 文档属性**写回**的契约测试：`docProps/app.xml` 的公司 / 经理 / 模板。
//!
//! 夹具与 `ooxml_contract.rs` 一样全部现场构造最小 ZIP，不下载样本、不依赖本机 Office；
//! 断言走真实写入链路（`metaedit::edit` 含备份、原子替换与回读校验）+ `metaedit::snapshot` 回读。
//! 覆盖：三字段往返、已有元素改写、自闭合展开、缺元素插入、清空删除、core 与 app 一次写、
//! 缺 app.xml 明确拒绝、非 UTF-8 明确拒绝、PDF 不支持公司、XLSX / PPTX 同一部件、
//! 幂等二次写不改字节。

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::metaedit::{self, MetaEditRequest};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-docwrite-{stamp}-{name}"));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn path_of(&self) -> &std::path::Path {
        &self.0
    }

    fn write(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
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

fn content_types(main_part: &str) -> Vec<u8> {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{main_part}" ContentType="application/xml"/></Types>"#
    )
    .into_bytes()
}

const CORE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>季度报告</dc:title><dc:subject>经营分析</dc:subject><dc:creator>张三</dc:creator>
<cp:keywords>预算、复盘</cp:keywords><dc:description>终稿</dc:description><cp:lastModifiedBy>李四</cp:lastModifiedBy>
</cp:coreProperties>"#;

const APP_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion>
<Company>示例科技</Company><Manager>王五</Manager><Template>Normal.dotm</Template>
<TotalTime>45</TotalTime><Pages>12</Pages><Words>3456</Words>
</Properties>"#;

fn docx_zip(core: &[u8], app: Option<&[u8]>, deflate: bool) -> Vec<u8> {
    let types = content_types("word/document.xml");
    let mut entries: Vec<(&str, &[u8], bool)> = vec![
        ("[Content_Types].xml", &types[..], deflate),
        ("word/document.xml", b"<w:document><w:body/></w:document>", deflate),
        ("docProps/core.xml", core, deflate),
    ];
    if let Some(app) = app {
        entries.push(("docProps/app.xml", app, deflate));
    }
    zip_of(&entries)
}

fn xlsx_zip(app: &[u8]) -> Vec<u8> {
    let types = content_types("xl/workbook.xml");
    zip_of(&[
        ("[Content_Types].xml", &types[..], true),
        ("xl/workbook.xml", b"<workbook/>", true),
        ("docProps/core.xml", CORE_XML.as_bytes(), true),
        ("docProps/app.xml", app, true),
    ])
}

fn edit(path: &str, fields: &[(&str, &str)]) -> metaedit::MetaEditResult {
    let map: BTreeMap<String, String> = fields
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    metaedit::edit(&MetaEditRequest {
        path: path.to_string(),
        fields: map,
        cover_path: None,
        clear_cover: false,
        backup: false,
    })
}

fn read(path: &str) -> metaedit::MetaSnapshot {
    metaedit::snapshot(path).unwrap()
}

fn value(snap: &metaedit::MetaSnapshot, id: &str) -> String {
    snap.fields.get(id).cloned().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn docx_company_manager_template_roundtrip() {
    let dir = TempDir::new("roundtrip");
    let path = dir.write("报告.docx", &docx_zip(CORE_XML.as_bytes(), Some(APP_XML.as_bytes()), true));
    let before = read(&path);
    assert_eq!(value(&before, "company"), "示例科技");
    assert_eq!(value(&before, "manager"), "王五");
    assert_eq!(value(&before, "template"), "Normal.dotm");
    // 读侧也要能拿到：支持字段共 10 个（core 7 + app 3）
    assert_eq!(before.supported_fields.len(), 10, "{:?}", before.supported_fields);
    assert!(before.supported_fields.iter().any(|f| f == "company"));

    let result = edit(
        &path,
        &[("company", "新公司"), ("manager", "赵六"), ("template", "Report.dotx")],
    );
    assert!(result.ok, "{:?}", result.error);
    let after = read(&path);
    assert_eq!(value(&after, "company"), "新公司");
    assert_eq!(value(&after, "manager"), "赵六");
    assert_eq!(value(&after, "template"), "Report.dotx");
    // core.xml 未动
    assert_eq!(value(&after, "title"), "季度报告");
    // 统计项与其它 app 元素保持原样（不被我们改写）
    assert_eq!(value(&after, "application"), "");
    assert!(result.warnings.iter().any(|w| w.contains("app.xml")), "{:?}", result.warnings);
}

#[test]
fn docx_self_closing_company_is_expanded() {
    let dir = TempDir::new("selfclosing");
    let app = APP_XML.replace("<Company>示例科技</Company>", "<Company/>");
    let path = dir.write("空公司.docx", &docx_zip(CORE_XML.as_bytes(), Some(app.as_bytes()), false));
    assert_eq!(value(&read(&path), "company"), "");
    let result = edit(&path, &[("company", "锐名科技")]);
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(value(&read(&path), "company"), "锐名科技");
}

#[test]
fn docx_missing_app_element_is_inserted_before_root_close() {
    let dir = TempDir::new("insert");
    let app = APP_XML.replace("<Manager>王五</Manager>", "");
    let path = dir.write("无经理.docx", &docx_zip(CORE_XML.as_bytes(), Some(app.as_bytes()), true));
    assert_eq!(value(&read(&path), "manager"), "");
    let result = edit(&path, &[("manager", "孙七 & 周八")]);
    assert!(result.ok, "{:?}", result.error);
    let after = read(&path);
    assert_eq!(value(&after, "manager"), "孙七 & 周八");
    // 其它 app 元素不受影响
    assert_eq!(value(&after, "company"), "示例科技");
    assert_eq!(value(&after, "template"), "Normal.dotm");
}

#[test]
fn docx_clearing_company_removes_the_element() {
    let dir = TempDir::new("clear");
    let path = dir.write("清空.docx", &docx_zip(CORE_XML.as_bytes(), Some(APP_XML.as_bytes()), true));
    let result = edit(&path, &[("company", "")]);
    assert!(result.ok, "{:?}", result.error);
    assert!(result.cleared.iter().any(|c| c == "company"), "{:?}", result.cleared);
    let after = read(&path);
    assert_eq!(value(&after, "company"), "");
    // 其余两项还在
    assert_eq!(value(&after, "manager"), "王五");
    let raw = fs::read(&path).unwrap();
    let probe = renomio_core::ooxml::probe(&raw).expect("仍是 OOXML");
    assert!(
        !probe.app.iter().any(|(k, _)| k == "Company"),
        "Company 元素应已删除：{:?}",
        probe.app
    );
    assert!(probe.app.iter().any(|(k, _)| k == "Manager"));
}

#[test]
fn docx_core_and_app_written_in_one_pass() {
    let dir = TempDir::new("both");
    let path = dir.write("一起写.docx", &docx_zip(CORE_XML.as_bytes(), Some(APP_XML.as_bytes()), true));
    let result = edit(&path, &[("title", "2026 年终总结"), ("company", "锐名科技")]);
    assert!(result.ok, "{:?}", result.error);
    assert!(result.written.iter().any(|w| w == "title"));
    assert!(result.written.iter().any(|w| w == "company"));
    let after = read(&path);
    assert_eq!(value(&after, "title"), "2026 年终总结");
    assert_eq!(value(&after, "company"), "锐名科技");
    // 正文部件逐字节保留：仍能按主部件判回 Word
    let raw = fs::read(&path).unwrap();
    let probe = renomio_core::ooxml::probe(&raw).expect("仍是 OOXML");
    assert_eq!(probe.detected_from, "MainPart");
}

#[test]
fn docx_without_app_xml_rejects_company_with_clear_reason() {
    let dir = TempDir::new("noapp");
    let path = dir.write("无 app.docx", &docx_zip(CORE_XML.as_bytes(), None, true));
    let snap = read(&path);
    assert_eq!(value(&snap, "company"), "");
    assert!(snap.warnings.iter().any(|w| w.contains("app.xml")), "{:?}", snap.warnings);
    let result = edit(&path, &[("company", "无处安放")]);
    assert!(!result.ok);
    let err = result.error.unwrap_or_default();
    assert!(err.contains("docProps/app.xml"), "{err}");
    assert!(err.contains("不新建"), "{err}");
    // 文件未被破坏，仍可作为 docx 读回
    let raw = fs::read(&path).unwrap();
    assert!(renomio_core::ooxml::probe(&raw).is_some());
}

#[test]
fn docx_app_xml_not_utf8_rejects_write() {
    let dir = TempDir::new("badutf8");
    let mut bad = b"<?xml version=\"1.0\"?><Properties><Company>".to_vec();
    bad.extend_from_slice(&[0xFF, 0xFE, 0x00]);
    bad.extend_from_slice(b"</Company></Properties>");
    let path = dir.write("坏编码.docx", &docx_zip(CORE_XML.as_bytes(), Some(&bad), false));
    let result = edit(&path, &[("company", "改不动")]);
    assert!(!result.ok);
    let err = result.error.unwrap_or_default();
    assert!(err.contains("app.xml") && err.contains("UTF-8"), "{err}");
}

#[test]
fn pdf_does_not_accept_company_manager_template() {
    let dir = TempDir::new("pdf");
    let pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
    let path = dir.write("合同.pdf", pdf);
    let result = edit(&path, &[("company", "不应写入")]);
    assert!(!result.ok);
    assert_eq!(result.format, "PDF");
    let err = result.error.unwrap_or_default();
    assert!(err.contains("company") && err.contains("不适用"), "{err}");
    assert_eq!(fs::read(&path).unwrap(), pdf, "被拒绝时不得改动文件");
}

#[test]
fn xlsx_uses_the_same_app_part() {
    let dir = TempDir::new("xlsx");
    let path = dir.write("台账.xlsx", &xlsx_zip(APP_XML.as_bytes()));
    let before = read(&path);
    assert_eq!(before.format, "XLSX");
    assert_eq!(value(&before, "company"), "示例科技");
    let result = edit(&path, &[("company", "锐名科技"), ("manager", "钱九")]);
    assert!(result.ok, "{:?}", result.error);
    let after = read(&path);
    assert_eq!(value(&after, "company"), "锐名科技");
    assert_eq!(value(&after, "manager"), "钱九");
    assert_eq!(value(&after, "template"), "Normal.dotm");
}

#[test]
fn pptx_uses_the_same_app_part() {
    let dir = TempDir::new("pptx");
    let types = content_types("ppt/presentation.xml");
    let zip = zip_of(&[
        ("[Content_Types].xml", &types[..], true),
        ("ppt/presentation.xml", b"<presentation/>", true),
        ("docProps/core.xml", CORE_XML.as_bytes(), false),
        ("docProps/app.xml", APP_XML.as_bytes(), false),
    ]);
    let path = dir.write("汇报.pptx", &zip);
    let result = edit(&path, &[("template", "Blank.potx")]);
    assert!(result.ok, "{:?}", result.error);
    let after = read(&path);
    assert_eq!(value(&after, "template"), "Blank.potx");
    assert_eq!(after.format, "PPTX");
}

#[test]
fn second_write_with_same_value_is_a_noop() {
    let dir = TempDir::new("noop");
    let path = dir.write("幂等.docx", &docx_zip(CORE_XML.as_bytes(), Some(APP_XML.as_bytes()), true));
    let first = edit(&path, &[("company", "锐名科技")]);
    assert!(first.ok);
    let bytes_after_first = fs::read(&path).unwrap();
    let second = edit(&path, &[("company", "锐名科技")]);
    assert!(second.ok, "{:?}", second.error);
    assert!(
        second.warnings.iter().any(|w| w.contains("一致")),
        "{:?}",
        second.warnings
    );
    assert_eq!(fs::read(&path).unwrap(), bytes_after_first, "同值再写不应改动字节");
}

#[test]
fn unknown_document_field_is_rejected_with_reason() {
    let dir = TempDir::new("unknown");
    let path = dir.write("字段.docx", &docx_zip(CORE_XML.as_bytes(), Some(APP_XML.as_bytes()), true));
    let result = edit(&path, &[("notAField", "x")]);
    assert!(!result.ok);
    let err = result.error.unwrap_or_default();
    assert!(err.contains("notAField") && err.contains("不适用"), "{err}");
}
