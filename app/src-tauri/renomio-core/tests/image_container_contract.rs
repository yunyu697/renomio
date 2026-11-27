//! GIF / BMP / AVIF 容器契约：全部用测试现场构造的最小文件，不下载样本、不依赖图像解码库。

use renomio_core::image_container::{probe, ImageProbe};
use renomio_core::metadata::{read_metadata, rename_field_values};

// ---------------------------------------------------------------------------
// 夹具与工具
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
        let dir =
            std::env::temp_dir().join(format!("renomio-image-{tag}-{}-{nanos}", std::process::id()));
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

fn field<'a>(p: &'a ImageProbe, key: &str) -> Option<&'a str> {
    p.fields
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.as_str())
}

fn warnings(p: &ImageProbe) -> String {
    p.warnings.join(" / ")
}

// --- GIF -------------------------------------------------------------------

fn sub_block(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![bytes.len() as u8];
    out.extend_from_slice(bytes);
    out
}

/// 一个 GIF：`frames` 个 1×1 图像块，每帧延时 `delay_cs`（1/100 秒），
/// 可选 NETSCAPE 循环次数与注释。
fn gif_file(frames: usize, delay_cs: u16, loops: Option<u16>, comment: Option<&str>) -> Vec<u8> {
    let mut g = Vec::new();
    g.extend_from_slice(b"GIF89a");
    g.extend_from_slice(&4u16.to_le_bytes()); // 宽 4
    g.extend_from_slice(&3u16.to_le_bytes()); // 高 3
    g.push(0x80 | 0x01); // 有全局调色板，2^(1+1)=4 色
    g.push(0); // 背景色索引
    g.push(0); // 像素宽高比
    g.extend_from_slice(&[0u8; 12]); // 4 色 × 3 字节

    if let Some(loops) = loops {
        // 真实结构：0x21 0xFF 0x0B "NETSCAPE2.0" 0x03 0x01 <lo> <hi> 0x00
        g.push(0x21);
        g.push(0xFF);
        g.push(11);
        g.extend_from_slice(b"NETSCAPE2.0");
        g.push(3);
        g.push(0x01);
        g.extend_from_slice(&loops.to_le_bytes());
        g.push(0);
    }
    if let Some(text) = comment {
        g.push(0x21);
        g.push(0xFE);
        g.extend_from_slice(&sub_block(text.as_bytes()));
        g.push(0);
    }

    for _ in 0..frames {
        // 图形控制扩展：延时
        g.push(0x21);
        g.push(0xF9);
        g.push(0x04);
        g.push(0x00); // packed：无透明色
        g.extend_from_slice(&delay_cs.to_le_bytes());
        g.push(0x00); // 透明色索引
        g.push(0x00); // 子块结束
                     // 图像描述符
        g.push(0x2C);
        g.extend_from_slice(&0u16.to_le_bytes());
        g.extend_from_slice(&0u16.to_le_bytes());
        g.extend_from_slice(&2u16.to_le_bytes());
        g.extend_from_slice(&2u16.to_le_bytes());
        g.push(0x00); // 无局部调色板
        g.push(0x02); // LZW 最小码长
        g.extend_from_slice(&sub_block(&[0x02, 0x02, 0x44, 0x01]));
        g.push(0x00); // 子块结束
    }
    g.push(0x3B);
    g
}

// --- BMP -------------------------------------------------------------------

fn bmp_file(width: i32, height: i32, bpp: u16, colors_used: u32, ppm: i32) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&0u32.to_le_bytes()); // 文件大小（解析器不依赖）
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(&54u32.to_le_bytes()); // 像素偏移
    b.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    b.extend_from_slice(&width.to_le_bytes());
    b.extend_from_slice(&height.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // planes
    b.extend_from_slice(&bpp.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    b.extend_from_slice(&0u32.to_le_bytes()); // 图像字节数
    b.extend_from_slice(&ppm.to_le_bytes());
    b.extend_from_slice(&ppm.to_le_bytes());
    b.extend_from_slice(&colors_used.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes()); // 重要色数
    b
}

// --- AVIF ------------------------------------------------------------------

fn bbox(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(body);
    out
}

fn full_box(typ: &[u8; 4], version_flags: [u8; 4], body: &[u8]) -> Vec<u8> {
    let mut inner = version_flags.to_vec();
    inner.extend_from_slice(body);
    bbox(typ, &inner)
}

fn ispe(w: u32, h: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&w.to_be_bytes());
    body.extend_from_slice(&h.to_be_bytes());
    full_box(b"ispe", [0, 0, 0, 0], &body)
}

fn pixi(channels: u8, bits: u8) -> Vec<u8> {
    let mut body = vec![channels];
    body.extend(std::iter::repeat_n(bits, channels as usize));
    full_box(b"pixi", [0, 0, 0, 0], &body)
}

/// AV1CodecConfigurationRecord：marker/version、profile/level、标志位（含位深）
fn av1c(high_bitdepth: bool, twelve_bit: bool) -> Vec<u8> {
    let mut flags = 0u8;
    if high_bitdepth {
        flags |= 0x40;
    }
    if twelve_bit {
        flags |= 0x20;
    }
    bbox(b"av1C", &[0x81, 0x00, flags, 0x00])
}

