const fs = require('node:fs');
const path = require('node:path');
const {ipcRenderer} = require('electron');
const SIZE = Number(process.env.RX_RPC_SIZE || 1024);
const LOOP = Number(process.env.RX_RPC_LOOP || 120);
const FRAMES = Number(process.env.RX_RPC_FRAMES || LOOP + 1);
const sourcePath = process.env.RX_RPC_SOURCE || path.resolve(__dirname, '../rxlogo.svg');
const svg = new DOMParser().parseFromString(fs.readFileSync(sourcePath, 'utf8'), 'image/svg+xml');
const scale = 2.20 / 880;
const point = (x, y) => [scale * (x - 512), scale * (512 - y)];
const TAU = Math.PI * 2;

// Union round-ended strokes from the actual launcher SVG before extruding them.
function parsePath(d) {
    const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g);
    const p = new THREE.Path();
    let x = 0, y = 0, i = 0, cmd;
    while (i < tokens.length) {
        if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
        if (cmd === 'M' || cmd === 'L') {
            x = +tokens[i++]; y = +tokens[i++];
            p[cmd === 'M' ? 'moveTo' : 'lineTo'](x, y);
            if (cmd === 'M') cmd = 'L';
        } else if (cmd === 'V') { y = +tokens[i++]; p.lineTo(x, y); }
        else if (cmd === 'H') { x = +tokens[i++]; p.lineTo(x, y); }
        else if (cmd === 'C') {
            const a = tokens.slice(i, i + 6).map(Number); i += 6;
            p.bezierCurveTo(...a); x = a[4]; y = a[5];
        } else throw new Error('Unsupported source path command: ' + cmd);
    }
    return p.getPoints(60);
}
function capsule(a, b, r) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const ring = [];
    for (let i = 0; i <= 24; i++) {
        const theta = angle - Math.PI / 2 + i * Math.PI / 24;
        ring.push([b.x + r * Math.cos(theta), b.y + r * Math.sin(theta)]);
    }
    for (let i = 0; i <= 24; i++) {
        const theta = angle + Math.PI / 2 + i * Math.PI / 24;
        ring.push([a.x + r * Math.cos(theta), a.y + r * Math.sin(theta)]);
    }
    ring.push(ring[0]);
    return [ring];
}
function strokeShape(color) {
    const paths = [...svg.querySelectorAll('path')].filter(p => p.getAttribute('stroke').toLowerCase() === color);
    const polygons = [];
    for (const p of paths) {
        const points = parsePath(p.getAttribute('d'));
        for (let i = 1; i < points.length; i++) polygons.push(capsule(points[i-1], points[i], 48));
    }
    const union = polygonClipping.union(...polygons);
    return union.map(polygon => {
        const shape = new THREE.Shape(polygon[0].slice(0,-1).map(p => new THREE.Vector2(...point(...p))));
        for (const hole of polygon.slice(1)) shape.holes.push(new THREE.Path(hole.slice(0,-1).map(p => new THREE.Vector2(...point(...p)))));
        return shape;
    });
}
function roundedRect(w, h, r) {
    const p = new THREE.Shape(), x = -w/2, y = -h/2;
    const k = .5522847498307936;
    p.moveTo(x+r,y); p.lineTo(x+w-r,y);
    p.bezierCurveTo(x+w-r+r*k,y,x+w,y+r-r*k,x+w,y+r);
    p.lineTo(x+w,y+h-r); p.bezierCurveTo(x+w,y+h-r+r*k,x+w-r+r*k,y+h,x+w-r,y+h);
    p.lineTo(x+r,y+h); p.bezierCurveTo(x+r-r*k,y+h,x,y+h-r+r*k,x,y+h-r);
    p.lineTo(x,y+r); p.bezierCurveTo(x,y+r-r*k,x+r-r*k,y,x+r,y); p.closePath();
    return p;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rrPath(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}

const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(29, 1, .1, 40);
camera.position.set(0, .02, 6.15); camera.lookAt(0, 0, 0);

// Backdrop: deep black with a crimson bloom behind the mark, so the dark tile has a visible silhouette.
const bg = canvas(1024, 1024), bgc = bg.getContext('2d');
bgc.fillStyle = '#08080a'; bgc.fillRect(0, 0, 1024, 1024);
let g = bgc.createRadialGradient(512, 540, 40, 512, 540, 560);
g.addColorStop(0, 'rgba(140,20,28,.46)'); g.addColorStop(.45, 'rgba(72,10,15,.28)'); g.addColorStop(1, 'rgba(8,8,10,0)');
bgc.fillStyle = g; bgc.fillRect(0, 0, 1024, 1024);
g = bgc.createRadialGradient(512, 512, 380, 512, 512, 760);
g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.6)');
bgc.fillStyle = g; bgc.fillRect(0, 0, 1024, 1024);
scene.background = new THREE.CanvasTexture(bg); scene.background.colorSpace = THREE.SRGBColorSpace;

