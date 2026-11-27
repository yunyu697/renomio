//! PDF 只读解析的契约测试。夹具全部现场构造，不依赖任何外部样本。

use renomio_core::pdf;

fn catalog(pages: u32) -> Vec<String> {
    vec![
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        format!("<< /Type /Pages /Count {pages} /Kids [3 0 R] >>"),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>".into(),
    ]
}

/// 写出一个经典 xref 表的 PDF：对象号从 1 递增，1 号必须是 Catalog。
fn classic(objects: Vec<String>, trailer_extra: &str) -> Vec<u8> {
    let mut buf = b"%PDF-1.4\n".to_vec();
    let mut offs = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offs.push(buf.len());
        buf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let xref_at = buf.len();
    buf.extend_from_slice(b"xref\n");
    buf.extend_from_slice(format!("0 {}\n", objects.len() + 1).as_bytes());
    buf.extend_from_slice(b"0000000000 65535 f\r\n");
    for off in offs {
        buf.extend_from_slice(format!("{off:010} 00000 n\r\n").as_bytes());
    }
    buf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R{} >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1,
            if trailer_extra.is_empty() {
                String::new()
            } else {
                format!(" {trailer_extra}")
            }
        )
        .as_bytes(),
    );
    buf
}

/// 在已有 PDF 之后追加一段增量更新：新对象 + 只含该对象的 xref + 带 /Prev 的 trailer。
fn append_update(base: &[u8], num: u32, body: &str, extra_trailer: &str) -> Vec<u8> {
    let prev = base
        .windows(9)
        .rposition(|w| w == b"startxref")
        .map(|p| {
            let tail = &base[p + 9..];
            let s = tail.iter().position(|b| b.is_ascii_digit()).unwrap_or(0);
            let e = s + tail[s..].iter().take_while(|b| b.is_ascii_digit()).count();
            std::str::from_utf8(&tail[s..e])
                .unwrap()
                .parse::<usize>()
                .unwrap()
        })
        .unwrap();
    let mut buf = base.to_vec();
    let off = buf.len();
    buf.extend_from_slice(format!("{num} 0 obj\n{body}\nendobj\n").as_bytes());
    let xref_at = buf.len();
    buf.extend_from_slice(b"xref\n");
    buf.extend_from_slice(format!("{num} 1\n").as_bytes());
    buf.extend_from_slice(format!("{off:010} 00000 n\r\n").as_bytes());
    buf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R {extra_trailer} /Prev {prev} >>\nstartxref\n{xref_at}\n%%EOF\n",
            num + 1
        )
        .as_bytes(),
    );
    buf
}

fn png_up_encode(rows: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut prev = vec![0u8; rows.first().map(|r| r.len()).unwrap_or(0)];
    for (i, row) in rows.iter().enumerate() {
        if i == 0 {
            out.push(0);
            out.extend_from_slice(row);
        } else {
            out.push(2);
            for (a, b) in row.iter().zip(prev.iter()) {
                out.push(a.wrapping_sub(*b));
            }
        }
        prev = row.clone();
    }
    out
}

