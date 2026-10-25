#!/usr/bin/env python3
"""把一张 1024 方形 PNG 转成 Windows .ico 和 macOS .icns。

用法：
    python scripts/make-icons.py build/icon-source.png

产物（直接写到 build/ 下，electron-builder 默认会读这两个文件）：
    build/icon.ico   多尺寸：16/24/32/48/64/128/256
    build/icon.icns  多尺寸：16/32/64/128/256/512/1024

两个平台的规范不一样，所以分开处理：
- Windows 图标满幅铺满画布，任务栏和开始菜单里才够醒目。
- macOS HIG 要求图标内容约占画布 82%，四周留透明边距，否则在 Dock 里
  会比系统自带 App 明显大一圈。所以 mac 版先缩到 82% 再居中贴回去。

依赖 Pillow（仅生成图标时需要，CI 不跑这个脚本）。
"""
import struct
import sys
from pathlib import Path

from PIL import Image

# macOS 图标内容占画布的比例（HIG 建议 824/1024 ≈ 0.805）
MAC_CONTENT_RATIO = 0.82

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ICNS 的 PNG 元素类型：(类型码, 该元素应有的像素边长)
ICNS_PNG_TYPES = [
    ("icp4", 16),
    ("icp5", 32),
    ("ic11", 32),   # 16@2x
    ("ic12", 64),   # 32@2x
    ("ic07", 128),
    ("ic13", 256),  # 128@2x
    ("ic08", 256),
    ("ic14", 512),  # 256@2x
    ("ic09", 512),
    ("ic10", 1024), # 512@2x
]


def load_square(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    if img.width != img.height:
        side = min(img.width, img.height)
        left = (img.width - side) // 2
        top = (img.height - side) // 2
        img = img.crop((left, top, left + side, top + side))
        print(f"非正方形输入，已居中裁切为 {side}x{side}")
    return img.resize((1024, 1024), Image.LANCZOS)


def with_margin(img: Image.Image, ratio: float) -> Image.Image:
    """把内容缩小到 ratio 比例，居中贴到 1024 透明画布上。"""
    inner = int(1024 * ratio)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    resized = img.resize((inner, inner), Image.LANCZOS)
    offset = (1024 - inner) // 2
    canvas.paste(resized, (offset, offset), resized)
    return canvas


def build_ico(img: Image.Image, out: Path) -> None:
    img.save(out, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"icon.ico  {out.stat().st_size / 1024:.0f} KB  尺寸 {ICO_SIZES}")


def build_icns(img: Image.Image, out: Path) -> None:
    import io

    chunks = []
    for type_code, size in ICNS_PNG_TYPES:
        buf = io.BytesIO()
        img.resize((size, size), Image.LANCZOS).save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        chunks.append(type_code.encode("ascii") + struct.pack(">I", len(data) + 8) + data)

    body = b"".join(chunks)
    header = b"icns" + struct.pack(">I", len(body) + 8)
    out.write_bytes(header + body)
    print(f"icon.icns {out.stat().st_size / 1024:.0f} KB  元素 {len(ICNS_PNG_TYPES)} 个")


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python scripts/make-icons.py <1024方形PNG>", file=sys.stderr)
        return 1

    src = Path(sys.argv[1])
    if not src.is_file():
        print(f"找不到文件：{src}", file=sys.stderr)
        return 1

    build_dir = Path(__file__).resolve().parent.parent / "build"
    build_dir.mkdir(exist_ok=True)

    base = load_square(src)

    # 顺带存一份标准大小的 png，Linux / 文档里用得到
    png_out = build_dir / "icon.png"
    base.save(png_out, format="PNG", optimize=True)
    print(f"icon.png  {png_out.stat().st_size / 1024:.0f} KB  1024x1024")

    build_ico(base, build_dir / "icon.ico")
    build_icns(with_margin(base, MAC_CONTENT_RATIO), build_dir / "icon.icns")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
