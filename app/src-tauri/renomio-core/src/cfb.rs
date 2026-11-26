//! OLE 复合文档（CFB / OLE2）只读解析：认类型、取流、解属性集。
//!
//! 为什么需要它：`.doc/.xls/.ppt/.msg/.msi` 的文件头是**同一个**签名
//! `D0 CF 11 E0 A1 B1 1A E1`，只按文件头判断会把安装包、Outlook 邮件、加密的 Office 包
//! 一律报成「旧版 Office 文档」，属性面板又只说「解析尚未实现」。本轮把三件事做实：
//!
//! 1. 按根存储 CLSID 与目录里的流名认出到底是 Word / Excel / PowerPoint / Visio /
//!    Publisher / Outlook 邮件 / Windows 安装包 / 加密的 OOXML；
//! 2. 文档类读出 `\x05SummaryInformation` 与 `\x05DocumentSummaryInformation`；
//! 3. 读不了的容器**明确拒绝并给原因**，不再含糊其辞、也不再假装那是 Word 文档。
//!
//! 只读：本模块不写任何文件，也不改任何字节。

const SIG: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const FREESECT: u32 = 0xFFFF_FFFF;
const ENDOFCHAIN: u32 = 0xFFFF_FFFE;
const NOSTREAM: u32 = 0xFFFF_FFFF;

/// 属性面板上认出的容器类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CfbKind {
    Word,
    Excel,
    PowerPoint,
    Visio,
    Publisher,
    OutlookMsg,
    Msi,
    EncryptedOoxml,
    Unknown,
}

impl CfbKind {
    pub fn label(self) -> &'static str {
        match self {
            CfbKind::Word => "旧版 Word 文档（.doc，OLE 复合文档）",
            CfbKind::Excel => "旧版 Excel 工作簿（.xls，OLE 复合文档）",
            CfbKind::PowerPoint => "旧版 PowerPoint 演示文稿（.ppt，OLE 复合文档）",
            CfbKind::Visio => "Visio 绘图（.vsd，OLE 复合文档）",
            CfbKind::Publisher => "Publisher 出版物（.pub，OLE 复合文档）",
            CfbKind::OutlookMsg => "Outlook 邮件（.msg，OLE 复合文档）",
            CfbKind::Msi => "Windows 安装包（.msi，OLE 复合文档）",
            CfbKind::EncryptedOoxml => "加密的 Office 文件（OLE 容器）",
            CfbKind::Unknown => "未识别的 OLE 复合文档",
        }
    }

    /// 沿用界面既有的四类：image / audio / document / other。
    pub fn metadata_kind(self) -> &'static str {
        match self {
            CfbKind::Msi | CfbKind::OutlookMsg | CfbKind::EncryptedOoxml | CfbKind::Unknown => {
                "other"
            }
            _ => "document",
        }
    }

    /// 能读属性就返回 None；读不了必须给出**具体**原因（不能用「尚未实现」搪塞）。
    pub fn refusal_reason(self) -> Option<&'static str> {
        Some(match self {
            CfbKind::Msi => "这是 Windows 安装包（MSI）：外层的复合文档只是打包容器，里面没有文档属性；属性面板只显示文件大小，也不会尝试修改它",
            CfbKind::OutlookMsg => "这是 Outlook 邮件（.msg）：内容在邮件的消息流里，不在文档摘要流；本轮只认类型，不解析邮件正文",
            CfbKind::EncryptedOoxml => "这是加密的 Office 文件：容器里是 EncryptedPackage，需要密码才能解开，这里不尝试读取",
            CfbKind::Unknown => "结构是 OLE 复合文档，但没有已知的文档流名（WordDocument / Workbook / PowerPoint Document），不做猜测",
            _ => return None,
        })
    }

    /// 文档类容器才有摘要流可读。
    pub fn reads_summary(self) -> bool {
        matches!(
            self,
            CfbKind::Word
                | CfbKind::Excel
                | CfbKind::PowerPoint
                | CfbKind::Visio
                | CfbKind::Publisher
        )
    }
}