fn deflate(bytes: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

/// 写出一个用 xref 流收尾的 PDF 1.5 文件（FlateDecode + 可选 PNG 预测器）。
/// `compressed` 里的对象（流号、序号）会写成 type 2 条目。
fn xref_stream(
    objects: &[String],
    size: u32,
    compressed: &[(u32, u32, u32)],
    predictor: bool,
) -> Vec<u8> {
    xref_stream_info(objects, size, compressed, predictor, None)
}

fn xref_stream_info(
    objects: &[String],
    size: u32,
    compressed: &[(u32, u32, u32)],
    predictor: bool,
    info: Option<u32>,
) -> Vec<u8> {
    let mut buf = b"%PDF-1.5\n".to_vec();
    let mut offs: Vec<u32> = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offs.push(buf.len() as u32);
        buf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
    }
    let stm_num = objects.len() as u32 + 1;
    let mut rows: Vec<Vec<u8>> = Vec::new();
    for num in 0..size {
        let mut r = vec![0u8; 6];
        if num == 0 {
            // 0 号永远自由
            r[5] = 0xff;
            r[3] = 0xff;
            rows.push(r);
            continue;
        }
        if let Some(idx) = compressed.iter().find(|c| c.0 == num) {
            r[0] = 2;
            r[1] = (idx.1 >> 16) as u8;
            r[2] = (idx.1 >> 8) as u8;
            r[3] = idx.1 as u8;
            r[4] = idx.2 as u8;
            rows.push(r);
            continue;
        }
        if let Some(off) = offs.get(num as usize - 1) {
            r[0] = 1;
            r[1] = (*off >> 16) as u8;
            r[2] = (*off >> 8) as u8;
            r[3] = *off as u8;
        }
        rows.push(r);
    }
    let plain = if predictor {
        png_up_encode(&rows)
    } else {
        rows.iter().flatten().copied().collect()
    };
    let payload = deflate(&plain);
    let xref_at = buf.len();
    let parms = if predictor {
        " /DecodeParms << /Predictor 12 /Columns 6 >>"
    } else {
        ""
    };
    let info_key = info.map(|n| format!(" /Info {n} 0 R")).unwrap_or_default();
    buf.extend_from_slice(
        format!(
            "{stm_num} 0 obj\n<< /Type /XRef /Size {size} /Root 1 0 R{info_key} /W [1 3 2] /Filter /FlateDecode{parms} /Length {} >>\nstream\n",
            payload.len()
        )
        .as_bytes(),
    );
    buf.extend_from_slice(&payload);
    buf.extend_from_slice(b"\nendstream\nendobj\n");
    buf.extend_from_slice(format!("startxref\n{xref_at}\n%%EOF\n").as_bytes());
    buf
}

fn objstm(members: &[(u32, &str)]) -> (String, Vec<u32>) {
    let mut header = String::new();
    let mut body = String::new();
    let mut marks = Vec::new();
    for (num, text) in members {
        header.push_str(&format!("{num} {} ", body.len()));
        body.push_str(text);
        body.push(' ');
        marks.push(*num);
    }
    let dict = format!(
        "<< /Type /ObjStm /N {} /First {} /Length {} >>",
        marks.len(),
        header.len(),
        header.len() + body.len()
    );
    (format!("{dict}\nstream\n{header}{body}\nendstream"), marks)
}

fn field<'a>(p: &'a pdf::PdfProbe, label: &str) -> Option<&'a str> {
    p.fields
        .iter()
        .find(|(l, _)| *l == label)
        .map(|(_, v)| v.as_str())
}

#[test]
fn classic_table_reads_info_and_pages() {
    let mut objects = catalog(3);
    objects.push(
        "<< /Title (季度报告) /Author (Tyler) /Subject (PDF 解析) /Keywords (pdf, test) /Creator (Renomio) /Producer (renomio-core) /CreationDate (D:20261127024900+08'00') /ModDate (D:20261127030000+08'00') >>".into(),
    );
    let bytes = classic(objects, "/Info 4 0 R");
    let p = pdf::probe(&bytes).expect("应识别为 PDF");
    assert_eq!(p.version, "1.4");
    assert_eq!(p.xref, "xref 表");
    assert_eq!(p.pages, Some(3));
    assert!(p.encrypted.is_none());
    assert_eq!(field(&p, "标题"), Some("季度报告"));
    assert_eq!(field(&p, "作者"), Some("Tyler"));
    assert_eq!(field(&p, "关键词"), Some("pdf, test"));
    assert_eq!(field(&p, "创建工具"), Some("Renomio"));
    assert_eq!(field(&p, "生成器"), Some("renomio-core"));
    assert_eq!(field(&p, "创建时间"), Some("2026-11-27 02:49:00 (+08:00)"));
    assert_eq!(field(&p, "修改时间"), Some("2026-11-27 03:00:00 (+08:00)"));
    assert_eq!(field(&p, "页数"), Some("3"));
    assert!(
        p.warnings.is_empty(),
        "干净的 PDF 不该有警告：{:?}",
        p.warnings
    );
}

