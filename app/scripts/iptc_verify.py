#!/usr/bin/env python3
"""IPTC-IIM 真实文件回读校验（独立实现：Pillow 的 IptcImagePlugin 读 APP13 8BIM）。

由 scripts/test-iptc.mjs 调用：
  PROBE_ARGV='["cargo","run",...,"metaedit_probe","--"]' python scripts/iptc_verify.py <workdir>

流程：造真实 JPEG（带 EXIF）→ 用 renomio-core 的 edit 写 4 个 IPTC Core 字段
→ Pillow 读回 IIM → 逐字段比对 → 清掉一个 → 再清全部 → 每步都校验像素与 EXIF 未被破坏。
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, IptcImagePlugin

FAILS = []
CHECKS = []


def check(name, ok, detail=None):
    CHECKS.append(bool(ok))
    if ok:
        print(f"  PASS  {name}")
    else:
        FAILS.append(f"{name} :: {json.dumps(detail, ensure_ascii=False)}")
        print(f"  FAIL  {name}{' :: ' + json.dumps(detail, ensure_ascii=False) if detail else ''}")


def iim_map(path):
    """读回 IIM：{(record, dataset): 解码后的字符串}"""
    with Image.open(path) as im:
        info = IptcImagePlugin.getiptcinfo(im)
    if not info:
        return {}
    out = {}
    for key, value in info.items():
        if isinstance(key, tuple) and len(key) == 2:
            pair = (int(key[0]), int(key[1]))
        elif isinstance(key, int):
            # 旧版 Pillow 把 (record, dataset) 折叠成「record*100 + dataset」
            pair = (key // 100, key % 100)
        else:
            continue
        raw = value if isinstance(value, (bytes, bytearray)) else bytes(str(value), 'utf-8')
        out[pair] = bytes(raw).decode('utf-8', 'replace')
    return out


def pixels(path):
    with Image.open(path) as im:
        im.load()
        return hashlib.sha256(im.convert('RGB').tobytes()).hexdigest(), im.size


def exif_make_model(path):
    with Image.open(path) as im:
        exif = im.getexif()
        return exif.get(0x010F), exif.get(0x0110)


def jpeg_bytes(path):
    return Path(path).read_bytes()


def probe(argv, path, fields):
    cmd = list(argv) + ["edit", str(path)] + fields
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stdout, res.stderr)
        raise SystemExit(f"probe 失败（exit {res.returncode}）：{' '.join(cmd)}")
    data = json.loads(res.stdout.strip().splitlines()[-1])
    if not data.get("ok", False):
        raise SystemExit(f"probe 返回失败：{json.dumps(data, ensure_ascii=False)}")
    return data


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: iptc_verify.py <workdir>")
    work = Path(sys.argv[1])
    work.mkdir(parents=True, exist_ok=True)
    argv = json.loads(os.environ["PROBE_ARGV"])

    jpg = work / "iptc-real.jpg"
    img = Image.new("RGB", (64, 48))
    px = img.load()
    for y in range(48):
        for x in range(64):
            px[x, y] = (x * 4 % 256, y * 5 % 256, (x + y) % 256)
    exif = Image.Exif()
    exif[0x010F] = "Canon"
    exif[0x0110] = "EOS R6"
    img.save(jpg, "JPEG", quality=88, exif=exif)

    base_pixels, base_size = pixels(jpg)
    base_make, base_model = exif_make_model(jpg)
    check("造出真实 JPEG（64×48，带 EXIF Make/Model）",
          base_size == (64, 48) and base_make == "Canon" and base_model == "EOS R6",
          {"size": base_size, "make": base_make, "model": base_model})

    # 1) 写入四个 IPTC Core 字段（含中文，验证 UTF-8 声明与码页无关）
    data = probe(argv, jpg, [
        "headline=春游 2024",
        "bylineTitle=摄影记者",
        "credit=某通讯社",
        "source=素材库",
    ])
    check("probe 走的是生产写路径（备份 + 替换，ok=true 且有 backup）",
          data.get("ok") and data.get("backup"), {"ok": data.get("ok"), "backup": data.get("backup")})

    iim = iim_map(jpg)
    check("Pillow 读回 IIM 的 Headline(2:105)", iim.get((2, 105)) == "春游 2024", {"got": iim.get((2, 105))})
    check("Pillow 读回 IIM 的 By-line Title(2:85)", iim.get((2, 85)) == "摄影记者", {"got": iim.get((2, 85))})
    check("Pillow 读回 IIM 的 Credit(2:110)", iim.get((2, 110)) == "某通讯社", {"got": iim.get((2, 110))})
    check("Pillow 读回 IIM 的 Source(2:115)", iim.get((2, 115)) == "素材库", {"got": iim.get((2, 115))})
    check("非 ASCII 值带 UTF-8 声明 dataset 1:90", iim.get((1, 90,)) == "\x1b%G", {"keys": [list(k) for k in iim]})

    raw = jpeg_bytes(jpg)
    check("XMP 同步写入（APP1 带 photoshop:Headline 与 AuthorsPosition）",
          b"photoshop:Headline" in raw and b"photoshop:AuthorsPosition" in raw,
          {"has_headline": b"photoshop:Headline" in raw})
    check("不留下过期的 8BIM 摘要资源 0x0406", b"8BIM\x04\x06" not in raw)
    check("写后像素未变、EXIF 未被破坏",
          pixels(jpg)[0] == base_pixels and exif_make_model(jpg) == ("Canon", "EOS R6"),
          {"pixels_same": pixels(jpg)[0] == base_pixels, "exif": exif_make_model(jpg)})

    # 2) 清掉一个字段：其余保留
    probe(argv, jpg, ["clear:credit"])
    iim = iim_map(jpg)
    check("清空 Credit 后 (2:110) 消失", (2, 110) not in iim, {"got": iim.get((2, 110))})
    check("清空 Credit 不影响 Headline/By-line Title/Source",
          iim.get((2, 105)) == "春游 2024" and iim.get((2, 85)) == "摄影记者" and iim.get((2, 115)) == "素材库",
          {"iim": {str(k): v for k, v in iim.items()}})
    check("清空后像素仍与原始一致", pixels(jpg)[0] == base_pixels)

    # 3) 全部清空：APP13 整段消失，JPEG 仍然可读
    probe(argv, jpg, ["clear:headline", "clear:bylineTitle", "clear:source"])
    iim = iim_map(jpg)
    check("全部清空后不再有 IIM 字段", not iim, {"iim": {str(k): v for k, v in iim.items()}})
    check("全部清空后 APP13 的 Photoshop 资源段整段移除", b"Photoshop 3.0" not in jpeg_bytes(jpg))
    check("清空后仍是可解码的 JPEG（Pillow 加载成功且尺寸不变）", pixels(jpg)[1] == (64, 48))

    total = len(CHECKS)
    passed = sum(1 for c in CHECKS if c)
    print(f"\nIPTC-IIM 真实文件回读：{passed} 通过 / {total - passed} 失败")
    if FAILS:
        for item in FAILS:
            print(f"  · {item}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
