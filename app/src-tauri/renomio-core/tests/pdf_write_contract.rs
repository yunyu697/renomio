//! PDF **写回**契约测试：xref 流（PDF 1.5+）文件的增量更新。
//!
//! 夹具全部现场构造，不下载样本：1 号 Catalog、可选 Info、可选 ObjStm，末节用未压缩的
//! `/Type /XRef` 流收尾。断言走真实链路 `metaedit::edit`（含备份/原子替换/回读校验）
//! 与 `metaedit::snapshot`、`pdf::probe` 双重复核。
//! 覆盖：xor 流写回往返、旧 Info 字段保留、经典 xref 表回归、加密拒写、
//! startxref 指向非 xref、Info 位于对象流时告警、Catalog 位于对象流时明确拒绝。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use renomio_core::metaedit::{self, MetaEditRequest};
use renomio_core::pdf;

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("renomio-pdfwrite-{stamp}-{name}"));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn edit(path: &str, fields: &[(&str, &str)]) -> metaedit::MetaEditResult {
    let map: BTreeMap<String, String> = fields
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    metaedit::edit(&MetaEditRequest {
        path: path.to_string(),
        fields: map,
        cover_path: None,
        clear_cover: false,
        backup: false,
    })
}

fn value(path: &str, id: &str) -> String {
    metaedit::snapshot(path)
        .map(|s| s.fields.get(id).cloned().unwrap_or_default())
        .unwrap_or_default()
}

/// 构造一份用 xref 流收尾的 PDF 1.5。
/// `objects` 按 1 号起始顺序直写；`compressed` 里的 (对象号, 对象流号, 序号) 写成 type 2 条目；
/// `extra_trailer` 追加到 xref 流字典里（例如 `/Encrypt ...`）。
fn xref_stream_pdf(objects: &[String], compressed: &[(u32, u32, u32)], extra_trailer: &str) -> Vec<u8> {
    let mut buf = b"%PDF-1.5\n".to_vec();
    let mut offs = vec![0u32; objects.len() + 1];
    for (i, body) in objects.iter().enumerate() {
        offs[i + 1] = buf.len() as u32;
        buf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let stm_num = objects.len() as u32 + 1;
    let size = stm_num + 1;
    let xref_at = buf.len();
    // /W [1 2 2]：类型 1 字节、偏移 2 字节、代次 2 字节；不压缩，直接写裸字节。
    let mut rows: Vec<u8> = Vec::new();
    for num in 0..size {
        let mut r = [0u8; 5];
        if num == 0 {
            r[3] = 0xff;
            r[4] = 0xff;
            rows.extend_from_slice(&r);
            continue;
        }
        if let Some(idx) = compressed.iter().find(|c| c.0 == num) {
            r[0] = 2;
            r[1] = (idx.1 >> 8) as u8;
            r[2] = idx.1 as u8;
            r[3] = 0;
            r[4] = idx.2 as u8;
            rows.extend_from_slice(&r);
            continue;
        }
        if let Some(off) = offs.get(num as usize) {
            if *off > 0 {
                r[0] = 1;
                r[1] = (*off >> 8) as u8;
                r[2] = *off as u8;
            }
        }
        rows.extend_from_slice(&r);
    }
    buf.extend_from_slice(
        format!(
            "{stm_num} 0 obj\n<< /Type /XRef /Size {size} /Root 1 0 R /W [1 2 2] /Length {}{extra_trailer} >>\nstream\n",
            rows.len()
        )
        .as_bytes(),
    );
    buf.extend_from_slice(&rows);
    buf.extend_from_slice(b"\nendstream\nendobj\n");
    buf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());
    buf
}

fn catalog(pages: u32) -> String {
    format!("<< /Type /Catalog /Pages 2 0 R /Marker ({pages}) >>")
}

fn pages() -> String {
    "<< /Type /Pages /Kids [] /Count 0 >>".to_string()
}

