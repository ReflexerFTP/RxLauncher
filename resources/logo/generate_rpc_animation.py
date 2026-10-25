from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "resources" / "logo" / "preview.png"
GIF_OUTPUT = ROOT / "resources" / "logo" / "rxlaunch-rpc-animated-v1.gif"
WEBP_OUTPUT = ROOT / "resources" / "logo" / "rxlaunch-rpc-animated-v1.webp"
POSTER_OUTPUT = ROOT / "resources" / "logo" / "rxlaunch-rpc-poster-v1.png"

OUTPUT_SIZE = 512
RENDER_SIZE = 768
FRAME_COUNT = 48
FRAME_DURATION_MS = 70


def perspective_coefficients(destination: list[tuple[float, float]], source: list[tuple[float, float]]) -> tuple[float, ...]:
    """Return Pillow perspective coefficients mapping output pixels to source pixels."""
    matrix: list[list[float]] = []
    values: list[float] = []
    for (x, y), (u, v) in zip(destination, source):
        matrix.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        values.append(u)
        matrix.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.append(v)
    return tuple(float(value) for value in np.linalg.solve(np.asarray(matrix), np.asarray(values)))


def rotation_matrix(yaw: float, pitch: float, roll: float) -> np.ndarray:
    cy, sy = math.cos(yaw), math.sin(yaw)
    cx, sx = math.cos(pitch), math.sin(pitch)
    cz, sz = math.cos(roll), math.sin(roll)

    rotate_y = np.asarray([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]])
    rotate_x = np.asarray([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]])
    rotate_z = np.asarray([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]])
    return rotate_z @ rotate_y @ rotate_x


def projected_quad(matrix: np.ndarray, z_offset: float, center_y: float) -> list[tuple[float, float]]:
    half = 318.0
    camera_distance = 1260.0
    focal_length = 1090.0
    center_x = RENDER_SIZE / 2.0

    corners = np.asarray(
        [
            [-half, -half, z_offset],
            [half, -half, z_offset],
            [half, half, z_offset],
            [-half, half, z_offset],
        ]
    )
    rotated = corners @ matrix.T
    result: list[tuple[float, float]] = []
    for x, y, z in rotated:
        scale = focal_length / (camera_distance - z)
        result.append((center_x + x * scale, center_y + y * scale))
    return result


def warp_texture(texture: Image.Image, quad: list[tuple[float, float]]) -> Image.Image:
    width, height = texture.size
    source = [(0.0, 0.0), (width - 1.0, 0.0), (width - 1.0, height - 1.0), (0.0, height - 1.0)]
    coefficients = perspective_coefficients(quad, source)
    return texture.transform(
        (RENDER_SIZE, RENDER_SIZE),
        Image.Transform.PERSPECTIVE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
        fillcolor=(0, 0, 0, 0),
    )


def add_moving_sheen(texture: Image.Image, progress: float) -> Image.Image:
    width, height = texture.size
    x = int(-0.45 * width + progress * 1.9 * width)
    sheen_mask = Image.new("L", texture.size, 0)
    draw = ImageDraw.Draw(sheen_mask)
    draw.polygon(
        [
            (x - 78, -80),
            (x + 20, -80),
            (x + 190, height + 80),
            (x + 92, height + 80),
        ],
        fill=112,
    )
    sheen_mask = sheen_mask.filter(ImageFilter.GaussianBlur(30))
    sheen_mask = ImageChops.multiply(sheen_mask, texture.getchannel("A"))
    sheen = Image.new("RGBA", texture.size, (255, 226, 255, 0))
    sheen.putalpha(sheen_mask)
    return Image.alpha_composite(texture, sheen)