#[test]
fn utf16_hex_string_and_escapes() {
    let mut objects = catalog(1);
    objects.push(
        concat!(
            "<< /Title <FEFF4E2D658700200032003000320036> ",
            "/Author (A\\(n\\)n\\101) /Subject (A\\351B) >>"
        )
        .into(),
    );
    let p = pdf::probe(&classic(objects, "/Info 4 0 R")).unwrap();
    assert_eq!(field(&p, "标题"), Some("中文 2026"));
    assert_eq!(field(&p, "作者"), Some("A(n)nA"));
    assert_eq!(field(&p, "主题"), Some("AéB"));
}

#[test]
fn latin1_fallback_for_non_ascii() {
    let mut objects = catalog(1);
    objects.push("<< /Title <E92041> /Author <EFBBBFE4BDA0E5A5BD> >>".into());
    let p = pdf::probe(&classic(objects, "/Info 4 0 R")).unwrap();
    assert_eq!(field(&p, "标题"), Some("é A"));
    assert_eq!(field(&p, "作者"), Some("你好"));
}

#[test]
fn info_value_as_indirect_string_object() {
    let mut objects = catalog(1);
    objects.push("<< /Title 5 0 R >>".into());
    objects.push("(间接标题)".into());
    let p = pdf::probe(&classic(objects, "/Info 4 0 R")).unwrap();
    assert_eq!(field(&p, "标题"), Some("间接标题"));
}

#[test]
fn xref_stream_with_flate() {
    let objects = catalog(2);
    let bytes = xref_stream(&objects, 4, &[], false);
    let p = pdf::probe(&bytes).expect("xref 流也要能读");
    assert_eq!(p.version, "1.5");
    assert_eq!(p.xref, "xref 流");
    assert_eq!(p.pages, Some(2));
    assert!(
        p.warnings.iter().any(|w| w.contains("Info 字典缺失")),
        "没有 Info 要明确说明：{:?}",
        p.warnings
    );
}

#[test]
fn xref_stream_png_predictor_decodes_like_plain() {
    let objects = catalog(5);
    let plain = pdf::probe(&xref_stream(&objects, 4, &[], false)).unwrap();
    let predicted = pdf::probe(&xref_stream(&objects, 4, &[], true)).unwrap();
    assert_eq!(predicted.xref, "xref 流");
    assert_eq!(predicted.pages, plain.pages);
    assert_eq!(field(&plain, "页数"), field(&predicted, "页数"));
    assert!(
        !predicted
            .warnings
            .iter()
            .any(|w| w.contains("预测器") || w.contains("不支持")),
        "预测器解码不该失败：{:?}",
        predicted.warnings
    );
}

#[test]
fn object_stream_holds_the_info_dictionary() {
    let (stm, marks) = objstm(&[(
        7,
        "<< /Title (对象流里的标题) /Author (Renomio) /CreationDate (D:20261127) >>",
    )]);
    let mut objects = catalog(2);
    objects.push(stm);
    let stm_num = objects.len() as u32;
    assert_eq!(stm_num, 4);
    let bytes = xref_stream_info(&objects, 8, &[(7, stm_num, 0)], false, Some(7));
    let p = pdf::probe(&bytes).unwrap();
    assert_eq!(marks, vec![7]);
    assert_eq!(field(&p, "标题"), Some("对象流里的标题"));
    assert_eq!(field(&p, "作者"), Some("Renomio"));
    assert_eq!(field(&p, "创建时间"), Some("2026-11-27"));
    assert_eq!(p.pages, Some(2));
    assert_eq!(p.xref, "xref 流");
}

#[test]
fn incremental_update_prefers_new_info() {
    let mut objects = catalog(1);
    objects.push("<< /Title (旧标题) >>".into());
    let base = classic(objects, "/Info 4 0 R");
    let updated = append_update(&base, 5, "<< /Title (新标题) >>", "/Info 5 0 R");
    let p = pdf::probe(&updated).unwrap();
    assert_eq!(field(&p, "标题"), Some("新标题"));
    assert_eq!(p.pages, Some(1));
}

