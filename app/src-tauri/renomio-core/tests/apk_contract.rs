//! APK（Android 安装包）只读解析的契约测试。
//!
//! 全部夹具在测试里**现场构造**：最小的 ZIP（本地头 + 中央目录 + EOCD）、
//! 二进制 `AndroidManifest.xml`（字符串池 + 起止元素 + 带类型属性）、
//! `resources.arsc`（全局字符串池 + package / typeSpec / type 三层）。
//! 不下载样本，也不依赖本机的真实 APK。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::{apk, metadata};

// ---------------------------------------------------------------------------
// 字节写入小工具
// ---------------------------------------------------------------------------

fn put16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put8(out: &mut Vec<u8>, v: u8) {
    out.push(v);
}

fn patch32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

// ---------------------------------------------------------------------------
// 字符串池（AXML 与 ARSC 共用）
// ---------------------------------------------------------------------------

fn encode_len(n: usize) -> Vec<u8> {
    if n > 0x7F {
        vec![0x80 | ((n >> 8) as u8), (n & 0xFF) as u8]
    } else {
        vec![n as u8]
    }
}

fn str_pool(strings: &[String], utf8: bool) -> Vec<u8> {
    let mut data: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();
    for s in strings {
        offsets.push(data.len() as u32);
        if utf8 {
            let bytes = s.as_bytes();
            data.extend(encode_len(s.chars().count()));
            data.extend(encode_len(bytes.len()));
            data.extend_from_slice(bytes);
            data.push(0);
        } else {
            let units: Vec<u16> = s.encode_utf16().collect();
            assert!(units.len() < 0x7FFF, "测试夹具里的字符串不应超过 32766 个 UTF-16 单元");
            put16(&mut data, units.len() as u16);
            for unit in units {
                put16(&mut data, unit);
            }
            put16(&mut data, 0);
        }
    }
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let header_size = 28usize;
    let strings_start = header_size + offsets.len() * 4;
    let size = strings_start + data.len();
    let mut out = Vec::with_capacity(size);
    put16(&mut out, 0x0001);
    put16(&mut out, header_size as u16);
    put32(&mut out, size as u32);
    put32(&mut out, offsets.len() as u32);
    put32(&mut out, 0); // styleCount
    put32(&mut out, if utf8 { 0x100 } else { 0 });
    put32(&mut out, strings_start as u32);
    put32(&mut out, 0); // stylesStart
    for off in &offsets {
        put32(&mut out, *off);
    }
    out.extend_from_slice(&data);
    out
}

// ---------------------------------------------------------------------------
// 二进制 AndroidManifest.xml
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub enum Val {
    Str(String),
    Int(u32),
    Bool(bool),
    Ref(u32),
}

pub struct El {
    pub name: &'static str,
    pub attrs: Vec<(&'static str, Val)>,
}

fn el(name: &'static str, attrs: Vec<(&'static str, Val)>) -> El {
    El { name, attrs }
}

