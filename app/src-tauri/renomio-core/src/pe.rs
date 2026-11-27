//! Windows PE（EXE / DLL / SYS）只读解析：读 `.rsrc` 里的 `VS_VERSIONINFO`。
//!
//! 三条硬约束：**只读**（一个字节都不改）、**不猜**（读不到就写进 `warnings`，不填默认值）、
//! **不 panic**（所有越界、畸形结构都只记原因）。不做反汇编、不碰代码段、不校验证书。

/// `VS_FIXEDFILEINFO` 结构定长 52 字节。
const FIXED_LEN: usize = 52;
/// 资源类型 `RT_VERSION`。
const RT_VERSION: u32 = 16;
/// 递归解析版本块的最大层数（畸形文件可能套很深，防打爆栈）。
const MAX_DEPTH: usize = 8;

/// 版本资源里的一条字符串（`CompanyName` / `ProductName` 之类）。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct PeString {
    pub key: String,
    pub value: String,
}

/// PE 文件的只读解析结果。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeProbe {
    /// 展示用格式名：`PE 可执行文件（EXE）` / `PE 动态链接库（DLL）` / `PE 驱动（SYS）`
    pub format: String,
    /// 机器可读的类别：`exe` / `dll` / `driver`
    pub pe_kind: String,
    /// 32 / 64（PE32 / PE32+）
    pub bitness: Option<u32>,
    /// 目标架构：`x64` / `x86` / `ARM64` …
    pub machine: Option<String>,
    /// 子系统：`Windows GUI` / `Windows 控制台` …
    pub subsystem: Option<String>,
    /// 编译时间（`TimeDateStamp`，UTC）
    pub built: Option<String>,
    /// `VS_FIXEDFILEINFO` 里的文件版本，如 `1.2.0.27`
    pub file_version: Option<String>,
    /// `VS_FIXEDFILEINFO` 里的产品版本
    pub product_version: Option<String>,
    /// 字符串表的语言，如 `0x0409（en-US）`
    pub language: Option<String>,
    /// 选中语言表里的全部字符串（保持文件里的顺序）
    pub strings: Vec<PeString>,
    /// 读不到的部分逐条写原因，绝不静默补默认值
    pub warnings: Vec<String>,
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// 4 字节对齐（相对某个块的起点）。
fn align4(n: usize) -> usize {
    (n + 3) & !3
}

/// 一个节（`IMAGE_SECTION_HEADER`）。
#[derive(Clone, Copy, Debug)]
struct Section {
    va: u32,
    vsize: u32,
    raw_off: u32,
    raw_size: u32,
}

impl Section {
    /// RVA 落在这个节里时换算成文件偏移。
    fn offset_of(&self, rva: u32) -> Option<u64> {
        let span = self.vsize.max(self.raw_size);
        let delta = rva.checked_sub(self.va)?;
        if delta >= span || delta >= self.raw_size {
            return None;
        }
        Some(u64::from(self.raw_off) + u64::from(delta))
    }
}

/// 机器类型 → 架构名；不认识就原样报数值，不猜。
fn machine_name(code: u16) -> String {
    match code {
        0x014c => "x86".into(),
        0x8664 => "x64".into(),
        0x01c0 => "ARM".into(),
        0x01c2 => "Thumb".into(),
        0x01c4 => "ARMv7".into(),
        0xaa64 => "ARM64".into(),
        0x0200 => "IA64".into(),
        0x5032 => "RISC-V 32".into(),
        0x5064 => "RISC-V 64".into(),
        0x6232 => "LoongArch 32".into(),
        0x6264 => "LoongArch 64".into(),
        other => format!("未知（0x{other:04X}）"),
    }
}

fn subsystem_name(code: u16) -> String {
    match code {
        1 => "Native（驱动）".into(),
        2 => "Windows GUI".into(),
        3 => "Windows 控制台".into(),
        5 => "OS/2 控制台".into(),
        7 => "POSIX 控制台".into(),
        9 => "Windows CE GUI".into(),
        10 => "EFI 应用".into(),
        11 => "EFI 启动驱动".into(),
        12 => "EFI 运行时驱动".into(),
        14 => "Xbox".into(),
        16 => "Windows 启动应用".into(),
        other => format!("未知（{other}）"),
    }
}

