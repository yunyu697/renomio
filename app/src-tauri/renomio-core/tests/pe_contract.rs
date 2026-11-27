//! PE（EXE / DLL / SYS）版本资源的契约测试。
//!
//! 全部夹具在测试里**现场构造最小的 PE 映像**（DOS 头、PE 签名、COFF 头、optional header、
//! 一个 `.rsrc` 节、资源目录三层 + `VS_VERSIONINFO`），不下载样本、不依赖本机 exe。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::{metadata, pe, sniff};

// ---------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------

fn utf16(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// 一个 `VS_VERSIONINFO` 块：头部 6 字节 + 键（UTF-16 + 结尾 0）+ 4 字节对齐 + 值 + 子块。
fn block(key: &str, kind: u16, value: &[u8], value_len: u16, children: &[u8]) -> Vec<u8> {
    let mut buf = vec![0u8; 6];
    buf.extend(utf16(key));
    buf.extend_from_slice(&[0, 0]);
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
    buf.extend_from_slice(value);
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
    buf.extend_from_slice(children);
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
    let len = buf.len() as u16;
    buf[0..2].copy_from_slice(&len.to_le_bytes());
    buf[2..4].copy_from_slice(&value_len.to_le_bytes());
    buf[4..6].copy_from_slice(&kind.to_le_bytes());
    buf
}

/// 一个字符串项（`String` 块，`wType = 1`，值长度按 UTF-16 字符数算，含结尾 0）。
fn string_item(key: &str, value: &str) -> Vec<u8> {
    let mut bytes = utf16(value);
    bytes.extend_from_slice(&[0, 0]);
    let chars = (value.encode_utf16().count() + 1) as u16;
    block(key, 1, &bytes, chars, &[])
}

/// 一张字符串表（`StringTable` 块，键是 8 位十六进制）。
fn string_table(lang: u16, code_page: u16, items: &[(&str, &str)]) -> Vec<u8> {
    let mut children = Vec::new();
    for (key, value) in items {
        children.extend(string_item(key, value));
    }
    let key = format!("{lang:04X}{code_page:04X}");
    block(&key, 1, &[], 0, &children)
}

/// 完整的版本资源数据：`VS_VERSION_INFO` → `StringFileInfo` → 若干 StringTable。
fn version_blob(file_version: (u16, u16), product_version: (u16, u16), tables: &[Vec<u8>]) -> Vec<u8> {
    let mut fixed = vec![0u8; 52];
    fixed[0..4].copy_from_slice(&0xFEEF_04BDu32.to_le_bytes());
    fixed[4..8].copy_from_slice(&0x0001_0000u32.to_le_bytes());
    let (fmajor, fminor) = file_version;
    let (pmajor, pminor) = product_version;
    let fms = (u32::from(fmajor) << 16) | u32::from(fminor);
    let pms = (u32::from(pmajor) << 16) | u32::from(pminor);
    fixed[8..12].copy_from_slice(&fms.to_le_bytes()); // FileVersionMS
    fixed[12..16].copy_from_slice(&0x0000_0064u32.to_le_bytes()); // FileVersionLS = 0.100
    fixed[16..20].copy_from_slice(&pms.to_le_bytes()); // ProductVersionMS
    fixed[20..24].copy_from_slice(&0u32.to_le_bytes()); // ProductVersionLS
    fixed[24..28].copy_from_slice(&0x3Fu32.to_le_bytes()); // FileFlagsMask
    fixed[28..32].copy_from_slice(&0u32.to_le_bytes()); // FileFlags
    fixed[32..36].copy_from_slice(&0x0004_0004u32.to_le_bytes()); // FileOS = NT / 32-bit
    fixed[36..40].copy_from_slice(&1u32.to_le_bytes()); // FileType = app

    let mut table_bytes = Vec::new();
    for table in tables {
        table_bytes.extend_from_slice(table);
    }
    let sfi = block("StringFileInfo", 1, &[], 0, &table_bytes);
    let root = block("VS_VERSION_INFO", 0, &fixed, 52, &sfi);
    root
}

/// 资源节内容：三层目录 + 数据项 + 版本数据。
fn resource_dir(version: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; 88 + version.len()];
    // 根目录：1 个 ID 项，指向偏移 24 的子目录
    out[14..16].copy_from_slice(&1u16.to_le_bytes());
    out[16..20].copy_from_slice(&16u32.to_le_bytes()); // name = RT_VERSION
    out[20..24].copy_from_slice(&(24u32 | 0x8000_0000).to_le_bytes());
    // 第二层：1 个 ID 项（资源 ID = 1），指向偏移 48 的子目录
    out[38..40].copy_from_slice(&1u16.to_le_bytes());
    out[40..44].copy_from_slice(&1u32.to_le_bytes());
    out[44..48].copy_from_slice(&(48u32 | 0x8000_0000).to_le_bytes());
    // 第三层：1 个语言项 0x0409，指向偏移 72 的数据项
    out[62..64].copy_from_slice(&1u16.to_le_bytes());
    out[64..68].copy_from_slice(&0x0409u32.to_le_bytes());
    out[68..72].copy_from_slice(&72u32.to_le_bytes());
    // 数据项：RVA / 大小 / 代码页 / 保留
    out[72..76].copy_from_slice(&(0x1000u32 + 88).to_le_bytes());
    out[76..80].copy_from_slice(&(version.len() as u32).to_le_bytes());
    out[80..84].copy_from_slice(&1200u32.to_le_bytes());
    out[88..].copy_from_slice(version);
    out
}

