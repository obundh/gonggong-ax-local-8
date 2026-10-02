"""Build Windows and browser brand assets from the approved logo source.

Requires Pillow (``python -m pip install Pillow``).  Run from the project root:
    python scripts/generate-brand-assets.py
"""
from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand" / "recovery-mark-source.png"
PNG_OUTPUTS = (
    ROOT / "assets" / "brand" / "recovery-mark-512.png",
    ROOT / "electron" / "icon.png",
)
ICO_OUTPUT = ROOT / "electron" / "icon.ico"
ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def make_outer_background_transparent(image: Image.Image) -> Image.Image:
    """Remove only the near-white canvas connected to the four outer corners."""
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    seen = set()
    queue = deque((x, y) for x, y in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)))

    def is_canvas_pixel(x: int, y: int) -> bool:
        red, green, blue, _alpha = pixels[x, y]
        return red >= 244 and green >= 244 and blue >= 244

    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < width and 0 <= y < height) or not is_canvas_pixel(x, y):
            continue
        seen.add((x, y))
        red, green, blue, _alpha = pixels[x, y]
        # This is only the connected, near-white exterior canvas. Keep the
        # darker blue antialiased tile edge intact and remove the canvas fully.
        pixels[x, y] = (red, green, blue, 0)
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return rgba


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Approved source is missing: {SOURCE}")
    source = Image.open(SOURCE)
    if source.width != source.height:
        raise SystemExit(f"Logo source must be square, received {source.width}x{source.height}")
    icon = make_outer_background_transparent(source)
    icon_512 = resize(icon, 512)
    for output in PNG_OUTPUTS:
        output.parent.mkdir(parents=True, exist_ok=True)
        icon_512.save(output, format="PNG", optimize=True)
    sizes = [resize(icon, size) for size in ICON_SIZES]
    ICO_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    sizes[-1].save(ICO_OUTPUT, format="ICO", sizes=[(size, size) for size in ICON_SIZES])
    print(f"Generated {ICO_OUTPUT.relative_to(ROOT)} and {len(PNG_OUTPUTS)} PNG assets from {SOURCE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