/// 语言代码 → `0x0409（en-US）`；不在表里的只报四位十六进制。
fn language_label(lang: u16) -> String {
    let name = match lang {
        0x0409 => "en-US",
        0x0809 => "en-GB",
        0x0407 => "de-DE",
        0x040c => "fr-FR",
        0x0410 => "it-IT",
        0x0c0a => "es-ES",
        0x0416 => "pt-BR",
        0x0419 => "ru-RU",
        0x0411 => "ja-JP",
        0x0412 => "ko-KR",
        0x0804 => "zh-CN",
        0x0404 => "zh-TW",
        0x0405 => "cs-CZ",
        0x0415 => "pl-PL",
        0x041d => "sv-SE",
        0x040b => "fi-FI",
        0x0414 => "nb-NO",
        0x0413 => "nl-NL",
        0x0406 => "da-DK",
        0x040e => "hu-HU",
        0x041f => "tr-TR",
        0x0000 => "中性",
        other => return format!("0x{other:04X}"),
    };
    format!("0x{lang:04X}（{name}）")
}

/// 1970 起的天数 → (年, 月, 日)，Howard Hinnant 的 civil_from_days。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `TimeDateStamp`（秒）→ `2026-11-27 04:32:08 (UTC)`。
fn utc_datetime(secs: u32) -> String {
    if secs == 0 {
        return String::new();
    }
    let days = i64::from(secs) / 86_400;
    let rem = i64::from(secs) % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} (UTC)",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 一个 `VS_VERSIONINFO` 块的头部信息。
struct Block {
    /// 块总长度（文件里声明的）
    len: usize,
    /// 块的值长度（字符串块是字符数，根块是 52 字节）
    value_len: usize,
    /// `wType`：0 = 二进制，1 = 文本
    kind: u16,
    /// 块名（UTF-16LE 解出来的 ASCII，如 `StringFileInfo` / `CompanyName`）
    key: String,
    /// 值的起始位置
    value_start: usize,
}

/// 读一个版本块的头（越界只返回 `None`，由调用方决定要不要报警告）。
fn read_block(data: &[u8], base: usize) -> Option<Block> {
    let len = usize::from(u16_at(data, base)?);
    if len == 0 {
        return None;
    }
    let value_len = usize::from(u16_at(data, base + 2)?);
    let kind = u16_at(data, base + 4)?;

    // 块名：从 base+6 起是一串 UTF-16LE 字符，0x0000 结尾
    let mut key = String::new();
    let mut cursor = base + 6;
    loop {
        let unit = u16_at(data, cursor)?;
        cursor += 2;
        if unit == 0 {
            break;
        }
        if unit < 0x80 {
            key.push(char::from(unit as u8));
        } else {
            // 块名按规范只有 ASCII；出现非 ASCII 时按 UTF-16 解，保证不吞字节
            key.push(char::from_u32(u32::from(unit)).unwrap_or('?'));
        }
        // 防御：块名不可能比块本身还长
        if cursor > base + len {
            return None;
        }
    }
    let relative = cursor - base;
    let value_start = base + align4(relative);
    Some(Block {
        len,
        value_len,
        kind,
        key,
        value_start,
    })
}

/// 块内子块区间：值之后按 4 字节对齐，直到块尾。
fn children_range(block: &Block, base: usize, value_end: usize, data_len: usize) -> (usize, usize) {
    let start = base + align4(value_end - base);
    let end = (base + block.len).min(data_len);
    (start.min(end), end)
}

