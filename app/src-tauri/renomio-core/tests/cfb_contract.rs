//! 旧版 OLE（CFB 复合文档）契约测试：
//! 类型认对、摘要流能读、读不了的明确拒并给原因、结构损坏不 panic。
//!
//! 这些用例全部用**现场构造**的最小 CFB 文件（不是从网上下载的样本），
//! 每个扇区、每条 FAT 链都在测试里自己算，所以三平台跑出来的断言完全一致。

use std::fs;
use std::path::{Path, PathBuf};

use renomio_core::cfb::{self, CfbKind, CompoundFile};

// ---------------------------------------------------------------------------
// 最小 CFB 构造器
// ---------------------------------------------------------------------------

const SECTOR: usize = 512;
const MINI: usize = 64;
const ENDOFCHAIN: u32 = 0xFFFF_FFFE;
const FREESECT: u32 = 0xFFFF_FFFF;
const FATSECT: u32 = 0xFFFF_FFFD;
const NOSTREAM: u32 = 0xFFFF_FFFF;

fn clsid_for(text: &str) -> [u8; 16] {
    let raw: Vec<u8> = text
        .split('-')
        .flat_map(|part| (0..part.len()).step_by(2).map(move |i| part[i..i + 2].to_string()))
        .map(|hex| u8::from_str_radix(&hex, 16).unwrap())
        .collect();
    // 字符串按 GUID 顺序写（d1 d2 d3 为大端惯例），这里转成 CLSID 的字节布局
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&[raw[3], raw[2], raw[1], raw[0]]);
    out[4..6].copy_from_slice(&[raw[5], raw[4]]);
    out[6..8].copy_from_slice(&[raw[7], raw[6]]);
    out[8..16].copy_from_slice(&raw[8..16]);
    out
}

fn le_u32(v: u32) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

fn put_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

