from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FRAMES_DIR = ROOT.parents[2] / 'dist-rpc-frames'
OUTPUT = ROOT.parent
OUTPUT.mkdir(exist_ok=True)
paths = sorted(FRAMES_DIR.glob('*.png'))
frames = [Image.open(path).convert('RGB') for path in paths]
sheet = Image.new('RGB', (1152, 800), '#101014')
draw = ImageDraw.Draw(sheet)
for i, index in enumerate([0,30,60,90,120,150]):
    p = FRAMES_DIR / f'{index:04}.png'
    if not p.exists(): continue
    im = Image.open(p).convert('RGB').resize((368,368), Image.Resampling.LANCZOS)
    x, y = (i%3)*384+8, (i//3)*400+8
    sheet.paste(im,(x,y))
    draw.text((x+10,y+374),f'{index/30:.1f} s',fill='#b9b9c4')
sheet.save(ROOT / 'contact-sheet.png')
if len(paths) < 180:
    print(f'Preview sheet ready, {len(paths)} frames')
    raise SystemExit(0)
frames = frames[:180]
durations = [33,33,34]*60
webp = OUTPUT / 'rxlaunch-rpc-animated-v2.webp'
frames[0].save(webp,save_all=True,append_images=frames[1:],duration=durations,loop=0,quality=82,method=3,minimize_size=False)
small = [im.resize((512,512),Image.Resampling.LANCZOS) for im in frames]
palette_sheet = Image.new('RGB',(512*3,512*2))
for i,index in enumerate([0,30,60,90,120,150]): palette_sheet.paste(small[index],((i%3)*512,(i//3)*512))
palette=palette_sheet.quantize(colors=256,method=Image.Quantize.MEDIANCUT)
gifframes=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in small]
gif=OUTPUT / 'rxlaunch-rpc-animated-v2.gif'
gifframes[0].save(gif,save_all=True,append_images=gifframes[1:],duration=[30,30,40]*60,loop=0,optimize=True,disposal=1)
frames[0].save(OUTPUT / 'rxlaunch-rpc-poster-v2.png',optimize=True)
report={}
for file in [webp,gif]:
    with Image.open(file) as im:
        duration=0
        for i in range(im.n_frames): im.seek(i); im.load(); duration+=im.info.get('duration',0)
        report[file.name]={'bytes':file.stat().st_size,'size':im.size,'frames':im.n_frames,'duration_ms':duration,'loop':im.info.get('loop')}
if (FRAMES_DIR/'0180.png').exists():
    first=np.asarray(Image.open(FRAMES_DIR/'0000.png').convert('RGB'),dtype=np.int16)
    last=np.asarray(Image.open(FRAMES_DIR/'0180.png').convert('RGB'),dtype=np.int16)
    report['loop_endpoint_max_difference']=int(np.abs(first-last).max())
(ROOT/'encoding-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
