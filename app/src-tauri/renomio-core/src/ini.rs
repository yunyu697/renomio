//! 设置文件的双向编解码：`serde_json::Value` ⇄ INI 文本（UTF-8）。
//!
//! 为什么不用 JSON 直接当设置文件：INI 一行一个键值，用户能在记事本里改、能 diff、
//! 跨机器复制不会因为格式化差异整片对不上。这里的实现只做「结构搬运」，不碰业务语义：
//!
//! - 顶层标量（`theme = system`）放进 `[@root]` 分节；顶层非空对象/数组各自开一个同名分节。
//! - 嵌套对象用点路径（`layout.side = 400`），数组用下标（`userVars[0] = ...`），
//!   数组里的对象继续用点路径（`rules[0].type = replace`）。
//! - 空对象/空数组写成 `{}` / `[]`，保证往返不丢结构。
//! - 注释用 `;` 或 `#`（只允许整行），空行忽略，CRLF 与 LF 等价。
//! - 值类型按字面量推断：`true/false` → 布尔、严格数字 → 数字、双引号包裹 → 字符串，
//!   其余按裸字符串；凡是推断不出原样的字符串（空的、像数字/布尔的、带 `= ; # [ ] " \`
//!   或首尾空白的）写出时加引号。
//! - 任何结构错误都带行号；同一路径重复写、数组下标乱序/重复一律拒绝，不做「后者覆盖前者」。

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// 顶层标量所在的分节名。`@` 不在合法键名字符集里，因此不会和真实键撞名。
pub const ROOT_SECTION: &str = "@root";

/// 文件开头写固定的说明注释（不含时间戳，保证同样的输入得到同样的输出）。
pub const HEADER: &str = "\
; Renomio 设置文件（UTF-8 / .ini）
; 一行一个键值；; 或 # 开头是注释；数组用下标 name[0]，嵌套对象用点路径 a.b
; 导入时逐键校验类型，未知键会被忽略并计数
";

/// 把 JSON 值写成 INI 文本。顶层必须是对象。
pub fn to_ini(value: &Value) -> Result<String, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "设置数据必须是对象（顶层是数组或标量）".to_string())?;

    // 分节按名字排序，保证输出稳定可 diff
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut root_lines: Vec<(String, String)> = Vec::new();

    for (key, val) in obj {
        let is_container = val.is_object() || val.is_array();
        let is_empty_container = match val {
            Value::Object(map) => map.is_empty(),
            Value::Array(items) => items.is_empty(),
            _ => false,
        };
        if is_container && !is_empty_container {
            let mut lines = Vec::new();
            flatten("", val, &mut lines)?;
            sections.push((escape_key(key), lines));
        } else {
            // 标量或空容器：留在 [@root]，键名即顶层键名
            root_lines.push((escape_key(key), scalar_text(val)));
        }
    }

    let mut out = String::from(HEADER);
    let mut blocks: Vec<(String, Vec<(String, String)>)> = Vec::new();
    if !root_lines.is_empty() {
        blocks.push((ROOT_SECTION.to_string(), root_lines));
    }
    blocks.extend(sections);
    blocks.sort_by(|a, b| a.0.cmp(&b.0));

    for (name, mut lines) in blocks {
        out.push('\n');
        out.push('[');
        out.push_str(&name);
        out.push_str("]\n");
        lines.sort_by(|a, b| a.0.cmp(&b.0));
        for (key, text) in lines {
            out.push_str(&key);
            out.push_str(" = ");
            out.push_str(&text);
            out.push('\n');
        }
    }
    Ok(out)
}

/// 把 INI 文本解析成 JSON 对象。所有错误都带行号。
pub fn from_ini(text: &str) -> Result<Value, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n").replace('\r', "\n");
    let mut root: Map<String, Value> = Map::new();
    let mut section: Option<String> = None;
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for (idx, raw_line) in text.split('\n').enumerate() {
        let line_no = idx + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        // 分节头是「整行只有一个 [名字]」；数组分节的键行以 [0] 起头，含等号，不能当分节头
        if line.starts_with('[') && !line.contains('=') {
            if !line.ends_with(']') {
                return Err(format!("第 {line_no} 行：分节头缺少右方括号"));
            }
            let name = line[1..line.len() - 1].trim();
            if name.is_empty() {
                return Err(format!("第 {line_no} 行：分节名为空"));
            }
            if name != ROOT_SECTION && !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                return Err(format!("第 {line_no} 行：分节名「{name}」含非法字符"));
            }
            section = Some(name.to_string());
            continue;
        }

        let (key_part, value_part) = split_kv(line).ok_or_else(|| format!("第 {line_no} 行：缺少等号（应写成 key = value）"))?;
        let key_text = key_part.trim();
        if key_text.is_empty() {
            return Err(format!("第 {line_no} 行：等号左边没有键名"));
        }
        let sec = match &section {
            Some(s) => s.clone(),
            None => return Err(format!("第 {line_no} 行：键「{key_text}」出现在任何分节之前")),
        };
        let tokens = parse_path(key_text).map_err(|err| format!("第 {line_no} 行：{err}"))?;
        let value = parse_value(value_part.trim(), line_no)?;

        let normalize = format!("{sec}\u{1f}{}", tokens_string(&tokens));
        if !seen.insert(normalize) {
            return Err(format!("第 {line_no} 行：键「{key_text}」在分节 [{sec}] 里重复"));
        }

        insert(&mut root, &sec, &tokens, value, line_no)?;
    }

    Ok(Value::Object(root))
}