/// 组装一份 AXML：`utf8_pool` 决定字符串池用哪种编码；`extra_strings` 用于构造超长字符串。
fn axml(els: &[El], utf8_pool: bool) -> Vec<u8> {
    let mut strings: Vec<String> = Vec::new();
    let mut push = |list: &mut Vec<String>, s: &str| -> u32 {
        if let Some(i) = list.iter().position(|x| x == s) {
            return i as u32;
        }
        list.push(s.to_string());
        (list.len() - 1) as u32
    };
    for e in els {
        push(&mut strings, e.name);
        for (name, _) in &e.attrs {
            push(&mut strings, name);
        }
        for (_, value) in &e.attrs {
            if let Val::Str(s) = value {
                push(&mut strings, s);
            }
        }
    }
    let pool = str_pool(&strings, utf8_pool);
    let idx = |s: &str| strings.iter().position(|x| x == s).unwrap() as u32;

    let mut body: Vec<u8> = Vec::new();
    for e in els {
        // 起点元素：header 16 + attrExt 20
        let mut chunk: Vec<u8> = Vec::new();
        put16(&mut chunk, 0x0102);
        put16(&mut chunk, 16);
        put32(&mut chunk, 0); // size 占位
        put32(&mut chunk, 1); // lineNumber
        put32(&mut chunk, 0xFFFF_FFFF); // comment
        put32(&mut chunk, 0xFFFF_FFFF); // ns
        put32(&mut chunk, idx(e.name));
        put16(&mut chunk, 20); // attributeStart（相对 attrExt 起点）
        put16(&mut chunk, 20); // attributeSize
        put16(&mut chunk, e.attrs.len() as u16);
        put16(&mut chunk, 0); // idIndex
        put16(&mut chunk, 0); // classIndex
        put16(&mut chunk, 0); // styleIndex
        for (name, value) in &e.attrs {
            let name_idx = idx(name);
            let (raw, data_type, data) = match value {
                Val::Str(s) => (idx(s), 0x03u8, idx(s)),
                Val::Int(v) => (0xFFFF_FFFF, 0x10u8, *v),
                Val::Bool(b) => (0xFFFF_FFFF, 0x12u8, if *b { 1 } else { 0 }),
                Val::Ref(id) => (0xFFFF_FFFF, 0x01u8, *id),
            };
            put32(&mut chunk, 0xFFFF_FFFF); // ns
            put32(&mut chunk, name_idx);
            put32(&mut chunk, raw);
            put16(&mut chunk, 8); // Res_value 大小
            put8(&mut chunk, 0); // res0
            put8(&mut chunk, data_type);
            put32(&mut chunk, data);
        }
        let size = chunk.len() as u32;
        patch32(&mut chunk, 4, size);
        body.extend_from_slice(&chunk);

        // 结束元素：header 16 + ns + name
        let mut end: Vec<u8> = Vec::new();
        put16(&mut end, 0x0103);
        put16(&mut end, 16);
        put32(&mut end, 24);
        put32(&mut end, 1);
        put32(&mut end, 0xFFFF_FFFF);
        put32(&mut end, 0xFFFF_FFFF);
        put32(&mut end, idx(e.name));
        body.extend_from_slice(&end);
    }

    let mut out: Vec<u8> = Vec::new();
    put16(&mut out, 0x0003);
    put16(&mut out, 8);
    put32(&mut out, (8 + pool.len() + body.len()) as u32);
    out.extend_from_slice(&pool);
    out.extend_from_slice(&body);
    out
}

// ---------------------------------------------------------------------------
// resources.arsc
// ---------------------------------------------------------------------------

