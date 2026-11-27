//! IPTC 细分标签（XMP `dc:subject` / `dc:description` / `dc:rights` / `Iptc4xmpCore:Location`
//! 与 IPTC-IIM `2:25` / `2:120` / `2:116` / `2:92` / `2:90` / `2:101`）的契约测试。
//!
//! 全部夹具在测试里**现场构造最小 JPEG**（SOI + APP1 XMP / APP13 Photoshop IRB + EOI），
//! 不下载样本、不依赖本机图片；IIM 的 UTF-8 声明、Latin-1 兜底、坏结构也都自己造。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::{iptc, metadata};

// ---------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------

const XMP_PREFIX: &str = "http://ns.adobe.com/xap/1.0/";

fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, marker];
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn jpeg(segments: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    for seg in segments {
        out.extend_from_slice(seg);
    }
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

fn xmp_app1(packet: &str) -> Vec<u8> {
    let mut payload = XMP_PREFIX.as_bytes().to_vec();
    payload.push(0);
    payload.extend_from_slice(packet.as_bytes());
    segment(0xE1, &payload)
}

/// 一段 XMP 包：`description` 里按需塞属性；`subject` 传 `None` 表示不写关键词。
fn xmp_packet(keywords: Option<&[&str]>, caption: Option<&str>, rights: Option<&str>, extra: &str) -> String {
    let mut body = String::from(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about=""
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
  xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
"#,
    );
    if let Some(list) = keywords {
        body.push_str("<dc:subject><rdf:Bag>");
        for item in list {
            body.push_str(&format!("<rdf:li>{item}</rdf:li>"));
        }
        body.push_str("</rdf:Bag></dc:subject>\n");
    }
    if let Some(text) = caption {
        body.push_str(&format!(
            "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{text}</rdf:li><rdf:li xml:lang=\"zh-CN\">{text}</rdf:li></rdf:Alt></dc:description>\n"
        ));
    }
    if let Some(text) = rights {
        body.push_str(&format!(
            "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">{text}</rdf:li></rdf:Alt></dc:rights>\n"
        ));
    }
    body.push_str(extra);
    body.push_str("</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end=\"w\"?>");
    body
}

/// IIM 数据集：`0x1C record dataset 长度 数据`（长度用普通 2 字节形式）。
fn iim_dataset(record: u8, dataset: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![0x1C, record, dataset];
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
    out
}

fn text(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

fn iim(datasets: &[(u8, u8, Vec<u8>)], utf8: bool) -> Vec<u8> {
    let mut out = Vec::new();
    if utf8 {
        out.extend_from_slice(&iim_dataset(1, 90, b"\x1b%G"));
    }
    for (record, dataset, value) in datasets {
        out.extend_from_slice(&iim_dataset(*record, *dataset, value));
    }
    out
}

/// APP13：`Photoshop 3.0` + 资源 0x0404（IIM）。
fn app13_iim(iim_bytes: &[u8]) -> Vec<u8> {
    let mut payload = b"Photoshop 3.0\0".to_vec();
    payload.extend_from_slice(b"8BIM");
    payload.extend_from_slice(&0x0404u16.to_be_bytes());
    payload.push(0); // 空 Pascal 名
    payload.push(0); // 补齐到偶数
    payload.extend_from_slice(&(iim_bytes.len() as u32).to_be_bytes());
    payload.extend_from_slice(iim_bytes);
    if iim_bytes.len() % 2 != 0 {
        payload.push(0);
    }
    segment(0xED, &payload)
}

struct Temp {
    dir: PathBuf,
}

impl Temp {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-iptc-{stamp}"));
        fs::create_dir_all(&dir).expect("建临时目录");
        Self { dir }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.join(name);
        fs::write(&path, bytes).expect("写临时文件");
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn field<'a>(info: &'a metadata::MetadataInfo, label: &str) -> Option<&'a str> {
    info.fields
        .iter()
        .find(|f| f.label == label)
        .map(|f| f.value.as_str())
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// XMP
// ------------------------------------------------------------------------------------------------------------------------------------------

#[test]
fn xmp_reads_keywords_caption_rights_and_places() {
    let packet = xmp_packet(
        Some(&["旅行", "风景", "A &amp; B"]),
        Some("东京的清晨"),
        Some("© 2025 Renomio"),
        "<Iptc4xmpCore:Location>东京塔</Iptc4xmpCore:Location>\n<photoshop:City>东京</photoshop:City>\n<Iptc4xmpCore:CountryName>日本</Iptc4xmpCore:CountryName>\n",
    );
    let probe = iptc::probe(&jpeg(&[xmp_app1(&packet)])).expect("应有 IPTC");
    assert_eq!(probe.keywords, vec!["旅行", "风景", "A & B"]);
    assert_eq!(probe.caption.as_deref(), Some("东京的清晨"));
    assert_eq!(probe.copyright.as_deref(), Some("© 2025 Renomio"));
    assert_eq!(probe.location.as_deref(), Some("东京塔"));
    assert_eq!(probe.city.as_deref(), Some("东京"));
    assert_eq!(probe.country.as_deref(), Some("日本"));
    assert_eq!(probe.source, "XMP");
    assert!(probe.warnings.is_empty(), "{:?}", probe.warnings);
}

#[test]
fn xmp_prefers_x_default_over_other_languages() {
    let packet = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:description><rdf:Alt><rdf:li xml:lang="ja-JP">東京の朝</rdf:li><rdf:li xml:lang="x-default">东京的清晨</rdf:li></rdf:Alt></dc:description>
</rdf:Description></rdf:RDF></x:xmpmeta>"#;
    let probe = iptc::probe(&jpeg(&[xmp_app1(packet)])).expect("应有 IPTC");
    assert_eq!(probe.caption.as_deref(), Some("东京的清晨"));
}

#[test]
fn xmp_simple_text_element_without_list_is_read() {
    let packet = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:rights>© 2024 单行版权</dc:rights>
</rdf:Description></rdf:RDF></x:xmpmeta>"#;
    let probe = iptc::probe(&jpeg(&[xmp_app1(packet)])).expect("应有 IPTC");
    assert_eq!(probe.copyright.as_deref(), Some("© 2024 单行版权"));
}

#[test]
fn empty_xmp_subject_means_no_keywords() {
    let packet = xmp_packet(None, None, None, "<dc:subject/>\n");
    let probe = iptc::probe(&jpeg(&[xmp_app1(&packet)]));
    assert!(probe.is_none(), "只有空列表应视为没有 IPTC 数据");
}

#[test]
fn unclosed_xmp_tag_only_warns() {
    let packet = xmp_packet(Some(&["旅行"]), None, None, "");
    let broken = packet.replace("</dc:subject>", "");
    let probe = iptc::probe(&jpeg(&[xmp_app1(&broken)]));
    let probe = probe.expect("结构坏但有诊断时应返回");
    assert!(probe.keywords.is_empty());
    assert!(probe.warnings.iter().any(|w| w.contains("dc:subject")), "{:?}", probe.warnings);
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// IPTC-IIM
// ------------------------------------------------------------------------------------------------------------------------------------------

#[test]
fn iim_reads_keywords_caption_copyright_and_places() {
    let datasets = vec![
        (2u8, 25u8, text("旅行")),
        (2, 25, text("风景")),
        (2, 120, text("东京的清晨")),
        (2, 116, text("© 2025 Renomio")),
        (2, 92, text("东京塔")),
        (2, 90, text("东京")),
        (2, 101, text("日本")),
    ];
    let probe = iptc::probe(&jpeg(&[app13_iim(&iim(&datasets, true))])).expect("应有 IPTC");
    assert_eq!(probe.keywords, vec!["旅行", "风景"]);
    assert_eq!(probe.caption.as_deref(), Some("东京的清晨"));
    assert_eq!(probe.copyright.as_deref(), Some("© 2025 Renomio"));
    assert_eq!(probe.location.as_deref(), Some("东京塔"));
    assert_eq!(probe.city.as_deref(), Some("东京"));
    assert_eq!(probe.country.as_deref(), Some("日本"));
    assert_eq!(probe.source, "IPTC-IIM");
}

#[test]
fn iim_without_utf8_declaration_falls_back_to_latin1() {
    let datasets = vec![(2u8, 92u8, b"Caf\xe9".to_vec())];
    let probe = iptc::probe(&jpeg(&[app13_iim(&iim(&datasets, false))])).expect("应有 IPTC");
    assert_eq!(probe.location.as_deref(), Some("Café"));
}

#[test]
fn iim_duplicate_keywords_are_deduped_in_order() {
    let datasets = vec![
        (2u8, 25u8, text("旅行")),
        (2, 25, text("风景")),
        (2, 25, text("旅行")),
    ];
    let probe = iptc::probe(&jpeg(&[app13_iim(&iim(&datasets, true))])).expect("应有 IPTC");
    assert_eq!(probe.keywords, vec!["旅行", "风景"]);
}

#[test]
fn non_photoshop_app13_is_ignored() {
    let mut payload = b"OtherApp 1.0\0".to_vec();
    payload.extend_from_slice(b"8BIM");
    let probe = iptc::probe(&jpeg(&[segment(0xED, &payload)]));
    assert!(probe.is_none());
}

#[test]
fn broken_irb_warns_without_panicking() {
    let mut payload = b"Photoshop 3.0\0".to_vec();
    payload.extend_from_slice(b"NOPE");
    payload.extend_from_slice(&[0xFF; 8]);
    let probe = iptc::probe(&jpeg(&[segment(0xED, &payload)])).expect("有诊断就应返回");
    assert!(probe.is_empty());
    assert!(!probe.warnings.is_empty(), "{:?}", probe.warnings);
}

#[test]
fn broken_iim_length_warns_without_panicking() {
    let mut bytes = vec![0x1C, 2, 25];
    bytes.extend_from_slice(&[0x00, 0x40]); // 声明 64 字节，实际只给 3 字节
    bytes.extend_from_slice(b"abc");
    let probe = iptc::probe(&jpeg(&[app13_iim(&bytes)])).expect("有诊断就应返回");
    assert!(probe.is_empty());
    assert!(probe.warnings.iter().any(|w| w.contains("IIM")), "{:?}", probe.warnings);
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// 合并规则
// ------------------------------------------------------------------------------------------------------------------------------------------

#[test]
fn xmp_wins_over_iim_when_both_have_the_same_field() {
    let packet = xmp_packet(Some(&["XMP 关键词"]), Some("XMP 说明"), None, "");
    let datasets = vec![
        (2u8, 25u8, text("IIM 关键词")),
        (2, 120, text("IIM 说明")),
    ];
    let probe = iptc::probe(&jpeg(&[xmp_app1(&packet), app13_iim(&iim(&datasets, true))])).expect("应有 IPTC");
    assert_eq!(probe.keywords, vec!["XMP 关键词"]);
    assert_eq!(probe.caption.as_deref(), Some("XMP 说明"));
    assert_eq!(probe.source, "XMP + IPTC-IIM");
}

#[test]
fn missing_fields_are_filled_from_iim_one_by_one() {
    let packet = xmp_packet(Some(&["XMP 关键词"]), None, None, "");
    let datasets = vec![
        (2u8, 25u8, text("IIM 关键词（不生效）")),
        (2, 92, text("东京塔")),
        (2, 116, text("© 2025 Renomio")),
    ];
    let probe = iptc::probe(&jpeg(&[xmp_app1(&packet), app13_iim(&iim(&datasets, true))])).expect("应有 IPTC");
    assert_eq!(probe.keywords, vec!["XMP 关键词"]);
    assert_eq!(probe.location.as_deref(), Some("东京塔"));
    assert_eq!(probe.copyright.as_deref(), Some("© 2025 Renomio"));
    assert_eq!(probe.caption, None);
    assert_eq!(probe.source, "XMP + IPTC-IIM");
}

#[test]
fn non_jpeg_returns_none() {
    assert!(iptc::probe(b"\x89PNG\r\n\x1a\nwhatever").is_none());
    assert!(iptc::probe(&[]).is_none());
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// 与 rename_field_values / read_metadata 的接线
// ------------------------------------------------------------------------------------------------------------------------------------------

#[test]
fn read_metadata_exposes_iptc_fields_and_rename_values() {
    let temp = Temp::new();
    let packet = xmp_packet(
        Some(&["旅行", "风景", "A &amp; B"]),
        Some("东京的清晨"),
        Some("© 2025 Renomio"),
        "<Iptc4xmpCore:Location>东京塔</Iptc4xmpCore:Location>\n",
    );
    let path = temp.write("trip.jpg", &jpeg(&[xmp_app1(&packet)]));
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");

    assert_eq!(field(&info, "关键词"), Some("旅行、风景、A & B"));
    assert_eq!(field(&info, "关键词数"), Some("3 个"));
    assert_eq!(field(&info, "说明"), Some("东京的清晨"));
    assert_eq!(field(&info, "版权"), Some("© 2025 Renomio"));
    assert_eq!(field(&info, "拍摄地点"), Some("东京塔"));
    assert_eq!(field(&info, "IPTC 来源"), Some("XMP"));

    let values = metadata::rename_field_values(&info);
    assert_eq!(values.keywords, "旅行-风景-A & B");
    assert_eq!(values.caption, "东京的清晨");
    assert_eq!(values.copyright, "© 2025 Renomio");
    assert_eq!(values.location, "东京塔");
}

#[test]
fn rename_keywords_take_first_three_and_strip_count_suffix() {
    let temp = Temp::new();
    let packet = xmp_packet(Some(&["一", "二", "三", "四", "五"]), None, None, "");
    let path = temp.write("many.jpg", &jpeg(&[xmp_app1(&packet)]));
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");
    assert_eq!(field(&info, "关键词"), Some("一、二、三、四、五"));
    assert_eq!(field(&info, "关键词数"), Some("5 个"));
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.keywords, "一-二-三");
}

#[test]
fn long_caption_is_clipped_for_file_names() {
    let temp = Temp::new();
    let caption = "东".repeat(200);
    let packet = xmp_packet(None, Some(&caption), None, "");
    let path = temp.write("long.jpg", &jpeg(&[xmp_app1(&packet)]));
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");
    assert_eq!(field(&info, "说明"), Some(caption.as_str()));
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.caption.chars().count(), 80);
}

#[test]
fn no_iptc_data_leaves_info_untouched() {
    let temp = Temp::new();
    let path = temp.write("plain.jpg", &jpeg(&[]));
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");
    assert_eq!(field(&info, "关键词"), None);
    assert_eq!(field(&info, "IPTC 来源"), None);
    let values = metadata::rename_field_values(&info);
    assert!(values.keywords.is_empty() && values.caption.is_empty());
    assert!(values.copyright.is_empty() && values.location.is_empty());
}
