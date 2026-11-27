//! 按文件头魔数嗅探「真实扩展名」，供扩展名规则的「智能分析」使用。
//!
//! 只读文件头（前 64 字节），不做全文解码、不依赖外部库；识别不出来就返回 `None`，
//! 让规则保持原名，而不是把扩展名改成一个猜出来的值。

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// 读取文件头时最多读多少字节。
///
/// 常见容器都落在前 64 字节内；PE 的 `PE\0\0` 签名在 `e_lfanew`（通常 0x80）处，
/// 因此放宽到 1 KiB 才能把 EXE / DLL 分开而不是只按 `MZ` 猜。
const HEAD_LEN: usize = 1024;

/// 按文件头字节判定扩展名。`head` 可以是文件开头若干字节，允许短于 12 字节。
///
/// 返回的扩展名一律小写、不含点，与 `split_name` 里的 `ext` 口径一致；
/// 判定不了（含空 / 非魔数文本）返回 `None`。
pub fn sniff_magic(head: &[u8]) -> Option<&'static str> {
    fn at(head: &[u8], start: usize, len: usize) -> Option<&[u8]> {
        head.get(start..start + len)
    }

    // JPEG：SOI + 首个标记
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    // PNG：8 字节签名
    if head.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    // GIF87a / GIF89a
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some("gif");
    }
    // BMP：BM + 保留字
    if head.starts_with(&[0x42, 0x4D]) {
        return Some("bmp");
    }
    // TIFF：小端 II*\0 / 大端 MM\0*
    if head.starts_with(&[0x49, 0x49, 0x2A, 0x00]) || head.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
        return Some("tif");
    }
    // RIFF 家族：WEBP / WAV / AVI 靠 FORM 类型区分
    if head.starts_with(b"RIFF") {
        return match at(head, 8, 4) {
            Some(b"WEBP") => Some("webp"),
            Some(b"WAVE") => Some("wav"),
            Some(b"AVI ") => Some("avi"),
            _ => None,
        };
    }
    // AIFF/AIFC 与 WAV 同属 IFF 家族，但用大端 FORM
    if head.starts_with(b"FORM") {
        return match at(head, 8, 4) {
            Some(b"AIFF") | Some(b"AIFC") => Some("aiff"),
            _ => None,
        };
    }
    // Monkey's Audio 与 WMA（ASF 容器）的魔数
    if head.starts_with(b"MAC ") {
        return Some("ape");
    }
    if head.starts_with(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) {
        return Some("wma");
    }
    // PE：`MZ` 之后按 e_lfanew 找 `PE\0\0`，再按 COFF 头特性位区分 EXE / DLL
    if head.starts_with(b"MZ") {
        let lfanew = at(head, 0x3C, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
        if let Some(off) = lfanew.filter(|off| *off > 0 && *off + 24 <= head.len()) {
            if at(head, off, 4) == Some(b"PE\0\0") {
                let characteristics = at(head, off + 22, 2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .unwrap_or(0);
                return Some(if characteristics & 0x2000 != 0 { "dll" } else { "exe" });
            }
        }
        return None;
    }
    // 字体：TrueType 集合 / CFF 轮廓的 OpenType / TrueType（含 Apple `true` 与 Type 1 封装）
    if head.starts_with(b"ttcf") {
        return Some("ttc");
    }
    if head.starts_with(b"OTTO") {
        return Some("otf");
    }
    if head.starts_with(&[0x00, 0x01, 0x00, 0x00])
        || head.starts_with(b"true")
        || head.starts_with(b"typ1")
    {
        return Some("ttf");
    }
    // ftyp 家族：MP4 / M4A / MOV / HEIC / AVIF
    if at(head, 4, 4) == Some(b"ftyp") {
        return match at(head, 8, 4) {
            Some(b"M4A ") => Some("m4a"),
            Some(b"qt  ") => Some("mov"),
            Some(b"avif") | Some(b"avis") => Some("avif"),
            Some(b"heic") | Some(b"heix") | Some(b"hevc") | Some(b"hevx") | Some(b"heim")
            | Some(b"heis") | Some(b"hevm") | Some(b"hevs") | Some(b"mif1") | Some(b"mif2")
            | Some(b"msf1") => Some("heic"),
            _ => Some("mp4"),
        };
    }
    if head.starts_with(b"%PDF") {
        return Some("pdf");
    }
    // ZIP 容器（docx / xlsx / apk 都落在这里，不深挖内部结构，避免猜错）
    if head.starts_with(&[0x50, 0x4B, 0x03, 0x04]) || head.starts_with(&[0x50, 0x4B, 0x05, 0x06]) {
        return Some("zip");
    }
    if head.starts_with(&[0x1F, 0x8B]) {
        return Some("gz");
    }
    if head.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return Some("7z");
    }
    if head.starts_with(&[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]) {
        return Some("rar");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    // MP3：ID3 标签头，或无标签时帧同步字（FFEx / FFFx）
    if head.starts_with(b"ID3") {
        return Some("mp3");
    }
    if let Some(b0b1) = at(head, 0, 2) {
        if b0b1[0] == 0xFF && (b0b1[1] & 0xE0) == 0xE0 {
            return Some("mp3");
        }
    }
    None
}

/// 读取文件头并判定真实扩展名；读失败或识别不出都返回 `None`。
pub fn sniff_extension(path: &Path) -> Option<&'static str> {
    let mut file = File::open(path).ok()?;
    let mut head = Vec::with_capacity(HEAD_LEN);
    // `take` 保证在短文件上只读实际存在的字节，不会因为长度不足而报错
    file.by_ref().take(HEAD_LEN as u64).read_to_end(&mut head).ok()?;
    if head.is_empty() {
        return None;
    }
    sniff_magic(&head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 写一个临时文件（文件名带纳秒时间戳，避开并发测试撞名）。
    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-sniff-{stamp}"));
        fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join(name);
        fs::write(&path, bytes).expect("写临时文件");
        path
    }

    const PNG_HEAD: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D];

    #[test]
    fn magic_covers_common_formats() {
        assert_eq!(sniff_magic(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_magic(PNG_HEAD), Some("png"));
        assert_eq!(sniff_magic(b"GIF89a\x01\x00"), Some("gif"));
        assert_eq!(sniff_magic(b"GIF87a\x01\x00"), Some("gif"));
        assert_eq!(sniff_magic(b"BM\x36\x00\x00\x00"), Some("bmp"));
        assert_eq!(sniff_magic(&[0x49, 0x49, 0x2A, 0x00]), Some("tif"));
        assert_eq!(sniff_magic(&[0x4D, 0x4D, 0x00, 0x2A]), Some("tif"));
        assert_eq!(sniff_magic(b"%PDF-1.7"), Some("pdf"));
        assert_eq!(sniff_magic(&[0x50, 0x4B, 0x03, 0x04]), Some("zip"));
        assert_eq!(sniff_magic(&[0x1F, 0x8B, 0x08]), Some("gz"));
        assert_eq!(sniff_magic(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]), Some("7z"));
        assert_eq!(sniff_magic(&[0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00]), Some("rar"));
        assert_eq!(sniff_magic(b"fLaC\x00\x00"), Some("flac"));
        assert_eq!(sniff_magic(b"OggS\x00\x02"), Some("ogg"));
        assert_eq!(sniff_magic(b"ID3\x04\x00"), Some("mp3"));
        assert_eq!(sniff_magic(&[0xFF, 0xFB, 0x90, 0x00]), Some("mp3"));
    }

    #[test]
    fn riff_and_ftyp_families_are_split_by_brand() {
        assert_eq!(sniff_magic(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_magic(b"RIFF\x24\x00\x00\x00WAVEfmt "), Some("wav"));
        assert_eq!(sniff_magic(b"FORM\x00\x00\x01\x0eAIFFCOMM"), Some("aiff"));
        assert_eq!(sniff_magic(b"FORM\x00\x00\x01\x0eAIFCCOMM"), Some("aiff"));
        assert_eq!(sniff_magic(b"MAC \x9a\x0f\x00\x00\x00\x00"), Some("ape"));
        assert_eq!(
            sniff_magic(&[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA]),
            Some("wma")
        );
        assert_eq!(sniff_magic(b"RIFF\x24\x00\x00\x00AVI LIST"), Some("avi"));
        assert_eq!(sniff_magic(b"RIFF\x24\x00\x00\x00XXXXVP8 "), None);
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypmp42"), Some("mp4"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypisom"), Some("mp4"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypM4A "), Some("m4a"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x14ftypqt  "), Some("mov"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypheic"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypmif1"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypmif2"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypmsf1"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftyphevc"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftyphevx"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypheis"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypheim"), Some("heic"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x1cftypavif"), Some("avif"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x1cftypavis"), Some("avif"));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x18ftypavifav01"), Some("avif"));
    }

    #[test]
    fn unknown_and_short_heads_are_none() {
        assert_eq!(sniff_magic(b""), None);
        assert_eq!(sniff_magic(b"\x00"), None);
        assert_eq!(sniff_magic(b"RIFF"), None); // 只有容器头、没有 FORM 类型
        assert_eq!(sniff_magic(b"ftyp"), None); // 偏移 0 的 ftyp 不是合法 MP4
        assert_eq!(sniff_magic(b"hello world"), None);
        assert_eq!(sniff_magic(b"{ \"a\": 1 }"), None);
        // FF D8 FF 之外的两个字节容易误判，确认只认 SOI 三字节
        assert_eq!(sniff_magic(&[0xFF, 0xD8]), None);
    }

    #[test]
    fn sniffs_real_files_by_head() {
        // 扩展名故意写错：内容是 PNG，名字是 .jpg
        let png = temp_file("renamed.jpg", &[PNG_HEAD, b"\x00\x00\x00\x00"].concat());
        assert_eq!(sniff_extension(&png), Some("png"));

        let jpg = temp_file("真实JPEG.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F']);
        assert_eq!(sniff_extension(&jpg), Some("jpg"));

        let mp4 = temp_file("clip.bin", b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00");
        assert_eq!(sniff_extension(&mp4), Some("mp4"));

        // 空文件、纯文本都识别不出 → None（规则会保持原名）
        let empty = temp_file("empty.txt", b"");
        assert_eq!(sniff_extension(&empty), None);
        let text = temp_file("note.txt", b"just some plain text, no magic here");
        assert_eq!(sniff_extension(&text), None);

        // 不存在 / 不可读的文件不 panic
        let missing = png.with_file_name("nope-not-here.jpg");
        assert_eq!(sniff_extension(&missing), None);

        if let Some(dir) = png.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}
