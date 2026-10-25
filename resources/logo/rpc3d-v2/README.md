# RxLaunch RPC 3D artwork v2

The geometry is generated from the current `../rxlogo.svg`. It preserves the white R, red stroke (`#E53935`), and charcoal tile. The glyphs and case are separate beveled 3D meshes with studio lighting.

- 6-second seamless loop, 180 frames, 30 fps.
- Animated WebP: 1024 × 1024. GIF: 512 × 512 with exact 6-second frame timing.
- Frame 180 is a duplicate of frame 0 for checking the loop and is not encoded twice.
- Rendering happens only during asset creation; the launcher sends a hosted image URL to Discord.

From the project root, render with the installed Electron runtime:

```powershell
.\node_modules\electron\dist\electron.exe .\resources\logo\rpc3d-v2\main.cjs
```

Frames are written to `dist-rpc-frames/` (already excluded from launcher packages by `!dist-*`). Then encode with Python, Pillow and NumPy:

```powershell
python .\resources\logo\rpc3d-v2\encode.py
```

Output files are written to `resources/logo/`. Optional renderer environment variables: `RX_RPC_SIZE`, `RX_RPC_FRAMES`, `RX_RPC_SOURCE`, `RX_RPC_FRAME_DIR`, and `RX_RPC_PREVIEW=yes` for six representative frames.

Discord requires a publicly accessible image URL for animation; local file paths and assets uploaded to the developer portal do not play animated GIF/WebP. After hosting a generated file, use its direct HTTPS URL as `DISCORD_RPC_LARGE_IMAGE_KEY`, retaining the `RX_DISCORD_RPC_LARGE_IMAGE_KEY` environment override.

Current hosted v2 GIF: <https://i.postimg.cc/8Pgp7Lzb/Rx-Launch-RPC-3D-v2.gif>.
The published file was downloaded and its SHA-256 matched the local GIF.

Vendored renderer libraries: Three.js r158 and polygon-clipping (MIT; licenses in `vendor/`).
