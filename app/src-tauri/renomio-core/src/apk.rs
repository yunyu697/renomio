//! APK（Android 安装包）只读解析。
//!
//! 只做三件事，全部只读、不修改任何字节：
//! 1. ZIP 中央目录（EOCD + `PK\x01\x02`），记为「头 + 尾」双窗口，大于 8 MB 的包也能读；
//! 2. 二进制 `AndroidManifest.xml`（AXML）：字符串池、起止元素、带类型属性；
//! 3. `resources.arsc` 的全局字符串池与 type/entry 表：把 `@string/app_name` 这类资源引用解析成文字。
//!
//! 不校验签名、不反编译 dex、不解析 layout 资源。写入 APK 需要重建 ZIP 与签名块，本版本不支持。

const MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
const EOCD_SIG: &[u8; 4] = b"PK\x05\x06";
const CENTRAL_SIG: &[u8; 4] = b"PK\x01\x02";
const LOCAL_SIG: &[u8; 4] = b"PK\x03\x04";
const APK_SIG_BLOCK: &[u8; 16] = b"APK Sig Block 42";

/// 解析结果。所有字段缺失时保持 `None`，不编造值。
#[derive(Clone, Debug, Default)]
pub struct ApkProbe {
    pub format: String,
    pub package: Option<String>,
    pub version_name: Option<String>,
    pub version_code: Option<i64>,
    pub label: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
    pub compile_sdk: Option<String>,
    pub main_activity: Option<String>,
    pub permissions: Vec<String>,
    pub debuggable: Option<bool>,
    pub allow_backup: Option<bool>,
    pub icon: Option<String>,
    /// 包内条目数（中央目录条目，不深挖）
    pub entry_count: usize,
    /// META-INF 下的 v1 签名文件
    pub sign_v1: bool,
    /// 中央目录前的 APK Signing Block（v2/v3/v4）
    pub sign_block: bool,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// 双窗口读取：头部 8 MB + 尾部 1 MB，按绝对偏移取字节
// ---------------------------------------------------------------------------

struct Window<'a> {
    head: &'a [u8],
    tail: &'a [u8],
    tail_base: usize,
    size: usize,
}

impl<'a> Window<'a> {
    fn new(head: &'a [u8], tail: &'a [u8], size: u64) -> Self {
        let size = size as usize;
        let tail = if tail.len() >= size || size == 0 {
            &tail[..0]
        } else {
            tail
        };
        Self {
            head,
            tail,
            tail_base: size.saturating_sub(tail.len()),
            size,
        }
    }

    fn get(&self, off: usize, len: usize) -> Option<&'a [u8]> {
        let end = off.checked_add(len)?;
        if end > self.size {
            return None;
        }
        if end <= self.head.len() {
            return self.head.get(off..end);
        }
        if !self.tail.is_empty() && off >= self.tail_base && end <= self.tail_base + self.tail.len() {
            let start = off - self.tail_base;
            return self.tail.get(start..start + len);
        }
        None
    }
}