/// 组装一个最小 PE 映像。
fn pe_image(version: &[u8], dll: bool, machine: u16, subsystem: u16, stamp: u32, pe32plus: bool) -> Vec<u8> {
    let rsrc = resource_dir(version);
    let raw_off = 0x200usize;
    let mut file = vec![0u8; raw_off + rsrc.len().max(1)];
    // DOS 头
    file[0] = b'M';
    file[1] = b'Z';
    file[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    // PE 签名
    file[0x80..0x84].copy_from_slice(b"PE\0\0");
    let coff = 0x84;
    file[coff..coff + 2].copy_from_slice(&machine.to_le_bytes());
    file[coff + 2..coff + 4].copy_from_slice(&1u16.to_le_bytes()); // 1 个节
    file[coff + 4..coff + 8].copy_from_slice(&stamp.to_le_bytes());
    let opt_size: u16 = if pe32plus { 0xF0 } else { 0xE0 };
    file[coff + 16..coff + 18].copy_from_slice(&opt_size.to_le_bytes());
    let characteristics: u16 = if dll { 0x2102 } else { 0x0102 };
    file[coff + 18..coff + 20].copy_from_slice(&characteristics.to_le_bytes());

    let opt = 0x98usize;
    let magic: u16 = if pe32plus { 0x20B } else { 0x10B };
    file[opt..opt + 2].copy_from_slice(&magic.to_le_bytes());
    file[opt + 68..opt + 70].copy_from_slice(&subsystem.to_le_bytes());
    let (count_off, dirs_off) = if pe32plus { (108usize, 112usize) } else { (92usize, 96usize) };
    file[opt + count_off..opt + count_off + 4].copy_from_slice(&16u32.to_le_bytes());
    let rsrc_entry = opt + dirs_off + 2 * 8;
    file[rsrc_entry..rsrc_entry + 4].copy_from_slice(&0x1000u32.to_le_bytes());
    file[rsrc_entry + 4..rsrc_entry + 8].copy_from_slice(&(rsrc.len() as u32).to_le_bytes());

    // 节表（紧跟在 optional header 之后）
    let table = opt + usize::from(opt_size);
    file[table..table + 5].copy_from_slice(b".rsrc");
    file[table + 8..table + 12].copy_from_slice(&(rsrc.len() as u32).to_le_bytes()); // VirtualSize
    file[table + 12..table + 16].copy_from_slice(&0x1000u32.to_le_bytes()); // VirtualAddress
    file[table + 16..table + 20].copy_from_slice(&(rsrc.len() as u32).to_le_bytes()); // SizeOfRawData
    file[table + 20..table + 24].copy_from_slice(&(raw_off as u32).to_le_bytes()); // PointerToRawData
    file[raw_off..].copy_from_slice(&rsrc);
    file
}

/// 写一个临时文件（名字带纳秒时间戳，避开并发撞名）。
struct Temp {
    dir: PathBuf,
}

impl Temp {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-pe-{stamp}"));
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

fn standard_tables() -> Vec<Vec<u8>> {
    vec![string_table(
        0x0409,
        1200,
        &[
            ("CompanyName", "Acme Studio"),
            ("ProductName", "Renomio"),
            ("FileDescription", "批量改名工具"),
            ("LegalCopyright", "© 2026 Acme"),
            ("OriginalFilename", "renomio.exe"),
            ("InternalName", "renomio"),
            ("FileVersion", "1.2.0.27"),
            ("Comments", "构建于 CI"),
        ],
    )]
}

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

#[test]
fn exe_with_version_resource_reads_every_field() {
    let blob = version_blob((1, 2), (1, 2), &standard_tables());
    let data = pe_image(&blob, false, 0x8664, 2, 1_795_000_000, false);
    let probe = pe::probe(&data).expect("应认出 PE");
    assert_eq!(probe.pe_kind, "exe");
    assert_eq!(probe.format, "PE 可执行文件（EXE）");
    assert_eq!(probe.bitness, Some(32));
    assert_eq!(probe.machine.as_deref(), Some("x64"));
    assert_eq!(probe.subsystem.as_deref(), Some("Windows GUI"));
    assert_eq!(probe.built.as_deref(), Some("2026-11-18 11:06:40 (UTC)"));
    assert_eq!(probe.file_version.as_deref(), Some("1.2.0.100"));
    assert_eq!(probe.product_version.as_deref(), Some("1.2.0.0"));
    assert_eq!(probe.language.as_deref(), Some("0x0409（en-US）"));
    let company = probe
        .strings
        .iter()
        .find(|s| s.key == "CompanyName")
        .map(|s| s.value.clone());
    assert_eq!(company.as_deref(), Some("Acme Studio"));
    assert!(probe.warnings.is_empty(), "不应有警告：{:?}", probe.warnings);
}

#[test]
fn dll_and_driver_are_told_apart() {
    let blob = version_blob((1, 0), (1, 0), &standard_tables());
    let dll = pe_image(&blob, true, 0x14c, 3, 0, false);
    let probe = pe::probe(&dll).expect("应认出 PE");
    assert_eq!(probe.pe_kind, "dll");
    assert!(probe.format.contains("DLL"));
    assert_eq!(probe.machine.as_deref(), Some("x86"));
    assert_eq!(probe.subsystem.as_deref(), Some("Windows 控制台"));

    let sys = pe_image(&blob, false, 0xAA64, 1, 0, false);
    let probe = pe::probe(&sys).expect("应认出 PE");
    assert_eq!(probe.pe_kind, "driver");
    assert!(probe.format.contains("SYS"));
    assert_eq!(probe.machine.as_deref(), Some("ARM64"));
}

#[test]
fn pe32plus_reads_64_bit_optional_header() {
    let blob = version_blob((2, 5), (2, 5), &standard_tables());
    let data = pe_image(&blob, false, 0x8664, 2, 0, true);
    let probe = pe::probe(&data).expect("应认出 PE32+");
    assert_eq!(probe.bitness, Some(64));
    assert_eq!(probe.file_version.as_deref(), Some("2.5.0.100"));
}

#[test]
fn missing_resource_directory_only_warns() {
    let mut data = pe_image(&[], false, 0x8664, 2, 0, false);
    // 资源目录 RVA 归零 = 没有资源
    let opt = 0x98usize;
    let entry = opt + 96 + 2 * 8;
    data[entry..entry + 4].copy_from_slice(&0u32.to_le_bytes());
    let probe = pe::probe(&data).expect("头仍然有效");
    assert!(probe.file_version.is_none());
    assert!(
        probe.warnings.iter().any(|w| w.contains("没有版本资源")),
        "{:?}",
        probe.warnings
    );
}

#[test]
fn missing_rt_version_entry_reports_reason() {
    let blob = version_blob((1, 0), (1, 0), &standard_tables());
    let mut data = pe_image(&blob, false, 0x8664, 2, 0, false);
    // 把根目录的类型 ID 改成 10（RT_RCDATA），RT_VERSION 就找不到了
    let rsrc_off = 0x200usize;
    data[rsrc_off + 16..rsrc_off + 20].copy_from_slice(&10u32.to_le_bytes());
    let probe = pe::probe(&data).expect("头仍然有效");
    assert!(probe.file_version.is_none());
    assert!(
        probe
            .warnings
            .iter()
            .any(|w| w.contains("没有 RT_VERSION")),
        "{:?}",
        probe.warnings
    );
}

#[test]
fn prefers_english_string_table_and_warns_about_others() {
    let zh = string_table(0x0804, 1200, &[("CompanyName", "示例公司")]);
    let en = string_table(0x0409, 1200, &[("CompanyName", "Example Corp")]);
    let blob = version_blob((1, 0), (1, 0), &[zh, en]);
    let data = pe_image(&blob, false, 0x8664, 2, 0, false);
    let probe = pe::probe(&data).expect("应认出 PE");
    assert_eq!(probe.language.as_deref(), Some("0x0409（en-US）"));
    assert_eq!(probe.strings[0].value, "Example Corp");
    assert!(
        probe.warnings.iter().any(|w| w.contains("2 张语言表")),
        "{:?}",
        probe.warnings
    );
}

#[test]
fn non_ascii_company_name_is_decoded_utf16() {
    let table = string_table(0x0409, 1200, &[("CompanyName", "广州示例科技有限公司")]);
    let blob = version_blob((1, 0), (1, 0), &[table]);
    let data = pe_image(&blob, false, 0x8664, 2, 0, false);
    let probe = pe::probe(&data).expect("应认出 PE");
    assert_eq!(probe.strings[0].value, "广州示例科技有限公司");
}

#[test]
fn bad_fixed_signature_is_warned_not_guessed() {
    let mut blob = version_blob((1, 0), (1, 0), &standard_tables());
    // 键 "VS_VERSION_INFO" 占 32 字节（含结尾 0），值从 6+32=38 → 40（4 字节对齐）
    let start = 40usize;
    blob[start..start + 4].copy_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
    let data = pe_image(&blob, false, 0x8664, 2, 0, false);
    let probe = pe::probe(&data).expect("头仍然有效");
    assert!(probe.file_version.is_none());
    assert!(probe.product_version.is_none());
    assert!(
        probe.warnings.iter().any(|w| w.contains("0xFEEF04BD")),
        "{:?}",
        probe.warnings
    );
}

#[test]
fn truncated_version_blob_does_not_panic() {
    let blob = version_blob((1, 2), (1, 2), &standard_tables());
    let mut data = pe_image(&blob, false, 0x8664, 2, 0, false);
    // 把资源数据项声明的长度改得比真实数据大，模拟文件被截断
    let data_entry = 0x200usize + 72;
    data[data_entry + 4..data_entry + 8].copy_from_slice(&0xFFFFu32.to_le_bytes());
    let probe = pe::probe(&data).expect("头仍然有效");
    assert!(probe.file_version.is_some(), "截断前的内容仍应解出来");
    assert!(!probe.warnings.is_empty(), "截断必须给警告");
}

#[test]
fn resource_rva_outside_sections_warns() {
    let blob = version_blob((1, 0), (1, 0), &standard_tables());
    let mut data = pe_image(&blob, false, 0x8664, 2, 0, false);
    let opt = 0x98usize;
    let entry = opt + 96 + 2 * 8;
    data[entry..entry + 4].copy_from_slice(&0x9000_0000u32.to_le_bytes());
    let probe = pe::probe(&data).expect("头仍然有效");
    assert!(probe.file_version.is_none());
    assert!(
        probe.warnings.iter().any(|w| w.contains("不在任何节")),
        "{:?}",
        probe.warnings
    );
}

#[test]
fn any_prefix_of_a_valid_pe_never_panics() {
    let blob = version_blob((1, 2), (1, 2), &standard_tables());
    let data = pe_image(&blob, false, 0x8664, 2, 0, false);
    for cut in 0..data.len().min(600) {
        let _ = pe::probe(&data[..cut]);
    }
}

#[test]
fn non_pe_bytes_are_none() {
    assert!(pe::probe(b"").is_none());
    assert!(pe::probe(b"plain text, no MZ").is_none());
    assert!(pe::probe(b"MZ").is_none());
}

#[test]
fn sniff_tells_exe_from_dll_and_rejects_bare_mz() {
    let blob = version_blob((1, 0), (1, 0), &standard_tables());
    let exe = pe_image(&blob, false, 0x8664, 2, 0, false);
    assert_eq!(sniff::sniff_magic(&exe), Some("exe"));
    let dll = pe_image(&blob, true, 0x8664, 2, 0, false);
    assert_eq!(sniff::sniff_magic(&dll), Some("dll"));
    // 只有 MZ、没有 PE 签名 → 不猜
    assert_eq!(sniff::sniff_magic(b"MZ\x00\x00"), None);
}

#[test]
fn metadata_and_rename_fields_use_the_version_resource() {
    let temp = Temp::new();
    let blob = version_blob((1, 2), (1, 2), &standard_tables());
    let exe = pe_image(&blob, false, 0x8664, 2, 1_795_000_000, false);
    let path = temp.write("renomio.exe", &exe);
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");
    assert_eq!(info.kind, "exe");
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.file_version, "1.2.0.100");
    let has_company = info
        .fields
        .iter()
        .any(|f| f.label == "公司名" && f.value == "Acme Studio");
    assert!(has_company, "{:?}", info.fields);
    let has_product = info
        .fields
        .iter()
        .any(|f| f.label == "产品名" && f.value == "Renomio");
    assert!(has_product);
}

#[test]
fn file_version_is_name_safe() {
    let temp = Temp::new();
    // 版本号里带冒号（非常规但可能出现在恶意/手改的资源里），必须换成 `-`
    let table = string_table(0x0409, 1200, &[("CompanyName", "A:B")]);
    let blob = version_blob((1, 2), (1, 2), &[table]);
    let exe = pe_image(&blob, false, 0x8664, 2, 0, false);
    let path = temp.write("weird.exe", &exe);
    let info = metadata::read_metadata(path.to_str().expect("UTF-8 路径")).expect("应能读取");
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.file_version, "1.2.0.100", "版本号本身不含非法字符");
}
