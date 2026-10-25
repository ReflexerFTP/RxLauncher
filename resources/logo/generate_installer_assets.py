from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[2]
RESOURCES = ROOT / "resources"
MASTER = RESOURCES / "installer-art-master-rx.png"
LOGO = RESOURCES / "logo" / "preview.png"

SIDEBAR_SIZE = (164, 314)
HEADER_SIZE = (150, 57)
SCALE = 4


def add_logo(canvas: Image.Image, size: int, x: int, y: int, glow_radius: int) -> None:
    logo = Image.open(LOGO).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    alpha = logo.getchannel("A")
    glow_alpha = alpha.filter(ImageFilter.GaussianBlur(glow_radius)).point(lambda value: int(value * 0.5))
    glow = Image.new("RGBA", logo.size, (255, 41, 116, 0))
    glow.putalpha(glow_alpha)
    canvas.alpha_composite(glow, (x, y))
    canvas.alpha_composite(logo, (x, y))


def create_sidebar(master: Image.Image) -> Image.Image:
    large_size = tuple(value * SCALE for value in SIDEBAR_SIZE)
    canvas = ImageOps.fit(
        master,
        large_size,
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    ).convert("RGBA")

    # Keep the logo area calm while retaining the generated energy scene below it.
    shade = Image.new("RGBA", large_size, (0, 0, 0, 0))
    shade_pixels = shade.load()
    for y in range(large_size[1]):
        progress = y / max(large_size[1] - 1, 1)
        opacity = int(115 * max(0.0, 1.0 - progress * 1.8))
        for x in range(large_size[0]):
            shade_pixels[x, y] = (3, 4, 12, opacity)
    canvas = Image.alpha_composite(canvas, shade)

    logo_size = 94 * SCALE
    add_logo(
        canvas,
        logo_size,
        (large_size[0] - logo_size) // 2,
        38 * SCALE,
        8 * SCALE,
    )

    accent = Image.new("RGBA", large_size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(accent)
    center = large_size[0] // 2
    dot_y = 151 * SCALE
    for offset, color in ((-16, (255, 91, 91, 155)), (0, (255, 39, 128, 230)), (16, (126, 91, 255, 155))):
        radius = 2 * SCALE
        draw.ellipse((center + offset * SCALE - radius, dot_y - radius, center + offset * SCALE + radius, dot_y + radius), fill=color)
    canvas = Image.alpha_composite(canvas, accent)

    return canvas.resize(SIDEBAR_SIZE, Image.Resampling.LANCZOS).convert("RGB")


def create_header(master: Image.Image, uninstall: bool = False) -> Image.Image:
    large_size = tuple(value * SCALE for value in HEADER_SIZE)
    canvas = ImageOps.fit(
        master,
        large_size,
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.72),
    ).convert("RGBA")

    overlay = Image.new("RGBA", large_size, (5, 5, 14, 150 if not uninstall else 178))
    canvas = Image.alpha_composite(canvas, overlay)

    # Blend the artwork into NSIS' light header instead of showing a hard rectangular edge.
    header_fade = Image.new("RGBA", large_size, (0, 0, 0, 0))
    fade_draw = ImageDraw.Draw(header_fade)
    fade_width = 58 * SCALE
    for x in range(fade_width):
        strength = max(0.0, 1.0 - x / max(fade_width - 1, 1))
        fade_draw.line((x, 0, x, large_size[1]), fill=(255, 247, 247, int(255 * strength * strength)))
    canvas = Image.alpha_composite(canvas, header_fade)

    logo_size = 45 * SCALE
    add_logo(canvas, logo_size, large_size[0] - logo_size - 8 * SCALE, 6 * SCALE, 5 * SCALE)

    line = Image.new("RGBA", large_size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(line)
    for x in range(large_size[0]):
        mix = x / max(large_size[0] - 1, 1)
        color = (
            int(255 * (1.0 - mix) + 126 * mix),
            int(79 * (1.0 - mix) + 91 * mix),
            int(92 * (1.0 - mix) + 255 * mix),
            220,
        )
        draw.line((x, large_size[1] - 3 * SCALE, x, large_size[1] - 1), fill=color)
    canvas = Image.alpha_composite(canvas, line)

    return canvas.resize(HEADER_SIZE, Image.Resampling.LANCZOS).convert("RGB")


def create_uninstaller_sidebar(sidebar: Image.Image) -> Image.Image:
    toned = ImageEnhance.Color(sidebar).enhance(0.72)
    toned = ImageEnhance.Brightness(toned).enhance(0.86)
    return toned.convert("RGB")


def save_bitmap(image: Image.Image, filename: str) -> None:
    output = RESOURCES / filename
    image.save(output, format="BMP")


def main() -> None:
    if not MASTER.is_file():
        raise FileNotFoundError(f"Missing generated installer artwork: {MASTER}")
    if not LOGO.is_file():
        raise FileNotFoundError(f"Missing RxLauncher logo: {LOGO}")

    master = Image.open(MASTER).convert("RGB")
    sidebar = create_sidebar(master)
    header = create_header(master)
    uninstaller_sidebar = create_uninstaller_sidebar(sidebar)
    uninstaller_header = create_header(master, uninstall=True)

    save_bitmap(sidebar, "installerSidebarRx.bmp")
    save_bitmap(header, "installerHeaderRx.bmp")
    save_bitmap(uninstaller_sidebar, "uninstallerSidebarRx.bmp")
    save_bitmap(uninstaller_header, "uninstallerHeaderRx.bmp")

    sidebar.save(RESOURCES / "installerSidebarRx.preview.png")
    header.save(RESOURCES / "installerHeaderRx.preview.png")

    print("Generated RxLauncher NSIS artwork: 164x314 sidebar and 150x57 header")


if __name__ == "__main__":
    main()