/// 一个最小资源表：单个 package、单个 type（default 配置），`entries` 给出「条目 id → 字符串」。
fn arsc(pkg_id: u8, type_id: u8, entries: &[(u16, &str)]) -> Vec<u8> {
    let values: Vec<String> = entries.iter().map(|(_, s)| s.to_string()).collect();
    let global_pool = str_pool(&values, false);

    let count = entries.iter().map(|(id, _)| *id as usize + 1).max().unwrap_or(0);
    let type_pool = str_pool(&["string".to_string()], false);
    let key_pool = str_pool(&["app_name".to_string()], false);

    let mut spec: Vec<u8> = Vec::new();
    put16(&mut spec, 0x0202);
    put16(&mut spec, 16);
    put32(&mut spec, (16 + 4 * count) as u32);
    put8(&mut spec, type_id);
    put8(&mut spec, 0);
    put16(&mut spec, 0);
    put32(&mut spec, count as u32);
    spec.extend(vec![0u8; 4 * count]);

    let header_size = 28usize;
    let entries_start = header_size + 4 * count;
    let mut blobs: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = vec![0xFFFF_FFFF; count];
    for (id, value) in entries {
        let slot = *id as usize;
        offsets[slot] = blobs.len() as u32;
        let string_index = values.iter().position(|v| v == value).unwrap() as u32;
        put16(&mut blobs, 8); // entry 大小
        put16(&mut blobs, 0); // flags
        put32(&mut blobs, 0); // key（都指向 key 池第 0 项）
        put16(&mut blobs, 8); // Res_value 大小
        put8(&mut blobs, 0);
        put8(&mut blobs, 0x03); // 字符串
        put32(&mut blobs, string_index);
    }

    let mut type_chunk: Vec<u8> = Vec::new();
    let size = entries_start + blobs.len();
    put16(&mut type_chunk, 0x0201);
    put16(&mut type_chunk, header_size as u16);
    put32(&mut type_chunk, size as u32);
    put8(&mut type_chunk, type_id);
    put8(&mut type_chunk, 0); // flags
    put16(&mut type_chunk, 0);
    put32(&mut type_chunk, count as u32);
    put32(&mut type_chunk, entries_start as u32);
    put32(&mut type_chunk, 8); // config 大小
    put32(&mut type_chunk, 0); // default 配置
    for off in &offsets {
        put32(&mut type_chunk, *off);
    }
    type_chunk.extend_from_slice(&blobs);

    let type_strings_off = 288usize;
    let key_strings_off = type_strings_off + type_pool.len();
    let mut pkg: Vec<u8> = Vec::new();
    put16(&mut pkg, 0x0200);
    put16(&mut pkg, 288);
    put32(&mut pkg, 0); // size 占位
    put32(&mut pkg, u32::from(pkg_id));
    pkg.extend(vec![0u8; 256]); // 包名（UTF-16，测试里留空）
    put32(&mut pkg, type_strings_off as u32);
    put32(&mut pkg, 0);
    put32(&mut pkg, key_strings_off as u32);
    put32(&mut pkg, 0);
    put32(&mut pkg, 0); // typeIdOffset
    pkg.extend_from_slice(&type_pool);
    pkg.extend_from_slice(&key_pool);
    pkg.extend_from_slice(&spec);
    pkg.extend_from_slice(&type_chunk);
    let pkg_size = pkg.len() as u32;
    patch32(&mut pkg, 4, pkg_size);

    let mut table: Vec<u8> = Vec::new();
    put16(&mut table, 0x0002);
    put16(&mut table, 12);
    put32(&mut table, 0); // size 占位
    put32(&mut table, 1); // packageCount
    table.extend_from_slice(&global_pool);
    table.extend_from_slice(&pkg);
    let total = table.len() as u32;
    patch32(&mut table, 4, total);
    table
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

pub struct ZipItem<'a> {
    pub name: &'a str,
    pub data: Vec<u8>,
    pub deflate: bool,
}

fn zip(items: &[ZipItem<'_>], sig_block: bool) -> Vec<u8> {
    use std::io::Write;
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for item in items {
        let local_off = out.len() as u32;
        let payload = if item.deflate {
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&item.data).expect("deflate");
            enc.finish().expect("deflate")
        } else {
            item.data.clone()
        };
        put32(&mut out, 0x0403_4B50);
        put16(&mut out, 20);
        put16(&mut out, 0);
        put16(&mut out, if item.deflate { 8 } else { 0 });
        put16(&mut out, 0);
        put16(&mut out, 0);
        put32(&mut out, 0); // crc（只读解析不校验）
        put32(&mut out, payload.len() as u32);
        put32(&mut out, item.data.len() as u32);
        put16(&mut out, item.name.len() as u16);
        put16(&mut out, 0);
        out.extend_from_slice(item.name.as_bytes());
        out.extend_from_slice(&payload);

        put32(&mut central, 0x0201_4B50);
        put16(&mut central, 20);
        put16(&mut central, 20);
        put16(&mut central, 0);
        put16(&mut central, if item.deflate { 8 } else { 0 });
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, 0);
        put32(&mut central, payload.len() as u32);
        put32(&mut central, item.data.len() as u32);
        put16(&mut central, item.name.len() as u16);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put16(&mut central, 0);
        put32(&mut central, 0);
        put32(&mut central, local_off);
        central.extend_from_slice(item.name.as_bytes());
    }
    if sig_block {
        out.extend(vec![0u8; 8]);
        out.extend_from_slice(b"APK Sig Block 42");
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&central);
    put32(&mut out, 0x0605_4B50);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, items.len() as u16);
    put16(&mut out, items.len() as u16);
    put32(&mut out, central.len() as u32);
    put32(&mut out, cd_off);
    put16(&mut out, 0);
    out
}