fn auxc(urn: &str) -> Vec<u8> {
    let mut body = urn.as_bytes().to_vec();
    body.push(0);
    full_box(b"auxC", [0, 0, 0, 0], &body)
}

fn stsz(count: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // sample_size = 0（变长）
    body.extend_from_slice(&count.to_be_bytes());
    full_box(b"stsz", [0, 0, 0, 0], &body)
}

/// 组装一个 AVIF：主品牌 + 兼容品牌、ipco 里的 ispe/pixi/av1C/auxC，可选动画（avis + stsz）
fn avif_file(
    major: &str,
    compat: &[&str],
    w: u32,
    h: u32,
    bits: Option<(bool, bool)>,
    alpha: bool,
    frames: Option<u32>,
) -> Vec<u8> {
    let mut ftyp = Vec::new();
    ftyp.extend_from_slice(major.as_bytes());
    ftyp.extend_from_slice(&0u32.to_be_bytes()); // minor version
    for c in compat {
        ftyp.extend_from_slice(c.as_bytes());
    }
    let mut out = bbox(b"ftyp", &ftyp);

    let mut ipco = Vec::new();
    ipco.extend(ispe(w, h));
    if let Some((high, twelve)) = bits {
        ipco.extend(pixi(3, if high { if twelve { 12 } else { 10 } } else { 8 }));
        ipco.extend(av1c(high, twelve));
    }
    if alpha {
        ipco.extend(auxc("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"));
    }
    let ipco = bbox(b"ipco", &ipco);
    let iprp = bbox(b"iprp", &ipco);
    let meta = full_box(b"meta", [0, 0, 0, 0], &iprp);
    out.extend(meta);

    if let Some(n) = frames {
        let stbl = bbox(b"stbl", &stsz(n));
        let minf = bbox(b"minf", &stbl);
        let mdia = bbox(b"mdia", &minf);
        let trak = bbox(b"trak", &mdia);
        out.extend(bbox(b"moov", &trak));
    }
    out
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn gif_animated_reports_frames_loop_and_duration() {
    let data = gif_file(3, 10, Some(0), Some("由测试构造的注释"));
    let p = probe(&data).expect("GIF 应被识别");
    assert_eq!(p.format, "GIF 图像");
    assert_eq!(field(&p, "版本"), Some("GIF89a"));
    assert_eq!(field(&p, "尺寸"), Some("4 × 3 px"));
    assert_eq!(field(&p, "全局调色板"), Some("4 色"));
    assert_eq!(field(&p, "帧数"), Some("3"));
    assert_eq!(field(&p, "动画"), Some("是"));
    assert_eq!(field(&p, "循环"), Some("无限"));
    assert_eq!(field(&p, "注释"), Some("由测试构造的注释"));
    assert_eq!(p.duration_ms, Some(300), "3 帧 × 10/100 秒 = 300 ms");
    assert!(p.warnings.is_empty(), "不应有警告：{}", warnings(&p));
}

#[test]
fn gif_single_frame_is_not_animated() {
    let data = gif_file(1, 0, None, None);
    let p = probe(&data).expect("GIF 应被识别");
    assert_eq!(field(&p, "帧数"), Some("1"));
    assert_eq!(field(&p, "动画"), Some("否"));
    assert_eq!(field(&p, "循环"), None, "没有 NETSCAPE 扩展就不该编造循环次数");
    assert_eq!(p.duration_ms, None, "单帧没有总时长");
}

#[test]
fn gif_truncated_is_reported_not_panicking() {
    let data = gif_file(2, 5, None, None);
    // 砍掉结束标记之后的一半内容
    let cut = data.len() - 14;
    let p = probe(&data[..cut]).expect("截断的 GIF 仍应识别");
    assert!(warnings(&p).contains("截断"), "应说明被截断：{}", warnings(&p));
    assert!(field(&p, "帧数").is_some(), "已读到的帧数照给");
}

#[test]
fn bmp_24bit_reports_depth_compression_and_dpi() {
    let data = bmp_file(640, 480, 24, 0, 3780);
    let p = probe(&data).expect("BMP 应被识别");
    assert_eq!(field(&p, "尺寸"), Some("640 × 480 px"));
    assert_eq!(field(&p, "位深"), Some("24 bit"));
    assert_eq!(field(&p, "压缩"), Some("无压缩（BI_RGB）"));
    assert_eq!(field(&p, "分辨率"), Some("96 × 96 DPI"));
    assert_eq!(field(&p, "调色板"), None, "24 位不需要调色板");
}

#[test]
fn bmp_8bit_palette_and_top_down_flag() {
    let data = bmp_file(16, -8, 8, 256, 2835);
    let p = probe(&data).expect("BMP 应被识别");
    assert_eq!(field(&p, "尺寸"), Some("16 × 8 px"), "负高度要取绝对值");
    assert_eq!(field(&p, "扫描方向"), Some("自上而下"));
    assert_eq!(field(&p, "调色板"), Some("256 色"));
    assert_eq!(field(&p, "分辨率"), Some("72 × 72 DPI"));
}

#[test]
fn bmp_os2_core_header_is_read_too() {
    let mut b = Vec::new();
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&[0u8; 12]);
    b.extend_from_slice(&12u32.to_le_bytes()); // BITMAPCOREHEADER
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&8u16.to_le_bytes());
    let p = probe(&b).expect("OS/2 BMP 应被识别");
    assert_eq!(field(&p, "尺寸"), Some("32 × 16 px"));
    assert_eq!(field(&p, "位深"), Some("8 bit"));
    assert_eq!(field(&p, "调色板"), Some("256 色"));
}