// Studio environment: broad softboxes sit where the tile face mirrors them while it swings, so reflections glide across it.
const env = canvas(2048, 1024), ec = env.getContext('2d');
g = ec.createLinearGradient(0, 0, 0, 1024);
g.addColorStop(0, '#26262d'); g.addColorStop(.32, '#18181d'); g.addColorStop(.5, '#121216'); g.addColorStop(1, '#060608');
ec.fillStyle = g; ec.fillRect(0, 0, 2048, 1024);
function softbox(x, y, w, h, color, blur = 50) {
    ec.save(); ec.shadowColor = color; ec.shadowBlur = blur; ec.fillStyle = color; ec.fillRect(x, y, w, h); ec.restore();
}
softbox(1350, 210, 90, 300, '#d6d6e0', 26);
softbox(1700, 150, 40, 560, '#c9c9d4', 22);
softbox(1160, 70, 800, 40, '#e4e4ec', 24);
softbox(1860, 560, 60, 240, '#b01c1c');
softbox(1180, 640, 70, 220, '#7a1313');
softbox(300, 250, 300, 360, '#cfcfd8');
softbox(1000, 300, 90, 400, '#8e8e99');
const envTexture = new THREE.CanvasTexture(env);
envTexture.mapping = THREE.EquirectangularReflectionMapping;
envTexture.colorSpace = THREE.SRGBColorSpace;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(envTexture).texture;
envTexture.dispose(); pmrem.dispose();

const key = new THREE.DirectionalLight('#ffffff', 2.9);
key.position.set(-3, 4, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, {left: -2.6, right: 2.6, top: 2.6, bottom: -2.6});
key.shadow.bias = -.0003; key.shadow.normalBias = .015;
const fill = new THREE.DirectionalLight('#cfd2e6', .55); fill.position.set(4, 1, 4);
const rim = new THREE.DirectionalLight('#ff4a3d', 1.6); rim.position.set(3.5, 1.2, -2.5);
scene.add(key, fill, rim, new THREE.HemisphereLight('#dfe0ee', '#1a1a20', .75));

const group = new THREE.Group(); scene.add(group);
function extrude(shape, depth, bevel, material, z, segments = 6) {
    const geometry = new THREE.ExtrudeGeometry(shape, {depth, steps: 1, curveSegments: 56, bevelEnabled: true,
        bevelSize: bevel, bevelThickness: bevel, bevelSegments: segments});
    const mesh = new THREE.Mesh(geometry, material); mesh.position.z = z;
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
}

// Face texture: graphite gradient with the hairline inner ring from rxlogo.svg. Shape UVs are world XY, hence repeat/offset.
const FACE_SPAN = 2.2;
const faceCanvas = canvas(1024, 1024), fc = faceCanvas.getContext('2d');
g = fc.createLinearGradient(0, 0, 1024, 1024);
g.addColorStop(0, '#2b2b33'); g.addColorStop(.45, '#17171c'); g.addColorStop(1, '#0c0c0f');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
g = fc.createRadialGradient(330, 260, 20, 330, 260, 520);
g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(1, 'rgba(255,255,255,0)');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
g = fc.createRadialGradient(720, 780, 10, 720, 780, 380);
g.addColorStop(0, 'rgba(229,57,53,.16)'); g.addColorStop(1, 'rgba(229,57,53,0)');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
const faceSize = 2.10 / FACE_SPAN * 1024, faceR = (208 * scale - .045) / FACE_SPAN * 1024, faceInset = (1024 - faceSize) / 2;
fc.strokeStyle = 'rgba(255,255,255,.13)'; fc.lineWidth = 3;
rrPath(fc, faceInset + 10, faceInset + 10, faceSize - 20, faceSize - 20, faceR - 10); fc.stroke();
const faceMap = new THREE.CanvasTexture(faceCanvas);
faceMap.colorSpace = THREE.SRGBColorSpace; faceMap.anisotropy = 8;
faceMap.repeat.set(1 / FACE_SPAN, 1 / FACE_SPAN); faceMap.offset.set(.5, .5);