fn u16_at(data: &[u8], off: usize) -> Option<u16> {
    data.get(off..off + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(data: &[u8], off: usize) -> Option<u32> {
    data.get(off..off + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn find_eocd(win: &Window<'_>) -> Option<usize> {
    let (base, buf) = if win.tail.is_empty() {
        (0usize, win.head)
    } else {
        (win.tail_base, win.tail)
    };
    if buf.len() < 22 {
        return None;
    }
    let start = buf.len().saturating_sub(65_557);
    (start..=buf.len() - 22)
        .rev()
        .find(|&pos| buf.get(pos..pos + 4) == Some(EOCD_SIG.as_ref()))
        .map(|pos| base + pos)
}

struct ZipEntry {
    name: String,
    method: u16,
    comp_size: usize,
    uncomp_size: usize,
    local_off: usize,
}

fn zip_entries(win: &Window<'_>) -> Option<Vec<ZipEntry>> {
    let eocd = find_eocd(win)?;
    let head = win.get(eocd, 22)?;
    let count = u16_at(head, 10)? as usize;
    let mut off = u32_at(head, 16)? as usize;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let rec = win.get(off, 46)?;
        if rec.get(0..4) != Some(CENTRAL_SIG.as_ref()) {
            return None;
        }
        let method = u16_at(rec, 10)?;
        let comp_size = u32_at(rec, 20)? as usize;
        let uncomp_size = u32_at(rec, 24)? as usize;
        let name_len = u16_at(rec, 28)? as usize;
        let extra_len = u16_at(rec, 30)? as usize;
        let comment_len = u16_at(rec, 32)? as usize;
        let local_off = u32_at(rec, 42)? as usize;
        if comp_size == 0xFFFF_FFFF || uncomp_size == 0xFFFF_FFFF || local_off == 0xFFFF_FFFF {
            // ZIP64：中央目录字段溢出，本版本不展开
            return None;
        }
        let name_bytes = win.get(off + 46, name_len)?;
        out.push(ZipEntry {
            name: String::from_utf8_lossy(name_bytes).to_string(),
            method,
            comp_size,
            uncomp_size,
            local_off,
        });
        off += 46 + name_len + extra_len + comment_len;
    }
    Some(out)
}

fn read_entry(win: &Window<'_>, entry: &ZipEntry) -> Result<Vec<u8>, String> {
    if entry.uncomp_size > MAX_ENTRY_BYTES {
        return Err(format!(
            "条目 {} 解压后 {} 字节，超出本版本的解析上限",
            entry.name, entry.uncomp_size
        ));
    }
    let local = win
        .get(entry.local_off, 30)
        .ok_or_else(|| format!("条目 {} 的本地头在读取窗口之外", entry.name))?;
    if local.get(0..4) != Some(LOCAL_SIG.as_ref()) {
        return Err(format!("条目 {} 的本地头签名不正确（包可能已损坏）", entry.name));
    }
    let name_len = u16_at(local, 26).ok_or("本地头截断")? as usize;
    let extra_len = u16_at(local, 28).ok_or("本地头截断")? as usize;
    let start = entry
        .local_off
        .checked_add(30 + name_len + extra_len)
        .ok_or("本地头偏移溢出")?;
    let raw = win
        .get(start, entry.comp_size)
        .ok_or_else(|| format!("条目 {} 的数据在读取窗口之外", entry.name))?;
    match entry.method {
        0 => Ok(raw.to_vec()),
        8 => {
            use std::io::Read;
            let mut out = Vec::with_capacity(entry.uncomp_size);
            flate2::read::DeflateDecoder::new(raw)
                .read_to_end(&mut out)
                .map_err(|e| format!("条目 {} 解压失败：{e}", entry.name))?;
            Ok(out)
        }
        other => Err(format!(
            "条目 {} 使用压缩方法 {other}，本版本只支持 存储(0) / deflate(8)",
            entry.name
        )),
    }
}

// ---------------------------------------------------------------------------
// AXML：字符串池 + 元素节点
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum AttrValue {
    Str(String),
    Int(i64),
    Bool(bool),
    /// 资源引用（`@string/app_name` 之类），值为资源 id
    Ref(u32),
    Other(String),
}

#[derive(Clone, Debug)]
pub struct Attr {
    pub name: String,
    pub value: AttrValue,
}

#[derive(Clone, Debug)]
pub enum Node {
    Start { name: String, attrs: Vec<Attr> },
    End,
}

struct StringPool {
    utf8: bool,
    data: Vec<u8>,
    offsets: Vec<u32>,
}

impl StringPool {
    fn parse(chunk: &[u8]) -> Option<Self> {
        let header_size = u16_at(chunk, 2)? as usize;
        let count = u32_at(chunk, 8)? as usize;
        let flags = u32_at(chunk, 16)?;
        let strings_start = u32_at(chunk, 20)? as usize;
        if header_size < 28 || count > 1_000_000 {
            return None;
        }
        let offsets_bytes = chunk.get(header_size..header_size + count * 4)?;
        let offsets = (0..count)
            .map(|i| u32_at(offsets_bytes, i * 4))
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            utf8: flags & 0x100 != 0,
            data: chunk.get(strings_start..)?.to_vec(),
            offsets,
        })
    }

    fn get(&self, index: usize) -> Option<String> {
        let off = *self.offsets.get(index)? as usize;
        let at = self.data.get(off..)?;
        if self.utf8 {
            // UTF-8 池：先是字符数、再是字节数，都可能是 1 或 2 字节
            let (_chars, rest) = decode_utf8_len(at)?;
            let (bytes, rest) = decode_utf8_len(rest)?;
            let raw = rest.get(0..bytes)?;
            Some(String::from_utf8_lossy(raw).to_string())
        } else {
            let (chars, rest) = decode_utf16_len(at)?;
            let bytes = chars.checked_mul(2)?;
            let raw = rest.get(0..bytes)?;
            Some(decode_utf16(raw))
        }
    }

    fn len(&self) -> usize {
        self.offsets.len()
    }
}

/// UTF-8 字符串池的长度编码：1 或 2 字节，最高位在首字节上。
fn decode_utf8_len(data: &[u8]) -> Option<(usize, &[u8])> {
    let first = *data.first()?;
    if first & 0x80 == 0 {
        Some((first as usize, &data[1..]))
    } else {
        let second = *data.get(1)?;
        Some(((((first & 0x7F) as usize) << 8) | second as usize, &data[2..]))
    }
}

/// UTF-16 字符串池的长度编码：u16，最高位表示需要第二个 u16 补高位。
fn decode_utf16_len(data: &[u8]) -> Option<(usize, &[u8])> {
    let first = u16_at(data, 0)?;
    if first & 0x8000 == 0 {
        Some((first as usize, &data[2..]))
    } else {
        let second = u16_at(data, 2)?;
        Some((
            (((first & 0x7FFF) as usize) << 16) | second as usize,
            &data[4..],
        ))
    }
}

fn decode_utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

struct Axml {
    nodes: Vec<Node>,
}

fn parse_axml(data: &[u8]) -> Option<Axml> {
    if data.len() < 8 || u16_at(data, 0)? != 0x0003 {
        return None;
    }
    let mut pool: Option<StringPool> = None;
    let mut nodes = Vec::new();
    let mut pos = u16_at(data, 2)? as usize;
    while pos + 8 <= data.len() {
        let ty = u16_at(data, pos)?;
        let size = u32_at(data, pos + 4)? as usize;
        if size < 8 || pos + size > data.len() {
            break;
        }
        let chunk = &data[pos..pos + size];
        match ty {
            0x0001 => {
                if pool.is_none() {
                    pool = StringPool::parse(chunk);
                }
            }
            0x0102 => {
                // 起点元素
                let name_idx = u32_at(chunk, 20)?;
                let attr_start = u16_at(chunk, 24)? as usize;
                let attr_size = u16_at(chunk, 26)? as usize;
                let attr_count = u16_at(chunk, 28)? as usize;
                let Some(p) = pool.as_ref() else { break };
                let name = if name_idx == 0xFFFF_FFFF {
                    String::new()
                } else {
                    p.get(name_idx as usize).unwrap_or_default()
                };
                let mut attrs = Vec::with_capacity(attr_count);
                for i in 0..attr_count {
                    // attributeStart 是相对 attrExt（chunk + 16）的偏移
                    let off = 16 + attr_start + i * attr_size;
                    if attr_size < 20 {
                        break;
                    }
                    let Some(rec) = chunk.get(off..off + attr_size) else { break };
                    let attr_name_idx = u32_at(rec, 4)?;
                    let raw_idx = u32_at(rec, 8)?;
                    let data_type = *rec.get(15)?;
                    let value_data = u32_at(rec, 16)?;
                    let attr_name = if attr_name_idx == 0xFFFF_FFFF {
                        String::new()
                    } else {
                        p.get(attr_name_idx as usize).unwrap_or_default()
                    };
                    let value = if raw_idx != 0xFFFF_FFFF {
                        AttrValue::Str(p.get(raw_idx as usize).unwrap_or_default())
                    } else {
                        match data_type {
                            0x03 => AttrValue::Str(p.get(value_data as usize).unwrap_or_default()),
                            0x01 => AttrValue::Ref(value_data),
                            0x02 => AttrValue::Other(format!("#attr/0x{value_data:08X}")),
                            0x10 | 0x11 | 0x1c => AttrValue::Int(value_data as i32 as i64),
                            0x12 => AttrValue::Bool(value_data != 0),
                            0x00 => AttrValue::Other("null".into()),
                            other => AttrValue::Other(format!("type 0x{other:02X} 0x{value_data:08X}")),
                        }
                    };
                    attrs.push(Attr {
                        name: attr_name,
                        value,
                    });
                }
                nodes.push(Node::Start { name, attrs });
            }
            0x0103 => nodes.push(Node::End),
            _ => {}
        }
        // 8 字节头以外的 headerSize 可能大于 8（字符串池 28），按 size 前进
        pos += size;
    }
    let _pool = pool?;
    Some(Axml { nodes })
}

fn attr<'a>(attrs: &'a [Attr], name: &str) -> Option<&'a AttrValue> {
    attrs
        .iter()
        .find(|a| a.name == name || a.name.ends_with(&format!(":{name}")))
        .map(|a| &a.value)
}