#[derive(Clone, Debug)]
struct Entry {
    name: String,
    kind: u8,
    clsid: [u8; 16],
    start: u32,
    size: u64,
}

/// 解析好的复合文档。`data` 是整份文件字节（元数据读取时本来就整份读入）。
pub struct CompoundFile<'a> {
    data: &'a [u8],
    major: u16,
    sector: usize,
    mini: usize,
    header_len: usize,
    mini_cutoff: usize,
    fat: Vec<u32>,
    minifat: Vec<u32>,
    entries: Vec<Entry>,
    mini_stream: Vec<u8>,
}

impl<'a> CompoundFile<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self, String> {
        if data.len() < 512 {
            return Err(format!(
                "长度不足 512 字节（只有 {} 字节），不可能是 OLE 复合文档",
                data.len()
            ));
        }
        if data.get(..8) != Some(SIG.as_ref()) {
            return Err("文件头不是 OLE 复合文档签名".into());
        }
        let major = u16_at(data, 26).ok_or("头部缺少主版本号")?;
        let sector_shift = u16_at(data, 30).ok_or("头部缺少扇区大小")?;
        let mini_shift = u16_at(data, 32).ok_or("头部缺少小扇区大小")?;
        let sector = 1usize
            .checked_shl(sector_shift as u32)
            .ok_or("扇区大小字段异常")?;
        let mini = 1usize
            .checked_shl(mini_shift as u32)
            .ok_or("小扇区大小字段异常")?;
        if sector != 512 && sector != 4096 {
            return Err(format!("扇区大小 {sector} 既不是 512 也不是 4096"));
        }
        if mini != 64 {
            return Err(format!("小扇区大小 {mini} 不是 64"));
        }
        if major != 3 && major != 4 {
            return Err(format!("主版本号 {major} 不受支持（只认 3 / 4）"));
        }
        let header_len = if sector == 512 { 512 } else { sector };
        let num_fat = u32_at(data, 44).ok_or("头部缺少 FAT 扇区数")?;
        let first_dir = u32_at(data, 48).ok_or("头部缺少目录起始扇区")?;
        let mini_cutoff = u32_at(data, 56).unwrap_or(4096) as usize;
        let first_minifat = u32_at(data, 60).unwrap_or(ENDOFCHAIN);
        let num_minifat = u32_at(data, 64).unwrap_or(0);
        let first_difat = u32_at(data, 68).unwrap_or(ENDOFCHAIN);
        let num_difat = u32_at(data, 72).unwrap_or(0);

        let mut fat_sectors: Vec<u32> = Vec::new();
        for i in 0..109usize {
            if let Some(v) = u32_at(data, 76 + i * 4) {
                if v != FREESECT && v != ENDOFCHAIN {
                    fat_sectors.push(v);
                }
            }
        }
        let mut next = first_difat;
        let mut guard = 0usize;
        while next != ENDOFCHAIN && next != FREESECT {
            if guard > num_difat as usize + 8 {
                return Err("DIFAT 链过长（疑似损坏）".into());
            }
            let sec = sector_at(data, header_len, sector, next)
                .ok_or_else(|| format!("DIFAT 扇区 {next} 越界"))?;
            let per = sector / 4 - 1;
            for i in 0..per {
                if let Some(v) = u32_at(sec, i * 4) {
                    if v != FREESECT && v != ENDOFCHAIN {
                        fat_sectors.push(v);
                    }
                }
            }
            next = u32_at(sec, per * 4).unwrap_or(ENDOFCHAIN);
            guard += 1;
        }
        if fat_sectors.len() < num_fat as usize {
            return Err(format!(
                "FAT 宣告 {} 个扇区，实际只找到 {} 个",
                num_fat,
                fat_sectors.len()
            ));
        }
        fat_sectors.truncate(num_fat as usize);

        let mut fat: Vec<u32> = Vec::new();
        for sid in &fat_sectors {
            let sec = sector_at(data, header_len, sector, *sid)
                .ok_or_else(|| format!("FAT 扇区 {sid} 越界"))?;
            for i in 0..sector / 4 {
                fat.push(u32_at(sec, i * 4).unwrap_or(FREESECT));
            }
        }

        let dir_bytes = read_fat_chain(data, header_len, sector, &fat, first_dir, None)?;
        let entries = parse_entries(&dir_bytes, major);
        if entries.is_empty() {
            return Err("目录区为空（没有根存储）".into());
        }

        let minifat = if num_minifat > 0 && first_minifat != ENDOFCHAIN {
            let bytes = read_fat_chain(
                data,
                header_len,
                sector,
                &fat,
                first_minifat,
                Some(num_minifat as usize * sector),
            )?;
            let mut out = Vec::with_capacity(bytes.len() / 4);
            for i in 0..bytes.len() / 4 {
                out.push(u32_at(&bytes, i * 4).unwrap_or(FREESECT));
            }
            out
        } else {
            Vec::new()
        };

        let root = &entries[0];
        let mini_stream = if root.size > 0 && root.start != ENDOFCHAIN {
            read_fat_chain(
                data,
                header_len,
                sector,
                &fat,
                root.start,
                Some(root.size as usize),
            )?
        } else {
            Vec::new()
        };

        Ok(Self {
            data,
            major,
            sector,
            mini,
            header_len,
            mini_cutoff,
            fat,
            minifat,
            entries,
            mini_stream,
        })
    }

    pub fn streams(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|e| e.kind == 2)
            .map(|e| e.name.clone())
            .collect()
    }

    fn find(&self, name: &str) -> Option<&Entry> {
        let want = name.to_ascii_lowercase();
        self.entries.iter().find(|e| {
            e.kind == 2 && strip_prefix_control(&e.name).to_ascii_lowercase() == want
        })
    }

    /// 取指定名字的流（名字大小写不敏感；目录名前面的 `\x05` 控制字符会被忽略）。
    pub fn stream(&self, name: &str) -> Option<Vec<u8>> {
        let entry = self.find(name)?;
        if entry.size == 0 {
            return Some(Vec::new());
        }
        if entry.size as usize >= self.mini_cutoff {
            read_fat_chain(
                self.data,
                self.header_len,
                self.sector,
                &self.fat,
                entry.start,
                Some(entry.size as usize),
            )
            .ok()
        } else {
            self.read_mini_chain(entry.start, entry.size as usize).ok()
        }
    }

    fn read_mini_chain(&self, start: u32, size: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(size);
        let mut cur = start;
        let mut seen = std::collections::HashSet::new();
        while cur != ENDOFCHAIN && cur != FREESECT && out.len() < size {
            if !seen.insert(cur) {
                return Err("小扇区链出现环".into());
            }
            let off = cur as usize * self.mini;
            let chunk = self
                .mini_stream
                .get(off..off + self.mini)
                .ok_or_else(|| format!("小扇区 {cur} 越出迷你流"))?;
            let need = (size - out.len()).min(self.mini);
            out.extend_from_slice(&chunk[..need]);
            cur = self
                .minifat
                .get(cur as usize)
                .copied()
                .unwrap_or(ENDOFCHAIN);
        }
        if out.len() != size {
            return Err(format!(
                "小扇区链不完整（要 {size} 字节，只读到 {}）",
                out.len()
            ));
        }
        Ok(out)
    }

    pub fn kind(&self) -> CfbKind {
        let names: Vec<String> = self
            .streams()
            .into_iter()
            .map(|n| strip_prefix_control(&n).to_ascii_lowercase())
            .collect();
        let has = |target: &str| names.iter().any(|n| n == target);
        let any_prefix = |p: &str| names.iter().any(|n| n.starts_with(p));

        let root_clsid = clsid_hex(&self.entries[0].clsid);
        match root_clsid.as_str() {
            "00020906-0000-0000-c000-000000000046" | "00020900-0000-0000-c000-000000000046" => {
                return CfbKind::Word
            }
            "00020820-0000-0000-c000-000000000046" | "00020810-0000-0000-c000-000000000046" => {
                return CfbKind::Excel
            }
            "64818d10-4f9b-11cf-86ea-00aa00b929e8" | "64818d11-4f9b-11cf-86ea-00aa00b929e8" => {
                return CfbKind::PowerPoint
            }
            "00021a14-0000-0000-c000-000000000046" => return CfbKind::Visio,
            "00021201-0000-0000-c000-000000000046" => return CfbKind::Publisher,
            "000c1084-0000-0000-c000-000000000046" => return CfbKind::Msi,
            "00020d0b-0000-0000-c000-000000000046" => return CfbKind::OutlookMsg,
            _ => {}
        }
        if has("encryptedpackage") || has("encryptioninfo") {
            return CfbKind::EncryptedOoxml;
        }
        if has("worddocument") {
            return CfbKind::Word;
        }
        if has("workbook") || has("book") {
            return CfbKind::Excel;
        }
        if has("powerpoint document") {
            return CfbKind::PowerPoint;
        }
        if has("visiodocument") {
            return CfbKind::Visio;
        }
        if any_prefix("__substg1.0") {
            return CfbKind::OutlookMsg;
        }
        if has("_tables") || has("_stringpool") || has("_stringdata") {
            return CfbKind::Msi;
        }
        CfbKind::Unknown
    }
}