// ---------------------------------------------------------------- 写出

/// 把一个分节里的值摊平成 `路径 = 值` 行；`prefix` 为空表示从分节根部开始。
fn flatten(prefix: &str, value: &Value, lines: &mut Vec<(String, String)>) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, val) in map {
                let path = if prefix.is_empty() {
                    escape_key(key)
                } else {
                    format!("{prefix}.{}", escape_key(key))
                };
                if is_empty_container(val) {
                    lines.push((path, scalar_text(val)));
                    continue;
                }
                flatten(&path, val, lines)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let path = format!("{prefix}[{i}]");
                if is_empty_container(item) {
                    lines.push((path, scalar_text(item)));
                    continue;
                }
                flatten(&path, item, lines)?;
            }
            Ok(())
        }
        _ => {
            lines.push((prefix.to_string(), scalar_text(value)));
            Ok(())
        }
    }
}

fn is_empty_container(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(), // 调用方应避免；占位保持可读
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_if_needed(s),
        Value::Array(_) => "[]".to_string(),
        Value::Object(_) => "{}".to_string(),
    }
}

fn quote_if_needed(raw: &str) -> String {
    if !raw.is_empty() && needs_quote(raw) {
        format!("\"{}\"", escape_str(raw))
    } else if raw.is_empty() {
        "\"\"".to_string()
    } else {
        raw.to_string()
    }
}

fn needs_quote(raw: &str) -> bool {
    if raw != raw.trim() {
        return true;
    }
    if raw.chars().any(|c| matches!(c, '"' | '\\' | '=' | ';' | '#' | '[' | ']' | '\n' | '\r' | '\t')) {
        return true;
    }
    // 裸写会被读成别的类型（布尔/数字/空容器），必须加引号才能还原成字符串
    matches!(raw, "true" | "false" | "null" | "{}" | "[]") || looks_like_number(raw)
}

fn looks_like_number(raw: &str) -> bool {
    let body = raw.strip_prefix('-').unwrap_or(raw);
    if body.is_empty() {
        return false;
    }
    let mut parts = body.split('.');
    let int_part = parts.next().unwrap_or("");
    if int_part.is_empty() || !int_part.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    // 拒绝前导零（除 "0" 本身），避免和版本号/编号混淆
    if int_part.len() > 1 && int_part.starts_with('0') {
        return false;
    }
    match parts.next() {
        None => true,
        Some(frac) => !frac.is_empty() && frac.chars().all(|c| c.is_ascii_digit()) && parts.next().is_none(),
    }
}

fn escape_str(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    for c in raw.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_key(raw: &str) -> String {
    if !raw.is_empty() && raw.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        raw.to_string()
    } else {
        format!("\"{}\"", escape_str(raw))
    }
}

// ---------------------------------------------------------------- 读入

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let mut in_quote = false;
    let mut escaped = false;
    for (i, c) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            '=' if !in_quote => return Some((&line[..i], &line[i + 1..])),
            _ => {}
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    name: String,
    indices: Vec<usize>,
}

