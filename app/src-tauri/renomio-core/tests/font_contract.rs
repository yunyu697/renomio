//! 字体契约：TTF / OTF / TTC 的 `name` / `maxp` / `head` / `OS/2` 读取。
//! 夹具全部在测试里现场构造（不下载字体、不依赖字体库），只按规范拼字节。

use renomio_core::font::{probe, weight_name};
use renomio_core::metadata::{read_metadata, rename_field_values};
use renomio_core::sniff::sniff_magic;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

struct Temp {
    dir: std::path::PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "renomio-font-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        Self { dir }
    }

    fn file(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.dir.join(name);
        std::fs::write(&path, bytes).expect("写临时文件");
        path.to_string_lossy().to_string()
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect()
}

/// 一条 `name` 记录：平台 / 语言 / nameID / 原始字节。
struct NameRec {
    platform: u16,
    language: u16,
    name_id: u16,
    raw: Vec<u8>,
}

fn win(id: u16, text: &str) -> NameRec {
    NameRec { platform: 3, language: 0x0409, name_id: id, raw: utf16(text) }
}

fn mac(id: u16, text: &str) -> NameRec {
    NameRec { platform: 1, language: 0, name_id: id, raw: text.as_bytes().to_vec() }
}

/// `name` 表：format 0 + 记录区 + 字符串区（偏移相对表头）。
fn name_table(records: &[NameRec]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_be_bytes()); // format
    out.extend_from_slice(&(records.len() as u16).to_be_bytes());
    let strings_base = 6 + 12 * records.len();
    out.extend_from_slice(&(strings_base as u16).to_be_bytes());

    let mut strings = Vec::new();
    for rec in records {
        out.extend_from_slice(&rec.platform.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes()); // encoding：ASCII / BMP
        out.extend_from_slice(&rec.language.to_be_bytes());
        out.extend_from_slice(&rec.name_id.to_be_bytes());
        out.extend_from_slice(&(rec.raw.len() as u16).to_be_bytes());
        out.extend_from_slice(&(strings.len() as u16).to_be_bytes());
        strings.extend_from_slice(&rec.raw);
    }
    out.extend_from_slice(&strings);
    out
}

fn maxp(glyphs: u16) -> Vec<u8> {
    let mut out = vec![0x00, 0x01, 0x00, 0x00];
    out.extend_from_slice(&glyphs.to_be_bytes());
    out.extend_from_slice(&[0u8; 26]);
    out
}

fn head(units_per_em: u16) -> Vec<u8> {
    let mut out = vec![0x00, 0x01, 0x00, 0x00];
    out.extend_from_slice(&[0u8; 14]); // fontRevision / checkSumAdjustment / magicNumber / flags
    out.extend_from_slice(&units_per_em.to_be_bytes()); // +18
    out.extend_from_slice(&[0u8; 34]);
    out
}

fn os2(weight: u16, italic: bool) -> Vec<u8> {
    let mut out = vec![0u8; 4];
    out.extend_from_slice(&weight.to_be_bytes()); // +4
    out.extend_from_slice(&[0u8; 56]);
    let mut selection = 0u16;
    if italic {
        selection |= 0b1;
    }
    out.extend_from_slice(&selection.to_be_bytes()); // +62
    out.extend_from_slice(&[0u8; 32]);
    out
}

/// 在文件内 `base` 处摆一个 sfnt 字体：表目录 12 + 16n，表体按 4 字节对齐。
fn sfnt(flavor: [u8; 4], tables: &[(&str, Vec<u8>)], base: usize) -> Vec<u8> {
    let count = tables.len() as u16;
    let mut out = Vec::new();
    out.extend_from_slice(&flavor);
    out.extend_from_slice(&count.to_be_bytes());
    out.extend_from_slice(&[0u8; 6]); // searchRange / entrySelector / rangeShift（解析不看）

    let mut offset = base + 12 + 16 * tables.len();
    let mut bodies = Vec::new();
    for (tag, body) in tables {
        out.extend_from_slice(tag.as_bytes());
        out.extend_from_slice(&0u32.to_be_bytes()); // checksum
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        let padded = body.len() + (4 - body.len() % 4) % 4;
        bodies.push((body.clone(), padded));
        offset += padded;
    }
    for (body, padded) in bodies {
        out.extend_from_slice(&body);
        out.extend(std::iter::repeat(0u8).take(padded - body.len()));
    }
    out
}

/// 一个正常字体：族名 / 字形 / 全名 / 版本 / PostScript 名齐全。
fn full_font(family: &str, style: &str) -> Vec<u8> {
    let names = name_table(&[
        win(1, family),
        win(2, style),
        win(4, &format!("{family} {style}")),
        win(5, "Version 1.020"),
        win(6, &family.replace(' ', "-")),
        win(9, "ACME Type Foundry"),
        win(13, "SIL Open Font License 1.1"),
    ]);
    sfnt(
        [0x00, 0x01, 0x00, 0x00],
        &[
            ("name", names),
            ("maxp", maxp(1234)),
            ("head", head(2048)),
            ("OS/2", os2(700, true)),
        ],
        0,
    )
}