fn item(name: &str, data: Vec<u8>, deflate: bool) -> ZipItem<'_> {
    ZipItem {
        name,
        data,
        deflate,
    }
}

/// 一个「正常」清单：包名、版本、SDK、主活动、权限、应用信息。
fn demo_manifest(label: Val, utf8_pool: bool) -> Vec<u8> {
    axml(
        &[
            el(
                "manifest",
                vec![
                    ("package", Val::Str("com.example.app".into())),
                    ("versionName", Val::Str("1.4.2".into())),
                    ("versionCode", Val::Int(10402)),
                    ("compileSdkVersion", Val::Int(34)),
                ],
            ),
            el(
                "uses-sdk",
                vec![
                    ("minSdkVersion", Val::Int(23)),
                    ("targetSdkVersion", Val::Int(34)),
                ],
            ),
            el(
                "uses-permission",
                vec![("name", Val::Str("android.permission.INTERNET".into()))],
            ),
            el(
                "uses-permission",
                vec![("name", Val::Str("android.permission.CAMERA".into()))],
            ),
            el(
                "application",
                vec![
                    ("label", label),
                    ("icon", Val::Ref(0x7F02_0001)),
                    ("debuggable", Val::Bool(false)),
                    ("allowBackup", Val::Bool(true)),
                ],
            ),
            el("activity", vec![("name", Val::Str(".MainActivity".into()))]),
            el(
                "intent-filter",
                vec![(
                    "priority",
                    Val::Str("android.intent.action.MAIN".into()),
                )],
            ),
            el(
                "action",
                vec![("name", Val::Str("android.intent.action.MAIN".into()))],
            ),
            el(
                "category",
                vec![("name", Val::Str("android.intent.category.LAUNCHER".into()))],
            ),
        ],
        utf8_pool,
    )
}

/// 直接喂给 `apk::probe` 的完整包字节。
fn probe_bytes(full: &[u8]) -> apk::ApkProbe {
    apk::probe(full, &[], full.len() as u64).expect("应当识别为 APK")
}

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

#[test]
fn literal_manifest_fields() {
    let manifest = demo_manifest(Val::Str("示例应用".into()), false);
    let full = zip(
        &[
            item("AndroidManifest.xml", manifest, false),
            item("classes.dex", vec![0u8; 32], false),
        ],
        false,
    );
    let p = probe_bytes(&full);
    assert_eq!(p.package.as_deref(), Some("com.example.app"));
    assert_eq!(p.version_name.as_deref(), Some("1.4.2"));
    assert_eq!(p.version_code, Some(10402));
    assert_eq!(p.label.as_deref(), Some("示例应用"));
    assert_eq!(p.compile_sdk.as_deref(), Some("34"));
    assert_eq!(p.entry_count, 2);
    assert_eq!(p.format, "Android 安装包 (APK)");
}

#[test]
fn utf8_string_pool_is_decoded() {
    let manifest = demo_manifest(Val::Str("八位池应用".into()), true);
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.package.as_deref(), Some("com.example.app"));
    assert_eq!(p.label.as_deref(), Some("八位池应用"));
}

#[test]
fn label_resource_reference_resolved_from_arsc() {
    let manifest = demo_manifest(Val::Ref(0x7F01_0000), false);
    let full = zip(
        &[
            item("AndroidManifest.xml", manifest, false),
            item("resources.arsc", arsc(0x7F, 0x01, &[(0, "资源名称应用")]), false),
        ],
        false,
    );
    let p = probe_bytes(&full);
    assert_eq!(p.label.as_deref(), Some("资源名称应用"));
    assert_eq!(p.icon.as_deref(), Some("资源 0x7F020001"));
}