/// 把 `value_start` 起的 `chars` 个 UTF-16LE 字符解成字符串（遇到 0 截断）。
fn utf16_value(data: &[u8], value_start: usize, chars: usize) -> Option<String> {
    let mut out = String::new();
    for i in 0..chars {
        let unit = u16_at(data, value_start + i * 2)?;
        if unit == 0 {
            break;
        }
        out.push(char::from_u32(u32::from(unit)).unwrap_or('?'));
    }
    Some(out.trim().to_string())
}

/// 一张字符串表（语言 + 代码页 + 条目）。
struct StringTable {
    lang: u16,
    code_page: u16,
    entries: Vec<PeString>,
}

/// 递归收集：字符串表、固定版本信息、警告。
struct Collected {
    tables: Vec<StringTable>,
    fixed: Option<(u32, u32, u32, u32)>,
    warnings: Vec<String>,
}

fn walk(data: &[u8], base: usize, depth: usize, out: &mut Collected) {
    if depth > MAX_DEPTH {
        out.warnings.push(format!("版本块嵌套超过 {MAX_DEPTH} 层，已停止解析"));
        return;
    }
    let block = match read_block(data, base) {
        Some(b) => b,
        None => return,
    };
    let key = block.key.clone();

    // 根块：值是 52 字节的 VS_FIXEDFILEINFO
    if key == "VS_VERSION_INFO" {
        let value_end = block.value_start + FIXED_LEN;
        if block.value_start + FIXED_LEN <= data.len() {
            let sig = u32_at(data, block.value_start).unwrap_or(0);
            if sig == 0xFEEF_04BD {
                let fms = u32_at(data, block.value_start + 8).unwrap_or(0);
                let fls = u32_at(data, block.value_start + 12).unwrap_or(0);
                let pms = u32_at(data, block.value_start + 16).unwrap_or(0);
                let pls = u32_at(data, block.value_start + 20).unwrap_or(0);
                out.fixed = Some((fms, fls, pms, pls));
            } else {
                out.warnings.push(format!(
                    "VS_FIXEDFILEINFO 签名不是 0xFEEF04BD（读到 0x{sig:08X}），文件版本按缺省处理"
                ));
            }
        } else {
            out.warnings
                .push("VS_VERSION_INFO 的固定信息被截断（不足 52 字节），文件版本读不到".into());
        }
        let (start, end) = children_range(&block, base, value_end, data.len());
        walk_children(data, start, end, depth, out);
        return;
    }

    // 字符串表：块名是 8 位十六进制（语言 4 位 + 代码页 4 位）
    if key.len() == 8 && key.chars().all(|c| c.is_ascii_hexdigit()) {
        let lang = u16::from_str_radix(&key[..4], 16).unwrap_or(0);
        let code_page = u16::from_str_radix(&key[4..], 16).unwrap_or(0);
        let mut table = StringTable {
            lang,
            code_page,
            entries: Vec::new(),
        };
        collect_strings(data, &block, base, &mut table, &mut out.warnings);
        out.tables.push(table);
        return;
    }

    // 其余两种容器块：StringFileInfo / VarFileInfo
    let value_end = block.value_start;
    let (start, end) = children_range(&block, base, value_end, data.len());
    walk_children(data, start, end, depth, out);
}

fn walk_children(data: &[u8], start: usize, end: usize, depth: usize, out: &mut Collected) {
    let mut cursor = start;
    while cursor + 6 <= end {
        let len = usize::from(u16_at(data, cursor).unwrap_or(0));
        if len == 0 || cursor + len > end {
            break;
        }
        walk(data, cursor, depth + 1, out);
        cursor += align4(len);
    }
}

/// 一张字符串表里的 `String` 块：块名是键，值是 UTF-16 文本。
fn collect_strings(
    data: &[u8],
    table: &Block,
    base: usize,
    out_table: &mut StringTable,
    warnings: &mut Vec<String>,
) {
    let (start, end) = children_range(table, base, table.value_start, data.len());
    let mut cursor = start;
    while cursor + 6 <= end {
        let len = usize::from(u16_at(data, cursor).unwrap_or(0));
        if len == 0 || cursor + len > end {
            break;
        }
        if let Some(child) = read_block(data, cursor) {
            // 字符串块的 wValueLength 是字符数（wType = 1）
            let chars = if child.kind == 1 { child.value_len } else { 0 };
            match utf16_value(data, child.value_start, chars) {
                Some(value) if !value.is_empty() => out_table.entries.push(PeString {
                    key: child.key,
                    value,
                }),
                Some(_) => {}
                None => warnings.push(format!("字符串 {} 的值被截断，已跳过", child.key)),
            }
        }
        cursor += align4(len);
    }
}

