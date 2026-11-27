//! HEIC / HEIF 只读解析（alpha25）。
//!
//! 此前 HEIC/HEIF 是**明确拒绝**：`detect()` 给一句「需要 HEVC 解码与专用容器写入库」，
//! 属性面板只有文件大小。而 iPhone 拍的照片、截图、实况照片全是这个容器，
//! 里面真实写着：主图尺寸、位深、色度采样、alpha 平面、旋转，以及完整的 EXIF
//! （拍摄时间、相机、镜头）。这里把 ISOBMFF 里这些**已经存在**的信息读出来，
//! 只读不写，读不到就说明原因，不编造默认值。
//!
//! 与 `image_container.rs` 的 AVIF 分支的分工：AVIF 品牌走那边，HEVC 品牌走这里，
//! 两边都只认自己那族品牌，不会互相抢格式。

/// HEIC / HEIF 解析结果。字段标签与 `metadata.rs` 的中文标签口径一致。
#[derive(Clone, Debug)]
pub struct HeifProbe {
    pub format: &'static str,
    pub fields: Vec<(&'static str, String)>,
    /// Exif 项的 TIFF 字节（已定位到 `II*\0` / `MM\0*` 头）；交给 `metadata.rs` 的 EXIF 解析器。
    pub exif_tiff: Option<Vec<u8>>,
    /// 图像序列（`msf1` / `hevc` 品牌）的帧数；静帧为 None。
    pub frames: Option<u32>,
    pub warnings: Vec<String>,
}

impl HeifProbe {
    fn new(format: &'static str) -> Self {
        Self {
            format,
            fields: Vec::new(),
            exif_tiff: None,
            frames: None,
            warnings: Vec::new(),
        }
    }

    fn push(&mut self, label: &'static str, value: impl Into<String>) {
        let value = value.into();
        let value = value.trim().to_string();
        if value.is_empty() || self.fields.iter().any(|f| f.0 == label) {
            return;
        }
        self.fields.push((label, value));
    }

    fn warn(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        if !self.warnings.iter().any(|w| w == &msg) {
            self.warnings.push(msg);
        }
    }
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_be_bytes([s[0], s[1]]))
}

fn be_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn be_u64(b: &[u8], off: usize) -> Option<u64> {
    let s = b.get(off..off + 8)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(s);
    Some(u64::from_be_bytes(buf))
}

/// 按 `size`（0/4/8 字节）读一个无符号数；其它长度（2 这类非标准写法）按读不出处理。
fn read_n(b: &[u8], off: usize, n: usize) -> Option<u64> {
    match n {
        0 => Some(0),
        4 => be_u32(b, off).map(u64::from),
        8 => be_u64(b, off),
        _ => None,
    }
}

/// 一个 ISOBMFF 盒子：类型 + 盒体在父缓冲里的区间。
#[derive(Clone, Debug)]
struct BoxNode {
    typ: [u8; 4],
    body_start: usize,
    body_end: usize,
    truncated: bool,
}

fn walk_boxes(data: &[u8], from: usize, to: usize) -> Vec<BoxNode> {
    let limit = to.min(data.len());
    let mut out = Vec::new();
    let mut pos = from;
    while pos + 8 <= limit {
        let Some(size32) = be_u32(data, pos) else {
            break;
        };
        let mut typ = [0u8; 4];
        typ.copy_from_slice(&data[pos + 4..pos + 8]);
        let (body_start, body_end, truncated, next) = if size32 == 0 {
            (pos + 8, limit, false, limit)
        } else if size32 == 1 {
            let Some(large) = be_u64(data, pos + 8) else {
                break;
            };
            let large = large as usize;
            let body_start = pos + 16;
            if large == 0 {
                (body_start, limit, false, limit)
            } else {
                let declared = pos.saturating_add(large);
                (
                    body_start,
                    declared.min(limit),
                    declared > limit,
                    declared.max(pos + 8),
                )
            }
        } else {
            let size = size32 as usize;
            let declared = pos.saturating_add(size);
            (
                pos + 8,
                declared.min(limit),
                declared > limit,
                declared.max(pos + 8),
            )
        };
        if body_start > limit {
            break;
        }
        out.push(BoxNode {
            typ,
            body_start,
            body_end: body_end.max(body_start),
            truncated,
        });
        if next <= pos {
            break;
        }
        pos = next;
    }
    out
}

