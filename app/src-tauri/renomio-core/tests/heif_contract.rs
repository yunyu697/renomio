//! HEIC / HEIF 容器契约：全部用测试现场构造的最小 ISOBMFF，不下载样本、不依赖解码库。

use renomio_core::heif::{probe, HeifProbe};
use renomio_core::metadata::{read_metadata, rename_field_values};

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
            std::env::temp_dir().join(format!("renomio-heif-{tag}-{}-{nanos}", std::process::id()));
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

fn field<'a>(p: &'a HeifProbe, key: &str) -> Option<&'a str> {
    p.fields
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.as_str())
}

fn warnings(p: &HeifProbe) -> String {
    p.warnings.join(" / ")
}

// ---------------------------------------------------------------------------
// 盒子构造
// ---------------------------------------------------------------------------

fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&((body.len() as u32) + 8).to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(body);
    out
}

fn full(typ: &[u8; 4], version: u8, flags: u8, body: &[u8]) -> Vec<u8> {
    let mut inner = vec![version, 0, 0, flags];
    inner.extend_from_slice(body);
    bx(typ, &inner)
}

fn ftyp(major: &[u8; 4], compat: &[&[u8; 4]]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(major);
    body.extend_from_slice(&[0, 0, 0, 0]);
    for c in compat {
        body.extend_from_slice(&c[..]);
    }
    bx(b"ftyp", &body)
}

fn ispe(w: u32, h: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&w.to_be_bytes());
    body.extend_from_slice(&h.to_be_bytes());
    full(b"ispe", 0, 0, &body)
}

fn pixi(channels: u8, bits: u8) -> Vec<u8> {
    let mut body = vec![channels];
    for _ in 0..channels {
        body.push(bits);
    }
    full(b"pixi", 0, 0, &body)
}

fn hvcc(chroma: u8, bits: u8) -> Vec<u8> {
    let mut body = vec![1u8; 21];
    body[16] = chroma;
    body[17] = bits.saturating_sub(8);
    bx(b"hvcC", &body)
}

fn auxc_alpha() -> Vec<u8> {
    full(b"auxC", 0, 0, b"urn:mpeg:hevc:2015:auxid:1")
}

fn irot(angle: u8) -> Vec<u8> {
    full(b"irot", 0, 0, &[angle & 0x03])
}

fn infe(id: u16, item_type: &[u8; 4]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&id.to_be_bytes());
    body.extend_from_slice(&[0, 0]);
    body.extend_from_slice(item_type);
    body.extend_from_slice(b"item\0");
    full(b"infe", 2, 0, &body)
}

fn iinf(items: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&(items.len() as u16).to_be_bytes());
    for it in items {
        body.extend_from_slice(it);
    }
    full(b"iinf", 0, 0, &body)
}

fn pitm(id: u16) -> Vec<u8> {
    full(b"pitm", 0, 0, &id.to_be_bytes())
}

/// iloc v0：offset / length 各 4 字节，无 base_offset。
fn iloc(entries: &[(u16, u32, u32)]) -> Vec<u8> {
    let mut body = vec![0x44, 0x00];
    body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
    for (id, off, len) in entries {
        body.extend_from_slice(&id.to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&1u16.to_be_bytes());
        body.extend_from_slice(&off.to_be_bytes());
        body.extend_from_slice(&len.to_be_bytes());
    }
    full(b"iloc", 0, 0, &body)
}

fn ipma(entries: &[(u16, &[u8])]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (id, idxs) in entries {
        body.extend_from_slice(&id.to_be_bytes());
        body.push(idxs.len() as u8);
        for i in *idxs {
            body.push(0x80 | (i & 0x7F));
        }
    }
    full(b"ipma", 0, 0, &body)
}

fn iprp(ipco_bodies: &[Vec<u8>], ipma_box: Vec<u8>) -> Vec<u8> {
    let mut ipco = Vec::new();
    for body in ipco_bodies {
        ipco.extend_from_slice(body);
    }
    let mut body = Vec::new();
    body.extend_from_slice(&bx(b"ipco", &ipco));
    body.extend_from_slice(&ipma_box);
    bx(b"iprp", &body)
}

fn stsz(count: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&count.to_be_bytes());
    full(b"stsz", 0, 0, &body)
}

fn moov_with_samples(count: u32) -> Vec<u8> {
    let mut stbl = Vec::new();
    stbl.extend_from_slice(&stsz(count));
    let mut minf = Vec::new();
    minf.extend_from_slice(&bx(b"stbl", &stbl));
    let mut mdia = Vec::new();
    mdia.extend_from_slice(&bx(b"minf", &minf));
    let mut trak = Vec::new();
    trak.extend_from_slice(&bx(b"mdia", &mdia));
    let mut moov = Vec::new();
    moov.extend_from_slice(&bx(b"trak", &trak));
    bx(b"moov", &moov)
}