def make_background(progress: float) -> Image.Image:
    size = RENDER_SIZE
    yy, xx = np.mgrid[0:size, 0:size]
    phase = progress * math.tau

    base = np.zeros((size, size, 3), dtype=np.float32)
    base[:, :, 0] = 4.0
    base[:, :, 1] = 6.0
    base[:, :, 2] = 15.0

    warm_x = size * (0.25 + 0.035 * math.sin(phase))
    warm_y = size * (0.38 + 0.025 * math.cos(phase))
    cool_x = size * (0.76 + 0.035 * math.cos(phase))
    cool_y = size * (0.68 + 0.025 * math.sin(phase))

    warm = np.exp(-(((xx - warm_x) / (size * 0.34)) ** 2 + ((yy - warm_y) / (size * 0.36)) ** 2) * 2.0)
    cool = np.exp(-(((xx - cool_x) / (size * 0.38)) ** 2 + ((yy - cool_y) / (size * 0.34)) ** 2) * 2.0)
    center = np.exp(-(((xx - size / 2) / (size * 0.55)) ** 2 + ((yy - size / 2) / (size * 0.55)) ** 2) * 2.5)

    base += warm[:, :, None] * np.asarray([52.0, 4.0, 30.0])
    base += cool[:, :, None] * np.asarray([17.0, 11.0, 58.0])
    base += center[:, :, None] * np.asarray([5.0, 5.0, 11.0])

    vignette_x = (xx - size / 2) / (size / 2)
    vignette_y = (yy - size / 2) / (size / 2)
    vignette = np.clip(1.0 - 0.35 * (vignette_x**2 + vignette_y**2), 0.48, 1.0)
    base *= vignette[:, :, None]

    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


PARTICLES = [
    (0.03, 0.80, 0.55, 1, 2.0),
    (0.12, 0.96, 0.68, 1, 1.4),
    (0.19, 0.72, 0.86, 2, 1.7),
    (0.27, 1.03, 0.58, 1, 2.4),
    (0.34, 0.83, 0.76, 2, 1.3),
    (0.42, 0.92, 0.93, 1, 1.8),
    (0.51, 0.77, 0.62, 1, 2.2),
    (0.58, 1.08, 0.79, 2, 1.5),
    (0.66, 0.87, 0.51, 1, 1.9),
    (0.73, 0.98, 0.88, 2, 1.2),
    (0.81, 0.75, 0.70, 1, 2.3),
    (0.89, 1.02, 0.60, 2, 1.6),
]


def draw_neon_orbit(canvas: Image.Image, progress: float) -> None:
    phase_degrees = progress * 360.0
    orbit_box = (86, 205, RENDER_SIZE - 86, RENDER_SIZE - 176)

    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.arc(orbit_box, phase_degrees + 8, phase_degrees + 114, fill=(255, 52, 124, 150), width=10)
    glow_draw.arc(orbit_box, phase_degrees + 188, phase_degrees + 292, fill=(118, 89, 255, 145), width=10)
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(16)))

    sharp = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sharp_draw = ImageDraw.Draw(sharp)
    sharp_draw.arc(orbit_box, phase_degrees + 8, phase_degrees + 114, fill=(255, 104, 157, 190), width=3)
    sharp_draw.arc(orbit_box, phase_degrees + 188, phase_degrees + 292, fill=(159, 133, 255, 180), width=3)
    canvas.alpha_composite(sharp)


def draw_particles(canvas: Image.Image, progress: float) -> None:
    phase = progress * math.tau
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sharp = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    sharp_draw = ImageDraw.Draw(sharp)

    for index, (offset, radius_x, radius_y, speed, radius) in enumerate(PARTICLES):
        angle = phase * speed + offset * math.tau
        x = RENDER_SIZE / 2 + math.cos(angle) * 318 * radius_x
        y = RENDER_SIZE / 2 + math.sin(angle) * 246 * radius_y
        pulse = 0.58 + 0.42 * (0.5 + 0.5 * math.sin(angle * 2.0 + index))
        color = (255, 77, 139) if index % 2 == 0 else (139, 112, 255)
        glow_radius = radius * 4.4
        glow_draw.ellipse(
            (x - glow_radius, y - glow_radius, x + glow_radius, y + glow_radius),
            fill=(*color, int(88 * pulse)),
        )
        sharp_draw.ellipse(
            (x - radius, y - radius, x + radius, y + radius),
            fill=(min(color[0] + 35, 255), min(color[1] + 35, 255), min(color[2] + 35, 255), int(205 * pulse)),
        )

    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)))
    canvas.alpha_composite(sharp)