#[test]
fn avif_still_reports_size_depth_and_no_alpha() {
    let data = avif_file("avif", &["mif1", "miaf"], 320, 240, Some((false, false)), false, None);
    let p = probe(&data).expect("AVIF 应被识别");
    assert_eq!(p.format, "AVIF 图像");
    assert_eq!(field(&p, "尺寸"), Some("320 × 240 px"));
    assert_eq!(field(&p, "编码"), Some("AV1"));
    assert_eq!(field(&p, "位深"), Some("8 bit"));
    assert_eq!(field(&p, "通道"), Some("3 通道"));
    assert_eq!(field(&p, "Alpha"), Some("无"));
    assert_eq!(field(&p, "动画"), Some("否"));
}

#[test]
fn avif_10bit_with_alpha_plane() {
    let data = avif_file("avif", &["mif1"], 64, 64, Some((true, false)), true, None);
    let p = probe(&data).expect("AVIF 应被识别");
    assert_eq!(field(&p, "位深"), Some("10 bit"));
    assert_eq!(field(&p, "Alpha"), Some("有（辅助 alpha 平面）"));
}

#[test]
fn avif_sequence_counts_samples() {
    let data = avif_file("avis", &["avif"], 128, 96, Some((false, false)), false, Some(5));
    let p = probe(&data).expect("AVIF 序列应被识别");
    assert_eq!(field(&p, "动画"), Some("是"));
    assert_eq!(field(&p, "帧数"), Some("5"));
}

#[test]
fn avif_compatible_brand_is_enough() {
    // 主品牌是 mif1，但兼容品牌里有 avif（MIAF 常见写法）
    let data = avif_file("mif1", &["avif"], 10, 10, None, false, None);
    let p = probe(&data).expect("兼容品牌带 avif 也算 AVIF");
    assert_eq!(field(&p, "尺寸"), Some("10 × 10 px"));
    assert!(warnings(&p).contains("pixi"), "没有 pixi/av1C 要说明位深未知");
}

#[test]
fn avif_truncated_and_other_bytes_are_safe() {
    let data = avif_file("avif", &["mif1"], 800, 600, Some((false, false)), false, None);
    let cut = data.len() - 10;
    let p = probe(&data[..cut]);
    // 尺寸未必还读得到，但绝不能 panic；读不到要说明
    if let Some(p) = p {
        if field(&p, "尺寸").is_none() {
            assert!(warnings(&p).contains("尺寸未知"), "{}", warnings(&p));
        }
    }
    assert!(probe(b"not an image at all").is_none());
    assert!(probe(b"RIFF\x00\x00\x00\x00WAVEfmt ").is_none(), "WAV 不该被当成图片");
    assert!(
        probe(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00").is_none(),
        "普通 MP4 不是 AVIF"
    );
}

#[test]
fn read_metadata_reads_real_gif_file() {
    let temp = Temp::new("gif");
    let path = temp.file("动画.gif", &gif_file(2, 4, Some(2), Some("现场构造")));
    let info = read_metadata(&path).expect("读取元数据");
    assert_eq!(info.kind, "image");
    assert_eq!(info.format, "GIF 图像");
    assert!(info.read_only);
    let label = |name: &str| {
        info.fields
            .iter()
            .find(|f| f.label == name)
            .map(|f| f.value.clone())
    };
    assert_eq!(label("尺寸").as_deref(), Some("4 × 3 px"));
    assert_eq!(label("帧数").as_deref(), Some("2"));
    assert_eq!(label("循环").as_deref(), Some("2 次"));
    assert_eq!(label("总时长").as_deref(), Some("0.08 秒"));

    let values = rename_field_values(&info);
    assert_eq!(values.width, "4", "尺寸里的宽要能进改名取值");
    assert_eq!(values.height, "3");
}

#[test]
fn read_metadata_reads_real_avif_file() {
    let temp = Temp::new("avif");
    let path = temp.file(
        "封面.avif",
        &avif_file("avif", &["mif1"], 1200, 800, Some((true, true)), false, None),
    );
    let info = read_metadata(&path).expect("读取元数据");
    assert_eq!(info.format, "AVIF 图像");
    let label = |name: &str| {
        info.fields
            .iter()
            .find(|f| f.label == name)
            .map(|f| f.value.clone())
    };
    assert_eq!(label("尺寸").as_deref(), Some("1200 × 800 px"));
    assert_eq!(label("位深").as_deref(), Some("12 bit"));
}