fn strip_prefix_control(name: &str) -> &str {
    name.trim_start_matches(|c: char| (c as u32) < 0x20)
}

// ---------------------------------------------------------------------------
// 属性集（Property Set）
// ---------------------------------------------------------------------------

/// 摘要流里的一项属性。只保留本应用用得上的四类标量。
#[derive(Clone, Debug, PartialEq)]
pub enum PropValue {
    Int(i32),
    Text(String),
    /// Unix 毫秒（来自 VT_FILETIME）
    Time(i64),
    Bool(bool),
    Unsupported(u16),
}

#[derive(Default)]
pub struct PropSet {
    pub values: Vec<(u32, PropValue)>,
}

impl PropSet {
    pub fn int(&self, id: u32) -> Option<i32> {
        self.values.iter().find_map(|(k, v)| match v {
            PropValue::Int(n) if *k == id => Some(*n),
            _ => None,
        })
    }

    pub fn text(&self, id: u32) -> Option<&str> {
        self.values.iter().find_map(|(k, v)| match v {
            PropValue::Text(s) if *k == id && !s.trim().is_empty() => Some(s.as_str()),
            _ => None,
        })
    }

    pub fn time(&self, id: u32) -> Option<i64> {
        self.values.iter().find_map(|(k, v)| match v {
            PropValue::Time(t) if *k == id => Some(*t),
            _ => None,
        })
    }
}

