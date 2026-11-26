//! 音频容器契约（WAV / AIFF / APE / WMA）：全部用测试现场构造的最小文件，不下载样本、
//! 不依赖本机音频软件。

use renomio_core::audio_container::{probe, AudioProbe};
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
        let dir = std::env::temp_dir().join(format!(
            "renomio-audio-{tag}-{}-{nanos}",
            std::process::id()
        ));
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

fn field<'a>(p: &'a AudioProbe, key: &str) -> Option<&'a str> {
    p.tags
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn warnings(p: &AudioProbe) -> String {
    p.warnings.join(" / ")
}

/// 一个 RIFF 子块：id + 小端长度 + 内容（奇数长度补一个 0）。
fn riff_chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(id);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(0);
    }
    out
}

fn wav_file(
    rate: u32,
    channels: u16,
    bits: u16,
    data_len: u32,
    info: &[(&str, &str)],
    rf64: bool,
) -> Vec<u8> {
    let block_align = channels as u32 * (bits as u32 / 8);
    let byte_rate = rate * block_align;
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
    fmt.extend_from_slice(&channels.to_le_bytes());
    fmt.extend_from_slice(&rate.to_le_bytes());
    fmt.extend_from_slice(&byte_rate.to_le_bytes());
    fmt.extend_from_slice(&(block_align as u16).to_le_bytes());
    fmt.extend_from_slice(&bits.to_le_bytes());

    let mut body = b"WAVE".to_vec();
    if rf64 {
        // ds64：riffSize(8) dataSize(8) sampleCount(8) tableLength(4)
        let mut ds64 = Vec::new();
        ds64.extend_from_slice(&0u64.to_le_bytes());
        ds64.extend_from_slice(&(data_len as u64).to_le_bytes());
        ds64.extend_from_slice(&0u64.to_le_bytes());
        ds64.extend_from_slice(&0u32.to_le_bytes());
        body.extend(riff_chunk(b"ds64", &ds64));
    }
    body.extend(riff_chunk(b"fmt ", &fmt));
    if !info.is_empty() {
        let mut info_body = b"INFO".to_vec();
        for (id, value) in info {
            let id: &[u8; 4] = id.as_bytes().try_into().expect("INFO 子块 id 必须是 4 字节");
            let mut text = value.as_bytes().to_vec();
            text.push(0);
            info_body.extend(riff_chunk(id, &text));
        }
        body.extend(riff_chunk(b"LIST", &info_body));
    }
    // data 块只写声明长度，不真的写那么多字节（解析器只用长度算时长）
    body.extend_from_slice(b"data");
    body.extend_from_slice(&if rf64 {
        u32::MAX.to_le_bytes()
    } else {
        data_len.to_le_bytes()
    });

    let mut out = Vec::new();
    out.extend_from_slice(if rf64 { b"RF64" } else { b"RIFF" });
    out.extend_from_slice(&if rf64 {
        u32::MAX.to_le_bytes()
    } else {
        (body.len() as u32).to_le_bytes()
    });
    out.extend_from_slice(&body);
    out
}

/// 十进制采样率的 80 位扩展精度表示（AIFF 的 COMM 块用这个）。
fn ext80(rate: f64) -> [u8; 10] {
    if rate <= 0.0 {
        return [0; 10];
    }
    let mut mantissa_rate = rate;
    let mut exponent = 0i32;
    while mantissa_rate >= 2.0 {
        mantissa_rate /= 2.0;
        exponent += 1;
    }
    while mantissa_rate < 1.0 {
        mantissa_rate *= 2.0;
        exponent -= 1;
    }
    let be_exp = (16383 + exponent) as u16;
    let mantissa = (mantissa_rate * 9.223_372_036_854_775_808e18) as u64;
    let mut out = [0u8; 10];
    out[0] = ((be_exp >> 8) as u8) & 0x7F;
    out[1] = (be_exp & 0xFF) as u8;
    out[2..].copy_from_slice(&mantissa.to_be_bytes());
    out
}