/// 找 `.rsrc` 里 `RT_VERSION` 的第一个语言变体的数据。
fn version_blob(data: &[u8], rsrc_off: u64, sections: &[Section]) -> Result<(Vec<u8>, Option<String>), String> {
    let base = usize::try_from(rsrc_off).map_err(|_| "资源节偏移超出可寻址范围".to_string())?;
    if base >= data.len() {
        return Err("资源节偏移在文件之外（文件可能被截断）".into());
    }

    /// 读一个资源目录的条目表。
    fn entries(data: &[u8], dir: usize) -> Option<Vec<(u32, u32, bool)>> {
        let named = usize::from(u16_at(data, dir + 12)?);
        let ids = usize::from(u16_at(data, dir + 14)?);
        let count = named + ids;
        if count > 4096 {
            return None;
        }
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let off = dir + 16 + i * 8;
            let name = u32_at(data, off)?;
            let target = u32_at(data, off + 4)?;
            // 保留 `target` 的高位（= 是否指向子目录），偏移在各层自己清掉
            out.push((name & 0x7FFF_FFFF, target, (name & 0x8000_0000) != 0));
        }
        Some(out)
    }

    /// 目录项指向子目录还是数据项。
    fn is_dir(raw: u32) -> bool {
        (raw & 0x8000_0000) != 0
    }

    let root = entries(data, base).ok_or("资源目录根节点解析失败（结构截断）")?;
    let version_entry = root
        .iter()
        .find(|(id, _, named)| !named && *id == RT_VERSION)
        .ok_or("资源节里没有 RT_VERSION（该文件没有版本资源）")?;

    // 第二层：类型下是名称/ID（无名资源用 ID），取第一个
    if !is_dir(version_entry.1 & 0x8000_0000) {
        return Err("RT_VERSION 的资源目录项没有指向子目录".into());
    }
    let type_dir = base
        .checked_add((version_entry.1 & 0x7FFF_FFFF) as usize)
        .filter(|v| *v < data.len())
        .ok_or("RT_VERSION 子目录偏移越界")?;
    let type_entries = entries(data, type_dir).ok_or("RT_VERSION 子目录结构截断")?;
    let name_entry = type_entries.first().ok_or("RT_VERSION 子目录是空的")?;

    // 第三层：语言变体，取第一个
    let name_dir = base
        .checked_add((name_entry.1 & 0x7FFF_FFFF) as usize)
        .filter(|v| *v < data.len())
        .ok_or("版本资源名称子目录偏移越界")?;
    let lang_entries = entries(data, name_dir).ok_or("版本资源名称子目录结构截断")?;
    let lang_entry = lang_entries.first().ok_or("版本资源没有语言变体")?;

    // 第四层：数据项（16 字节：RVA / Size / CodePage / Reserved）
    let data_entry = base
        .checked_add((lang_entry.1 & 0x7FFF_FFFF) as usize)
        .filter(|v| *v + 16 <= data.len())
        .ok_or("版本资源数据项偏移越界")?;
    let rva = u32_at(data, data_entry).ok_or("版本资源数据项 RVA 读取失败")?;
    let size = usize::try_from(u32_at(data, data_entry + 4).ok_or("版本资源数据项长度读取失败")?)
        .map_err(|_| "版本资源长度超出可寻址范围".to_string())?;

    let file_off = sections
        .iter()
        .find_map(|s| s.offset_of(rva))
        .ok_or("版本资源 RVA 不在任何节里（资源被压缩或文件被截断）")?;
    let start = usize::try_from(file_off).map_err(|_| "版本资源偏移超出范围".to_string())?;
    if start >= data.len() {
        return Err("版本资源数据在文件之外（文件被截断）".into());
    }
    let declared_end = start.saturating_add(size);
    let end = declared_end.min(data.len());
    let warning = if declared_end > data.len() {
        Some(format!(
            "版本资源声明 {} 字节，但文件从该偏移起只剩 {} 字节，按实际内容解析",
            size,
            data.len() - start
        ))
    } else {
        None
    };
    Ok((data[start..end].to_vec(), warning))
}