// Sweep texture: a glassy diagonal sheen on a 4.4-unit period; it crosses the mark once per loop.
const sweepCanvas = canvas(1024, 512), sc = sweepCanvas.getContext('2d');
sc.fillStyle = '#000'; sc.fillRect(0, 0, 1024, 512);
sc.save(); sc.translate(512, 256); sc.transform(1, 0, -.42, 1, 0, 0);
g = sc.createLinearGradient(-130, 0, 130, 0);
g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
sc.fillStyle = g; sc.fillRect(-130, -400, 260, 800);
g = sc.createLinearGradient(150, 0, 185, 0);
g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
sc.fillStyle = g; sc.fillRect(150, -400, 35, 800);
sc.restore();
const sweep = new THREE.CanvasTexture(sweepCanvas);
sweep.colorSpace = THREE.SRGBColorSpace; sweep.wrapS = THREE.RepeatWrapping;
sweep.repeat.set(1 / (FACE_SPAN * 2), 1 / FACE_SPAN); sweep.offset.set(0, .5);

const faceMaterial = new THREE.MeshPhysicalMaterial({color: '#ffffff', map: faceMap, metalness: .2, roughness: .42,
    clearcoat: 1, clearcoatRoughness: .055, envMapIntensity: .45, emissive: '#ffffff', emissiveMap: sweep, emissiveIntensity: .2});
const steel = new THREE.MeshPhysicalMaterial({color: '#6b6b78', metalness: 1, roughness: .2, envMapIntensity: 1.5});
const white = new THREE.MeshPhysicalMaterial({color: '#f4f4f7', metalness: .1, roughness: .3, clearcoat: .6, clearcoatRoughness: .09,
    envMapIntensity: .7, emissive: '#ffffff', emissiveMap: sweep, emissiveIntensity: .2});
const whiteSide = new THREE.MeshPhysicalMaterial({color: '#a2a2ae', metalness: .6, roughness: .28, envMapIntensity: 1.1});
const red = new THREE.MeshPhysicalMaterial({color: '#e53935', metalness: .06, roughness: .2, clearcoat: 1, clearcoatRoughness: .14,
    envMapIntensity: .55, emissive: '#ff1f1f', emissiveIntensity: .26});
const redSide = new THREE.MeshPhysicalMaterial({color: '#b01e1e', metalness: .3, roughness: .22, envMapIntensity: 1,
    emissive: '#c01414', emissiveIntensity: .25});

extrude(roundedRect(2.10, 2.10, 208 * scale - .045), .14, .045, [faceMaterial, steel], -.12, 8);
const whiteShapes = strokeShape('#ffffff'), redShapes = strokeShape('#e53935');
extrude(whiteShapes, .09, .016, [white, whiteSide], .052);
extrude(redShapes, .075, .016, [red, redSide], .13);

// Aura behind the tile (pulses with the slash) and a soft contact shadow.
const auraCanvas = canvas(512, 512), ac = auraCanvas.getContext('2d');
g = ac.createRadialGradient(256, 256, 20, 256, 256, 256);
g.addColorStop(0, 'rgba(255,60,50,.9)'); g.addColorStop(.35, 'rgba(200,28,32,.45)'); g.addColorStop(1, 'rgba(120,10,16,0)');
ac.fillStyle = g; ac.fillRect(0, 0, 512, 512);
const aura = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(auraCanvas), color: '#ffffff',
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: .4}));
aura.scale.set(5.1, 5.1, 1); aura.position.set(.2, -.15, -.9); scene.add(aura);
const shadowCanvas = canvas(512, 256), shc = shadowCanvas.getContext('2d');
g = shc.createRadialGradient(256, 128, 10, 256, 128, 128);
g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)');
shc.fillStyle = g; shc.fillRect(0, 0, 512, 256);
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.9, .6), new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false}));
shadow.position.set(0, -1.38, -.45); scene.add(shadow);