fn aiff_file(aifc: bool, rate: f64, channels: u16, frames: u32, bits: u16, texts: &[(&str, &str)]) -> Vec<u8> {
    let mut comm = Vec::new();
    comm.extend_from_slice(&channels.to_be_bytes());
    comm.extend_from_slice(&frames.to_be_bytes());
    comm.extend_from_slice(&bits.to_be_bytes());
    comm.extend_from_slice(&ext80(rate));
    if aifc {
        comm.extend_from_slice(b"NONE");
        comm.extend_from_slice(&[0, 0]);
    }
    let mut body = if aifc { b"AIFC".to_vec() } else { b"AIFF".to_vec() };
    body.extend_from_slice(b"COMM");
    body.extend_from_slice(&(comm.len() as u32).to_be_bytes());
    body.extend_from_slice(&comm);
    for (id, text) in texts {
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(text.len() as u32).to_be_bytes());
        body.extend_from_slice(text.as_bytes());
        if text.len() % 2 == 1 {
            body.push(0);
        }
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"FORM");
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

fn apev2(tags: &[(&str, &str)]) -> Vec<u8> {
    let mut items = Vec::new();
    for (key, value) in tags {
        let payload = key.len() + 1 + value.len();
        items.extend_from_slice(&(payload as u32).to_le_bytes());
        items.extend_from_slice(&0u32.to_le_bytes());
        items.extend_from_slice(key.as_bytes());
        items.push(0);
        items.extend_from_slice(value.as_bytes());
    }
    let tag_size = items.len() as u32 + 32;
    let mut out = items;
    out.extend_from_slice(b"APETAGEX");
    out.extend_from_slice(&2000u32.to_le_bytes());
    out.extend_from_slice(&tag_size.to_le_bytes());
    out.extend_from_slice(&(tags.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // 不带标签头
    out.extend_from_slice(&[0u8; 8]);
    out
}

fn ape_file(header: &[u8], tags: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"MAC ");
    out.extend_from_slice(&3990u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // padding → 描述符从偏移 8 开始
    out.extend_from_slice(&52u32.to_le_bytes()); // descriptorBytes
    out.extend_from_slice(&(header.len() as u32).to_le_bytes()); // headerBytes
    out.extend_from_slice(&0u32.to_le_bytes()); // seekTableBytes
    out.extend_from_slice(&(header.len() as u32).to_le_bytes()); // headerDataBytes
    out.extend_from_slice(&1024u32.to_le_bytes()); // apeFrameDataBytes
    out.extend_from_slice(&0u32.to_le_bytes()); // apeFrameDataBytesHigh
    out.extend_from_slice(&0u32.to_le_bytes()); // terminatingDataBytes
    out.extend_from_slice(&[0u8; 16]); // md5
    out.extend_from_slice(header);
    out.extend_from_slice(&apev2(tags));
    out
}

fn asf_object(guid: &[u8; 16], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(guid);
    out.extend_from_slice(&((24 + body.len()) as u64).to_le_bytes());
    out.extend_from_slice(body);
    out
}

fn utf16(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

fn asf_file(rate: u32, channels: u16, bits: u16, play_100ns: u64, preroll_ms: u64, tags: &[(&str, &str)]) -> Vec<u8> {
    const FILE_PROP: [u8; 16] = [
        0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
    ];
    const STREAM_PROP: [u8; 16] = [
        0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
    ];
    const AUDIO_MEDIA: [u8; 16] = [
        0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
    ];
    const CONTENT_DESC: [u8; 16] = [
        0x33, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
    ];
    const EXT_CONTENT: [u8; 16] = [
        0x40, 0xA4, 0xD0, 0xD2, 0x07, 0xE3, 0xD2, 0x11, 0x97, 0xF0, 0x00, 0xA0, 0xC9, 0x5E, 0xA8, 0x50,
    ];

    // 文件属性：fileID(16) fileSize(8) creation(8) packets(8) play(8) send(8) preroll(8) flags(4)
    //           min(4) max(4) bitrate(4)
    let mut file_props = Vec::new();
    file_props.extend_from_slice(&[0u8; 16]);
    file_props.extend_from_slice(&0u64.to_le_bytes());
    file_props.extend_from_slice(&0u64.to_le_bytes());
    file_props.extend_from_slice(&1024u64.to_le_bytes());
    file_props.extend_from_slice(&play_100ns.to_le_bytes());
    file_props.extend_from_slice(&0u64.to_le_bytes());
    file_props.extend_from_slice(&preroll_ms.to_le_bytes());
    file_props.extend_from_slice(&2u32.to_le_bytes());
    file_props.extend_from_slice(&0u32.to_le_bytes());
    file_props.extend_from_slice(&0u32.to_le_bytes());
    file_props.extend_from_slice(&128000u32.to_le_bytes());

    // 流属性：streamType(16) errorCorrection(16) timeOffset(8) typeLen(4) ecLen(4) flags(2)
    //         reserved(4) + WAVEFORMATEX
    let mut wfx = Vec::new();
    wfx.extend_from_slice(&0x0161u16.to_le_bytes()); // WMA v2
    wfx.extend_from_slice(&channels.to_le_bytes());
    wfx.extend_from_slice(&rate.to_le_bytes());
    wfx.extend_from_slice(&(rate * channels as u32).to_le_bytes());
    wfx.extend_from_slice(&(channels * bits / 8).to_le_bytes());
    wfx.extend_from_slice(&bits.to_le_bytes());
    wfx.extend_from_slice(&0u16.to_le_bytes());
    let mut stream_props = Vec::new();
    stream_props.extend_from_slice(&AUDIO_MEDIA);
    stream_props.extend_from_slice(&[0u8; 16]);
    stream_props.extend_from_slice(&0u64.to_le_bytes());
    stream_props.extend_from_slice(&(wfx.len() as u32).to_le_bytes());
    stream_props.extend_from_slice(&0u32.to_le_bytes());
    stream_props.extend_from_slice(&1u16.to_le_bytes());
    stream_props.extend_from_slice(&0u32.to_le_bytes());
    stream_props.extend_from_slice(&wfx);

    // 内容描述：5 个 u16 长度 + 各自的 UTF-16LE 字符串
    let mut content = Vec::new();
    let text_keys: [(&str, &str); 5] = [
        ("title", "Morning Set"),
        ("artist", "Tyler Zhang"),
        ("copyright", "(c) 2026"),
        ("comment", "现场录音"),
        ("rating", ""),
    ];
    for (_, value) in text_keys {
        content.extend_from_slice(&(utf16(value).len() as u16).to_le_bytes());
    }
    for (_, value) in text_keys {
        content.extend_from_slice(&utf16(value));
    }

    // 扩展内容描述：count(u16) 然后 nameLen(u16) name valueType(u16) valueLen(u16) value
    let mut ext = Vec::new();
    ext.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    for (name, value) in tags {
        ext.extend_from_slice(&(utf16(name).len() as u16).to_le_bytes());
        ext.extend_from_slice(&0u16.to_le_bytes()); // 类型 0 = Unicode 字符串
        ext.extend_from_slice(&(utf16(value).len() as u16).to_le_bytes());
        ext.extend_from_slice(&utf16(name));
        ext.extend_from_slice(&utf16(value));
    }

    let mut objects = Vec::new();
    objects.extend(asf_object(&FILE_PROP, &file_props));
    objects.extend(asf_object(&STREAM_PROP, &stream_props));
    objects.extend(asf_object(&CONTENT_DESC, &content));
    objects.extend(asf_object(&EXT_CONTENT, &ext));

    let header_size = 30 + objects.len();
    let mut out = Vec::new();
    out.extend_from_slice(&[
        0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
    ]);
    out.extend_from_slice(&(header_size as u64).to_le_bytes());
    out.extend_from_slice(&4u32.to_le_bytes()); // 4 个子对象
    out.extend_from_slice(&[1, 2]);
    out.extend_from_slice(&objects);
    out
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

#[test]
fn wav_exposes_params_and_info_tags() {
    let bytes = wav_file(
        44100,
        2,
        16,
        1_587_600,
        &[
            ("INAM", "会议录音"),
            ("IART", "Tyler Zhang"),
            ("IPRD", "季度评审"),
            ("ICRD", "2026-05-04"),
            ("IGNR", "Ambient"),
        ],
        false,
    );
    let p = probe(&bytes, &[]).expect("WAV 必须被识别");
    assert_eq!(p.format, "WAV 无损音频");
    assert_eq!(p.sample_rate, Some(44100));
    assert_eq!(p.channels, Some(2));
    assert_eq!(p.bits, Some(16));
    // 1,587,600 B / 176,400 Bps = 9 秒
    assert_eq!(p.duration_ms, Some(9000));
    assert_eq!(field(&p, "title"), Some("会议录音"));
    assert_eq!(field(&p, "artist"), Some("Tyler Zhang"));
    assert_eq!(field(&p, "album"), Some("季度评审"));
    assert_eq!(field(&p, "year"), Some("2026"), "年份只留四位");
    assert_eq!(field(&p, "genre"), Some("Ambient"));
    assert!(p.warnings.is_empty(), "干净的 WAV 不该有警告：{}", warnings(&p));
}

#[test]
fn wav_info_in_tail_is_read() {
    // 头部只有 fmt + data（标签写在数据之后，超出头部读取窗口），尾部窗口能捡到 LIST/INFO
    let head = wav_file(48000, 2, 24, 480_000, &[], false);
    let tail = wav_file(48000, 2, 24, 480_000, &[("INAM", "尾部标题")], false);
    let p = probe(&head, &tail).expect("WAV 必须被识别");
    assert_eq!(field(&p, "title"), Some("尾部标题"), "尾部 LIST/INFO 必须被读到");
    assert_eq!(p.sample_rate, Some(48000));
}

#[test]
fn wav_rf64_reads_ds64_sizes() {
    let bytes = wav_file(48000, 6, 24, 576_000, &[], true);
    let p = probe(&bytes, &[]).expect("RF64 必须被识别");
    assert_eq!(p.format, "WAV 大音频（RF64）");
    assert_eq!(p.sample_rate, Some(48000));
    assert_eq!(p.channels, Some(6));
    // byte_rate = 48000 * 6 * 3 = 864,000；576,000 B → 0.66 s → 666 ms
    assert_eq!(p.duration_ms, Some(666));
}

// ---------------------------------------------------------------------------
// AIFF / AIFC
// ---------------------------------------------------------------------------

#[test]
fn aiff_reads_comm_and_text_blocks() {
    let bytes = aiff_file(
        false,
        44100.0,
        2,
        132_300,
        16,
        &[("NAME", "采样大会"), ("AUTH", "Tyler Zhang")],
    );
    let p = probe(&bytes, &[]).expect("AIFF 必须被识别");
    assert_eq!(p.format, "AIFF 音频");
    assert_eq!(p.sample_rate, Some(44100));
    assert_eq!(p.channels, Some(2));
    assert_eq!(p.bits, Some(16));
    assert_eq!(p.duration_ms, Some(3000), "132300 帧 / 44100 = 3 秒");
    assert_eq!(field(&p, "title"), Some("采样大会"));
    assert_eq!(field(&p, "artist"), Some("Tyler Zhang"));
}

#[test]
fn aifc_reports_compression_type() {
    let bytes = aiff_file(true, 48000.0, 1, 48_000, 16, &[("NAME", "单声道样片")]);
    let p = probe(&bytes, &[]).expect("AIFC 必须被识别");
    assert_eq!(p.format, "AIFC 音频");
    assert_eq!(p.sample_rate, Some(48000));
    assert_eq!(p.channels, Some(1));
    assert_eq!(field(&p, "codec"), Some("NONE"));
}

// ---------------------------------------------------------------------------
// APE
// ---------------------------------------------------------------------------

#[test]
fn ape_with_plain_wav_header_reads_params_and_apEv2_tags() {
    let wav_header = wav_file(44100, 2, 16, 883_000, &[], false);
    let file = ape_file(
        &wav_header,
        &[
            ("Title", "APE 曲目"),
            ("Artist", "Tyler"),
            ("Album", "无损集"),
            ("Year", "2026"),
        ],
    );
    // 真实文件里标签在末尾：把最后 512 字节当尾部窗口
    let tail = &file[file.len().saturating_sub(512)..];
    let p = probe(&file, tail).expect("APE 必须被识别");
    assert_eq!(p.format, "APE 无损音频（Monkey's Audio）");
    assert_eq!(p.sample_rate, Some(44100));
    assert_eq!(p.channels, Some(2));
    assert_eq!(p.bits, Some(16));
    assert_eq!(field(&p, "title"), Some("APE 曲目"));
    assert_eq!(field(&p, "artist"), Some("Tyler"));
    assert_eq!(field(&p, "album"), Some("无损集"));
    assert_eq!(field(&p, "year"), Some("2026"));
}

#[test]
fn ape_with_compressed_header_says_so_instead_of_guessing() {
    let file = ape_file(b"\x00\x01\x02compressed", &[("Title", "只有标签")]);
    let tail = &file[file.len().saturating_sub(256)..];
    let p = probe(&file, tail).expect("APE 必须被识别");
    assert_eq!(p.sample_rate, None, "头数据是压缩的，不许编一个采样率");
    assert_eq!(p.channels, None);
    assert!(
        warnings(&p).contains("需要解码器"),
        "必须说清为什么读不到：{}",
        warnings(&p)
    );
    assert_eq!(field(&p, "title"), Some("只有标签"));
}

// ---------------------------------------------------------------------------
// ASF / WMA
// ---------------------------------------------------------------------------

#[test]
fn wma_reads_params_duration_and_both_content_blocks() {
    // 播放时长 123 秒（100ns 单位），pre-roll 2000ms
    let bytes = asf_file(
        44100,
        2,
        16,
        1_230_000_000,
        2000,
        &[("WM/AlbumTitle", "ASF 专辑"), ("WM/Genre", "Vocal")],
    );
    let p = probe(&bytes, &[]).expect("ASF 必须被识别");
    assert_eq!(p.format, "WMA 音频（ASF 容器）");
    assert_eq!(p.sample_rate, Some(44100));
    assert_eq!(p.channels, Some(2));
    assert_eq!(p.bits, Some(16));
    assert_eq!(p.duration_ms, Some(121_000), "播放时长减去 pre-roll");
    assert_eq!(field(&p, "title"), Some("Morning Set"));
    assert_eq!(field(&p, "artist"), Some("Tyler Zhang"));
    assert_eq!(field(&p, "comment"), Some("现场录音"));
    assert_eq!(field(&p, "album"), Some("ASF 专辑"));
    assert_eq!(field(&p, "genre"), Some("Vocal"));
}

#[test]
fn truncated_asf_does_not_panic() {
    let full = asf_file(48000, 2, 16, 60_000_000, 0, &[]);
    let cut = &full[..full.len().min(40)];
    let p = probe(cut, &[]).expect("带头部魔数就必须认出来");
    assert!(warnings(&p).contains("时长未解析") || warnings(&p).contains("长度异常"));
}

// ---------------------------------------------------------------------------
// 边界与接线
// ---------------------------------------------------------------------------

#[test]
fn unknown_bytes_are_not_claimed_as_audio() {
    assert!(probe(b"not an audio container at all", &[]).is_none());
    assert!(probe(&[0u8; 4], &[]).is_none());
}

#[test]
fn read_metadata_exposes_audio_fields_and_feeds_rename_values() {
    let t = Temp::new("wav");
    let path = t.file(
        "会议录音.wav",
        &wav_file(
            44100,
            2,
            16,
            1_058_400,
            &[
                ("INAM", "季度评审记录"),
                ("IART", "Tyler Zhang"),
                ("IPRD", "2026 Q2"),
                ("ICRD", "2026-05-04"),
                ("IGNR", "Speech"),
            ],
            false,
        ),
    );
    let info = read_metadata(&path).expect("读元数据");
    assert_eq!(info.kind, "audio");
    assert_eq!(info.format, "WAV 无损音频");
    let labels: Vec<&str> = info.fields.iter().map(|f| f.label.as_str()).collect();
    assert!(labels.contains(&"采样率"));
    assert!(labels.contains(&"声道"));
    assert!(labels.contains(&"时长"));
    assert!(labels.contains(&"标题"));
    let values = rename_field_values(&info);
    assert_eq!(values.title, "季度评审记录");
    assert_eq!(values.artist, "Tyler Zhang");
    assert_eq!(values.album, "2026 Q2");
    assert_eq!(values.year, "2026");
    assert_eq!(values.genre, "Speech");
}
