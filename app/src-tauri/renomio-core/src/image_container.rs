//! GIF / BMP / AVIF 三种图片容器的只读解析。
//!
//! 这三个格式此前的差别很大：GIF / BMP 只给出「尺寸」一行，AVIF 连识别都没有
//! （落到「未识别的文件类型」）。这里把容器里真实存在的信息读出来——
//! GIF 的帧数与循环、BMP 的位深/压缩/DPI/调色板、AVIF 的 ISOBMFF 结构与位深，
//! 并且**读不到就明说读不到**，不编造默认值。
//!
//! 全部逻辑只依赖字节切片，不写文件、不重编码、不依赖第三方解码器。

/// 单个容器解析结果。字段标签与 `metadata.rs` 的中文标签口径一致。
#[derive(Clone, Debug)]
pub struct ImageProbe {
    pub format: &'static str,
    pub fields: Vec<(&'static str, String)>,
    /// 动画总时长（毫秒）；仅 GIF 的逐帧延时之和有值。
    pub duration_ms: Option<u64>,
    pub warnings: Vec<String>,
}

impl ImageProbe {
    fn new(format: &'static str) -> Self {
        Self {
            format,
            fields: Vec::new(),
            duration_ms: None,
            warnings: Vec::new(),
        }
    }

    fn push(&mut self, label: &'static str, value: impl Into<String>) {
        let value = value.into();
        let value = value.trim().to_string();
        if value.is_empty() {
            return;
        }
        if self.fields.iter().any(|f| f.0 == label) {
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

fn le_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off + 2)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

fn le_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// 四种容器的入口：认不出返回 `None`，交给调用方的其他分支。
pub fn probe(data: &[u8]) -> Option<ImageProbe> {
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some(gif(data));
    }
    if data.starts_with(b"BM") {
        return Some(bmp(data));
    }
    if data.get(4..8) == Some(b"ftyp".as_ref()) {
        if let Some(brand) = avif_brand(data) {
            return Some(avif(data, brand));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/// 跳过 `pos` 起的一串子块（`长度字节 + 内容`，0x00 结束），返回结束后的位置。
fn skip_sub_blocks(data: &[u8], mut pos: usize) -> usize {
    while pos < data.len() {
        let len = data[pos] as usize;
        pos += 1;
        if len == 0 {
            break;
        }
        pos = pos.saturating_add(len);
    }
    pos
}

/// 收集 `pos` 起一串子块的文本内容（注释、应用扩展的正文）。
fn collect_sub_blocks(data: &[u8], mut pos: usize) -> (String, usize) {
    let mut text = String::new();
    while pos < data.len() {
        let len = data[pos] as usize;
        pos += 1;
        if len == 0 {
            break;
        }
        let end = pos.saturating_add(len).min(data.len());
        if let Some(chunk) = data.get(pos..end) {
            text.push_str(&String::from_utf8_lossy(chunk));
        }
        pos = pos.saturating_add(len);
    }
    (text, pos)
}

fn gif(data: &[u8]) -> ImageProbe {
    let mut p = ImageProbe::new("GIF 图像");
    p.push(
        "版本",
        if data.starts_with(b"GIF89a") {
            "GIF89a"
        } else {
            "GIF87a"
        },
    );

    let width = le_u16(data, 6).unwrap_or(0);
    let height = le_u16(data, 8).unwrap_or(0);
    if width > 0 && height > 0 {
        p.push("尺寸", format!("{width} × {height} px"));
    } else {
        p.warn("GIF 逻辑屏幕描述符不完整，尺寸未知");
    }

    let packed = data.get(10).copied().unwrap_or(0);
    let has_gct = packed & 0x80 != 0;
    let mut pos = 13usize;
    if has_gct {
        let colors = 1usize << ((packed & 0x07) + 1);
        p.push("全局调色板", format!("{colors} 色"));
        pos += 3 * colors;
    } else {
        p.push("全局调色板", "无");
    }

    let mut frames = 0u32;
    let mut delay_cs = 0u64;
    let mut loop_label: Option<String> = None;
    let mut comment: Option<String> = None;
    let mut saw_trailer = false;

    while pos < data.len() {
        match data[pos] {
            0x21 => {
                // 扩展块：0x21 + 标签 + 子块
                let Some(label) = data.get(pos + 1).copied() else {
                    p.warn(format!("GIF 在偏移 {pos} 处的扩展块被截断"));
                    break;
                };
                let body = pos + 2;
                match label {
                    0xF9 => {
                        // 图形控制扩展：子块长度 0x04，packed 在 +1，延时在 +2（单位 1/100 秒）
                        if data.get(body).copied() == Some(4) {
                            if let Some(delay) = le_u16(data, body + 2) {
                                delay_cs += delay as u64;
                            }
                        }
                        pos = skip_sub_blocks(data, body);
                    }
                    0xFE => {
                        let (text, next) = collect_sub_blocks(data, body);
                        if comment.is_none() && !text.trim().is_empty() {
                            comment = Some(text.trim().to_string());
                        }
                        pos = next;
                    }
                    0xFF => {
                        // 应用扩展：首个子块是标识（如 "NETSCAPE2.0"，旧编码会把 3 字节认证码
                        // 塞进同一个子块）；循环信息在后面的 0x03 0x01 <lo> <hi> 子块里。
                        let mut q = body;
                        let mut id = String::new();
                        if q < data.len() {
                            let len = data[q] as usize;
                            q += 1;
                            let end = q.saturating_add(len).min(data.len());
                            if let Some(chunk) = data.get(q..end) {
                                id.push_str(&String::from_utf8_lossy(chunk));
                            }
                            q = q.saturating_add(len);
                        }
                        while q < data.len() {
                            let len = data[q] as usize;
                            q += 1;
                            if len == 0 {
                                break;
                            }
                            if id.starts_with("NETSCAPE2.0") && len >= 3 && data[q] == 0x01 {
                                let loops = le_u16(data, q + 1).unwrap_or(0);
                                loop_label = Some(if loops == 0 {
                                    "无限".to_string()
                                } else {
                                    format!("{loops} 次")
                                });
                            }
                            q = q.saturating_add(len);
                        }
                        pos = q;
                    }
                    _ => {
                        pos = skip_sub_blocks(data, body);
                    }
                }
            }
            0x2C => {
                // 图像描述符：左/上/宽/高各 2 字节，再 1 字节 packed
                let Some(desc) = data.get(pos + 1..pos + 10) else {
                    p.warn(format!("GIF 在偏移 {pos} 处的图像描述符被截断"));
                    break;
                };
                let _ = desc;
                frames += 1;
                let packed_local = data[pos + 9];
                let mut q = pos + 10;
                if packed_local & 0x80 != 0 {
                    // 局部调色板：3 × 2^(n+1)
                    q += 3 * (1usize << ((packed_local & 0x07) + 1));
                }
                q += 1; // LZW 最小码长
                pos = skip_sub_blocks(data, q);
            }
            0x3B => {
                saw_trailer = true;
                break;
            }
            other => {
                p.warn(format!("GIF 在偏移 {pos} 处遇到未知块标记 0x{other:02X}，停止解析"));
                break;
            }
        }
    }

    if !saw_trailer {
        p.warn("GIF 未读到文件结束标记（0x3B，可能被截断）");
    }
    p.push("帧数", frames.max(1).to_string());
    p.push("动画", if frames > 1 { "是" } else { "否" });
    if let Some(loops) = loop_label {
        p.push("循环", loops);
    }
    if let Some(c) = comment {
        p.push("注释", c);
    }
    if frames > 1 && delay_cs > 0 {
        p.duration_ms = Some(delay_cs * 10);
    }
    p
}

// ---------------------------------------------------------------------------
// BMP
// ---------------------------------------------------------------------------

fn bmp(data: &[u8]) -> ImageProbe {
    let mut p = ImageProbe::new("BMP 图像");
    let dib = le_u32(data, 14).unwrap_or(0);

    if dib == 12 {
        // BITMAPCOREHEADER（OS/2 1.x）：宽高都是 u16
        p.push("头部", "BITMAPCOREHEADER（12 字节）");
        let w = le_u16(data, 18).unwrap_or(0);
        let h = le_u16(data, 20).unwrap_or(0);
        if w > 0 && h > 0 {
            p.push("尺寸", format!("{w} × {h} px"));
        } else {
            p.warn("BMP 核心头不完整，尺寸未知");
        }
        if let Some(bpp) = le_u16(data, 24) {
            p.push("位深", format!("{bpp} bit"));
            if bpp <= 8 {
                p.push("调色板", format!("{} 色", 1u32 << bpp));
            }
        }
        return p;
    }

    if dib < 40 {
        p.warn(format!(
            "BMP 信息头长度 {dib} 字节无法识别（只认 12 / 40 及以上）"
        ));
        return p;
    }

    let header_name = match dib {
        40 => "BITMAPINFOHEADER（40 字节）",
        52 => "BITMAPV2INFOHEADER（52 字节）",
        56 => "BITMAPV3INFOHEADER（56 字节）",
        108 => "BITMAPV4HEADER（108 字节）",
        124 => "BITMAPV5HEADER（124 字节）",
        n if n > 124 => "扩展信息头",
        _ => "自定义信息头",
    };
    p.push("头部", header_name);

    let w = le_u32(data, 18).map(|v| v as i32).unwrap_or(0);
    let h_raw = le_u32(data, 22).map(|v| v as i32).unwrap_or(0);
    if w > 0 && h_raw != 0 {
        p.push("尺寸", format!("{} × {} px", w, h_raw.abs()));
    } else {
        p.warn("BMP 信息头不完整，尺寸未知");
    }
    if h_raw < 0 {
        p.push("扫描方向", "自上而下");
    }

    if let Some(bpp) = le_u16(data, 28) {
        p.push("位深", format!("{bpp} bit"));
        if bpp <= 8 && le_u32(data, 30).unwrap_or(0) == 0 {
            let used = le_u32(data, 46).unwrap_or(0);
            let colors = if used > 0 {
                used
            } else {
                1u32 << bpp
            };
            p.push("调色板", format!("{colors} 色"));
        }
    }

    let compression = le_u32(data, 30).unwrap_or(0);
    let name = match compression {
        0 => Some("无压缩（BI_RGB）"),
        1 => Some("RLE8 行程编码"),
        2 => Some("RLE4 行程编码"),
        3 => Some("位域（BI_BITFIELDS）"),
        4 => Some("内嵌 JPEG（BI_JPEG）"),
        5 => Some("内嵌 PNG（BI_PNG）"),
        6 => Some("带 alpha 位域（BI_ALPHABITFIELDS）"),
        _ => None,
    };
    match name {
        Some(n) => p.push("压缩", n),
        None => p.warn(format!("BMP 压缩方式编号 {compression} 不认识，按未压缩展示")),
    }

    // 分辨率：像素/米 → DPI（1 英寸 = 0.0254 米）
    let xppm = le_u32(data, 38).map(|v| v as i32).unwrap_or(0);
    let yppm = le_u32(data, 42).map(|v| v as i32).unwrap_or(0);
    if xppm > 0 && yppm > 0 {
        let x = (xppm as f64 * 0.0254).round() as i64;
        let y = (yppm as f64 * 0.0254).round() as i64;
        p.push("分辨率", format!("{x} × {y} DPI"));
    }
    p
}

// ---------------------------------------------------------------------------
// AVIF（ISOBMFF 结构）
// ---------------------------------------------------------------------------

/// ISOBMFF 盒子递归深度上限，防构造过的畸形文件把栈打爆。
const MAX_BOX_DEPTH: usize = 12;

#[derive(Default)]
struct AvifScan {
    major: String,
    compat: Vec<String>,
    ispe: Option<(u32, u32)>,
    pixi: Option<(u8, u8)>,
    av1c_bits: Option<u8>,
    has_av1c: bool,
    alpha: bool,
    frames: Option<u32>,
    truncated_at: Option<usize>,
}

/// `ftyp` 里认 AVIF：主品牌是 avif/avis，或兼容品牌里带 avif（MIAF 常见写法）。
fn avif_brand(data: &[u8]) -> Option<String> {
    let body = data.get(8..)?;
    let major = std::str::from_utf8(body.get(0..4)?).ok()?.trim().to_string();
    let compat: Vec<String> = body
        .get(8..)
        .unwrap_or(&[])
        .chunks_exact(4)
        .take(16)
        .filter_map(|c| std::str::from_utf8(c).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if major == "avif" || major == "avis" || compat.iter().any(|c| c == "avif" || c == "avis") {
        Some(major)
    } else {
        None
    }
}

fn scan_boxes(data: &[u8], scan: &mut AvifScan, depth: usize) {
    if depth > MAX_BOX_DEPTH {
        return;
    }
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = be_u32(data, pos).unwrap_or(0) as usize;
        let Some(typ) = data.get(pos + 4..pos + 8) else {
            break;
        };
        let (body_start, declared_end) = if size32 == 0 {
            (pos + 8, None)
        } else if size32 == 1 {
            let large = be_u64(data, pos + 8).unwrap_or(0) as usize;
            (
                pos + 16,
                if large == 0 {
                    None
                } else {
                    Some(pos.saturating_add(large))
                },
            )
        } else {
            (pos + 8, Some(pos.saturating_add(size32)))
        };
        if body_start > data.len() {
            break;
        }
        // 声明的盒长超过实际字节：记下截断位置，能读到的字段照读
        if let Some(de) = declared_end {
            if de > data.len() {
                scan.truncated_at.get_or_insert(pos);
            }
        }
        let end = declared_end.unwrap_or(data.len()).min(data.len());
        let body = &data[body_start..end];

        match typ {
            b"ftyp" => {
                if let Some(major) = body.get(0..4).and_then(|b| std::str::from_utf8(b).ok()) {
                    scan.major = major.trim().to_string();
                }
                for c in body.get(8..).unwrap_or(&[]).chunks_exact(4) {
                    if let Ok(s) = std::str::from_utf8(c) {
                        let t = s.trim();
                        if !t.is_empty() && !scan.compat.iter().any(|x| x == t) {
                            scan.compat.push(t.to_string());
                        }
                    }
                }
            }
            b"ispe" => {
                // FullBox：version/flags(4) + width u32 + height u32
                if scan.ispe.is_none() && body.len() >= 12 {
                    if let (Some(w), Some(h)) = (be_u32(body, 4), be_u32(body, 8)) {
                        if w > 0 && h > 0 {
                            scan.ispe = Some((w, h));
                        }
                    }
                }
            }
            b"pixi" => {
                // FullBox：version/flags(4) + 通道数 u8 + 每通道位深 u8…
                if scan.pixi.is_none() && body.len() >= 6 {
                    let channels = body[4];
                    let bits = body[5];
                    if channels > 0 && bits > 0 {
                        scan.pixi = Some((channels, bits));
                    }
                }
            }
            b"av1C" => {
                scan.has_av1c = true;
                // AV1CodecConfigurationRecord：marker/version(1) + profile/level(1) + 标志与位深(1)
                if scan.av1c_bits.is_none() && body.len() >= 3 {
                    let flags = body[2];
                    let high_bitdepth = flags & 0x40 != 0;
                    let twelve_bit = flags & 0x20 != 0;
                    scan.av1c_bits = Some(if high_bitdepth {
                        if twelve_bit {
                            12
                        } else {
                            10
                        }
                    } else {
                        8
                    });
                }
            }
            b"auxC" => {
                // 辅助类型 URN：alpha 平面用 ...:auxiliary:alpha
                if body.windows(5).any(|w| w == b"alpha") {
                    scan.alpha = true;
                }
            }
            b"stsz" => {
                // FullBox：version/flags(4) + sample_size u32 + sample_count u32
                if scan.frames.is_none() && body.len() >= 12 {
                    scan.frames = be_u32(body, 8);
                }
            }
            b"meta" | b"iprp" | b"ipco" | b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl"
            | b"mvex" | b"moof" | b"traf" | b"dinf" | b"edts" => {
                // meta 是 FullBox，子盒从 body+4 起
                let skip = if typ == b"meta" { 4 } else { 0 };
                if body.len() > skip {
                    scan_boxes(&body[skip..], scan, depth + 1);
                }
            }
            _ => {}
        }

        let next = end;
        if next <= pos {
            break;
        }
        pos = next;
    }
}

fn avif(data: &[u8], brand: String) -> ImageProbe {
    let mut p = ImageProbe::new("AVIF 图像");
    let mut scan = AvifScan {
        major: brand,
        ..Default::default()
    };
    scan_boxes(data, &mut scan, 0);

    if let Some((w, h)) = scan.ispe {
        p.push("尺寸", format!("{w} × {h} px"));
    } else {
        p.warn("AVIF 未找到 ispe 尺寸盒，尺寸未知（非标准 MIAF 结构或文件被截断）");
    }

    let major = if scan.major.is_empty() {
        "未知".to_string()
    } else {
        scan.major.clone()
    };
    let compat = scan.compat.join(" / ");
    if compat.is_empty() {
        p.push("品牌", major);
    } else {
        p.push("品牌", format!("{major}（兼容 {compat}）"));
    }

    p.push("编码", if scan.has_av1c { "AV1" } else { "AV1（未找到 av1C）" });

    if let Some((channels, bits)) = scan.pixi {
        p.push("位深", format!("{bits} bit"));
        p.push("通道", format!("{channels} 通道"));
    } else if let Some(bits) = scan.av1c_bits {
        p.push("位深", format!("{bits} bit"));
    } else {
        p.warn("AVIF 未找到 pixi / av1C，位深未知");
    }

    p.push(
        "Alpha",
        if scan.alpha {
            "有（辅助 alpha 平面）"
        } else {
            "无"
        },
    );

    let animated = scan.major == "avis" || scan.frames.map(|n| n > 1).unwrap_or(false);
    if animated {
        let frames = scan.frames.unwrap_or(0);
        p.push("帧数", if frames > 0 { frames.to_string() } else { "未知".to_string() });
        p.push("动画", "是");
    } else {
        p.push("帧数", "1");
        p.push("动画", "否");
    }

    if let Some(at) = scan.truncated_at {
        p.warn(format!("AVIF 盒子结构在偏移 {at} 处被截断，部分字段可能缺失"));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gif_minimal_is_single_frame() {
        // GIF87a + 1×1 逻辑屏 + 无全局调色板 + 一个 1×1 图像块 + 结束标记
        let mut g = Vec::new();
        g.extend_from_slice(b"GIF87a");
        g.extend_from_slice(&[1, 0, 1, 0]); // 宽 1 高 1
        g.extend_from_slice(&[0x00, 0x00, 0x00]); // packed / 背景 / 像素比
        g.push(0x2C);
        g.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0x00]); // 描述符 packed=0
        g.push(0x02); // LZW 最小码长
        g.extend_from_slice(&[0x02, 0x4C, 0x01, 0x00]); // 子块 + 结束
        g.push(0x3B);
        let p = gif(&g);
        assert_eq!(p.format, "GIF 图像");
        let frames = p.fields.iter().find(|f| f.0 == "帧数").map(|f| f.1.clone());
        assert_eq!(frames.as_deref(), Some("1"));
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn bmp_ppm_maps_to_dpi() {
        // 40 字节信息头，100×50，24bit，3780 ppm ≈ 96 DPI
        let mut b = Vec::new();
        b.extend_from_slice(b"BM");
        b.extend_from_slice(&[0u8; 12]);
        b.extend_from_slice(&40u32.to_le_bytes());
        b.extend_from_slice(&100i32.to_le_bytes());
        b.extend_from_slice(&50i32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&24u16.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes()); // 压缩 BI_RGB
        b.extend_from_slice(&0u32.to_le_bytes()); // 图像字节数
        b.extend_from_slice(&3780i32.to_le_bytes()); // 100 DPI 的像素/米
        b.extend_from_slice(&3780i32.to_le_bytes());
        b.extend_from_slice(&[0u8; 8]); // 调色板数 / 重要色数
        let p = bmp(&b);
        let dpi = p.fields.iter().find(|f| f.0 == "分辨率").map(|f| f.1.clone());
        assert_eq!(dpi.as_deref(), Some("96 × 96 DPI"));
    }

    #[test]
    fn unknown_bmp_header_is_reported() {
        let mut b = Vec::new();
        b.extend_from_slice(b"BM");
        b.extend_from_slice(&[0u8; 12]);
        b.extend_from_slice(&16u32.to_le_bytes());
        let p = bmp(&b);
        assert!(p.warnings.iter().any(|w| w.contains("无法识别")));
    }
}
