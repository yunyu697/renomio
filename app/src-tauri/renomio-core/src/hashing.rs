//! 名称元变量用的内容哈希：CRC32 / MD5 / SHA-1。
//! 全部为纯 Rust 实现（不引入额外依赖），单遍流式读取，三种算法同时计算；
//! 支持逐块检查取消标记，适合大批量文件。

use std::fs::File;
use std::io::Read;
use std::path::Path;

// ---------------------------------------------------------------------------
// CRC32（IEEE 802.3，反射多项式 0xEDB88320）
// ---------------------------------------------------------------------------

const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

struct Crc32 {
    state: u32,
}

impl Crc32 {
    fn new() -> Self {
        Self { state: 0xFFFF_FFFF }
    }

    fn update(&mut self, data: &[u8]) {
        let mut crc = self.state;
        for &b in data {
            crc = CRC_TABLE[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
        }
        self.state = crc;
    }

    fn finish(&self) -> u32 {
        self.state ^ 0xFFFF_FFFF
    }
}

// ---------------------------------------------------------------------------
// MD5（RFC 1321）
// ---------------------------------------------------------------------------

const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

struct Md5 {
    state: [u32; 4],
    block: [u8; 64],
    filled: usize,
    len: u64,
}

impl Md5 {
    fn new() -> Self {
        Self {
            state: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476],
            block: [0; 64],
            filled: 0,
            len: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        if self.filled > 0 {
            let need = 64 - self.filled;
            let take = need.min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
        while data.len() >= 64 {
            let (head, rest) = data.split_at(64);
            let mut block = [0u8; 64];
            block.copy_from_slice(head);
            self.compress(&block);
            data = rest;
        }
        if !data.is_empty() {
            self.block[..data.len()].copy_from_slice(data);
            self.filled = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        let [mut a, mut b, mut c, mut d] = self.state;
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(f)
                .wrapping_add(MD5_K[i])
                .wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(MD5_S[i]));
            a = tmp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }

    fn finish(self) -> [u8; 16] {
        let len = self.len;
        let mut tail: Vec<u8> = Vec::with_capacity(72);
        tail.push(0x80u8);
        let rem = ((len + 1) % 64) as usize;
        let zeros = if rem <= 56 { 56 - rem } else { 120 - rem };
        tail.extend(std::iter::repeat(0u8).take(zeros));
        tail.extend_from_slice(&len.wrapping_mul(8).to_le_bytes());
        let mut h = self;
        h.len = 0;
        h.update(&tail);
        let mut out = [0u8; 16];
        for (i, v) in h.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        out
    }
}

// ---------------------------------------------------------------------------
// SHA-1（FIPS 180-4）
// ---------------------------------------------------------------------------

struct Sha1 {
    state: [u32; 5],
    block: [u8; 64],
    filled: usize,
    len: u64,
}

impl Sha1 {
    fn new() -> Self {
        Self {
            state: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0],
            block: [0; 64],
            filled: 0,
            len: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        if self.filled > 0 {
            let need = 64 - self.filled;
            let take = need.min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
        while data.len() >= 64 {
            let (head, rest) = data.split_at(64);
            let mut block = [0u8; 64];
            block.copy_from_slice(head);
            self.compress(&block);
            data = rest;
        }
        if !data.is_empty() {
            self.block[..data.len()].copy_from_slice(data);
            self.filled = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = self.state;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
    }

    fn finish(self) -> [u8; 20] {
        let len = self.len;
        let mut tail: Vec<u8> = Vec::with_capacity(72);
        tail.push(0x80u8);
        let rem = ((len + 1) % 64) as usize;
        let zeros = if rem <= 56 { 56 - rem } else { 120 - rem };
        tail.extend(std::iter::repeat(0u8).take(zeros));
        tail.extend_from_slice(&len.wrapping_mul(8).to_be_bytes());
        let mut h = self;
        h.len = 0;
        h.update(&tail);
        let mut out = [0u8; 20];
        for (i, v) in h.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 文件流式哈希
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashes {
    pub crc32: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub size: u64,
}

/// 单遍流式读取，按需计算；`cancel` 每块检查一次，返回 Err("已取消")。
pub fn file_hashes(
    path: &Path,
    want_crc32: bool,
    want_md5: bool,
    want_sha1: bool,
    cancel: &dyn Fn() -> bool,
) -> Result<FileHashes, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if !meta.is_file() {
        return Err("不是文件（目录不参与哈希）".into());
    }
    let mut file = File::open(path).map_err(|e| format!("无法打开文件：{e}"))?;
    let mut crc = Crc32::new();
    let mut md5 = Md5::new();
    let mut sha1 = Sha1::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut size = 0u64;
    loop {
        if cancel() {
            return Err("已取消".into());
        }
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if want_crc32 {
            crc.update(&buf[..n]);
        }
        if want_md5 {
            md5.update(&buf[..n]);
        }
        if want_sha1 {
            sha1.update(&buf[..n]);
        }
    }
    Ok(FileHashes {
        crc32: want_crc32.then(|| hex(&crc.finish().to_be_bytes())),
        md5: want_md5.then(|| hex(&md5.finish())),
        sha1: want_sha1.then(|| hex(&sha1.finish())),
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_known_vector() {
        let mut crc = Crc32::new();
        crc.update(b"123456789");
        assert_eq!(crc.finish(), 0xCBF4_3926);
        assert_eq!(hex(&crc.finish().to_be_bytes()), "cbf43926");
    }

    #[test]
    fn md5_known_vectors() {
        let empty = Md5::new();
        assert_eq!(hex(&empty.finish()), "d41d8cd98f00b204e9800998ecf8427e");
        let mut abc = Md5::new();
        abc.update(b"abc");
        assert_eq!(hex(&abc.finish()), "900150983cd24fb0d6963f7d28e17f72");
        let mut h2 = Md5::new();
        h2.update(b"12345678901234567890123456789012345678901234567890123456789012345678901234567890");
        assert_eq!(hex(&h2.finish()), "57edf4a22be3c955ac49da2e2107b67a");
    }

    #[test]
    fn md5_chunked_equals_whole() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let mut whole = Md5::new();
        whole.update(&data);
        let mut chunked = Md5::new();
        for chunk in data.chunks(97) {
            chunked.update(chunk);
        }
        assert_eq!(hex(&whole.finish()), hex(&chunked.finish()));
    }

    #[test]
    fn sha1_known_vectors() {
        let empty = Sha1::new();
        assert_eq!(hex(&empty.finish()), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        let mut abc = Sha1::new();
        abc.update(b"abc");
        assert_eq!(hex(&abc.finish()), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn sha1_chunked_equals_whole() {
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 253) as u8).collect();
        let mut whole = Sha1::new();
        whole.update(&data);
        let mut chunked = Sha1::new();
        for chunk in data.chunks(63) {
            chunked.update(chunk);
        }
        assert_eq!(hex(&whole.finish()), hex(&chunked.finish()));
    }

    #[test]
    fn file_hashes_matches_memory_and_cancel() {
        let dir = std::env::temp_dir().join(format!("renomio-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.bin");
        std::fs::write(&path, b"abc").unwrap();
        let got = file_hashes(&path, true, true, true, &|| false).unwrap();
        assert_eq!(got.crc32.as_deref(), Some("352441c2"));
        assert_eq!(got.md5.as_deref(), Some("900150983cd24fb0d6963f7d28e17f72"));
        assert_eq!(got.sha1.as_deref(), Some("a9993e364706816aba3e25717850c26c9cd0d89d"));
        assert_eq!(got.size, 3);
        let cancelled = file_hashes(&path, true, false, false, &|| true);
        assert!(cancelled.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