enum Raw {
    Int(i32),
    Bool(bool),
    Time(i64),
    Bytes(Vec<u8>),
    Wide(String),
    Other(u16),
}

pub fn read_property_set(bytes: &[u8]) -> Result<PropSet, String> {
    if bytes.len() < 48 {
        return Err(format!("属性集流太短（{} 字节）", bytes.len()));
    }
    let order = u16_at(bytes, 0).ok_or("属性集缺少字节序标记")?;
    if order != 0xFFFE {
        return Err(format!("属性集字节序标记异常（0x{order:04X}）"));
    }
    let count = u32_at(bytes, 24).unwrap_or(0);
    if count == 0 {
        return Ok(PropSet::default());
    }
    let offset = u32_at(bytes, 44).ok_or("属性集缺少第一个扇区位置")? as usize;
    let section = bytes
        .get(offset..)
        .ok_or_else(|| format!("属性扇区偏移 {offset} 越界"))?;
    let props = u32_at(section, 4).ok_or("属性扇区缺少条目数")? as usize;
    if props > 1024 {
        return Err(format!("属性条目数异常（{props}）"));
    }
    let mut raw: Vec<(u32, Raw)> = Vec::new();
    for i in 0..props {
        let id = match u32_at(section, 8 + i * 8) {
            Some(v) => v,
            None => break,
        };
        let voff = match u32_at(section, 12 + i * 8) {
            Some(v) => v as usize,
            None => break,
        };
        if let Ok(value) = read_value(section, voff) {
            raw.push((id, value));
        }
    }
    // 码页在 id=1 里，先在原始字节里找到它，再据此解码所有窄字符串。
    let codepage = raw
        .iter()
        .find_map(|(k, v)| match v {
            Raw::Int(n) if *k == 1 => Some(*n as u16),
            _ => None,
        })
        .unwrap_or(1252);
    let values = raw
        .into_iter()
        .map(|(id, value)| {
            let value = match value {
                Raw::Int(n) => PropValue::Int(n),
                Raw::Bool(b) => PropValue::Bool(b),
                Raw::Time(t) => PropValue::Time(t),
                Raw::Bytes(b) => PropValue::Text(decode_cp(&b, codepage)),
                Raw::Wide(s) => PropValue::Text(s),
                Raw::Other(vt) => PropValue::Unsupported(vt),
            };
            (id, value)
        })
        .collect();
    Ok(PropSet { values })
}