fn parse_path(raw: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut i = 0usize;

    loop {
        // 段名：引号包裹或裸名
        let name = if chars.get(i) == Some(&'"') {
            i += 1;
            let mut buf = String::new();
            let mut closed = false;
            while i < chars.len() {
                match chars[i] {
                    '\\' => {
                        if i + 1 >= chars.len() {
                            return Err("键名引号里的转义不完整".to_string());
                        }
                        buf.push(unescape_char(chars[i + 1]));
                        i += 2;
                    }
                    '"' => {
                        i += 1;
                        closed = true;
                        break;
                    }
                    c => {
                        buf.push(c);
                        i += 1;
                    }
                }
            }
            if !closed {
                return Err(format!("键名「{raw}」引号未闭合"));
            }
            buf
        } else {
            let mut buf = String::new();
            while i < chars.len() && !matches!(chars[i], '.' | '[') {
                if chars[i] == '"' {
                    return Err(format!("键名「{raw}」里引号位置不对"));
                }
                buf.push(chars[i]);
                i += 1;
            }
            buf.trim().to_string()
        };
        // 分节根部是数组时，键可以从 `[0]` 直接起（无名下标段），但这只能出现在最前面
        if name.is_empty() && !(tokens.is_empty() && chars.get(i) == Some(&'[')) {
            return Err(format!("键名「{raw}」有空段（多余的点号？）"));
        }

        // 下标
        let mut indices = Vec::new();
        while chars.get(i) == Some(&'[') {
            i += 1;
            let mut digits = String::new();
            while i < chars.len() && chars[i] != ']' {
                digits.push(chars[i]);
                i += 1;
            }
            if chars.get(i) != Some(&']') {
                return Err(format!("键「{raw}」的方括号未闭合"));
            }
            i += 1;
            if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
                return Err(format!("键「{raw}」的数组下标必须是整数（写成了 [{digits}]）"));
            }
            let idx: usize = digits
                .parse()
                .map_err(|_| format!("键「{raw}」的数组下标超出范围（{digits}）"))?;
            indices.push(idx);
        }

        tokens.push(Token { name, indices });

        if i >= chars.len() {
            break;
        }
        if chars[i] != '.' {
            return Err(format!("键「{raw}」在位置 {} 出现无法识别的内容", i));
        }
        i += 1;
        if i >= chars.len() {
            return Err(format!("键「{raw}」以点号结尾"));
        }
    }
    Ok(tokens)
}

fn unescape_char(c: char) -> char {
    match c {
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        other => other,
    }
}