def tint_alpha(source: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    tinted = Image.new("RGBA", source.size, color)
    tinted.putalpha(ImageChops.multiply(source.getchannel("A"), Image.new("L", source.size, color[3])))
    return tinted


def render_frame(source: Image.Image, index: int) -> Image.Image:
    progress = index / FRAME_COUNT
    phase = progress * math.tau
    canvas = make_background(progress)

    draw_neon_orbit(canvas, progress)
    draw_particles(canvas, progress)

    yaw = math.radians(24.0) * math.sin(phase)
    pitch = math.radians(9.0) * math.cos(phase)
    roll = math.radians(1.8) * math.sin(phase * 2.0)
    matrix = rotation_matrix(yaw, pitch, roll)
    center_y = RENDER_SIZE / 2 + 8.0 * math.sin(phase * 2.0)

    texture = add_moving_sheen(source, progress)
    front_quad = projected_quad(matrix, 22.0, center_y)
    front = warp_texture(texture, front_quad)

    shadow_alpha = front.getchannel("A").filter(ImageFilter.GaussianBlur(34))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha.point(lambda value: int(value * 0.50)))
    shadow = ImageChops.offset(shadow, 0, 30)
    canvas.alpha_composite(shadow)

    glow_alpha = front.getchannel("A").filter(ImageFilter.GaussianBlur(24))
    warm_glow = Image.new("RGBA", canvas.size, (255, 43, 107, 0))
    warm_glow.putalpha(glow_alpha.point(lambda value: int(value * 0.23)))
    cool_glow = Image.new("RGBA", canvas.size, (116, 83, 255, 0))
    cool_glow.putalpha(glow_alpha.point(lambda value: int(value * 0.17)))
    canvas.alpha_composite(ImageChops.offset(warm_glow, -10, 5))
    canvas.alpha_composite(ImageChops.offset(cool_glow, 12, -4))

    edge_texture = tint_alpha(source, (42, 14, 52, 244))
    for depth in np.linspace(-24.0, 18.0, 15):
        edge_quad = projected_quad(matrix, float(depth), center_y)
        canvas.alpha_composite(warp_texture(edge_texture, edge_quad))

    canvas.alpha_composite(front)

    sparkle = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sparkle_draw = ImageDraw.Draw(sparkle)
    sparkle_angle = phase + 0.62
    sparkle_x = RENDER_SIZE / 2 + math.cos(sparkle_angle) * 230
    sparkle_y = center_y + math.sin(sparkle_angle) * 210
    sparkle_strength = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(phase * 2.0))
    ray = 16 * sparkle_strength
    sparkle_draw.line((sparkle_x - ray, sparkle_y, sparkle_x + ray, sparkle_y), fill=(255, 222, 255, 210), width=2)
    sparkle_draw.line((sparkle_x, sparkle_y - ray, sparkle_x, sparkle_y + ray), fill=(255, 222, 255, 210), width=2)
    sparkle_draw.ellipse((sparkle_x - 4, sparkle_y - 4, sparkle_x + 4, sparkle_y + 4), fill=(255, 255, 255, 230))
    canvas.alpha_composite(sparkle.filter(ImageFilter.GaussianBlur(7)))
    canvas.alpha_composite(sparkle)

    return canvas.convert("RGB").resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.Resampling.LANCZOS)


def save_animation(frames: list[Image.Image]) -> None:
    sample_indices = [0, FRAME_COUNT // 6, FRAME_COUNT // 3, FRAME_COUNT // 2, FRAME_COUNT * 2 // 3, FRAME_COUNT * 5 // 6]
    palette_sample = Image.new("RGB", (OUTPUT_SIZE * 3, OUTPUT_SIZE * 2))
    for position, frame_index in enumerate(sample_indices):
        palette_sample.paste(frames[frame_index], ((position % 3) * OUTPUT_SIZE, (position // 3) * OUTPUT_SIZE))
    palette = palette_sample.quantize(colors=112, method=Image.Quantize.MEDIANCUT)
    gif_frames = [frame.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG) for frame in frames]

    gif_frames[0].save(
        GIF_OUTPUT,
        save_all=True,
        append_images=gif_frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    frames[0].save(
        WEBP_OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        quality=86,
        method=6,
        minimize_size=True,
    )
    frames[0].save(POSTER_OUTPUT, optimize=True)


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    frames = [render_frame(source, index) for index in range(FRAME_COUNT)]
    save_animation(frames)
    print(f"GIF: {GIF_OUTPUT} ({GIF_OUTPUT.stat().st_size / 1024 / 1024:.2f} MiB)")
    print(f"WebP: {WEBP_OUTPUT} ({WEBP_OUTPUT.stat().st_size / 1024 / 1024:.2f} MiB)")
    print(f"Poster: {POSTER_OUTPUT} ({POSTER_OUTPUT.stat().st_size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