fn read_value(section: &[u8], off: usize) -> Result<Raw, String> {
    let vt = u16_at(section, off).ok_or("值类型缺失")?;
    let p = off + 4;
    match vt {
        2 | 18 => Ok(Raw::Int(
            u16_at(section, p).ok_or("VT_I2 数据缺失")? as i32
        )),
        3 | 19 | 20 | 22 | 23 => Ok(Raw::Int(
            u32_at(section, p).ok_or("VT_I4 数据缺失")? as i32
        )),
        11 => Ok(Raw::Bool(u16_at(section, p).ok_or("VT_BOOL 数据缺失")? != 0)),
        30 => {
            let n = u32_at(section, p).ok_or("VT_LPSTR 长度缺失")? as usize;
            let raw = section
                .get(p + 4..p + 4 + n)
                .ok_or("VT_LPSTR 数据越界")?;
            Ok(Raw::Bytes(trim_nul(raw).to_vec()))
        }
        31 => {
            let n = u32_at(section, p).ok_or("VT_LPWSTR 长度缺失")? as usize;
            let raw = section
                .get(p + 4..p + 4 + n * 2)
                .ok_or("VT_LPWSTR 数据越界")?;
            Ok(Raw::Wide(decode_utf16(raw)))
        }
        64 => {
            let lo = u32_at(section, p).ok_or("VT_FILETIME 低 32 位缺失")? as u64;
            let hi = u32_at(section, p + 4).ok_or("VT_FILETIME 高 32 位缺失")? as u64;
            Ok(Raw::Time(filetime_to_unix_ms((hi << 32) | lo)))
        }
        other => Ok(Raw::Other(other)),
    }
}

fn trim_nul(bytes: &[u8]) -> &[u8] {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    &bytes[..end]
}

fn decode_utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|u| *u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// 窄字符串按码页解码：优先用 `encoding_rs` 的内置码表，认不出的码页按 latin-1 兜底
/// （至少不丢字符），绝不把字节静默当 UTF-8。
fn decode_cp(bytes: &[u8], cp: u16) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    match cp {
        0 | 65001 => return String::from_utf8_lossy(trim_nul(bytes)).into_owned(),
        1200 => return decode_utf16(bytes),
        _ => {}
    }
    let label = match cp {
        932 => "shift_jis".to_string(),
        936 => "gbk".to_string(),
        949 => "euc-kr".to_string(),
        950 => "big5".to_string(),
        874 => "windows-874".to_string(),
        10000 => "macintosh".to_string(),
        1250..=1258 => format!("windows-{cp}"),
        _ => String::new(),
    };
    if !label.is_empty() {
        if let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            let (text, _, _) = enc.decode(bytes);
            return text.into_owned();
        }
    }
    bytes.iter().map(|b| *b as char).collect()
}

/// FILETIME（1601-01-01 起的 100ns）→ Unix 毫秒。
pub fn filetime_to_unix_ms(ft: u64) -> i64 {
    if ft == 0 {
        return 0;
    }
    let ticks = ft as i128;
    let ms = ticks / 10_000 - 11_644_473_600_000i128;
    if ms <= 0 {
        0
    } else if ms > i64::MAX as i128 {
        i64::MAX
    } else {
        ms as i64
    }
}