fn tokens_string(tokens: &[Token]) -> String {
    tokens
        .iter()
        .map(|tok| {
            let mut s = tok.name.clone();
            if !tok.indices.is_empty() {
                for idx in &tok.indices {
                    s.push_str(&format!("[{idx}]"));
                }
            }
            s
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn parse_value(raw: &str, line_no: usize) -> Result<Value, String> {
    if raw.is_empty() {
        return Ok(Value::String(String::new()));
    }
    if raw == "{}" {
        return Ok(Value::Object(Map::new()));
    }
    if raw == "[]" {
        return Ok(Value::Array(Vec::new()));
    }
    if raw.starts_with('"') {
        let chars: Vec<char> = raw.chars().collect();
        let mut i = 1usize;
        let mut buf = String::new();
        let mut closed = false;
        while i < chars.len() {
            match chars[i] {
                '\\' => {
                    if i + 1 >= chars.len() {
                        return Err(format!("第 {line_no} 行：值里的转义不完整"));
                    }
                    buf.push(unescape_char(chars[i + 1]));
                    i += 2;
                }
                '"' => {
                    i += 1;
                    closed = true;
                    break;
                }
                c => {
                    buf.push(c);
                    i += 1;
                }
            }
        }
        if !closed {
            return Err(format!("第 {line_no} 行：值的引号未闭合"));
        }
        if i != chars.len() {
            return Err(format!("第 {line_no} 行：值在右引号之后还有多余内容"));
        }
        return Ok(Value::String(buf));
    }
    match raw {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        "null" => return Ok(Value::Null),
        _ => {}
    }
    if looks_like_number(raw) {
        if raw.contains('.') {
            if let Ok(f) = raw.parse::<f64>() {
                return Ok(Value::Number(serde_json::Number::from_f64(f).ok_or_else(|| {
                    format!("第 {line_no} 行：数字「{raw}」无法表示")
                })?));
            }
        } else if let Ok(n) = raw.parse::<i64>() {
            return Ok(Value::Number(serde_json::Number::from(n)));
        }
        if let Ok(u) = raw.parse::<u64>() {
            return Ok(Value::Number(serde_json::Number::from(u)));
        }
    }
    Ok(Value::String(raw.to_string()))
}

fn insert(root: &mut Map<String, Value>, section: &str, tokens: &[Token], value: Value, line_no: usize) -> Result<(), String> {
    if section == ROOT_SECTION {
        if tokens.len() != 1 || tokens[0].name.is_empty() || !tokens[0].indices.is_empty() {
            return Err(format!("第 {line_no} 行：[@root] 分节里只能写顶层标量键"));
        }
        let name = tokens[0].name.clone();
        if root.contains_key(&name) {
            return Err(format!("第 {line_no} 行：顶层键「{name}」重复"));
        }
        root.insert(name, value);
        return Ok(());
    }

    let slot = root.entry(section.to_string()).or_insert(Value::Null);
    put(slot, section, tokens, value, line_no)
}

fn put(slot: &mut Value, owner: &str, tokens: &[Token], value: Value, line_no: usize) -> Result<(), String> {
    let tok = &tokens[0];
    // 分节根部是数组（顶层非空数组）时，第一条键是 `[0]...` 这种无名字的下标
    if tok.name.is_empty() {
        if slot.is_null() {
            *slot = Value::Array(Vec::new());
        }
        let arr = slot
            .as_array_mut()
            .ok_or_else(|| format!("第 {line_no} 行：分节 [{owner}] 已经是对象，不能再按下标写"))?;
        return put_array(arr, owner, &tok.indices, &tokens[1..], value, line_no);
    }

    if slot.is_null() {
        *slot = Value::Object(Map::new());
    }
    let map = slot
        .as_object_mut()
        .ok_or_else(|| format!("第 {line_no} 行：键「{}」与已有结构冲突（此处应是对象）", tok.name))?;

    if tok.indices.is_empty() {
        if tokens.len() == 1 {
            if map.contains_key(&tok.name) {
                return Err(format!("第 {line_no} 行：键「{}」重复", tok.name));
            }
            map.insert(tok.name.clone(), value);
            return Ok(());
        }
        let entry = map.entry(tok.name.clone()).or_insert(Value::Null);
        return put(entry, &tok.name, &tokens[1..], value, line_no);
    }

    let entry = map.entry(tok.name.clone()).or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        return Err(format!("第 {line_no} 行：键「{}」已经是对象或标量，不能按数组下标写", tok.name));
    }
    let arr = entry.as_array_mut().expect("checked above");
    put_array(arr, &tok.name, &tok.indices, &tokens[1..], value, line_no)
}

fn put_array(
    arr: &mut Vec<Value>,
    owner: &str,
    indices: &[usize],
    rest: &[Token],
    value: Value,
    line_no: usize,
) -> Result<(), String> {
    let last_index = *indices.last().expect("indices 非空");
    // 逐层建数组，保证 a[0][1] 这种嵌套也能落位
    let mut cursor: &mut Vec<Value> = arr;
    for &idx in &indices[..indices.len() - 1] {
        if idx > cursor.len() {
            return Err(format!(
                "第 {line_no} 行：数组「{owner}」下标跳号（写到了 [{idx}]，当前只到 [{}]）",
                cursor.len()
            ));
        }
        if idx == cursor.len() {
            cursor.push(Value::Null);
        }
        let entry = &mut cursor[idx];
        if entry.is_null() {
            *entry = Value::Array(Vec::new());
        }
        cursor = entry.as_array_mut().ok_or_else(|| {
            format!("第 {line_no} 行：数组「{owner}」的 [{idx}] 已是标量，不能再按嵌套下标写")
        })?;
    }
    if last_index > cursor.len() {
        return Err(format!(
            "第 {line_no} 行：数组「{owner}」下标跳号（写到了 [{last_index}]，当前只到 [{}]）",
            cursor.len()
        ));
    }

    if rest.is_empty() {
        // 叶子：同一下标只能写一次
        if last_index < cursor.len() {
            return Err(format!(
                "第 {line_no} 行：数组「{owner}」的 [{last_index}] 重复写（下标必须从 0 递增）"
            ));
        }
        cursor.push(value);
        return Ok(());
    }

    // 还有子键：同一元素可以分多行补齐，第一次出现时先占位
    if last_index == cursor.len() {
        cursor.push(Value::Null);
    }
    let child = &mut cursor[last_index];
    put(child, owner, rest, value, line_no)
}

/// 往返编解码：解析后再写回，用于自测与探针。
pub fn round_trip(value: &Value) -> Result<Value, String> {
    let text = to_ini(value)?;
    from_ini(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&str, Value)]) -> Value {
        let mut map = Map::new();
        for (k, v) in pairs {
            map.insert(k.to_string(), v.clone());
        }
        Value::Object(map)
    }

    #[test]
    fn scalars_and_nested_objects_survive() {
        let value = obj(&[
            ("theme", Value::String("system".into())),
            ("nameMaxLength", Value::from(255)),
            (
                "layout",
                obj(&[("view", Value::String("files-left".into())), ("side", Value::from(400))]),
            ),
        ]);
        assert_eq!(round_trip(&value).unwrap(), value);
    }

    #[test]
    fn nested_arrays_and_objects_inside_arrays_survive() {
        let value = obj(&[
            (
                "rules",
                Value::Array(vec![obj(&[
                    ("type", Value::String("replace".into())),
                    ("enabled", Value::Bool(true)),
                    ("keywords", Value::Array(vec![Value::String("a".into()), Value::String("b".into())])),
                ])]),
            ),
            (
                "userVars",
                Value::Array(vec![Value::String(String::new()), Value::String("x".into())]),
            ),
        ]);
        assert_eq!(round_trip(&value).unwrap(), value);
    }

    #[test]
    fn empty_containers_are_not_collapsed() {
        let value = obj(&[
            ("columnWidths", obj(&[])),
            ("rules", Value::Array(vec![])),
            ("shortcuts", obj(&[("focus", Value::String("Ctrl+K".into()))])),
        ]);
        assert_eq!(round_trip(&value).unwrap(), value);
    }

    #[test]
    fn numbers_and_bool_like_strings_are_quoted() {
        let value = obj(&[
            ("invalidReplacement", Value::String("123".into())),
            ("emptyNameFallback", Value::String("true".into())),
            ("blank", Value::String(String::new())),
            ("spacey", Value::String(" a b ".into())),
        ]);
        let text = to_ini(&value).unwrap();
        assert!(text.contains("invalidReplacement = \"123\""), "{text}");
        assert!(text.contains("emptyNameFallback = \"true\""), "{text}");
        assert!(text.contains("blank = \"\""), "{text}");
        assert!(text.contains("spacey = \" a b \""), "{text}");
        assert_eq!(round_trip(&value).unwrap(), value);
    }

    #[test]
    fn special_characters_are_escaped() {
        let value = obj(&[(
            "note",
            Value::String("a=b;c#d\n第二行\"引号\"\\反斜杠".into()),
        )]);
        let text = to_ini(&value).unwrap();
        assert_eq!(round_trip(&value).unwrap(), value, "{text}");
    }

    #[test]
    fn dotted_and_spaced_keys_are_quoted() {
        let value = obj(&[(
            "layout",
            obj(&[("sizes", obj(&[("files-left", Value::from(400)), ("a.b", Value::from(1))]))]),
        )]);
        assert_eq!(round_trip(&value).unwrap(), value);
    }

    #[test]
    fn duplicate_key_is_rejected_with_line_number() {
        let err = from_ini("[a]\nx = 1\nx = 2\n").unwrap_err();
        assert!(err.contains("第 3 行"), "{err}");
        assert!(err.contains("重复"), "{err}");
    }

    #[test]
    fn key_before_section_and_bad_index_report_line() {
        let err = from_ini("x = 1\n").unwrap_err();
        assert!(err.contains("第 1 行"), "{err}");
        let err = from_ini("[a]\nlist[x] = 1\n").unwrap_err();
        assert!(err.contains("第 2 行"), "{err}");
        assert!(err.contains("整数"), "{err}");
        let err = from_ini("[a]\nlist[1] = 1\n").unwrap_err();
        assert!(err.contains("跳号"), "{err}");
    }

    #[test]
    fn unterminated_quote_reports_line() {
        let err = from_ini("[a]\nnote = \"没闭合\n").unwrap_err();
        assert!(err.contains("第 2 行"), "{err}");
        assert!(err.contains("未闭合"), "{err}");
    }

    #[test]
    fn comments_blank_lines_and_crlf_are_ignored() {
        let text = "; 注释\r\n\r\n[a]\r\n# 另一种注释\r\nx = 1\r\n";
        let value = from_ini(text).unwrap();
        assert_eq!(value, obj(&[("a", obj(&[("x", Value::from(1))]))]));
        assert_eq!(to_ini(&value).unwrap().contains("x = 1"), true);
    }

    #[test]
    fn root_section_holds_scalars() {
        let value = obj(&[
            ("theme", Value::String("dark".into())),
            ("layout", obj(&[("side", Value::from(1))])),
        ]);
        let text = to_ini(&value).unwrap();
        assert!(text.contains("[@root]"), "{text}");
        assert!(text.contains("[layout]"), "{text}");
        assert_eq!(from_ini(&text).unwrap(), value);
    }

    #[test]
    fn non_object_top_level_is_rejected() {
        assert!(to_ini(&Value::Array(vec![])).is_err());
        assert!(to_ini(&Value::String("x".into())).is_err());
    }

    #[test]
    fn section_name_with_illegal_chars_is_rejected() {
        let err = from_ini("[a b]\nx = 1\n").unwrap_err();
        assert!(err.contains("非法字符"), "{err}");
        let err = from_ini("[a\nx = 1\n").unwrap_err();
        assert!(err.contains("右方括号"), "{err}");
    }
}