/// 构造一个只有小流（mini stream）的复合文档。
fn build_cfb(root_clsid: [u8; 16], streams: &[(&str, Vec<u8>)]) -> Vec<u8> {
    for (_, data) in streams {
        assert!(data.len() < 4096, "测试构造器只处理小流");
    }
    let dir_sectors = (1 + streams.len()).div_ceil(4);
    let mini_units: usize = streams.iter().map(|(_, d)| d.len().div_ceil(MINI)).sum();
    let minifat_sectors = mini_units.max(1).div_ceil(SECTOR / 4);
    let mini_bytes_units = mini_units * MINI;
    let mini_sectors = mini_bytes_units.div_ceil(SECTOR);

    let fat_sector = 0usize;
    let dir_start = 1usize;
    let minifat_start = dir_start + dir_sectors;
    let mini_start = minifat_start + minifat_sectors;
    let total_sectors = mini_start + mini_sectors;

    // ---- FAT
    let mut fat = vec![FREESECT; SECTOR / 4];
    fat[fat_sector] = FATSECT;
    for i in 0..dir_sectors {
        fat[dir_start + i] = if i + 1 == dir_sectors {
            ENDOFCHAIN
        } else {
            (dir_start + i + 1) as u32
        };
    }
    for i in 0..minifat_sectors {
        fat[minifat_start + i] = if i + 1 == minifat_sectors {
            ENDOFCHAIN
        } else {
            (minifat_start + i + 1) as u32
        };
    }
    for i in 0..mini_sectors {
        fat[mini_start + i] = if i + 1 == mini_sectors {
            ENDOFCHAIN
        } else {
            (mini_start + i + 1) as u32
        };
    }

    // ---- miniFAT：每个流占 ceil(len/64) 个小扇区，按顺序连起来
    let mut minifat = vec![FREESECT; minifat_sectors * (SECTOR / 4)];
    let mut mini_offsets: Vec<u32> = Vec::new();
    let mut cursor = 0usize;
    for (_, data) in streams {
        let units = data.len().div_ceil(MINI);
        mini_offsets.push(cursor as u32);
        for u in 0..units {
            let idx = cursor + u;
            minifat[idx] = if u + 1 == units {
                ENDOFCHAIN
            } else {
                (idx + 1) as u32
            };
        }
        cursor += units;
    }

    // ---- mini stream 容器
    let mut mini_stream = vec![0u8; mini_bytes_units];
    let mut pos = 0usize;
    for (_, data) in streams {
        mini_stream[pos..pos + data.len()].copy_from_slice(data);
        pos += data.len().div_ceil(MINI) * MINI;
    }

    // ---- 目录
    let mut dir = vec![0u8; dir_sectors * SECTOR];
    write_dir_entry(&mut dir[0..128], "Root Entry", 5, root_clsid, mini_start as u32, mini_bytes_units as u64);
    {
        let root = &mut dir[0..128];
        put_u32_at(root, 68, 1); // child
    }
    for (i, (name, data)) in streams.iter().enumerate() {
        let base = (1 + i) * 128;
        write_dir_entry(
            &mut dir[base..base + 128],
            name,
            2,
            [0u8; 16],
            mini_offsets[i],
            data.len() as u64,
        );
        let right = if 1 + i + 1 < 1 + streams.len() {
            (1 + i + 1) as u32
        } else {
            NOSTREAM
        };
        put_u32_at(&mut dir[base..base + 128], 72, right);
    }

    // ---- 头
    let mut out = vec![0u8; 512];
    out[0..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    out[24..26].copy_from_slice(&0x003Eu16.to_le_bytes());
    out[26..28].copy_from_slice(&3u16.to_le_bytes());
    out[28..30].copy_from_slice(&0xFFFEu16.to_le_bytes());
    out[30..32].copy_from_slice(&9u16.to_le_bytes());
    out[32..34].copy_from_slice(&6u16.to_le_bytes());
    out[44..48].copy_from_slice(&1u32.to_le_bytes()); // 一个 FAT 扇区
    out[48..52].copy_from_slice(&(dir_start as u32).to_le_bytes());
    out[56..60].copy_from_slice(&4096u32.to_le_bytes());
    out[60..64].copy_from_slice(&(minifat_start as u32).to_le_bytes());
    out[64..68].copy_from_slice(&(minifat_sectors as u32).to_le_bytes());
    out[68..72].copy_from_slice(&ENDOFCHAIN.to_le_bytes());
    out[72..76].copy_from_slice(&0u32.to_le_bytes());
    out[76..80].copy_from_slice(&(fat_sector as u32).to_le_bytes());

    // ---- 扇区正文
    let mut fat_bytes = Vec::new();
    for v in &fat {
        fat_bytes.extend_from_slice(&v.to_le_bytes());
    }
    assert_eq!(fat_bytes.len(), SECTOR);
    assert!(total_sectors <= SECTOR / 4, "最小构造器只支持单个 FAT 扇区");
    out.extend_from_slice(&fat_bytes);
    out.extend_from_slice(&dir);
    let mut minifat_bytes = Vec::new();
    for v in &minifat {
        minifat_bytes.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&minifat_bytes);
    // 迷你流容器必须补满整扇区，否则文件比 FAT 宣告的短（读侧会判越界）
    let mut padded = mini_stream;
    padded.resize(mini_sectors * SECTOR, 0);
    out.extend_from_slice(&padded);
    out
}

fn write_dir_entry(buf: &mut [u8], name: &str, kind: u8, clsid: [u8; 16], start: u32, size: u64) {
    let units: Vec<u16> = name.encode_utf16().collect();
    for (i, unit) in units.iter().enumerate() {
        buf[i * 2..i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
    }
    let name_bytes = (units.len() + 1) * 2;
    buf[64..66].copy_from_slice(&(name_bytes as u16).to_le_bytes());
    buf[66] = kind;
    buf[67] = 1; // black
    put_u32_at(buf, 68, NOSTREAM); // left
    put_u32_at(buf, 72, NOSTREAM); // right
    put_u32_at(buf, 76, NOSTREAM); // child
    buf[80..96].copy_from_slice(&clsid);
    put_u32_at(buf, 116, start);
    put_u32_at(buf, 120, size as u32);
    put_u32_at(buf, 124, 0);
}

fn put_u32_at(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

// ---------------------------------------------------------------------------
// 属性集构造器
// ---------------------------------------------------------------------------

enum Val {
    /// 码页号（id=1）
    CodePage(u16),
    /// 窄字符串（按码页字节原样给出）
    Bytes(Vec<u8>),
    Int(i32),
    FileTime(u64),
}

fn summary_stream(codepage: u16, rest: &[(u32, Val)]) -> Vec<u8> {
    prop_set(
        &[0xE0, 0x85, 0x9F, 0xF2, 0xF9, 0x4F, 0x68, 0x10, 0xAB, 0x91, 0x08, 0x00, 0x2B, 0x27, 0xB3, 0xD9],
        codepage,
        rest,
    )
}

fn doc_summary_stream(codepage: u16, rest: &[(u32, Val)]) -> Vec<u8> {
    prop_set(
        &[0x02, 0xD5, 0xCD, 0xD5, 0x9C, 0x2E, 0x1B, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2B, 0x2C, 0xF9, 0xAE],
        codepage,
        rest,
    )
}

fn prop_set(fmtid: &[u8], codepage: u16, rest: &[(u32, Val)]) -> Vec<u8> {
    // 值的字节编码
    let mut values: Vec<(u32, Vec<u8>)> = Vec::new();
    values.push((1, encode_val(&Val::CodePage(codepage))));
    for (id, val) in rest {
        values.push((*id, encode_val(val)));
    }

    let count = values.len();
    let mut entries = Vec::new();
    let mut payload = Vec::new();
    let base = 8 + count * 8; // 相对扇区起点
    for (id, bytes) in &values {
        let off = base + payload.len();
        entries.extend_from_slice(&le_u32(*id));
        entries.extend_from_slice(&le_u32(off as u32));
        payload.extend_from_slice(bytes);
        while payload.len() % 4 != 0 {
            payload.push(0);
        }
    }

    let section_len = base + payload.len();
    let mut out = vec![0u8; 48];
    out[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
    out[4..8].copy_from_slice(&0x0002_0006u32.to_le_bytes());
    out[24..28].copy_from_slice(&1u32.to_le_bytes());
    out[28..44].copy_from_slice(fmtid);
    out[44..48].copy_from_slice(&48u32.to_le_bytes());
    out.extend_from_slice(&le_u32(section_len as u32));
    out.extend_from_slice(&le_u32(count as u32));
    out.extend_from_slice(&entries);
    out.extend_from_slice(&payload);
    out
}

fn encode_val(val: &Val) -> Vec<u8> {
    let mut out = Vec::new();
    match val {
        Val::CodePage(cp) => {
            out.extend_from_slice(&2u16.to_le_bytes()); // VT_I2
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&(*cp as i16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        Val::Bytes(bytes) => {
            out.extend_from_slice(&30u16.to_le_bytes()); // VT_LPSTR
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&((bytes.len() + 1) as u32).to_le_bytes());
            out.extend_from_slice(bytes);
            out.push(0);
        }
        Val::Int(n) => {
            out.extend_from_slice(&3u16.to_le_bytes()); // VT_I4
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&(*n).to_le_bytes());
        }
        Val::FileTime(ft) => {
            out.extend_from_slice(&64u16.to_le_bytes()); // VT_FILETIME
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&ft.to_le_bytes());
        }
    }
    out
}

fn ft_from_unix_ms(ms: i64) -> u64 {
    ((ms + 11_644_473_600_000) * 10_000) as u64
}

// ---------------------------------------------------------------------------
// 临时目录
// ---------------------------------------------------------------------------

struct Temp {
    root: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("renomio-cfb-{tag}-{stamp}"));
        fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_meta(path: &Path) -> renomio_core::metadata::MetadataInfo {
    renomio_core::metadata::read_metadata(&path.to_string_lossy()).unwrap()
}

fn field<'a>(info: &'a renomio_core::metadata::MetadataInfo, label: &str) -> Option<&'a str> {
    info.fields
        .iter()
        .find(|f| f.label == label)
        .map(|f| f.value.as_str())
}

const WORD_CLSID: &str = "00020906-0000-0000-C000-000000000046";
const EXCEL_CLSID: &str = "00020820-0000-0000-C000-000000000046";
const PPT_CLSID: &str = "64818D10-4F9B-11CF-86EA-00AA00B929E8";
const MSI_CLSID: &str = "000C1084-0000-0000-C000-000000000046";
const MSG_CLSID: &str = "00020D0B-0000-0000-C000-000000000046";

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn word_doc_is_identified_and_summary_is_read() {
    let stamp = 1_774_753_440_000i64; // 2026-03-29 03:04 UTC
    let summary = summary_stream(
        1252,
        &[
            (2, Val::Bytes(b"Q3 Reorg Plan".to_vec())),
            (4, Val::Bytes(b"Tyler Zhang".to_vec())),
            (8, Val::Bytes(b"Ann Lee".to_vec())),
            (12, Val::FileTime(ft_from_unix_ms(stamp))),
            (18, Val::Bytes(b"Microsoft Word".to_vec())),
        ],
    );
    let bytes = build_cfb(
        clsid_for(WORD_CLSID),
        &[
            ("\u{5}SummaryInformation", summary),
            ("WordDocument", Vec::new()),
        ],
    );

    let file = CompoundFile::parse(&bytes).unwrap();
    assert_eq!(file.kind(), CfbKind::Word);
    assert_eq!(file.kind().metadata_kind(), "document");

    let t = Temp::new("word");
    let path = t.file("报告.doc", &bytes);
    let info = read_meta(&path);
    assert_eq!(info.kind, "document", "{:?}", info.warnings);
    assert!(info.format.contains("Word"), "{}", info.format);
    assert_eq!(field(&info, "标题"), Some("Q3 Reorg Plan"));
    assert_eq!(field(&info, "作者"), Some("Tyler Zhang"));
    assert_eq!(field(&info, "最后修改者"), Some("Ann Lee"));
    assert_eq!(field(&info, "生成应用"), Some("Microsoft Word"));
    assert_eq!(
        field(&info, "创建时间（UTC）"),
        Some(cfb::utc_text_from_unix_ms(stamp).as_str()),
        "FILETIME 必须按 UTC 正确换算"
    );
    assert!(info.warnings.is_empty(), "{:?}", info.warnings);
}

#[test]
fn excel_and_powerpoint_are_told_apart_by_root_clsid() {
    let excel = build_cfb(
        clsid_for(EXCEL_CLSID),
        &[("\u{5}SummaryInformation", summary_stream(1252, &[])), ("Workbook", Vec::new())],
    );
    assert_eq!(CompoundFile::parse(&excel).unwrap().kind(), CfbKind::Excel);

    let ppt = build_cfb(clsid_for(PPT_CLSID), &[("PowerPoint Document", Vec::new())]);
    let parsed = CompoundFile::parse(&ppt).unwrap();
    assert_eq!(parsed.kind(), CfbKind::PowerPoint);
    assert!(parsed.kind().reads_summary());
}

#[test]
fn msi_installer_is_not_reported_as_a_word_document() {
    // 这就是本轮要修的真实缺陷：.msi 的文件头与 .doc 完全相同，旧实现一律报「旧版 Office 文档」。
    let msi = build_cfb(
        clsid_for(MSI_CLSID),
        &[("_Tables", Vec::new()), ("_StringPool", Vec::new())],
    );
    let file = CompoundFile::parse(&msi).unwrap();
    assert_eq!(file.kind(), CfbKind::Msi);
    assert_eq!(file.kind().metadata_kind(), "other");

    let t = Temp::new("msi");
    let path = t.file("setup.msi", &msi);
    let info = read_meta(&path);
    assert_eq!(info.kind, "other");
    assert!(
        info.format.contains("安装包"),
        "格式名必须写清是安装包：{}",
        info.format
    );
    let reason = info.warnings.join(" / ");
    assert!(reason.contains("安装包"), "{reason}");
    assert!(
        !info.format.contains("Word"),
        "绝不能还把安装包叫成 Word 文档：{}",
        info.format
    );
    assert!(field(&info, "作者").is_none(), "安装包里没有文档属性可读");
}

#[test]
fn outlook_msg_and_encrypted_ooxml_are_recognized() {
    let msg = build_cfb(
        clsid_for(MSG_CLSID),
        &[("__substg1.0_0037001F", Vec::new())],
    );
    let file = CompoundFile::parse(&msg).unwrap();
    assert_eq!(file.kind(), CfbKind::OutlookMsg);
    assert!(file
        .kind()
        .refusal_reason()
        .unwrap_or_default()
        .contains("邮件"));

    let encrypted = build_cfb(
        [0u8; 16],
        &[("EncryptedPackage", Vec::new()), ("EncryptionInfo", Vec::new())],
    );
    let file = CompoundFile::parse(&encrypted).unwrap();
    assert_eq!(file.kind(), CfbKind::EncryptedOoxml);
    assert!(file
        .kind()
        .refusal_reason()
        .unwrap_or_default()
        .contains("密码"));
}

#[test]
fn gbk_summary_text_is_decoded_instead_of_garbled() {
    // cp936 的「季度报告」，字节由 GBK 编码器现算，不手抄码位
    let (encoded, _, _) = encoding_rs::GBK.encode("季度报告");
    let summary = summary_stream(936, &[(2, Val::Bytes(encoded.into_owned()))]);
    let bytes = build_cfb(
        clsid_for(WORD_CLSID),
        &[
            ("\u{5}SummaryInformation", summary),
            ("WordDocument", Vec::new()),
        ],
    );

    let stream = CompoundFile::parse(&bytes)
        .unwrap()
        .stream("SummaryInformation")
        .unwrap();
    let set = cfb::read_property_set(&stream).unwrap();
    assert_eq!(set.text(2), Some("季度报告"), "GBK 必须按码页解开，不能当 UTF-8 猜");
}

#[test]
fn company_comes_from_document_summary() {
    let bytes = build_cfb(
        clsid_for(WORD_CLSID),
        &[
            ("\u{5}SummaryInformation", summary_stream(1252, &[(2, Val::Bytes(b"Memo".to_vec()))])),
            (
                "\u{5}DocumentSummaryInformation",
                doc_summary_stream(1252, &[(15, Val::Bytes(b"Yunyu Studio".to_vec()))]),
            ),
            ("WordDocument", Vec::new()),
        ],
    );
    let t = Temp::new("company");
    let path = t.file("memo.doc", &bytes);
    let info = read_meta(&path);
    assert_eq!(field(&info, "标题"), Some("Memo"));
    assert_eq!(field(&info, "公司"), Some("Yunyu Studio"));
}

#[test]
fn corrupt_ole_structure_is_reported_with_reason() {
    let mut truncated = vec![0u8; 300];
    truncated[0..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    let t = Temp::new("corrupt");
    let path = t.file("broken.doc", &truncated);
    let info = read_meta(&path);
    assert_eq!(info.kind, "other");
    let all = info.warnings.join(" / ");
    assert!(all.contains("结构读取失败"), "{all}");
    assert!(
        !all.contains("尚未实现"),
        "拒绝理由必须具体，不能用「尚未实现」搪塞：{all}"
    );

    // 头部正常、但目录起始扇区指向文件之外：给原因而不是 panic
    let good = build_cfb(clsid_for(WORD_CLSID), &[("WordDocument", vec![7u8; 100])]);
    assert!(CompoundFile::parse(&good).is_ok(), "同一份字节必须能正常解析");
    let mut broken = good.clone();
    broken[48..52].copy_from_slice(&999u32.to_le_bytes());
    let err = match CompoundFile::parse(&broken) {
        Err(e) => e,
        Ok(_) => panic!("损坏的目录起始扇区必须被拒绝"),
    };
    assert!(err.contains("越出文件"), "原因必须具体：{err}");
}

#[test]
fn ole_title_flows_into_rename_field_values() {
    // 标题/作者读出来之后要能直接用于「按元数据取名」，否则面板好看但改名仍拿不到值
    let bytes = build_cfb(
        clsid_for(WORD_CLSID),
        &[
            (
                "\u{5}SummaryInformation",
                summary_stream(
                    1252,
                    &[
                        (2, Val::Bytes(b"Board Minutes 2026".to_vec())),
                        (4, Val::Bytes(b"Tyler Zhang".to_vec())),
                    ],
                ),
            ),
            ("WordDocument", Vec::new()),
        ],
    );
    let t = Temp::new("rename");
    let path = t.file("minutes.doc", &bytes);
    let info = read_meta(&path);
    let values = renomio_core::metadata::rename_field_values(&info);
    assert_eq!(values.title, "Board Minutes 2026");
    // 标题里带冒号/斜杠时，取名取值必须已经被安全化，不能原样落进文件名
    let unsafe_title = build_cfb(
        clsid_for(WORD_CLSID),
        &[
            (
                "\u{5}SummaryInformation",
                summary_stream(1252, &[(2, Val::Bytes(b"Q3: A/B plan".to_vec()))]),
            ),
            ("WordDocument", Vec::new()),
        ],
    );
    let p2 = t.file("unsafe.doc", &unsafe_title);
    let v2 = renomio_core::metadata::rename_field_values(&read_meta(&p2));
    assert!(
        !v2.title.contains(':') && !v2.title.contains('/'),
        "取名取值必须文件名安全化：{}",
        v2.title
    );
}

#[test]
fn utc_text_and_filetime_edges() {
    assert_eq!(cfb::utc_text_from_unix_ms(0), "");
    assert_eq!(cfb::utc_text_from_unix_ms(-1), "");
    assert_eq!(cfb::filetime_to_unix_ms(0), 0);
    // 2026-03-29 03:04 UTC
    assert_eq!(
        cfb::utc_text_from_unix_ms(1_774_753_440_000),
        "2026-03-29 03:04"
    );
    assert_eq!(
        cfb::filetime_to_unix_ms(ft_from_unix_ms(1_774_753_440_000)),
        1_774_753_440_000
    );
}