#[test]
fn encrypted_aes128_is_reported_not_decrypted() {
    let mut objects = catalog(1);
    objects.push("<< /Title (密文标题) >>".into());
    let bytes = classic(
        objects,
        "/Info 4 0 R /Encrypt << /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> >>",
    );
    let p = pdf::probe(&bytes).unwrap();
    assert_eq!(p.encrypted.as_deref(), Some("AES-128"));
    assert_eq!(field(&p, "加密"), Some("AES-128"));
    assert!(field(&p, "标题").is_none(), "密文不能当标题");
    assert!(
        p.warnings.iter().any(|w| w.contains("没有密码")),
        "要说明为什么读不到：{:?}",
        p.warnings
    );
}

#[test]
fn encrypted_rc4_variants() {
    let objects = catalog(1);
    let v1 = pdf::probe(&classic(
        objects.clone(),
        "/Encrypt << /Filter /Standard /V 1 /R 2 >>",
    ))
    .unwrap();
    assert_eq!(v1.encrypted.as_deref(), Some("RC4 40 位"));

    let v2 = pdf::probe(&classic(
        objects.clone(),
        "/Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 >>",
    ))
    .unwrap();
    assert_eq!(v2.encrypted.as_deref(), Some("RC4 128 位"));

    let v5 = pdf::probe(&classic(
        objects,
        "/Encrypt << /Filter /Standard /V 5 /R 5 /Length 256 >>",
    ))
    .unwrap();
    assert_eq!(v5.encrypted.as_deref(), Some("AES-256"));
}

#[test]
fn truncated_file_is_reported_without_panic() {
    let mut objects = catalog(1);
    objects.push("<< /Title (残缺) >>".into());
    let bytes = classic(objects, "/Info 4 0 R");
    let cut = &bytes[..bytes.len() / 2];
    let p = pdf::probe(cut).unwrap();
    assert!(
        p.warnings.iter().any(|w| w.contains("找不到 startxref")),
        "截断要给出明确原因：{:?}",
        p.warnings
    );
    assert_eq!(field(&p, "版本"), Some("PDF 1.4"));
}

#[test]
fn arbitrary_truncations_never_panic() {
    let mut objects = catalog(2);
    objects.push("<< /Title (稳健性) /Author (Renomio) >>".into());
    let bytes = classic(objects, "/Info 4 0 R");
    for len in (0..bytes.len()).step_by(7) {
        let _ = pdf::probe(&bytes[..len]);
    }
}

#[test]
fn non_pdf_returns_none() {
    assert!(pdf::probe(b"hello world").is_none());
    assert!(pdf::probe(&[]).is_none());
}

#[test]
fn missing_info_is_a_warning_not_a_default_value() {
    let objects = catalog(1);
    let p = pdf::probe(&classic(objects, "")).unwrap();
    assert!(field(&p, "标题").is_none());
    assert!(field(&p, "作者").is_none());
    assert_eq!(field(&p, "页数"), Some("1"));
    assert!(p.warnings.iter().any(|w| w.contains("Info 字典缺失")));
}

#[test]
fn pages_count_comes_from_pages_dictionary() {
    for count in [0u32, 1, 12] {
        let objects = catalog(count);
        let p = pdf::probe(&classic(objects, "")).unwrap();
        assert_eq!(p.pages, Some(count), "Count 应原样取回");
    }
}

#[test]
fn date_prefix_variants() {
    let cases = [
        ("D:2026", "2026"),
        ("D:202611", "2026-11"),
        ("D:20261127", "2026-11-27"),
        ("D:20261127024900", "2026-11-27 02:49:00"),
        ("20261127024900-05'00'", "2026-11-27 02:49:00 (-05:00)"),
        ("D:20261127024900Z", "2026-11-27 02:49:00"),
    ];
    for (raw, want) in cases {
        let mut objects = catalog(1);
        objects.push(format!("<< /CreationDate ({raw}) >>"));
        let p = pdf::probe(&classic(objects, "/Info 4 0 R")).unwrap();
        assert_eq!(field(&p, "创建时间"), Some(want), "输入 {raw}");
    }
}