#[test]
fn missing_arsc_warns_and_keeps_label_empty() {
    let manifest = demo_manifest(Val::Ref(0x7F01_0000), false);
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.label, None);
    assert!(
        p.warnings.iter().any(|w| w.contains("resources.arsc")),
        "缺少资源表时应给出提示，实际：{:?}",
        p.warnings
    );
}

#[test]
fn broken_arsc_reports_warning_instead_of_panicking() {
    let manifest = demo_manifest(Val::Ref(0x7F01_0000), false);
    let mut bad = arsc(0x7F, 0x01, &[(0, "坏表应用")]);
    let bad_len = (bad.len() + 4096) as u32;
    patch32(&mut bad, 4, bad_len); // 声明长度超出文件尾
    let full = zip(
        &[
            item("AndroidManifest.xml", manifest, false),
            item("resources.arsc", bad, false),
        ],
        false,
    );
    let p = probe_bytes(&full);
    assert_eq!(p.label, None);
    assert!(
        p.warnings.iter().any(|w| w.contains("0x7F010000")),
        "应说明是哪个资源 id 没解析出来，实际：{:?}",
        p.warnings
    );
}

#[test]
fn sdk_levels_are_read() {
    let manifest = axml(
        &[
            el(
                "manifest",
                vec![("package", Val::Str("com.example.sdk".into()))],
            ),
            el(
                "uses-sdk",
                vec![
                    ("minSdkVersion", Val::Int(21)),
                    ("targetSdkVersion", Val::Int(33)),
                ],
            ),
        ],
        false,
    );
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.min_sdk.as_deref(), Some("21"));
    assert_eq!(p.target_sdk.as_deref(), Some("33"));
    assert_eq!(p.compile_sdk, None);
}

#[test]
fn main_activity_relative_name_gets_package_prefix() {
    let full = zip(
        &[item(
            "AndroidManifest.xml",
            demo_manifest(Val::Str("应用".into()), false),
            false,
        )],
        false,
    );
    let p = probe_bytes(&full);
    assert_eq!(p.main_activity.as_deref(), Some("com.example.app.MainActivity"));
}

#[test]
fn main_activity_ignores_activities_without_launcher_intent() {
    let manifest = axml(
        &[
            el(
                "manifest",
                vec![("package", Val::Str("com.example.multi".into()))],
            ),
            el("application", vec![]),
            el("activity", vec![("name", Val::Str(".First".into()))]),
            el("intent-filter", vec![]),
            el(
                "action",
                vec![("name", Val::Str("android.intent.action.VIEW".into()))],
            ),
            el("activity", vec![("name", Val::Str(".Second".into()))]),
            el("intent-filter", vec![]),
            el(
                "action",
                vec![("name", Val::Str("android.intent.action.MAIN".into()))],
            ),
            el(
                "category",
                vec![("name", Val::Str("android.intent.category.LAUNCHER".into()))],
            ),
        ],
        false,
    );
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.main_activity.as_deref(), Some("com.example.multi.Second"));
}

#[test]
fn permissions_are_collected_once() {
    let manifest = axml(
        &[
            el(
                "manifest",
                vec![("package", Val::Str("com.example.perm".into()))],
            ),
            el(
                "uses-permission",
                vec![("name", Val::Str("android.permission.INTERNET".into()))],
            ),
            el(
                "uses-permission-sdk-23",
                vec![("name", Val::Str("android.permission.READ_PHONE_STATE".into()))],
            ),
            el(
                "uses-permission",
                vec![("name", Val::Str("android.permission.INTERNET".into()))],
            ),
        ],
        false,
    );
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(
        p.permissions,
        vec![
            "android.permission.INTERNET".to_string(),
            "android.permission.READ_PHONE_STATE".to_string()
        ]
    );
}

#[test]
fn application_flags_are_read() {
    let manifest = axml(
        &[
            el(
                "manifest",
                vec![("package", Val::Str("com.example.flags".into()))],
            ),
            el(
                "application",
                vec![
                    ("debuggable", Val::Bool(true)),
                    ("allowBackup", Val::Bool(false)),
                ],
            ),
        ],
        false,
    );
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.debuggable, Some(true));
    assert_eq!(p.allow_backup, Some(false));
}