/// Unix 毫秒 → `YYYY-MM-DD HH:MM`（UTC；本应用不猜本地时区，标签里会写明 UTC）。
pub fn utc_text_from_unix_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms / 1000;
    let days = secs.div_euclid(86_400);
    let today = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        today / 3600,
        (today % 3600) / 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
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

// ---------------------------------------------------------------------------
// 底层读写
// ---------------------------------------------------------------------------

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn u32_at(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn sector_at(data: &[u8], header_len: usize, sector: usize, id: u32) -> Option<&[u8]> {
    if id == FREESECT || id == ENDOFCHAIN {
        return None;
    }
    let off = header_len.checked_add(id as usize * sector)?;
    data.get(off..off + sector)
}

fn read_fat_chain(
    data: &[u8],
    header_len: usize,
    sector: usize,
    fat: &[u32],
    start: u32,
    limit: Option<usize>,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut cur = start;
    let mut seen: Vec<u32> = Vec::new();
    while cur != ENDOFCHAIN && cur != FREESECT {
        if seen.contains(&cur) {
            return Err("扇区链出现环（文件已损坏）".into());
        }
        seen.push(cur);
        if seen.len() > data.len() / sector + 8 {
            return Err("扇区链过长（文件已损坏）".into());
        }
        let sec = sector_at(data, header_len, sector, cur)
            .ok_or_else(|| format!("扇区 {cur} 越出文件"))?;
        match limit {
            Some(n) => {
                let need = (n - out.len()).min(sector);
                out.extend_from_slice(&sec[..need]);
                if out.len() >= n {
                    break;
                }
            }
            None => out.extend_from_slice(sec),
        }
        cur = fat.get(cur as usize).copied().unwrap_or(ENDOFCHAIN);
    }
    if let Some(n) = limit {
        if out.len() < n {
            return Err(format!("扇区链不完整（要 {n} 字节，只读到 {}）", out.len()));
        }
    }
    Ok(out)
}

fn parse_entries(dir: &[u8], major: u16) -> Vec<Entry> {
    let mut out = Vec::new();
    for chunk in dir.chunks_exact(128) {
        let kind = chunk[66];
        if kind == 0 {
            continue;
        }
        let name_len = u16_at(chunk, 64).unwrap_or(0) as usize;
        let name = if name_len >= 2 && name_len <= 64 {
            let units: Vec<u16> = chunk[..name_len - 2]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::new()
        };
        let mut clsid = [0u8; 16];
        clsid.copy_from_slice(&chunk[80..96]);
        let start = u32_at(chunk, 116).unwrap_or(ENDOFCHAIN);
        let size = if major >= 4 {
            let lo = u32_at(chunk, 120).unwrap_or(0) as u64;
            let hi = u32_at(chunk, 124).unwrap_or(0) as u64;
            (hi << 32) | lo
        } else {
            u32_at(chunk, 120).unwrap_or(0) as u64
        };
        out.push(Entry {
            name,
            kind,
            clsid,
            start,
            size,
        });
    }
    // 根存储必须排在最前
    if let Some(pos) = out.iter().position(|e| e.kind == 5) {
        if pos > 0 {
            out.swap(0, pos);
        }
    }
    out
}

fn clsid_hex(b: &[u8; 16]) -> String {
    let d1 = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    let d2 = u16::from_le_bytes([b[4], b[5]]);
    let d3 = u16::from_le_bytes([b[6], b[7]]);
    let mut tail = String::with_capacity(16);
    for byte in &b[8..] {
        tail.push_str(&format!("{byte:02x}"));
    }
    format!(
        "{d1:08x}-{d2:04x}-{d3:04x}-{}-{}",
        &tail[..4],
        &tail[4..]
    )
}

#[allow(dead_code)]
const _NOSTREAM: u32 = NOSTREAM;