fn body<'a>(data: &'a [u8], node: &BoxNode) -> &'a [u8] {
    data.get(node.body_start..node.body_end).unwrap_or(&[])
}

fn fourcc(data: &[u8], off: usize) -> Option<String> {
    let s = data.get(off..off + 4)?;
    std::str::from_utf8(s).ok().map(|s| s.trim().to_string())
}

const HEVC_BRANDS: [&str; 8] = [
    "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs",
];
const GENERIC_BRANDS: [&str; 3] = ["mif1", "mif2", "msf1"];

/// 认 HEIC/HEIF：主品牌或兼容品牌里有 HEVC 那族品牌；纯 `mif1` 这类通用品牌也认，
/// 但会标明「未指明编码」。AVIF 品牌（avif / avis）留给 `image_container.rs`。
fn heif_brand(data: &[u8]) -> Option<(String, Vec<String>, bool)> {
    // `ftyp` 的兼容品牌必须按声明长度截断，否则会把后面 `meta`/`mdat` 的字节当品牌读
    let size = be_u32(data, 0)? as usize;
    let end = if size >= 8 { size.min(data.len()) } else { data.len() };
    let body = data.get(8..end)?;
    let major = body.get(0..4).and_then(|b| std::str::from_utf8(b).ok())?.trim().to_string();
    let compat: Vec<String> = body
        .get(8..)
        .unwrap_or(&[])
        .chunks_exact(4)
        .take(16)
        .filter_map(|c| std::str::from_utf8(c).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if major.is_empty() {
        return None;
    }
    if major == "avif" || major == "avis" || compat.iter().any(|c| c == "avif" || c == "avis") {
        return None;
    }
    let has_hevc = HEVC_BRANDS.contains(&major.as_str())
        || compat.iter().any(|c| HEVC_BRANDS.contains(&c.as_str()));
    let generic = GENERIC_BRANDS.contains(&major.as_str())
        || compat.iter().any(|c| GENERIC_BRANDS.contains(&c.as_str()));
    if has_hevc {
        Some((major, compat, true))
    } else if generic {
        Some((major, compat, false))
    } else {
        None
    }
}

/// `ipco` 里的一个属性盒。
#[derive(Clone, Debug)]
enum Property {
    Ispe(u32, u32),
    Pixi(u8, u8),
    HvcC { chroma: u8, bits: u8 },
    AuxC { alpha: bool },
    Irot(u8),
    Unknown,
}

#[derive(Default, Debug)]
struct Scan {
    major: String,
    compat: Vec<String>,
    pixi: Option<(u8, u8)>,
    hvc: Option<(u8, u8)>, // chroma, bits
    alpha: bool,
    rotation: Option<u8>,
    primary: Option<u32>,
    items: Vec<(u32, String)>,
    iloc: Vec<(u32, u16, Vec<(u64, u64)>)>,
    props: Vec<Property>,
    assoc: Vec<(u32, Vec<u16>)>,
    frames: Option<u32>,
    truncated_at: Option<usize>,
}

fn property_of(data: &[u8], node: &BoxNode) -> Property {
    match &node.typ {
        b"ispe" => {
            let b = body(data, node);
            if b.len() >= 12 {
                if let (Some(w), Some(h)) = (be_u32(b, 4), be_u32(b, 8)) {
                    if w > 0 && h > 0 {
                        return Property::Ispe(w, h);
                    }
                }
            }
            Property::Unknown
        }
        b"pixi" => {
            let b = body(data, node);
            if b.len() >= 6 && b[4] > 0 && b[5] > 0 {
                return Property::Pixi(b[4], b[5]);
            }
            Property::Unknown
        }
        b"hvcC" => {
            // HEVCDecoderConfigurationRecord：chromaFormat 在 +16、bitDepthLumaMinus8 在 +17
            let b = body(data, node);
            if b.len() >= 18 {
                let chroma = b[16] & 0x03;
                let bits = (b[17] & 0x07) + 8;
                return Property::HvcC { chroma, bits };
            }
            Property::Unknown
        }
        b"auxC" => {
            // alpha 平面两种写法：AVIF 用 ...:auxiliary:alpha，HEVC 族用 ...:auxid:1
            let b = body(data, node);
            Property::AuxC {
                alpha: b.windows(5).any(|w| w == b"alpha") || b.windows(6).any(|w| w == b"auxid:"),
            }
        }
        b"irot" => {
            let b = body(data, node);
            Property::Irot(b.get(4).copied().unwrap_or(0) & 0x03)
        }
        b"av1C" => Property::Unknown,
        _ => Property::Unknown,
    }
}

fn parse_iinf(b: &[u8], scan: &mut Scan) {
    let version = b.first().copied().unwrap_or(0);
    let start = if version == 0 { 6 } else { 8 };
    // 条目是嵌套的 infe 盒；项数与盒数不一致（老式写法）时按盒数算
    let entries = walk_boxes(b, start, b.len());
    for node in entries.iter() {
        if &node.typ != b"infe" {
            continue;
        }
        let eb = body(b, node);
        let ver = eb.first().copied().unwrap_or(0);
        let (id, type_off) = if ver >= 3 {
            (be_u32(eb, 4).unwrap_or(0), 10usize)
        } else if ver == 2 {
            (be_u16(eb, 4).unwrap_or(0) as u32, 8usize)
        } else {
            (be_u16(eb, 4).unwrap_or(0) as u32, 0usize)
        };
        let item_type = if type_off > 0 {
            fourcc(eb, type_off).unwrap_or_default()
        } else {
            String::new()
        };
        if id > 0 {
            scan.items.push((id, item_type));
        }
    }
}

fn parse_iloc(b: &[u8], scan: &mut Scan, truncated: bool, offset: usize) {
    let version = b.first().copied().unwrap_or(0);
    let Some(sizes) = b.get(4).copied() else {
        return;
    };
    let offset_size = ((sizes >> 4) & 0x0F) as usize;
    let length_size = (sizes & 0x0F) as usize;
    let sizes2 = b.get(5).copied().unwrap_or(0);
    let base_offset_size = ((sizes2 >> 4) & 0x0F) as usize;
    let index_size = if version >= 1 { (sizes2 & 0x0F) as usize } else { 0 };
    let mut pos = 6usize;
    let count = if version < 2 {
        let Some(n) = be_u16(b, pos) else { return };
        pos += 2;
        n as usize
    } else {
        let Some(n) = be_u32(b, pos) else { return };
        pos += 4;
        n as usize
    };
    for _ in 0..count.min(1024) {
        let (id, id_step) = if version < 2 {
            (be_u16(b, pos).unwrap_or(0) as u32, 2)
        } else {
            (be_u32(b, pos).unwrap_or(0), 4)
        };
        pos += id_step;
        if id == 0 {
            return;
        }
        let method = if version >= 1 {
            let m = be_u16(b, pos).unwrap_or(0) & 0x0F;
            pos += 2;
            m
        } else {
            0
        };
        pos += 2; // data_reference_index
        let Some(base) = read_n(b, pos, base_offset_size) else { return };
        pos += base_offset_size;
        let Some(extent_count) = be_u16(b, pos) else { return };
        pos += 2;
        let mut extents = Vec::new();
        for _ in 0..extent_count.min(256) {
            if version >= 1 && index_size > 0 {
                if read_n(b, pos, index_size).is_none() {
                    break;
                }
                pos += index_size;
            }
            let (Some(off), Some(len)) = (
                read_n(b, pos, offset_size),
                read_n(b, pos + offset_size, length_size),
            ) else {
                break;
            };
            pos += offset_size + length_size;
            extents.push((base.saturating_add(off), len));
        }
        scan.iloc.push((id, method, extents));
    }
    if truncated {
        scan.truncated_at.get_or_insert(offset);
    }
}

fn parse_ipma(b: &[u8], scan: &mut Scan) {
    let flags = b.get(3).copied().unwrap_or(0);
    let Some(count) = be_u32(b, 4) else { return };
    let mut pos = 8usize;
    let wide = flags & 0x01 == 0x01;
    for _ in 0..count.min(4096) {
        let Some(item) = be_u16(b, pos) else { return };
        pos += 2;
        let Some(n) = b.get(pos).copied() else { return };
        pos += 1;
        let mut props = Vec::new();
        for _ in 0..n {
            if wide {
                let Some(idx) = be_u16(b, pos) else { return };
                pos += 2;
                props.push(idx & 0x7FFF);
            } else {
                let Some(idx) = b.get(pos).copied() else { return };
                pos += 1;
                props.push((idx & 0x7F) as u16);
            }
        }
        scan.assoc.push((item as u32, props));
    }
}

fn props_for(scan: &Scan, item: u32) -> Vec<&Property> {
    let mut out = Vec::new();
    for (id, idxs) in &scan.assoc {
        if *id != item {
            continue;
        }
        for idx in idxs {
            if let Some(p) = scan.props.get((*idx as usize).saturating_sub(1)) {
                out.push(p);
            }
        }
    }
    out
}

/// 把 item 的 extent 拼成一段连续字节；只支持「文件内偏移」寻址（construction_method 0）。
fn read_item(data: &[u8], scan: &Scan, item: u32) -> Option<(Vec<u8>, bool)> {
    let (_, method, extents) = scan.iloc.iter().find(|(id, _, _)| *id == item)?;
    if *method != 0 {
        return None;
    }
    let mut buf = Vec::new();
    let mut truncated = false;
    for (off, len) in extents {
        let start = *off as usize;
        let end = start.saturating_add(*len as usize);
        match data.get(start..end) {
            Some(slice) => buf.extend_from_slice(slice),
            None => {
                if let Some(partial) = data.get(start..) {
                    buf.extend_from_slice(partial);
                }
                truncated = true;
                break;
            }
        }
    }
    if buf.is_empty() {
        None
    } else {
        Some((buf, truncated))
    }
}

/// 在 Exif 项里定位 TIFF 头：规范写「4 字节偏移 + Exif\0\0 + TIFF」，但各家写法不一致
/// （偏移基准有按项起点、也有按 `Exif\0\0` 之后），所以按「真的能找到 `II*\0` / `MM\0*`」为准。
fn locate_tiff(buf: &[u8]) -> Option<usize> {
    let scan_len = buf.len().min(96);
    let mut pos = 0usize;
    while pos + 4 <= scan_len {
        if &buf[pos..pos + 2] == b"II" && &buf[pos + 2..pos + 4] == [0x2A, 0x00] {
            return Some(pos);
        }
        if &buf[pos..pos + 2] == b"MM" && &buf[pos + 2..pos + 4] == [0x00, 0x2A] {
            return Some(pos);
        }
        pos += 1;
    }
    None
}

fn chroma_text(chroma: u8) -> &'static str {
    match chroma {
        0 => "单色（4:0:0）",
        1 => "4:2:0",
        2 => "4:2:2",
        _ => "4:4:4",
    }
}