/// TTC：`count` 个字体，表内偏移按整文件重算；`bad_offset_for` 指定第几个字体的偏移写成越界值。
fn ttc(families: &[&str], bad_offset_for: Option<usize>) -> Vec<u8> {
    let header_len = 12 + 4 * families.len();
    let mut bodies = Vec::new();
    let mut body_offsets = Vec::new();
    let mut next = header_len;
    for family in families {
        let names = name_table(&[win(1, family), win(2, "Regular")]);
        let body = sfnt(
            [0x00, 0x01, 0x00, 0x00],
            &[("name", names), ("maxp", maxp(42))],
            next,
        );
        next += body.len();
        body_offsets.push(next - body.len());
        bodies.push(body);
    }

    let mut out = Vec::new();
    out.extend_from_slice(b"ttcf");
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    out.extend_from_slice(&(families.len() as u32).to_be_bytes());
    for (index, offset) in body_offsets.iter().enumerate() {
        let value = if bad_offset_for == Some(index) {
            u32::MAX as usize
        } else {
            *offset
        };
        out.extend_from_slice(&(value as u32).to_be_bytes());
    }
    for body in bodies {
        out.extend_from_slice(&body);
    }
    out
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn ttf_reads_names_and_structure() {
    let p = probe(&full_font("Noto Sans", "Bold")).expect("认成字体");
    assert_eq!(p.format, "TrueType 字体（二次曲线）");
    assert_eq!(p.faces, None);
    assert_eq!(p.family.as_deref(), Some("Noto Sans"));
    assert_eq!(p.subfamily.as_deref(), Some("Bold"));
    assert_eq!(p.full_name.as_deref(), Some("Noto Sans Bold"));
    assert_eq!(p.version.as_deref(), Some("Version 1.020"));
    assert_eq!(p.postscript.as_deref(), Some("Noto-Sans"));
    assert_eq!(p.designer.as_deref(), Some("ACME Type Foundry"));
    assert_eq!(p.license.as_deref(), Some("SIL Open Font License 1.1"));
    assert_eq!(p.glyphs, Some(1234));
    assert_eq!(p.units_per_em, Some(2048));
    assert_eq!(p.weight, Some(700));
    assert_eq!(p.italic, Some(true));
    assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    assert_eq!(weight_name(700), "Bold");
}

#[test]
fn open_type_cff_is_named_as_cff() {
    let names = name_table(&[win(1, "Source Han Sans"), win(4, "Source Han Sans Regular")]);
    let data = sfnt(*b"OTTO", &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert!(p.format.contains("CFF"), "{}", p.format);
    assert_eq!(p.family.as_deref(), Some("Source Han Sans"));
}

#[test]
fn apple_true_flavor_is_accepted() {
    let names = name_table(&[win(1, "Chicago")]);
    let data = sfnt(*b"true", &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert!(p.format.contains("Apple"), "{}", p.format);
    assert_eq!(p.family.as_deref(), Some("Chicago"));
}

#[test]
fn collection_reports_face_count_and_first_family() {
    let data = ttc(&["Acme Sans", "Acme Serif"], None);
    let p = probe(&data).expect("认成集合");
    assert!(p.format.contains("TTC"), "{}", p.format);
    assert_eq!(p.faces, Some(2));
    assert_eq!(p.family.as_deref(), Some("Acme Sans"));
    assert_eq!(p.glyphs, Some(42));
}

#[test]
fn collection_with_offset_past_eof_warns_without_panic() {
    let data = ttc(&["Acme Sans", "Acme Serif"], Some(1));
    let p = probe(&data).expect("认成集合");
    assert_eq!(p.faces, Some(2));
    assert_eq!(p.family.as_deref(), Some("Acme Sans"));
    assert!(
        p.warnings.iter().any(|w| w.contains("越过文件末尾")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn windows_record_wins_over_mac() {
    let names = name_table(&[mac(1, "Mac Family"), win(1, "Win Family")]);
    let data = sfnt([0x00, 0x01, 0x00, 0x00], &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("Win Family"));
    assert!(
        p.warnings.iter().any(|w| w.contains("Mac 平台记录")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn mac_only_record_is_decoded_approximately() {
    let names = name_table(&[mac(1, "PingFang SC")]);
    let data = sfnt([0x00, 0x01, 0x00, 0x00], &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("PingFang SC"));
}

#[test]
fn chinese_family_name_decodes_from_utf16be() {
    let names = name_table(&[win(1, "思源黑体"), win(2, "粗体")]);
    let data = sfnt(*b"OTTO", &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("思源黑体"));
    assert_eq!(p.subfamily.as_deref(), Some("粗体"));
}

#[test]
fn missing_name_table_only_warns() {
    let data = sfnt(
        [0x00, 0x01, 0x00, 0x00],
        &[("maxp", maxp(88)), ("head", head(1000))],
        0,
    );
    let p = probe(&data).expect("认得表头");
    assert_eq!(p.family, None);
    assert_eq!(p.glyphs, Some(88));
    assert_eq!(p.units_per_em, Some(1000));
    assert!(
        p.warnings.iter().any(|w| w.contains("`name` 表")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn record_count_larger_than_table_does_not_panic() {
    let mut names = name_table(&[win(1, "Acme")]);
    // 把 count 改成 50，但表里只有 1 条记录 + 字符串
    names[2..4].copy_from_slice(&50u16.to_be_bytes());
    let data = sfnt([0x00, 0x01, 0x00, 0x00], &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("Acme"));
    assert!(
        p.warnings.iter().any(|w| w.contains("越过表尾")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn table_offset_past_eof_is_skipped() {
    let names = name_table(&[win(1, "Acme")]);
    let mut data = sfnt([0x00, 0x01, 0x00, 0x00], &[("name", names), ("maxp", maxp(10))], 0);
    // 第二项（maxp）的偏移改成越界值：目录第 1 项偏移字段在 12 + 16 + 8
    data[36..40].copy_from_slice(&0xFFFF_FF00u32.to_be_bytes());
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("Acme"));
    assert_eq!(p.glyphs, None);
    assert!(
        p.warnings.iter().any(|w| w.contains("越过文件末尾")),
        "{:?}",
        p.warnings
    );
}

#[test]
fn odd_utf16_length_is_truncated() {
    let mut rec = win(1, "Acme");
    rec.raw.push(0x00); // 让长度变奇数
    let names = name_table(&[rec]);
    let data = sfnt([0x00, 0x01, 0x00, 0x00], &[("name", names)], 0);
    let p = probe(&data).expect("认成字体");
    assert_eq!(p.family.as_deref(), Some("Acme"));
}

#[test]
fn empty_table_directory_is_not_an_error() {
    let mut data = vec![0x00, 0x01, 0x00, 0x00];
    data.extend_from_slice(&0u16.to_be_bytes()); // numTables = 0
    data.extend_from_slice(&[0u8; 6]);
    let p = probe(&data).expect("表头仍是字体");
    assert_eq!(p.family, None);
    assert!(p.warnings.iter().any(|w| w.contains("表目录为空")), "{:?}", p.warnings);
}

#[test]
fn non_font_bytes_return_none() {
    assert!(probe(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]).is_none());
    assert!(probe(b"PK\x03\x04zzzzzzzz").is_none());
    assert!(probe(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0x10, 0, 0, 0, 0, 0]).is_none());
}

#[test]
fn sniff_magic_recognizes_font_containers() {
    let ttf_bytes = full_font("Acme Sans", "Regular");
    assert_eq!(sniff_magic(&ttf_bytes), Some("ttf"));
    let names = name_table(&[win(1, "Acme")]);
    assert_eq!(sniff_magic(&sfnt(*b"OTTO", &[("name", names)], 0)), Some("otf"));
    assert_eq!(sniff_magic(&ttc(&["A", "B"], None)), Some("ttc"));
}

#[test]
fn metadata_panel_and_rename_fields_use_the_font() {
    let temp = Temp::new("panel");
    let path = temp.file("Acme-Sans-Bold.ttf", &full_font("Acme Sans", "Bold"));

    let info = read_metadata(&path).expect("读元数据");
    assert_eq!(info.kind, "font");
    assert_eq!(info.format, "TrueType 字体（二次曲线）");
    let get = |label: &str| {
        info.fields
            .iter()
            .find(|f| f.label == label)
            .map(|f| f.value.as_str())
    };
    assert_eq!(get("字体名"), Some("Acme Sans"));
    assert_eq!(get("字形"), Some("Bold"));
    assert_eq!(get("字体版本"), Some("Version 1.020"));
    assert_eq!(get("字重"), Some("700（Bold）"));
    assert_eq!(get("斜体"), Some("是"));
    assert_eq!(get("字形数"), Some("1234 个"));
    assert_eq!(get("设计网格"), Some("2048 units/em"));

    let values = rename_field_values(&info);
    // 空格是合法文件名字符，只把非法字符换掉，所以族名原样保留
    assert_eq!(values.font_family, "Acme Sans");
    assert_eq!(values.font_style, "Bold");
    // 「Version 1.020;hotconv」这类尾巴只留版本号
    assert_eq!(values.font_version, "1.020");
    assert_eq!(values.title, "");
}

#[test]
fn version_token_drops_generator_tail() {
    let names = name_table(&[win(1, "Acme"), win(5, "Version 2.001;hotconv 1.0.109")]);
    let temp = Temp::new("version");
    let path = temp.file(
        "Acme.otf",
        &sfnt(*b"OTTO", &[("name", names)], 0),
    );
    let info = read_metadata(&path).expect("读元数据");
    let values = rename_field_values(&info);
    assert_eq!(values.font_version, "2.001");
}