fn attr_str(attrs: &[Attr], name: &str) -> Option<String> {
    match attr(attrs, name) {
        Some(AttrValue::Str(s)) if !s.is_empty() => Some(s.clone()),
        Some(AttrValue::Int(v)) => Some(v.to_string()),
        Some(AttrValue::Bool(b)) => Some(if *b { "true".into() } else { "false".into() }),
        _ => None,
    }
}

fn attr_int(attrs: &[Attr], name: &str) -> Option<i64> {
    match attr(attrs, name) {
        Some(AttrValue::Int(v)) => Some(*v),
        Some(AttrValue::Str(s)) => s.parse().ok(),
        _ => None,
    }
}

fn attr_bool(attrs: &[Attr], name: &str) -> Option<bool> {
    match attr(attrs, name) {
        Some(AttrValue::Bool(b)) => Some(*b),
        Some(AttrValue::Str(s)) if s == "true" || s == "false" => Some(s == "true"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// resources.arsc：资源 id → 字符串
// ---------------------------------------------------------------------------

/// 在 `resources.arsc` 里按资源 id 找字符串值（只认 default 配置里的简单条目）。
fn resolve_resource_string(arsc: &[u8], id: u32) -> Result<String, String> {
    if arsc.len() < 12 || u16_at(arsc, 0) != Some(0x0002) {
        return Err("resources.arsc 头部类型不正确".into());
    }
    let header_size = u16_at(arsc, 2).ok_or("arsc 截断")? as usize;
    let table_size = u32_at(arsc, 4).ok_or("arsc 截断")? as usize;
    if table_size > arsc.len() {
        return Err("resources.arsc 声明长度超出文件尾（已截断）".into());
    }
    // 全局字符串池：紧跟在表头之后
    let pool = StringPool::parse(arsc.get(header_size..).ok_or("arsc 缺少字符串池")?)
        .ok_or("arsc 全局字符串池解析失败")?;
    let target_pkg = (id >> 24) & 0xFF;
    let target_type = ((id >> 16) & 0xFF) as u8;
    let target_entry = (id & 0xFFFF) as usize;

    let mut pos = header_size;
    while pos + 8 <= table_size {
        let ty = u16_at(arsc, pos).ok_or("arsc 截断")?;
        let size = u32_at(arsc, pos + 4).ok_or("arsc 截断")? as usize;
        if size < 8 || pos + size > table_size {
            break;
        }
        if ty == 0x0200 {
            let pkg_id = u32_at(arsc, pos + 8).ok_or("arsc 包截断")?;
            let pkg_header = u16_at(arsc, pos + 2).ok_or("arsc 包截断")? as usize;
            if pkg_id & 0xFF == target_pkg {
                if let Some(v) = resolve_in_package(
                    arsc,
                    pos,
                    pkg_header,
                    pos + size,
                    target_type,
                    target_entry,
                    &pool,
                )? {
                    return Ok(v);
                }
            }
        }
        pos += size;
    }
    Err(format!("resources.arsc 里没有 0x{id:08X} 的字符串值"))
}

fn resolve_in_package(
    data: &[u8],
    pkg_start: usize,
    pkg_header: usize,
    pkg_end: usize,
    target_type: u8,
    target_entry: usize,
    pool: &StringPool,
) -> Result<Option<String>, String> {
    let mut pos = pkg_start + pkg_header;
    let mut fallback: Option<String> = None;
    while pos + 8 <= pkg_end {
        let ty = u16_at(data, pos).ok_or("arsc 包内截断")?;
        let header = u16_at(data, pos + 2).ok_or("arsc 包内截断")? as usize;
        let size = u32_at(data, pos + 4).ok_or("arsc 包内截断")? as usize;
        if size < 8 || pos + size > pkg_end {
            break;
        }
        if ty == 0x0201 {
            let type_id = *data.get(pos + 8).ok_or("arsc type 截断")?;
            if type_id != target_type {
                pos += size;
                continue;
            }
            let entry_count = u32_at(data, pos + 12).ok_or("arsc type 截断")? as usize;
            let entries_start = u32_at(data, pos + 16).ok_or("arsc type 截断")? as usize;
            let config_start = pos + 20;
            let config_size = u32_at(data, config_start).unwrap_or(0) as usize;
            let is_default = config_size >= 4
                && data
                    .get(config_start + 4..config_start + config_size.max(4))
                    .map(|b| b.iter().all(|&x| x == 0))
                    .unwrap_or(false);
            if target_entry < entry_count {
                let offsets_at = pos + header;
                if let Some(rel) = u32_at(data, offsets_at + target_entry * 4) {
                    if rel != 0xFFFF_FFFF {
                        let entry_off = pos + entries_start + rel as usize;
                        if let Some(value) = entry_string(data, entry_off, pool) {
                            if is_default {
                                return Ok(Some(value));
                            }
                            fallback.get_or_insert(value);
                        }
                    }
                }
            }
        }
        pos += size;
    }
    Ok(fallback)
}

fn entry_string(data: &[u8], entry_off: usize, pool: &StringPool) -> Option<String> {
    let size = u16_at(data, entry_off)? as usize;
    let flags = u16_at(data, entry_off + 2)?;
    if flags & 0x0001 != 0 {
        // 复杂条目（bag）：不做默认值推导
        return None;
    }
    let value_at = entry_off + 8;
    if size < 8 || value_at + 8 > data.len() {
        return None;
    }
    let data_type = *data.get(value_at + 3)?;
    let value = u32_at(data, value_at + 4)?;
    if data_type == 0x03 && (value as usize) < pool.len() {
        pool.get(value as usize)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

fn normalize_activity(package: Option<&str>, name: &str) -> String {
    match package {
        Some(pkg) if name.starts_with('.') => format!("{pkg}{name}"),
        Some(pkg) if !name.contains('.') => format!("{pkg}.{name}"),
        _ => name.to_string(),
    }
}

/// 只读探测。不是 APK（例如普通 ZIP、DOCX）时返回 `None`，不误判。
pub fn probe(head: &[u8], tail: &[u8], size: u64) -> Option<ApkProbe> {
    if !head.starts_with(LOCAL_SIG) && !head.starts_with(EOCD_SIG) {
        return None;
    }
    let win = Window::new(head, tail, size);
    let entries = zip_entries(&win)?;
    let manifest = entries.iter().find(|e| e.name == "AndroidManifest.xml")?;
    let mut warnings = Vec::new();
    let mut probe = ApkProbe {
        format: "Android 安装包 (APK)".into(),
        entry_count: entries.len(),
        sign_v1: entries.iter().any(|e| {
            let upper = e.name.to_ascii_uppercase();
            upper.starts_with("META-INF/")
                && [".RSA", ".DSA", ".EC", ".SF"].iter().any(|s| upper.ends_with(*s))
        }),
        sign_block: zip_signing_block(&win, &entries).is_some(),
        ..Default::default()
    };

    let raw = match read_entry(&win, manifest) {
        Ok(bytes) => bytes,
        Err(err) => {
            probe.warnings.push(err);
            return Some(probe);
        }
    };
    let Some(axml) = parse_axml(&raw) else {
        probe
            .warnings
            .push("AndroidManifest.xml 不是可解析的二进制 XML（可能被加密或已损坏）".into());
        return Some(probe);
    };

    let mut package: Option<String> = None;
    let mut activity: Option<String> = None;
    let mut has_main = false;
    let mut has_launcher = false;
    let mut launcher: Option<String> = None;
    let mut label_value: Option<AttrValue> = None;
    let mut label_resolved: Option<String> = None;
    let mut icon_value: Option<AttrValue> = None;

    for node in &axml.nodes {
        let Node::Start { name, attrs } = node else {
            continue;
        };
        match name.as_str() {
            "manifest" => {
                package = attr_str(attrs, "package");
                probe.version_name = attr_str(attrs, "versionName");
                probe.version_code = attr_int(attrs, "versionCode");
                probe.compile_sdk = attr_str(attrs, "compileSdkVersion");
            }
            "uses-sdk" => {
                probe.min_sdk = attr_str(attrs, "minSdkVersion");
                probe.target_sdk = attr_str(attrs, "targetSdkVersion");
            }
            "uses-permission" | "uses-permission-sdk-23" => {
                if let Some(perm) = attr_str(attrs, "name") {
                    if !probe.permissions.contains(&perm) {
                        probe.permissions.push(perm);
                    }
                }
            }
            "application" => {
                label_value = attr(attrs, "label").cloned();
                icon_value = attr(attrs, "icon").cloned();
                probe.debuggable = attr_bool(attrs, "debuggable");
                probe.allow_backup = attr_bool(attrs, "allowBackup");
            }
            "activity" | "activity-alias" => {
                activity = attr_str(attrs, "name");
                has_main = false;
                has_launcher = false;
            }
            "action" => {
                if activity.is_some() && attr_str(attrs, "name").as_deref() == Some("android.intent.action.MAIN")
                {
                    has_main = true;
                }
            }
            "category" => {
                if activity.is_some()
                    && attr_str(attrs, "name").as_deref() == Some("android.intent.category.LAUNCHER")
                {
                    has_launcher = true;
                }
            }
            _ => {}
        }
        if has_main && has_launcher && launcher.is_none() {
            if let Some(name) = &activity {
                launcher = Some(normalize_activity(package.as_deref(), name));
            }
        }
    }
    probe.package = package.clone();
    probe.main_activity = launcher;

    // 应用名称：字符串直接用，资源引用查 resources.arsc
    if let Some(value) = label_value {
        match value {
            AttrValue::Str(text) if !text.is_empty() => {
                // 以 @ 开头的是资源引用被存成字符串的少见情况
                if text.starts_with('@') {
                    warnings.push(format!("应用名称是资源引用 {text}，本版本未解析"));
                } else {
                    label_resolved = Some(text);
                }
            }
            AttrValue::Ref(id) => {
                let arsc = entries
                    .iter()
                    .find(|e| e.name == "resources.arsc")
                    .ok_or_else(|| "包里没有 resources.arsc".to_string())
                    .and_then(|e| read_entry(&win, e));
                match &arsc {
                    Ok(bytes) => match resolve_resource_string(bytes, id) {
                        Ok(text) => label_resolved = Some(text),
                        Err(err) => warnings.push(format!(
                            "应用名称的资源引用 0x{id:08X} 未解析成文字：{err}"
                        )),
                    },
                    Err(err) => warnings.push(format!(
                        "应用名称的资源引用 0x{id:08X} 需要 resources.arsc，{err}"
                    )),
                }
            }
            _ => {}
        }
    }
    probe.label = label_resolved;

    if let Some(value) = icon_value {
        match value {
            AttrValue::Str(text) if !text.is_empty() => probe.icon = Some(text),
            AttrValue::Ref(id) => probe.icon = Some(format!("资源 0x{id:08X}")),
            _ => {}
        }
    }
    probe.warnings.extend(warnings);
    Some(probe)
}

/// 中央目录前的 APK Signing Block（v2/v3）：以 16 字节魔数结尾。
fn zip_signing_block(win: &Window<'_>, entries: &[ZipEntry]) -> Option<usize> {
    let cd_min = entries.iter().map(|e| e.local_off).min()?;
    let eocd = find_eocd(win)?;
    let cd_off = u32_at(win.get(eocd, 22)?, 16)? as usize;
    if cd_off < 32 || cd_min > cd_off {
        return None;
    }
    let magic = win.get(cd_off - 16, 16)?;
    if magic == APK_SIG_BLOCK {
        Some(cd_off)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_length_prefix_one_byte() {
        let data = [0x05u8, 0x03, b'h', b'e', b'l', b'l', b'o', 0];
        let (chars, rest) = decode_utf8_len(&data).expect("长度字节");
        assert_eq!(chars, 5);
        let (bytes, rest) = decode_utf8_len(rest).expect("字节长度");
        assert_eq!(bytes, 3);
        assert_eq!(rest.get(0..3), Some(b"hel".as_ref()));
    }

    #[test]
    fn utf8_length_prefix_two_bytes() {
        let data = [0x80u8, 0x02, 0x40, 0x01];
        let (chars, rest) = decode_utf8_len(&data).expect("两字节长度");
        assert_eq!(chars, 2);
        let (bytes, _) = decode_utf8_len(rest).expect("字节长度");
        assert_eq!(bytes, 0x40);
    }

    #[test]
    fn utf16_length_prefix_with_high_bit() {
        // 首 u16 = 0x8001：最高位置位，真实长度 = (1 << 16) | 2
        let data = [0x01u8, 0x80, 0x02, 0x00, 0x02, 0x00];
        let (chars, rest) = decode_utf16_len(&data).expect("u16 长度");
        assert_eq!(chars, 65_538);
        let (bytes, _) = decode_utf16_len(rest).expect("u16 字节长度");
        assert_eq!(bytes, 2);
    }

    #[test]
    fn activity_relative_name_gets_package_prefix() {
        assert_eq!(
            normalize_activity(Some("com.example.app"), ".Main"),
            "com.example.app.Main"
        );
        assert_eq!(
            normalize_activity(Some("com.example.app"), "Main"),
            "com.example.app.Main"
        );
        assert_eq!(
            normalize_activity(Some("com.example.app"), "com.other.Main"),
            "com.other.Main"
        );
        assert_eq!(normalize_activity(None, ".Main"), ".Main");
    }
}