/// 解析 PE 头 + 版本资源；不是 PE 就返回 `None`。
pub fn probe(data: &[u8]) -> Option<PeProbe> {
    if data.len() < 0x40 || !data.starts_with(b"MZ") {
        return None;
    }
    let e_lfanew = usize::try_from(u32_at(data, 0x3C)?).ok()?;
    if e_lfanew + 24 > data.len() || data.get(e_lfanew..e_lfanew + 4) != Some(b"PE\0\0".as_ref()) {
        return None;
    }

    let machine = u16_at(data, e_lfanew + 4)?;
    let section_count = usize::from(u16_at(data, e_lfanew + 6)?);
    let stamp = u32_at(data, e_lfanew + 8)?;
    let opt_size = usize::from(u16_at(data, e_lfanew + 20)?);
    let characteristics = u16_at(data, e_lfanew + 22)?;
    let opt = e_lfanew + 24;
    let magic = u16_at(data, opt)?;
    let (bitness, rva_count_off, dirs_off) = match magic {
        0x10B => (32u32, 92usize, 96usize),
        0x20B => (64u32, 108usize, 112usize),
        _ => {
            // ROM 映像 / 未知 optional header：不冒充 PE32/PE32+
            return None;
        }
    };

    let subsystem = u16_at(data, opt + 68).map(subsystem_name).filter(|s| !s.is_empty());
    let dll = (characteristics & 0x2000) != 0;
    let is_driver = subsystem.as_deref() == Some("Native（驱动）");
    let (pe_kind, format) = if is_driver {
        ("driver", "PE 驱动（SYS）".to_string())
    } else if dll {
        ("dll", "PE 动态链接库（DLL）".to_string())
    } else {
        ("exe", "PE 可执行文件（EXE）".to_string())
    };

    let mut probe = PeProbe {
        format,
        pe_kind: pe_kind.into(),
        bitness: Some(bitness),
        machine: Some(machine_name(machine)),
        subsystem,
        built: Some(utc_datetime(stamp)).filter(|s| !s.is_empty()),
        ..Default::default()
    };

    // 节表：紧跟在 optional header 之后
    let table = opt + opt_size;
    let mut sections = Vec::with_capacity(section_count);
    for i in 0..section_count {
        let at = table + i * 40;
        if at + 40 > data.len() {
            probe.warnings.push(format!(
                "节表第 {} 项越界（文件可能被截断），只解析已读到的节",
                i + 1
            ));
            break;
        }
        sections.push(Section {
            vsize: u32_at(data, at + 8).unwrap_or(0),
            va: u32_at(data, at + 12).unwrap_or(0),
            raw_size: u32_at(data, at + 16).unwrap_or(0),
            raw_off: u32_at(data, at + 20).unwrap_or(0),
        });
    }
    if sections.is_empty() {
        probe.warnings.push("没有读到任何节表，无法定位资源节".into());
        return Some(probe);
    }

    // 数据目录第 3 项（下标 2）是资源目录
    let rva_count = u32_at(data, opt + rva_count_off).unwrap_or(0);
    if rva_count <= 2 {
        probe
            .warnings
            .push("数据目录项不足 3 个，没有资源目录（该文件没有版本资源）".into());
        return Some(probe);
    }
    let ridx = opt + dirs_off + 2 * 8;
    let rsrc_rva = match u32_at(data, ridx) {
        Some(v) => v,
        None => {
            probe.warnings.push("资源目录项被截断，读不到 RVA".into());
            return Some(probe);
        }
    };
    if rsrc_rva == 0 {
        probe
            .warnings
            .push("资源目录 RVA 为 0（该文件没有版本资源）".into());
        return Some(probe);
    }
    let rsrc_off = match sections.iter().find_map(|s| s.offset_of(rsrc_rva)) {
        Some(off) => off,
        None => {
            probe.warnings.push(format!(
                "资源目录 RVA 0x{rsrc_rva:X} 不在任何节里，资源节可能被压缩或文件被截断"
            ));
            return Some(probe);
        }
    };

    let blob = match version_blob(data, rsrc_off, &sections) {
        Ok((b, warning)) => {
            if let Some(warning) = warning {
                probe.warnings.push(warning);
            }
            b
        }
        Err(reason) => {
            probe.warnings.push(reason);
            return Some(probe);
        }
    };

    let mut out = Collected {
        tables: Vec::new(),
        fixed: None,
        warnings: Vec::new(),
    };
    walk(&blob, 0, 0, &mut out);
    probe.warnings.extend(out.warnings);

    if let Some((fms, fls, pms, pls)) = out.fixed {
        probe.file_version = Some(format!(
            "{}.{}.{}.{}",
            fms >> 16,
            fms & 0xFFFF,
            fls >> 16,
            fls & 0xFFFF
        ));
        probe.product_version = Some(format!(
            "{}.{}.{}.{}",
            pms >> 16,
            pms & 0xFFFF,
            pls >> 16,
            pls & 0xFFFF
        ));
    }

    // 语言表优先级：en-US → 任意第一次出现的表（值若是纯数字的语言码也不猜）
    if let Some(table) = out
        .tables
        .iter()
        .find(|t| t.lang == 0x0409)
        .or_else(|| out.tables.first())
    {
        probe.language = Some(language_label(table.lang));
        probe.strings = table.entries.clone();
        let other = out.tables.len() - 1;
        if other > 0 {
            probe.warnings.push(format!(
                "版本资源有 {} 张语言表，只展示 {}（其余语言的字符串不混入）",
                out.tables.len(),
                language_label(table.lang)
            ));
        }
    } else if out.fixed.is_none() {
        probe
            .warnings
            .push("版本资源里没有任何字符串表".into());
    }

    Some(probe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_pe_and_truncated() {
        assert!(probe(b"").is_none());
        assert!(probe(b"not a pe file at all").is_none());
        // MZ 但 PE 签名位置越界
        let mut mz = vec![0u8; 0x40];
        mz[0] = b'M';
        mz[1] = b'Z';
        mz[0x3C..0x40].copy_from_slice(&0x2000u32.to_le_bytes());
        assert!(probe(&mz).is_none());
        // MZ + 偏移落在文件内但没有 PE\0\0
        let mut mz2 = vec![0u8; 0x80];
        mz2[0] = b'M';
        mz2[1] = b'Z';
        mz2[0x3C..0x40].copy_from_slice(&0x40u32.to_le_bytes());
        assert!(probe(&mz2).is_none());
    }

    #[test]
    fn date_and_language_helpers() {
        assert_eq!(utc_datetime(0), "");
        assert_eq!(utc_datetime(1_795_000_000), "2026-11-18 11:06:40 (UTC)");
        assert_eq!(language_label(0x0409), "0x0409（en-US）");
        assert_eq!(language_label(0x1234), "0x1234");
    }

    #[test]
    fn machine_and_subsystem_names() {
        assert_eq!(machine_name(0x8664), "x64");
        assert_eq!(machine_name(0x014c), "x86");
        assert_eq!(machine_name(0xAA64), "ARM64");
        assert_eq!(machine_name(0x1234), "未知（0x1234）");
        assert_eq!(subsystem_name(2), "Windows GUI");
        assert_eq!(subsystem_name(3), "Windows 控制台");
        assert_eq!(subsystem_name(99), "未知（99）");
    }
}