#[test]
fn xref_stream_pdf_accepts_title_write() {
    let dir = TempDir::new("xref-stm");
    let bytes = xref_stream_pdf(&[catalog(0), pages()], &[], "");
    let path = dir.write("论文.pdf", &bytes);
    let result = edit(&path, &[("title", "新标题"), ("author", "张三")]);
    assert!(result.ok, "xref 流 PDF 应可写：{:?}", result.error);
    assert!(result.verified, "写回后回读必须一致");
    assert_eq!(value(&path, "title"), "新标题");
    assert_eq!(value(&path, "author"), "张三");
    let p = pdf::probe(&fs::read(&path).unwrap()).expect("写回后仍是合法 PDF");
    assert!(p.xref.contains("xref 表"), "增量节应是经典 xref 表：{}", p.xref);
    assert!(p.xref.contains("流"), "旧节仍是 xref 流：{}", p.xref);
}

#[test]
fn xref_stream_pdf_keeps_old_info_fields() {
    let dir = TempDir::new("xref-info");
    let info = "2 0 obj\n<< /Producer (Old Producer) /CreationDate (D:20240101000000Z) >>\nendobj\n";
    // 用直写方式把 Info 放在 2 号，再让 xref 流字典带上 /Info 2 0 R。
    let mut buf = b"%PDF-1.5\n".to_vec();
    let off1 = buf.len();
    buf.extend_from_slice(format!("1 0 obj\n{}\nendobj\n", catalog(0)).as_bytes());
    let off2 = buf.len();
    buf.extend_from_slice(info.as_bytes());
    let stm_num = 3u32;
    let size = 4u32;
    let xref_at = buf.len();
    let mut rows = vec![0u8; 5];
    rows[3] = 0xff;
    rows[4] = 0xff;
    for off in [off1 as u16, off2 as u16] {
        let mut r = [0u8; 5];
        r[0] = 1;
        r[1] = (off >> 8) as u8;
        r[2] = off as u8;
        rows.extend_from_slice(&r);
    }
    let mut r = [0u8; 5];
    r[0] = 1;
    r[1] = (xref_at >> 8) as u8;
    r[2] = xref_at as u8;
    rows.extend_from_slice(&r);
    buf.extend_from_slice(
        format!(
            "{stm_num} 0 obj\n<< /Type /XRef /Size {size} /Root 1 0 R /Info 2 0 R /W [1 2 2] /Length {} >>\nstream\n",
            rows.len()
        )
        .as_bytes(),
    );
    buf.extend_from_slice(&rows);
    buf.extend_from_slice(b"\nendstream\nendobj\n");
    buf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());

    let path = dir.write("保留.pdf", &buf);
    let result = edit(&path, &[("title", "只改标题")]);
    assert!(result.ok, "{:?}", result.error);
    let p = pdf::probe(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        p.info.get("Producer").map(|s| s.as_str()),
        Some("Old Producer"),
        "旧 Info 字段必须保留：{:?}",
        p.info
    );
    assert_eq!(p.info.get("Title").map(|s| s.as_str()), Some("只改标题"));
}

#[test]
fn classic_xref_table_still_writes() {
    let dir = TempDir::new("classic");
    let mut buf = b"%PDF-1.4\n".to_vec();
    let off1 = buf.len();
    buf.extend_from_slice(format!("1 0 obj\n{}\nendobj\n", catalog(0)).as_bytes());
    let off2 = buf.len();
    buf.extend_from_slice(format!("2 0 obj\n{}\nendobj\n", pages()).as_bytes());
    let xref_at = buf.len();
    buf.extend_from_slice(b"xref\n0 3\n0000000000 65535 f \n");
    buf.extend_from_slice(format!("{off1:010} 00000 n \n{off2:010} 00000 n \n").as_bytes());
    buf.extend_from_slice(
        format!("trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n").as_bytes(),
    );
    let path = dir.write("经典.pdf", &buf);
    let result = edit(&path, &[("subject", "主题")]);
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(value(&path, "subject"), "主题");
}

#[test]
fn encrypted_xref_stream_is_rejected() {
    let dir = TempDir::new("xref-enc");
    let bytes = xref_stream_pdf(
        &[catalog(0), pages()],
        &[],
        " /Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>",
    );
    let path = dir.write("加密.pdf", &bytes);
    let before = fs::read(&path).unwrap();
    let result = edit(&path, &[("title", "不该写进去")]);
    assert!(!result.ok);
    assert!(
        result.error.as_deref().unwrap_or("").contains("加密"),
        "应给出加密说明：{:?}",
        result.error
    );
    assert_eq!(fs::read(&path).unwrap(), before, "被拒绝时不得改动文件");
}