pub fn probe(data: &[u8]) -> Option<HeifProbe> {
    if data.len() < 16 || data.get(4..8)? != b"ftyp" {
        return None;
    }
    let (major, compat, has_hevc_brand) = heif_brand(data)?;
    let format = if has_hevc_brand {
        if major == "hevc" || major == "hevx" || major == "hevm" || major == "hevs" {
            "HEIC 图像（序列）"
        } else {
            "HEIC 图像"
        }
    } else {
        "HEIF 图像"
    };
    let mut p = HeifProbe::new(format);
    let mut scan = Scan {
        major: major.clone(),
        compat: compat.clone(),
        ..Default::default()
    };

    let top = walk_boxes(data, 0, data.len());
    let mut has_meta = false;
    for node in &top {
        if node.truncated {
            scan.truncated_at.get_or_insert(node.body_start.saturating_sub(8));
        }
        if &node.typ != b"meta" {
            continue;
        }
        has_meta = true;
        let meta = body(data, node);
        // meta 是 FullBox：version/flags 4 字节之后再是子盒
        let children = walk_boxes(meta, 4, meta.len());
        for child in &children {
            let cb = body(meta, child);
            match &child.typ {
                b"pitm" => {
                    let ver = cb.first().copied().unwrap_or(0);
                    scan.primary = if ver == 0 {
                        be_u16(cb, 4).map(u32::from)
                    } else {
                        be_u32(cb, 4)
                    };
                }
                b"iinf" => parse_iinf(cb, &mut scan),
                b"iloc" => {
                    let truncated = child.truncated;
                    parse_iloc(cb, &mut scan, truncated, child.body_start);
                }
                b"iprp" => {
                    let iprp = walk_boxes(cb, 0, cb.len());
                    for sub in &iprp {
                        let sb = body(cb, sub);
                        match &sub.typ {
                            b"ipco" => {
                                for prop in walk_boxes(sb, 0, sb.len()) {
                                    scan.props.push(property_of(sb, &prop));
                                }
                            }
                            b"ipma" => parse_ipma(sb, &mut scan),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // moov/stbl/stsz：HEIF 图像序列（msf1）的帧数
    for node in &top {
        if &node.typ == b"moov" {
            collect_stsz(body(data, node), &mut scan, 0);
        }
    }

    if !has_meta {
        p.warn("HEIC/HEIF 文件没有 meta 盒，容器参数与 EXIF 均读不到（可能被截断或不是标准编码器产物）");
    }

    // 尺寸：优先「与主图关联的 ispe」，退到任意 ispe
    let primary = scan.primary;
    let mut dims: Option<(u32, u32)> = None;
    if let Some(id) = primary {
        dims = props_for(&scan, id).into_iter().find_map(|prop| match prop {
            Property::Ispe(w, h) => Some((*w, *h)),
            _ => None,
        });
    }
    if dims.is_none() {
        dims = scan.props.iter().find_map(|prop| match prop {
            Property::Ispe(w, h) => Some((*w, *h)),
            _ => None,
        });
    }
    match dims {
        Some((w, h)) => p.push("尺寸", format!("{w} × {h} px")),
        None => p.warn("HEIC/HEIF 未找到 ispe 尺寸盒，尺寸未知（非标准结构或文件被截断）"),
    }

    let compat_text = scan.compat.join(" / ");
    if compat_text.is_empty() {
        p.push("品牌", scan.major.clone());
    } else {
        p.push("品牌", format!("{}（兼容 {}）", scan.major, compat_text));
    }

    // 位深 / 通道：主图的 pixi 优先，其次 hvcC 的编码参数
    let (pixi, hvc) = if let Some(id) = primary {
        let props = props_for(&scan, id);
        let pixi = props.iter().find_map(|prop| match prop {
            Property::Pixi(c, b) => Some((*c, *b)),
            _ => None,
        });
        let hvc = props.iter().find_map(|prop| match prop {
            Property::HvcC { chroma, bits } => Some((*chroma, *bits)),
            _ => None,
        });
        (pixi.or(scan.pixi), hvc.or(scan.hvc))
    } else {
        (scan.pixi, scan.hvc)
    };

    if has_hevc_brand {
        p.push("编码", if hvc.is_some() || scan.props.iter().any(|x| matches!(x, Property::HvcC { .. })) {
            "HEVC（H.265）"
        } else {
            "HEVC（未找到 hvcC 参数）"
        });
    } else {
        p.push("编码", "未指明（品牌只标了通用 HEIF）");
    }

    match pixi {
        Some((channels, bits)) => {
            p.push("位深", format!("{bits} bit"));
            p.push("通道", format!("{channels} 通道"));
        }
        None => {}
    }
    if let Some((chroma, bits)) = hvc {
        p.push("色度采样", chroma_text(chroma));
        if pixi.is_none() {
            p.push("位深", format!("{bits} bit"));
        }
    } else if pixi.is_none() {
        p.warn("未找到 pixi / hvcC，位深与色度采样未知");
    }

    // 旋转：`irot` 是「与主图关联的属性」，值 ×90°
    if let Some(id) = primary {
        scan.rotation = props_for(&scan, id).iter().find_map(|prop| match prop {
            Property::Irot(a) => Some(*a),
            _ => None,
        });
    }
    if scan.rotation.is_none() {
        scan.rotation = scan.props.iter().find_map(|prop| match prop {
            Property::Irot(a) => Some(*a),
            _ => None,
        });
    }

    let alpha = scan.alpha
        || if let Some(id) = primary {
            props_for(&scan, id)
                .iter()
                .any(|prop| matches!(prop, Property::AuxC { alpha: true }))
        } else {
            false
        };
    p.push("Alpha", if alpha { "有（辅助 alpha 平面）" } else { "无" });

    if let Some(rot) = scan.rotation {
        if rot != 0 {
            p.push("旋转", format!("{}°", rot as u32 * 90));
        }
    }

    if let Some(id) = primary {
        p.push("主图项", format!("#{id}"));
    }
    if !scan.items.is_empty() {
        p.push("项数", scan.items.len().to_string());
    }

    p.frames = scan.frames;
    match scan.frames {
        Some(n) if n > 1 => {
            p.push("帧数", n.to_string());
            p.push("动画", "是");
        }
        Some(_) => p.push("动画", "否"),
        None => {}
    }

    // Exif 项：item_type == "Exif"，按 iloc 取字节，定位 TIFF 头后交给调用方
    if let Some((id, _)) = scan
        .items
        .iter()
        .find(|(_, t)| t.eq_ignore_ascii_case("Exif"))
        .map(|(id, t)| (*id, t.clone()))
    {
        match read_item(data, &scan, id) {
            Some((buf, truncated)) => {
                if truncated {
                    p.warn("Exif 项的字节超出已读取范围，EXIF 可能不完整");
                }
                match locate_tiff(&buf) {
                    Some(pos) => p.exif_tiff = Some(buf[pos..].to_vec()),
                    None => p.warn("找到 Exif 项，但里面没有可识别的 TIFF 头（可能是压缩或私有格式）"),
                }
            }
            None => p.warn("找到 Exif 项，但读不到它的数据区（寻址方式不是文件内偏移）"),
        }
    } else {
        p.warn("容器里没有 Exif 项（截图或已剥离元数据的 HEIC 常见）");
    }

    if let Some(at) = scan.truncated_at {
        p.warn(format!("HEIC/HEIF 盒子结构在偏移 {at} 处被截断，部分字段可能缺失"));
    }

    Some(p)
}

fn collect_stsz(data: &[u8], scan: &mut Scan, depth: usize) {
    if depth > 12 {
        return;
    }
    for node in walk_boxes(data, 0, data.len()) {
        let b = body(data, &node);
        match &node.typ {
            b"stsz" => {
                if scan.frames.is_none() && b.len() >= 12 {
                    scan.frames = be_u32(b, 8);
                }
            }
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" => collect_stsz(b, scan, depth + 1),
            _ => {}
        }
    }
}