#[test]
fn deflated_manifest_is_inflated() {
    let manifest = demo_manifest(Val::Str("压缩清单".into()), false);
    let full = zip(&[item("AndroidManifest.xml", manifest, true)], false);
    let p = probe_bytes(&full);
    assert_eq!(p.version_name.as_deref(), Some("1.4.2"));
    assert_eq!(p.label.as_deref(), Some("压缩清单"));
}

#[test]
fn non_apk_zip_is_not_misdetected() {
    let full = zip(
        &[
            item("[Content_Types].xml", b"<Types/>".to_vec(), true),
            item("word/document.xml", b"<w/>".to_vec(), true),
        ],
        false,
    );
    assert!(
        apk::probe(&full, &[], full.len() as u64).is_none(),
        "DOCX 这类普通 ZIP 不应被当成 APK"
    );
}

#[test]
fn broken_central_directory_returns_none() {
    let manifest = demo_manifest(Val::Str("坏包".into()), false);
    let mut full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let eocd = full.len() - 22;
    patch32(&mut full, eocd + 16, 0xFFFF_FFF0); // 中央目录偏移指到文件外
    assert!(apk::probe(&full, &[], full.len() as u64).is_none());
}

#[test]
fn large_apk_uses_tail_window_for_central_directory() {
    let manifest = demo_manifest(Val::Str("大包".into()), false);
    // 清单在最前，后面塞一个大资源，让中央目录落进尾部窗口
    let full = zip(
        &[
            item("AndroidManifest.xml", manifest, false),
            item("assets/payload.bin", vec![7u8; 20_000], false),
            item("classes.dex", vec![1u8; 1_000], false),
        ],
        false,
    );
    let head = &full[..4_096];
    let tail = &full[full.len() - 1_024..];
    let p = apk::probe(head, tail, full.len() as u64).expect("大包也应识别");
    assert_eq!(p.package.as_deref(), Some("com.example.app"));
    assert_eq!(p.version_name.as_deref(), Some("1.4.2"));
    assert_eq!(p.entry_count, 3);
}

#[test]
fn apk_signing_block_and_v1_signature_are_detected() {
    let manifest = demo_manifest(Val::Str("签名包".into()), false);
    let plain = zip(&[item("AndroidManifest.xml", manifest.clone(), false)], false);
    assert!(!probe_bytes(&plain).sign_block);

    let signed = zip(
        &[
            item("AndroidManifest.xml", manifest, false),
            item("META-INF/CERT.RSA", vec![0u8; 16], false),
            item("META-INF/CERT.SF", vec![0u8; 16], false),
        ],
        true,
    );
    let p = probe_bytes(&signed);
    assert!(p.sign_block, "中央目录前的 APK Sig Block 应被识别");
    assert!(p.sign_v1, "META-INF 下的 .RSA/.SF 应视作 v1 签名");
}

#[test]
fn rename_field_uses_apk_version_name() {
    let manifest = demo_manifest(Val::Str("真盘应用".into()), false);
    let full = zip(&[item("AndroidManifest.xml", manifest, false)], false);
    let dir = temp_dir("apk-rename");
    let path = dir.join("demo-1.4.2.apk");
    fs::write(&path, &full).expect("写临时 apk");

    let info = metadata::read_metadata(path.to_string_lossy().as_ref()).expect("读取元数据");
    assert_eq!(info.kind, "apk");
    assert!(
        info.fields.iter().any(|f| f.label == "包名" && f.value == "com.example.app"),
        "属性面板应列出包名"
    );
    assert!(
        info.fields.iter().any(|f| f.label == "文件版本" && f.value == "1.4.2"),
        "属性面板应列出文件版本"
    );
    let values = metadata::rename_field_values(&info);
    assert_eq!(values.file_version, "1.4.2");

    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir(&dir);
}

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("renomio-apk-{tag}-{stamp}"));
    fs::create_dir_all(&dir).expect("建临时目录");
    dir
}
