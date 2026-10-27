# RxLaunch RPC 3D artwork v3

Same geometry as v2 (built from `../rxlogo.svg`: white R, red `#E53935` stroke, charcoal tile), with a new look made to read at Discord's small avatar sizes.

- Dark glass tile with a steel bevel, a hairline inner ring and a lit backdrop, so the silhouette no longer disappears into a black background.
- Sharp clearcoat glints, a diagonal sheen that crosses the mark once per loop, a gently pulsing crimson aura and sparse embers.
- Red glow (bloom) around the slash and on specular peaks is added in `encode.py`.
- 6-second seamless loop, 120 frames, 20 fps. Frame 120 is rendered only to check the loop (difference of 1 level) and is not encoded.
- Animated WebP: 1024 × 1024. GIF: 512 × 512.

From the project root, render with the installed Electron runtime (`RX_RPC_FRAME_DIR` keeps the PNG frames outside the repo; the default `dist-rpc-frames/` is excluded from launcher packages by `!dist-*`):

```powershell
$env:RX_RPC_FRAME_DIR = "$env:TEMP\rpc-frames"
.\node_modules\electron\dist\electron.exe .\resources\logo\rpc3d-v3\main.cjs
python .\resources\logo\rpc3d-v3\encode.py
```

`encode.py` needs Pillow and NumPy and writes `rxlaunch-rpc-animated-v3.gif`, `rxlaunch-rpc-animated-v3.webp` and `rxlaunch-rpc-poster-v3.png` to `resources/logo/`, and `encoding-report.json` next to it.

Renderer options: `RX_RPC_SIZE`, `RX_RPC_LOOP`, `RX_RPC_FRAMES`, `RX_RPC_SOURCE`, `RX_RPC_FRAME_DIR`, and `RX_RPC_PREVIEW=yes` for six representative frames. Encoder options: `RX_RPC_OUT`, `RX_RPC_GIF_SIZE`, `RX_RPC_TOLERANCE` (default 6), `RX_RPC_DITHER` (default 1.4), `RX_RPC_WEBP=no`.

How the GIF stays at 4.8 MB: pixels that stay within `RX_RPC_TOLERANCE` of what is already on screen become transparent (so LZW sees long runs), the palette is refined with k-means, and a static 8×8 Bayer pattern hides banding on the dark gradients without flicker.

Discord requires a publicly accessible image URL for animation. The launcher uses the file hosted on the project site:
<https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v3.gif>. The `RX_DISCORD_RPC_LARGE_IMAGE_KEY` environment override still works. The published file was fetched back and its SHA-256 matched the local GIF.

Vendored renderer libraries are shared with v2 (`../rpc3d-v2/vendor`): Three.js r158 and polygon-clipping (MIT).