#[test]
fn startxref_pointing_at_plain_object_is_rejected() {
    let dir = TempDir::new("bad-startxref");
    let mut buf = b"%PDF-1.4\n".to_vec();
    let off1 = buf.len();
    buf.extend_from_slice(format!("1 0 obj\n{}\nendobj\n", catalog(0)).as_bytes());
    buf.extend_from_slice(format!("startxref\n{off1}\n%%EOF\n").as_bytes());
    let path = dir.write("坏指针.pdf", &buf);
    let result = edit(&path, &[("title", "x")]);
    assert!(!result.ok);
    assert!(
        result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("xref 流"),
        "{:?}",
        result.error
    );
}

#[test]
fn info_inside_object_stream_keeps_old_fields() {
    let dir = TempDir::new("xref-objstm");
    let members = "<< /Producer (Streamed Producer) >>";
    let header = format!("6 0 ");
    let objstm = format!(
        "<< /Type /ObjStm /N 1 /First {} /Length {} >>\nstream\n{}{}\nendstream",
        header.len(),
        header.len() + members.len(),
        header,
        members
    );
    // 1 Catalog、2 Pages、3 ObjStm、4 占位（让 xref 流落在 5 号），6 号 Info 只存在对象流里。
    let bytes = xref_stream_pdf(
        &[catalog(0), pages(), objstm, "<< /Filler true >>".to_string()],
        &[(6, 3, 0)],
        " /Info 6 0 R",
    );
    let path = dir.write("对象流Info.pdf", &bytes);
    let result = edit(&path, &[("title", "新标题")]);
    assert!(result.ok, "{:?}", result.error);
    assert!(
        !result.warnings.iter().any(|w| w.contains("对象流")),
        "对象流里的 Info 已经能解，不该再报警告：{:?}",
        result.warnings
    );
    let p = pdf::probe(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        p.info.get("Producer").map(|s| s.as_str()),
        Some("Streamed Producer"),
        "对象流里的旧 Info 字段必须保留：{:?}",
        p.info
    );
    assert_eq!(value(&path, "title"), "新标题");
}

#[test]
fn unsupported_object_stream_filter_still_warns() {
    let dir = TempDir::new("xref-objstm-lzw");
    let members = "<< /Producer (LZW Producer) >>";
    let header = "8 0 ".to_string();
    let objstm = format!(
        "<< /Type /ObjStm /N 1 /First {} /Length {} /Filter /LZWDecode >>\nstream\n{}{}\nendstream",
        header.len(),
        header.len() + members.len(),
        header,
        members
    );
    let bytes = xref_stream_pdf(
        &[catalog(0), pages(), objstm, "<< /Filler true >>".to_string()],
        &[(8, 3, 0)],
        " /Info 8 0 R",
    );
    let path = dir.write("对象流LZW.pdf", &bytes);
    let result = edit(&path, &[("title", "新标题")]);
    assert!(result.ok, "{:?}", result.error);
    assert!(
        result.warnings.iter().any(|w| w.contains("对象流")),
        "不支持的流编码要明确告警：{:?}",
        result.warnings
    );
    assert_eq!(value(&path, "title"), "新标题");
}

