# Makes every icon and logo file from the master logo image (white background).
# Usage: python3 scripts/make-icons.py "path/to/SameSecond Sync Mark.png"
# Needs Pillow (pip install pillow).
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(sys.argv[1] if len(sys.argv) > 1 else root / "store" / "logo-master.png").convert("RGB")
src.save(root / "store" / "logo-master.png")


def cut_out(img):
    """White background to transparent. Coloured parts stay fully solid; only
    the anti-aliased edges become partly transparent, so the mark looks right on
    dark backgrounds too."""
    img = img.convert("RGB")
    out = Image.new("RGBA", img.size)
    px, po = img.load(), out.load()
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            r, g, b = px[x, y]
            d = max(255 - r, 255 - g, 255 - b) / 255
            # Near-white (the paper-white background has slight noise) becomes fully clear.
            a = max(0.0, min(1.0, (d - 0.04) / 0.18))
            if a <= 0:
                po[x, y] = (0, 0, 0, 0)
                continue
            # Remove the white the edge pixel was blended with.
            un = lambda c: max(0, min(255, round((c - 255 * (1 - a)) / a)))
            po[x, y] = (un(r), un(g), un(b), round(a * 255))
    return out


def bbox_of(img, y0, y1):
    part = img.crop((0, y0, img.size[0], y1))
    xs, ys = [], []
    p = part.load()
    for y in range(0, part.size[1], 2):
        for x in range(0, part.size[0], 2):
            if min(p[x, y]) < 235:
                xs.append(x); ys.append(y)
    return min(xs), y0 + min(ys), max(xs) + 2, y0 + max(ys) + 2


w, h = src.size
mark_box = bbox_of(src, 0, int(h * 0.64))
full_box = bbox_of(src, 0, h)
mark = cut_out(src.crop(mark_box))
full = cut_out(src.crop(full_box))


def square(img, size, pad, bg=None):
    """Fit img into a size×size square with `pad` (fraction) margin on each side."""
    inner = round(size * (1 - 2 * pad))
    scaled = img.copy()
    scaled.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    canvas.alpha_composite(scaled, ((size - scaled.size[0]) // 2, (size - scaled.size[1]) // 2))
    return canvas


white = (255, 255, 255, 255)
out = {
    # Website
    "public/brand/mark.png": square(mark, 256, 0.02),
    "public/brand/logo.png": full,
    "public/favicon.png": square(mark, 64, 0.04),
    "public/apple-touch-icon.png": square(mark, 180, 0.16, white).convert("RGB"),
    "public/icon-192.png": square(mark, 192, 0.18, white),
    "public/icon-512.png": square(mark, 512, 0.18, white),
    # Extension
    "extension/icons/16.png": square(mark, 16, 0.0),
    "extension/icons/32.png": square(mark, 32, 0.0),
    "extension/icons/48.png": square(mark, 48, 0.02),
    "extension/icons/128.png": square(mark, 128, 0.08),
    # Store listing icon on white, and the full logo for the README
    "store/icon-128.png": square(mark, 128, 0.12, white),
    "store/logo-on-white.png": square(cut_out(src.crop(full_box)), 640, 0.06, white).convert("RGB"),
}
full.thumbnail((900, 900), Image.LANCZOS)
out["public/brand/logo.png"] = full
for rel, img in out.items():
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print(f"{rel}  {img.size[0]}x{img.size[1]}")
