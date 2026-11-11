# RxLaunch RPC 3D artwork v4

The Discord Rich Presence avatar. Same logo geometry as v2/v3 (built from `../rxlogo.svg`), staged as a short 3D shot:

- The tile is thicker, with polished steel edges and a neon strip around its side; the logo is on both faces.
- A full 360° turn early in the loop: the neon dims while the tile turns, then re-ignites with a flash, a scale punch
  and a thin shockwave ring.
- Sparks orbit the tile on a tilted ring and pass behind and in front of it; soft rays rotate slowly behind.
- Glow is a real second pass: only the neon and the sparks are drawn (everything else black, so occlusion is right),
  blurred at four radii and screened over the frame. No colour thresholds.
- 6-second seamless loop, 150 frames at 25 fps (the loop seam check renders frame 150 and compares it with frame 0).

Output: `rxlaunch-rpc-animated-v4.gif` (360 × 360, about 4.9 MB) and `rxlaunch-rpc-poster-v4.png` (1024 × 1024).

The GIF is encoded on the same page with [gifenc](https://github.com/mattdesl/gifenc) (MIT): one palette of 255
colours for the whole animation (+1 transparent), a static 8 × 8 Bayer pattern before quantising (no flicker), and
pixels within `RX_RPC_TOLERANCE` of what is already shown become transparent. A tolerance above 3 leaves faint traces
of the shockwave on the dark background.

From the project root (any Electron 30+; the old Electron project has one):

```powershell
npm install --prefix $env:TEMP\rpc-tools gifenc@1.0.3
$env:RX_GIFENC = "$env:TEMP\rpc-tools\node_modules\gifenc"
& ..\RxLaunch\node_modules\electron\dist\electron.exe .\resources\logo\rpc3d-v4\main.cjs
```

`RX_RPC_PREVIEW=yes` writes a sheet of 8 frames, a Discord-size preview and the poster instead of the GIF.
Other options: `RX_RPC_OUT`, `RX_RPC_NAME`, `RX_RPC_SIZE`, `RX_RPC_FPS`, `RX_RPC_SECONDS`, `RX_RPC_GIF_SIZE`,
`RX_RPC_TOLERANCE` (default 3), `RX_RPC_DITHER` (default 9), `RX_RPC_SOURCE`.

Published at <https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v4.gif>. Launchers from 4.6.0 read the image address
from <https://rxlauncher.xyz/rpc.json> (`{"largeImage": "https://rxlauncher.xyz/…"}`, https on rxlauncher.xyz only),
so a future v5 can be switched on from the site without a launcher release.

Vendored renderer libraries are shared with v2 (`../rpc3d-v2/vendor`): Three.js r158 and polygon-clipping (MIT).