#[test]
fn catalog_inside_object_stream_is_written() {
    let dir = TempDir::new("xref-objstm-cat");
    let members = "<< /Type /Catalog /Pages 2 0 R >>";
    let header = "1 0 ".to_string();
    let objstm = format!(
        "<< /Type /ObjStm /N 1 /First {} /Length {} >>\nstream\n{}{}\nendstream",
        header.len(),
        header.len() + members.len(),
        header,
        members
    );
    // 1 号 Catalog 只存在于对象流（3 号）里，没有直写的 "1 0 obj"；2 号 Pages 直写。
    let mut buf = b"%PDF-1.5\n".to_vec();
    let off2 = buf.len();
    buf.extend_from_slice(format!("2 0 obj\n{}\nendobj\n", pages()).as_bytes());
    let off3 = buf.len();
    buf.extend_from_slice(format!("3 0 obj\n{objstm}\nendobj\n").as_bytes());
    let xref_at = buf.len();
    let mut rows = vec![0u8; 5];
    rows[3] = 0xff;
    rows[4] = 0xff;
    // 1 号：type 2，对象流 3、序号 0
    let mut r = [0u8; 5];
    r[0] = 2;
    r[1] = 3;
    rows.extend_from_slice(&r);
    for off in [off2 as u16, off3 as u16] {
        let mut r = [0u8; 5];
        r[0] = 1;
        r[1] = (off >> 8) as u8;
        r[2] = off as u8;
        rows.extend_from_slice(&r);
    }
    let mut r = [0u8; 5];
    r[0] = 1;
    r[1] = (xref_at >> 8) as u8;
    r[2] = xref_at as u8;
    rows.extend_from_slice(&r);
    buf.extend_from_slice(
        format!(
            "4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 2 2] /Length {} >>\nstream\n",
            rows.len()
        )
        .as_bytes(),
    );
    buf.extend_from_slice(&rows);
    buf.extend_from_slice(b"\nendstream\nendobj\n");
    buf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());

    let path = dir.write("对象流Catalog.pdf", &buf);
    assert!(pdf::probe(&buf).is_some(), "读侧先要能解析这份夹具");
    let result = edit(&path, &[("title", "写进对象流Catalog")]);
    assert!(
        result.ok,
        "Catalog 在对象流时也要能写回：{:?}",
        result.error
    );
    let p = pdf::probe(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        p.info.get("Title").map(|s| s.as_str()),
        Some("写进对象流Catalog")
    );
    assert_eq!(
        p.pages,
        Some(0),
        "新 Catalog 必须继承旧字典的 /Pages：{:?}",
        p.pages
    );
}

#[test]
fn catalog_inside_flate_object_stream_is_written() {
    let dir = TempDir::new("xref-objstm-cat-flate");
    let members = "<< /Type /Catalog /Pages 2 0 R >>".to_string();
    let header = "1 0 ".to_string();
    let payload = format!("{header}{members}");
    let raw = {
        use std::io::Write;
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(payload.as_bytes()).unwrap();
        enc.finish().unwrap()
    };
    let objstm = format!(
        "<< /Type /ObjStm /N 1 /First {} /Filter /FlateDecode /Length {} >>\nstream\n",
        header.len(),
        raw.len()
    );
    let mut body = objstm.into_bytes();
    body.extend_from_slice(&raw);
    body.extend_from_slice(b"\nendstream");

    let mut buf = b"%PDF-1.5\n".to_vec();
    let off2 = buf.len();
    buf.extend_from_slice(format!("2 0 obj\n{}\nendobj\n", pages()).as_bytes());
    let off3 = buf.len();
    buf.extend_from_slice(b"3 0 obj\n");
    buf.extend_from_slice(&body);
    buf.extend_from_slice(b"\nendobj\n");
    let xref_at = buf.len();
    let mut rows = vec![0u8; 5];
    rows[3] = 0xff;
    rows[4] = 0xff;
    let mut r = [0u8; 5];
    r[0] = 2;
    r[1] = 3;
    rows.extend_from_slice(&r);
    for off in [off2 as u16, off3 as u16] {
        let mut r = [0u8; 5];
        r[0] = 1;
        r[1] = (off >> 8) as u8;
        r[2] = off as u8;
        rows.extend_from_slice(&r);
    }
    let mut r = [0u8; 5];
    r[0] = 1;
    r[1] = (xref_at >> 8) as u8;
    r[2] = xref_at as u8;
    rows.extend_from_slice(&r);
    buf.extend_from_slice(
        format!(
            "4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 2 2] /Length {} >>\nstream\n",
            rows.len()
        )
        .as_bytes(),
    );
    buf.extend_from_slice(&rows);
    buf.extend_from_slice(b"\nendstream\nendobj\n");
    buf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());

    let path = dir.write("对象流Catalog-Flate.pdf", &buf);
    assert!(pdf::probe(&buf).is_some(), "读侧先要能解析一份 Flate 对象流夹具");
    let result = edit(&path, &[("title", "压缩对象流")]);
    assert!(result.ok, "Flate 压缩的对象流也要能读回来：{:?}", result.error);
    let p = pdf::probe(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(p.info.get("Title").map(|s| s.as_str()), Some("压缩对象流"));
    assert_eq!(p.pages, Some(0));
}