// ---------------------------------------------------------------------------
// 最小 EXIF（TIFF）：IFD0 放相机品牌/型号 + ExifIFD 指针，ExifIFD 放拍摄时间
// ---------------------------------------------------------------------------

fn exif_tiff() -> Vec<u8> {
    let make = b"RenomioCam\0";
    let model = b"RC-Phone\0";
    let taken = b"2025:03:04 05:06:07\0";

    let ifd0_off: u32 = 8;
    let ifd0_count = 3u16;
    let ifd0_data: u32 = ifd0_off + 2 + 3 * 12 + 4; // 50
    let make_off = ifd0_data;
    let model_off = make_off + make.len() as u32;
    let exif_off = model_off + model.len() as u32;
    let exif_data = exif_off + 2 + 1 * 12 + 4;
    let taken_off = exif_data;

    let u16b = |v: u16| v.to_be_bytes().to_vec();
    let u32b = |v: u32| v.to_be_bytes().to_vec();
    let entry = |tag: u16, kind: u16, count: u32, value: Vec<u8>| -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&u16b(tag));
        out.extend_from_slice(&u16b(kind));
        out.extend_from_slice(&u32b(count));
        out.extend_from_slice(&value);
        out
    };

    let mut t = Vec::new();
    t.extend_from_slice(b"MM");
    t.extend_from_slice(&u16b(42));
    t.extend_from_slice(&u32b(ifd0_off));
    t.extend_from_slice(&u16b(ifd0_count));
    t.extend_from_slice(&entry(0x010F, 2, make.len() as u32, u32b(make_off)));
    t.extend_from_slice(&entry(0x0110, 2, model.len() as u32, u32b(model_off)));
    t.extend_from_slice(&entry(0x8769, 4, 1, u32b(exif_off)));
    t.extend_from_slice(&[0u8; 4]);
    t.extend_from_slice(make);
    t.extend_from_slice(model);
    t.extend_from_slice(&u16b(1));
    t.extend_from_slice(&entry(0x9003, 2, taken.len() as u32, u32b(taken_off)));
    t.extend_from_slice(&[0u8; 4]);
    t.extend_from_slice(taken);
    t
}

