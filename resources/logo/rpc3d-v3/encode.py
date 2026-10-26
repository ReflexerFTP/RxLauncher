from pathlib import Path
import json
import os
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
FRAMES_DIR = Path(os.environ.get('RX_RPC_FRAME_DIR') or ROOT.parents[2] / 'dist-rpc-frames')
OUTPUT = Path(os.environ.get('RX_RPC_OUT') or ROOT.parent)
LOOP = int(os.environ.get('RX_RPC_LOOP', 120))
GIF_SIZE = int(os.environ.get('RX_RPC_GIF_SIZE', 512))
FRAME_MS = 50  # 120 frames x 50 ms = 6 s seamless loop
TOLERANCE = int(os.environ.get('RX_RPC_TOLERANCE', 6))
DITHER = float(os.environ.get('RX_RPC_DITHER', 1.4))
OUTPUT.mkdir(exist_ok=True)

# --- bloom: red glow from the slash plus a faint halo on specular peaks ---------------------------------------------
_filters = {}
def blur(plane, sigma):
    key = (plane.shape, sigma)
    if key not in _filters:
        ky = np.fft.fftfreq(plane.shape[0])[:, None]
        kx = np.fft.rfftfreq(plane.shape[1])[None, :]
        _filters[key] = np.exp(-2 * np.pi ** 2 * sigma ** 2 * (kx ** 2 + ky ** 2)).astype(np.float32)
    return np.fft.irfft2(np.fft.rfft2(plane) * _filters[key], s=plane.shape).astype(np.float32)

def grade(path):
    img = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    red = np.clip((r - np.maximum(g, b) - .30) / .45, 0, 1)
    glow = .5 * blur(red, 9) + .38 * blur(red, 32) + .3 * blur(red, 90)
    luma = .2126 * r + .7152 * g + .0722 * b
    peaks = np.clip((luma - .86) / .14, 0, 1)
    shine = .22 * blur(peaks, 5) + .12 * blur(peaks, 20)
    add = glow[..., None] * np.array([1, .17, .13], np.float32) * .9 + shine[..., None] * np.array([1, .97, .95], np.float32)
    out = 1 - (1 - img) * (1 - np.clip(add, 0, .95))
    return Image.fromarray((np.clip(out, 0, 1) * 255 + .5).astype(np.uint8))

paths = sorted(FRAMES_DIR.glob('*.png'))
if len(paths) < LOOP:
    raise SystemExit(f'Need {LOOP} rendered frames in {FRAMES_DIR}, found {len(paths)}')
frames = [grade(p) for p in paths[:LOOP]]
closing = grade(paths[LOOP]) if len(paths) > LOOP else None

webp = OUTPUT / 'rxlaunch-rpc-animated-v3.webp'
if os.environ.get('RX_RPC_WEBP', 'yes') != 'no':
    frames[0].save(webp, save_all=True, append_images=frames[1:], duration=FRAME_MS, loop=0, quality=84, method=4)
frames[0].save(OUTPUT / 'rxlaunch-rpc-poster-v3.png', optimize=True)

# GIF: 256 colours need help on dark gradients.
#  - A static 8x8 Bayer pattern is added before quantising; it is identical on every frame, so it does not flicker.
#  - The palette is refined with k-means over sampled pixels, which keeps edges and glints closer than median cut alone.
#  - Pixels that stay within TOLERANCE of what is already on screen become transparent, so LZW sees long runs.
bayer = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38],
                  [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], np.float32) / 64 - .5
tile = np.tile(bayer, (GIF_SIZE // 8, GIF_SIZE // 8))[..., None] * DITHER
def to_gif_input(im):
    small = np.asarray(im.resize((GIF_SIZE, GIF_SIZE), Image.Resampling.LANCZOS), dtype=np.float32)
    return Image.fromarray(np.clip(small + tile, 0, 255).astype(np.uint8))
smalls = [to_gif_input(im) for im in frames]

COLORS = 255  # index 255 is reserved for "unchanged"
def build_palette(images, iters=12):
    rng = np.random.default_rng(1)
    px = np.concatenate([np.asarray(im).reshape(-1, 3)[rng.integers(0, GIF_SIZE ** 2, 50000)] for im in images]).astype(np.float32)
    montage = Image.new('RGB', (GIF_SIZE, GIF_SIZE * len(images)))
    for i, im in enumerate(images): montage.paste(im, (0, i * GIF_SIZE))
    centers = np.array(montage.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).getpalette()[:COLORS * 3], np.float32).reshape(-1, 3)
    px_sq = (px ** 2).sum(1)[:, None]
    for _ in range(iters):
        nearest = (px_sq - 2 * px @ centers.T + (centers ** 2).sum(1)[None, :]).argmin(1)
        for k in range(COLORS):
            members = nearest == k
            if members.any(): centers[k] = px[members].mean(0)
    return np.clip(centers + .5, 0, 255).astype(np.uint8)
palette_rgb = build_palette(smalls[::5])
flat = palette_rgb.flatten().tolist()
flat += flat[:3] + [0] * (768 - len(flat) - 3)  # entry 255 mirrors entry 0 so the quantiser never needs it
quantizer = Image.new('P', (1, 1)); quantizer.putpalette(flat)
palette16 = np.vstack([palette_rgb, palette_rgb[:1]]).astype(np.int16)
indexed = [np.where(a == 255, 0, a).astype(np.uint8) for a in (np.asarray(im.quantize(palette=quantizer, dither=Image.Dither.NONE)) for im in smalls)]
shown = indexed[0].copy(); delta = [indexed[0]]
for current in indexed[1:]:
    changed = np.abs(palette16[current] - palette16[shown]).max(axis=2) > TOLERANCE
    shown = np.where(changed, current, shown)
    frame = np.full(current.shape, 255, np.uint8); frame[changed] = current[changed]
    delta.append(frame)
gif_frames = []
for data in delta:
    im = Image.fromarray(data, 'P'); im.putpalette(flat); gif_frames.append(im)
gif = OUTPUT / 'rxlaunch-rpc-animated-v3.gif'
gif_frames[0].save(gif, save_all=True, append_images=gif_frames[1:], duration=FRAME_MS, loop=0, optimize=False, disposal=1, transparency=255)

report = {}
for file in [f for f in (webp, gif) if f.exists()]:
    with Image.open(file) as im:
        total = 0
        for i in range(im.n_frames):
            im.seek(i); im.load(); total += im.info.get('duration', 0)
        report[file.name] = {'bytes': file.stat().st_size, 'size': im.size, 'frames': im.n_frames, 'duration_ms': total, 'loop': im.info.get('loop')}
if closing is not None:
    report['loop_endpoint_max_difference'] = int(np.abs(np.asarray(frames[0], np.int16) - np.asarray(closing, np.int16)).max())
(ROOT / 'encoding-report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