// Embers: sparse additive points that drift upward and wrap with a fade, so the loop stays seamless.
const discCanvas = canvas(64, 64), dc = discCanvas.getContext('2d');
g = dc.createRadialGradient(32, 32, 0, 32, 32, 32);
g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.35, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
dc.fillStyle = g; dc.fillRect(0, 0, 64, 64);
const disc = new THREE.CanvasTexture(discCanvas);
let seed = 20261026;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const RANGE = 4.6;
function makeEmbers(count, size, tint, zMin, zMax, brightness) {
    const items = [];
    while (items.length < count) {
        const x = (rand() - .5) * 5, z = zMin + rand() * (zMax - zMin);
        if (Math.abs(x) < 1.3 && z > -.4) continue;
        items.push({x, z, y0: rand(), cycles: rand() < .6 ? 1 : 2, sway: .03 + rand() * .06, phase: rand() * TAU, tw: 1 + Math.floor(rand() * 3), twPhase: rand() * TAU});
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({size, map: disc, vertexColors: true, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true}));
    points.frustumCulled = false; scene.add(points);
    return {items, geometry, tint: new THREE.Color(tint), brightness};
}
const embers = [
    makeEmbers(46, .06, '#ff5a44', -2.4, .6, 1),
    makeEmbers(18, .13, '#ff8a70', -2.6, -.8, .55),
    makeEmbers(7, .34, '#d83b3b', -3, -1.4, .26)
];
function updateEmbers(t) {
    for (const set of embers) {
        const pos = set.geometry.attributes.position, col = set.geometry.attributes.color;
        set.items.forEach((e, i) => {
            const u = (((e.y0 + e.cycles * t) % 1) + 1) % 1;
            pos.setXYZ(i, e.x + e.sway * Math.sin(TAU * t + e.phase), (u - .5) * RANGE, e.z);
            const fade = Math.sin(Math.PI * u) ** 1.5 * (.65 + .35 * Math.sin(TAU * e.tw * t + e.twPhase)) * set.brightness;
            col.setXYZ(i, set.tint.r * fade, set.tint.g * fade, set.tint.b * fade);
        });
        pos.needsUpdate = true; col.needsUpdate = true;
    }
}

function renderFrame(index) {
    const t = index / LOOP, phase = t * TAU;
    group.rotation.set(-.06 + .05 * Math.sin(phase * 2), .42 * Math.sin(phase), .02 * Math.sin(phase));
    group.position.set(0, .03 * Math.sin(phase * 2 + .4), 0);
    key.position.set(-3 + 1.5 * Math.sin(phase - .4), 4, 5 + .7 * Math.cos(phase));
    const pulse = Math.sin(phase * 2 - .6);
    red.emissiveIntensity = .26 + .1 * pulse;
    redSide.emissiveIntensity = .25 + .08 * pulse;
    aura.material.opacity = .52 + .1 * pulse;
    aura.position.x = .2 + .12 * Math.sin(phase);
    sweep.offset.x = .25 - t;
    shadow.scale.x = 1 + .04 * Math.cos(phase * 2);
    updateEmbers(t);
    renderer.render(scene, camera);
}
(async () => {
    ipcRenderer.send('log', `3D geometry ready: white ${whiteShapes.length} part(s), red ${redShapes.length} part(s)`);
    const previewOnly = process.env.RX_RPC_PREVIEW === 'yes';
    const indices = previewOnly ? [0, 1, 2, 3, 4, 5].map(i => Math.round(i * LOOP / 6)) : Array.from({length: FRAMES}, (_, i) => i);
    for (const index of indices) {
        renderFrame(index);
        const data = renderer.domElement.toDataURL('image/png').split(',')[1];
        await new Promise(resolve => { ipcRenderer.once('saved', resolve); ipcRenderer.send('frame', index, data); });
    }
    ipcRenderer.send('done', 0);
})().catch(error => { ipcRenderer.send('log', error.stack || String(error)); ipcRenderer.send('done', 1); });