/// Exif 项字节：4 字节头偏移 + `Exif\0\0` + TIFF。
fn exif_item(tiff: &[u8], with_prefix: bool) -> Vec<u8> {
    let mut out = Vec::new();
    if with_prefix {
        out.extend_from_slice(&6u32.to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
    } else {
        out.extend_from_slice(&0u32.to_be_bytes());
    }
    out.extend_from_slice(tiff);
    out
}

// ---------------------------------------------------------------------------
// 组一个完整 HEIC
// ---------------------------------------------------------------------------

struct Spec {
    major: [u8; 4],
    compat: Vec<[u8; 4]>,
    width: u32,
    height: u32,
    pixi: Option<(u8, u8)>,
    hvc: Option<(u8, u8)>,
    alpha: bool,
    rotation: Option<u8>,
    frames: Option<u32>,
    /// (Exif 项 id, 项字节)；None 表示不带 Exif 项
    exif: Option<Vec<u8>>,
    /// 额外（非主图）项类型，用来验证「项数」
    extra_items: Vec<[u8; 4]>,
    meta: bool,
}

impl Default for Spec {
    fn default() -> Self {
        Self {
            major: *b"heic",
            compat: vec![*b"mif1", *b"heic"],
            width: 4032,
            height: 3024,
            pixi: Some((3, 8)),
            hvc: Some((1, 8)),
            alpha: false,
            rotation: None,
            frames: None,
            exif: None,
            extra_items: Vec::new(),
            meta: true,
        }
    }
}

fn build(spec: &Spec) -> Vec<u8> {
    let mut compat_refs: Vec<&[u8; 4]> = Vec::new();
    for c in &spec.compat {
        compat_refs.push(c);
    }
    let mut out = ftyp(&spec.major, &compat_refs);
    if spec.meta {
        // iinf：主图项 #1 + 可能的 Exif 项 #2 + 额外项
        let mut items = vec![infe(1, b"hvc1")];
        let mut have_exif = false;
        if spec.exif.is_some() {
            items.push(infe(2, b"Exif"));
            have_exif = true;
        }
        for (i, typ) in spec.extra_items.iter().enumerate() {
            items.push(infe(3 + i as u16, typ));
        }

        let mut ipco_bodies: Vec<Vec<u8>> = Vec::new();
        ipco_bodies.push(ispe(spec.width, spec.height));
        let mut assoc_mid: Vec<u8> = vec![1]; // 主图关联第 1 个属性（ispe）
        if let Some((c, b)) = spec.pixi {
            ipco_bodies.push(pixi(c, b));
            let idx = ipco_bodies.len() as u8;
            assoc_mid.push(idx);
        }
        if let Some((chroma, bits)) = spec.hvc {
            ipco_bodies.push(hvcc(chroma, bits));
            let idx = ipco_bodies.len() as u8;
            assoc_mid.push(idx);
        }
        if spec.alpha {
            ipco_bodies.push(auxc_alpha());
            let idx = ipco_bodies.len() as u8;
            assoc_mid.push(idx);
        }
        if let Some(angle) = spec.rotation {
            ipco_bodies.push(irot(angle));
            let idx = ipco_bodies.len() as u8;
            assoc_mid.push(idx);
        }

        // 先占位算长度（iloc 的值是定长 u32，两轮长度一致）
        let meta_with_off = |offset: u32, have_exif: bool, ipco: &[Vec<u8>], assoc: &[u8]| -> Vec<u8> {
            let mut children = Vec::new();
            children.extend_from_slice(&pitm(1));
            children.extend_from_slice(&iinf(&items));
            let mut iloc_entries: Vec<(u16, u32, u32)> = vec![(1, 0, 32)];
            if have_exif {
                let len = spec.exif.as_ref().map(|e| e.len() as u32).unwrap_or(0);
                iloc_entries.push((2, offset, len));
            }
            children.extend_from_slice(&iloc(&iloc_entries));
            let mut ipma_entries: Vec<(u16, &[u8])> = vec![(1, assoc)];
            if have_exif {
                ipma_entries.push((2, &[]));
            }
            children.extend_from_slice(&iprp(ipco, ipma(&ipma_entries)));
            let mut body = vec![0u8; 4];
            body.extend_from_slice(&children);
            bx(b"meta", &body)
        };

        let meta0 = meta_with_off(0, have_exif, &ipco_bodies, &assoc_mid);
        let exif_offset = (out.len() + meta0.len() + 8) as u32;
        out.extend_from_slice(&meta_with_off(exif_offset, have_exif, &ipco_bodies, &assoc_mid));
    }
    if let Some(frames) = spec.frames {
        out.extend_from_slice(&moov_with_samples(frames));
    }
    if let Some(exif) = &spec.exif {
        out.extend_from_slice(&bx(b"mdat", exif));
    }
    out
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn heic_still_reads_dimensions_bit_depth_and_chroma() {
    let data = build(&Spec::default());
    let p = probe(&data).expect("认成 HEIC");
    assert_eq!(p.format, "HEIC 图像");
    assert_eq!(field(&p, "尺寸"), Some("4032 × 3024 px"));
    assert_eq!(field(&p, "位深"), Some("8 bit"));
    assert_eq!(field(&p, "通道"), Some("3 通道"));
    assert_eq!(field(&p, "色度采样"), Some("4:2:0"));
    assert!(field(&p, "编码").unwrap().contains("HEVC"));
    assert_eq!(field(&p, "Alpha"), Some("无"));
    assert!(warnings(&p).contains("Exif 项"), "{}", warnings(&p));
}

#[test]
fn heic_without_pixi_falls_back_to_hvcc_bit_depth() {
    let mut spec = Spec::default();
    spec.pixi = None;
    spec.hvc = Some((3, 10));
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(field(&p, "位深"), Some("10 bit"));
    assert_eq!(field(&p, "色度采样"), Some("4:4:4"));
    assert_eq!(field(&p, "通道"), None);
}

#[test]
fn heic_ten_bit_with_alpha_plane() {
    let mut spec = Spec::default();
    spec.pixi = Some((4, 10));
    spec.hvc = Some((1, 10));
    spec.alpha = true;
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(field(&p, "位深"), Some("10 bit"));
    assert_eq!(field(&p, "Alpha"), Some("有（辅助 alpha 平面）"));
}

#[test]
fn generic_heif_brand_reports_unknown_codec() {
    let mut spec = Spec::default();
    spec.major = *b"mif1";
    spec.compat = vec![*b"mif1"];
    spec.hvc = None;
    spec.pixi = None;
    let data = build(&spec);
    let p = probe(&data).expect("通用 HEIF 也认");
    assert_eq!(p.format, "HEIF 图像");
    assert_eq!(field(&p, "编码"), Some("未指明（品牌只标了通用 HEIF）"));
    assert!(warnings(&p).contains("位深"), "{}", warnings(&p));
}

#[test]
fn heic_rotation_is_reported() {
    let mut spec = Spec::default();
    spec.rotation = Some(1);
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(field(&p, "旋转"), Some("90°"));
}

#[test]
fn heic_item_count_and_primary_item() {
    let mut spec = Spec::default();
    spec.extra_items = vec![*b"hvc1"];
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(field(&p, "主图项"), Some("#1"));
    assert_eq!(field(&p, "项数"), Some("2"));
}

#[test]
fn heic_sequence_uses_stsz_frame_count() {
    let mut spec = Spec::default();
    spec.major = *b"hevc";
    spec.compat = vec![*b"msf1", *b"hevc"];
    spec.frames = Some(5);
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(p.frames, Some(5), "{:?}", p.fields);
    assert_eq!(field(&p, "动画"), Some("是"));
    assert_eq!(p.format, "HEIC 图像（序列）");
}

#[test]
fn exif_item_is_extracted_and_located() {
    let tiff = exif_tiff();
    let mut spec = Spec::default();
    spec.exif = Some(exif_item(&tiff, true));
    let p = probe(&build(&spec)).expect("认成 HEIC");
    let got = p.exif_tiff.expect("Exif 项被定位");
    assert_eq!(&got[..2], b"MM");
    assert_eq!(got, tiff);
}

#[test]
fn exif_item_without_prefix_is_also_located() {
    let tiff = exif_tiff();
    let mut spec = Spec::default();
    spec.exif = Some(exif_item(&tiff, false));
    let p = probe(&build(&spec)).expect("认成 HEIC");
    assert_eq!(p.exif_tiff.expect("Exif 项被定位"), tiff);
}

#[test]
fn real_heic_file_metadata_and_naming() {
    let temp = Temp::new("real");
    let tiff = exif_tiff();
    let mut spec = Spec::default();
    spec.width = 3024;
    spec.height = 4032;
    spec.exif = Some(exif_item(&tiff, true));
    let path = temp.file("IMG_0001.HEIC", &build(&spec));

    let info = read_metadata(&path).expect("读元数据");
    assert_eq!(info.kind, "image");
    assert!(info.format.contains("HEIC"), "{}", info.format);
    assert!(info.read_only);
    let f = |label: &str| {
        info.fields
            .iter()
            .find(|x| x.label == label)
            .map(|x| x.value.as_str())
    };
    assert_eq!(f("尺寸"), Some("3024 × 4032 px"));
    assert_eq!(f("拍摄时间"), Some("2025-03-04 05:06:07"));
    assert_eq!(f("相机品牌"), Some("RenomioCam"));
    assert_eq!(f("相机型号"), Some("RC-Phone"));

    let vals = rename_field_values(&info);
    assert_eq!(vals.width, "3024");
    assert_eq!(vals.height, "4032");
    assert_eq!(vals.resolution, "3024x4032");
    assert_eq!(vals.taken, "2025-03-04 05-06-07");
    assert_eq!(vals.camera, "RC-Phone");
}

#[test]
fn heic_without_meta_box_only_warns() {
    let mut spec = Spec::default();
    spec.meta = false;
    let p = probe(&build(&spec)).expect("品牌就能认得");
    assert_eq!(field(&p, "尺寸"), None);
    assert!(warnings(&p).contains("没有 meta 盒"), "{}", warnings(&p));
}

#[test]
fn truncated_meta_is_reported_not_panicked() {
    let data = build(&Spec::default());
    // 砍掉尾部一半：meta 里的盒子声明长度超过实际字节
    let cut = data.len() / 2;
    let p = probe(&data[..cut]).expect("截断也认");
    let w = warnings(&p);
    assert!(w.contains("截断") || w.contains("尺寸未知"), "{}", w);
}

#[test]
fn avif_mp4_and_wav_are_not_heif() {
    let avif = ftyp(b"avif", &[&b"mif1", &b"avif"]);
    assert!(probe(&avif).is_none(), "AVIF 归 image_container，不该被 HEIF 抢");
    let mut mp4 = ftyp(b"isom", &[&b"isom", &b"mp42"]);
    mp4.extend_from_slice(&bx(b"mdat", &[0u8; 8]));
    assert!(probe(&mp4).is_none());
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&[0u8; 12]);
    wav.extend_from_slice(b"WAVEfmt ");
    assert!(probe(&wav).is_none());
    assert!(probe(b"\x00\x00\x00\x18fty").is_none());
}
