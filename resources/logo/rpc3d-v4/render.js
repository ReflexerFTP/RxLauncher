// RxLauncher — 3D-аватарка Discord RPC v4.
// Плитка с логотипом из rxlogo.svg делает полный разворот (на обороте — тот же логотип), неоновый штрих гаснет на
// развороте и вспыхивает снова с ударной волной, искры облетают плитку по наклонной орбите, сзади медленно вращаются лучи.
// Свечение — отдельный проход (светятся только неон и искры) с размытием, без порогов по цвету.
// Петля бесшовная: всё движение — периодические функции от t ∈ [0, 1).
// Здесь же собирается GIF (gifenc): общая палитра на всю анимацию, статичный узор Байера, неизменные пиксели прозрачные.
const fs = require('node:fs');
const path = require('node:path');
const {ipcRenderer} = require('electron');

const SIZE = Number(process.env.RX_RPC_SIZE || 1024);
const FPS = Number(process.env.RX_RPC_FPS || 25);
const SECONDS = Number(process.env.RX_RPC_SECONDS || 6);
const LOOP = FPS * SECONDS;
const GIF_SIZE = Number(process.env.RX_RPC_GIF_SIZE || 360);
const TOLERANCE = Number(process.env.RX_RPC_TOLERANCE || 3);
const DITHER = Number(process.env.RX_RPC_DITHER || 9);
const OUT = process.env.RX_RPC_OUT || path.resolve(__dirname, '..');
const NAME = process.env.RX_RPC_NAME || 'rxlaunch-rpc-animated-v4';
const PREVIEW = process.env.RX_RPC_PREVIEW === 'yes';
const GIFENC = process.env.RX_GIFENC || 'gifenc';
const sourcePath = process.env.RX_RPC_SOURCE || path.resolve(__dirname, '../rxlogo.svg');
const log = message => ipcRenderer.send('log', message);
const TAU = Math.PI * 2;

// ---------- геометрия логотипа из SVG (как в v3) ----------
const svg = new DOMParser().parseFromString(fs.readFileSync(sourcePath, 'utf8'), 'image/svg+xml');
const scale = 2.20 / 880;
const point = (x, y) => [scale * (x - 512), scale * (512 - y)];
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
        for (let i = 1; i < points.length; i++) polygons.push(capsule(points[i - 1], points[i], 48));
    }
    return polygonClipping.union(...polygons).map(polygon => {
        const shape = new THREE.Shape(polygon[0].slice(0, -1).map(p => new THREE.Vector2(...point(...p))));
        for (const hole of polygon.slice(1)) shape.holes.push(new THREE.Path(hole.slice(0, -1).map(p => new THREE.Vector2(...point(...p)))));
        return shape;
    });
}
function roundedRect(w, h, r, path = new THREE.Shape()) {
    const x = -w / 2, y = -h / 2, k = .5522847498307936;
    path.moveTo(x + r, y); path.lineTo(x + w - r, y);
    path.bezierCurveTo(x + w - r + r * k, y, x + w, y + r - r * k, x + w, y + r);
    path.lineTo(x + w, y + h - r); path.bezierCurveTo(x + w, y + h - r + r * k, x + w - r + r * k, y + h, x + w - r, y + h);
    path.lineTo(x + r, y + h); path.bezierCurveTo(x + r - r * k, y + h, x, y + h - r + r * k, x, y + h - r);
    path.lineTo(x, y + r); path.bezierCurveTo(x, y + r - r * k, x + r - r * k, y, x + r, y);
    return path;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rrPath(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const texture = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
let seed = 20261112;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const easeInOut = x => x <= 0 ? 0 : x >= 1 ? 1 : x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
// Расстояние «вперёд» по кругу от a до t (обе в [0, 1)): для событий, которые повторяются раз за петлю
const since = (t, a) => ((t - a) % 1 + 1) % 1;

// ---------- рендерер, камера, окружение ----------
const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(27, 1, .1, 40);
camera.position.set(0, .04, 7.15); camera.lookAt(0, 0, 0);

// Фон: почти чёрный, багровое свечение за плиткой и затемнение к краям
const bg = canvas(1024, 1024), bgc = bg.getContext('2d');
bgc.fillStyle = '#060607'; bgc.fillRect(0, 0, 1024, 1024);
let g = bgc.createRadialGradient(512, 520, 30, 512, 520, 600);
g.addColorStop(0, 'rgba(150,18,26,.55)'); g.addColorStop(.38, 'rgba(70,8,14,.32)'); g.addColorStop(1, 'rgba(6,6,7,0)');
bgc.fillStyle = g; bgc.fillRect(0, 0, 1024, 1024);
const background = texture(bg);
scene.background = background;

// Студийное окружение: софтбоксы отражаются в стали торца при развороте
const env = canvas(2048, 1024), ec = env.getContext('2d');
g = ec.createLinearGradient(0, 0, 0, 1024);
g.addColorStop(0, '#2a2a32'); g.addColorStop(.35, '#16161b'); g.addColorStop(.55, '#0f0f13'); g.addColorStop(1, '#050506');
ec.fillStyle = g; ec.fillRect(0, 0, 2048, 1024);
function softbox(x, y, w, h, color, blur = 40) {
    ec.save(); ec.shadowColor = color; ec.shadowBlur = blur; ec.fillStyle = color; ec.fillRect(x, y, w, h); ec.restore();
}
softbox(1320, 200, 110, 320, '#e4e4ee', 24);
softbox(1700, 140, 46, 600, '#d2d2de', 20);
softbox(1120, 60, 860, 44, '#f0f0f6', 22);
softbox(260, 230, 320, 380, '#d8d8e2', 30);
softbox(720, 160, 60, 520, '#b8b8c6', 22);
softbox(1880, 520, 80, 280, '#c01818', 50);
softbox(1060, 620, 90, 260, '#8a1414', 50);
softbox(40, 600, 160, 200, '#a01414', 50);
const envTexture = texture(env);
envTexture.mapping = THREE.EquirectangularReflectionMapping;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(envTexture).texture;
envTexture.dispose(); pmrem.dispose();

const key = new THREE.DirectionalLight('#ffffff', 3.1);
key.position.set(-3, 4, 5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, {left: -2.6, right: 2.6, top: 2.6, bottom: -2.6});
key.shadow.bias = -.0003; key.shadow.normalBias = .015;
const fill = new THREE.DirectionalLight('#cfd3ea', .6); fill.position.set(4, 1, 4);
const rim = new THREE.DirectionalLight('#ff3b30', 2.4); rim.position.set(3.2, 1.6, -3);
const rim2 = new THREE.DirectionalLight('#ff5040', 1.4); rim2.position.set(-3.4, -1.2, -2.6);
// Красный свет от штриха — подсвечивает белую букву рядом с ним
const slashLight = new THREE.PointLight('#ff2a20', 0, 2.4, 1.6);
scene.add(key, fill, rim, rim2, slashLight, new THREE.HemisphereLight('#e0e1ef', '#16161c', .6));

// ---------- плитка ----------
const tile = new THREE.Group(); scene.add(tile);
const glowItems = []; // {object, color: THREE.Color, strength: () => number}
function extrude(shape, depth, bevel, material, z, segments = 6, parent = tile) {
    const geometry = new THREE.ExtrudeGeometry(shape, {depth, steps: 1, curveSegments: 56, bevelEnabled: bevel > 0,
        bevelSize: bevel, bevelThickness: bevel, bevelSegments: segments});
    const mesh = new THREE.Mesh(geometry, material); mesh.position.z = z;
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

const TILE = 2.10, TILE_R = 208 * scale - .045, DEPTH = .26, BEVEL = .055;
const FACE_SPAN = 2.2;
// Лицевая сторона: графит с лёгким отсветом и тонкой внутренней рамкой из rxlogo.svg
const faceCanvas = canvas(1024, 1024), fc = faceCanvas.getContext('2d');
g = fc.createLinearGradient(0, 0, 1024, 1024);
g.addColorStop(0, '#2d2d36'); g.addColorStop(.45, '#16161b'); g.addColorStop(1, '#0a0a0d');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
g = fc.createRadialGradient(320, 250, 20, 320, 250, 520);
g.addColorStop(0, 'rgba(255,255,255,.11)'); g.addColorStop(1, 'rgba(255,255,255,0)');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
g = fc.createRadialGradient(720, 790, 10, 720, 790, 400);
g.addColorStop(0, 'rgba(229,57,53,.20)'); g.addColorStop(1, 'rgba(229,57,53,0)');
fc.fillStyle = g; fc.fillRect(0, 0, 1024, 1024);
// Мелкая шлифовка: еле заметные концентрические дуги, на развороте они ловят свет
fc.globalAlpha = .035; fc.strokeStyle = '#ffffff'; fc.lineWidth = 1;
for (let r = 40; r < 900; r += 7) { fc.beginPath(); fc.arc(300, 260, r, 0, TAU); fc.stroke(); }
fc.globalAlpha = 1;
const faceSize = TILE / FACE_SPAN * 1024, faceR = TILE_R / FACE_SPAN * 1024, faceInset = (1024 - faceSize) / 2;
fc.strokeStyle = 'rgba(255,255,255,.14)'; fc.lineWidth = 3;
rrPath(fc, faceInset + 12, faceInset + 12, faceSize - 24, faceSize - 24, faceR - 12); fc.stroke();
const faceMap = texture(faceCanvas);
faceMap.anisotropy = 8; faceMap.repeat.set(1 / FACE_SPAN, 1 / FACE_SPAN); faceMap.offset.set(.5, .5);

// Блик-полоса по стеклу лица: проходит по плитке один раз за петлю
const sweepCanvas = canvas(1024, 512), sc = sweepCanvas.getContext('2d');
sc.fillStyle = '#000'; sc.fillRect(0, 0, 1024, 512);
sc.save(); sc.translate(512, 256); sc.transform(1, 0, -.42, 1, 0, 0);
g = sc.createLinearGradient(-120, 0, 120, 0);
g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
sc.fillStyle = g; sc.fillRect(-120, -400, 240, 800);
g = sc.createLinearGradient(150, 0, 182, 0);
g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
sc.fillStyle = g; sc.fillRect(150, -400, 32, 800);
sc.restore();
const sweep = texture(sweepCanvas);
sweep.wrapS = THREE.RepeatWrapping; sweep.repeat.set(1 / (FACE_SPAN * 2), 1 / FACE_SPAN); sweep.offset.set(0, .5);

const faceMaterial = new THREE.MeshPhysicalMaterial({color: '#ffffff', map: faceMap, metalness: .25, roughness: .38,
    clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: .5, emissive: '#ffffff', emissiveMap: sweep, emissiveIntensity: .18});
const steel = new THREE.MeshPhysicalMaterial({color: '#80808e', metalness: 1, roughness: .14, envMapIntensity: 1.8, clearcoat: .4});
const white = new THREE.MeshPhysicalMaterial({color: '#f6f6f9', metalness: .08, roughness: .26, clearcoat: .8, clearcoatRoughness: .07,
    envMapIntensity: .75, emissive: '#ffffff', emissiveMap: sweep, emissiveIntensity: .16});
const whiteSide = new THREE.MeshPhysicalMaterial({color: '#a6a6b2', metalness: .7, roughness: .22, envMapIntensity: 1.3});
const neonFace = new THREE.MeshPhysicalMaterial({color: '#e01a12', metalness: 0, roughness: .2, clearcoat: 1, clearcoatRoughness: .08,
    envMapIntensity: .45, emissive: '#ff0e06', emissiveIntensity: .6});
const neonSide = new THREE.MeshPhysicalMaterial({color: '#c01c1c', metalness: .2, roughness: .2, envMapIntensity: .9,
    emissive: '#e01010', emissiveIntensity: 1.1});
const stripMaterial = new THREE.MeshBasicMaterial({color: '#ff2a1e'});

// Плитка (центр по толщине — в нуле), неоновый кант по торцу
const slab = extrude(roundedRect(TILE, TILE, TILE_R), DEPTH, BEVEL, [faceMaterial, steel], -DEPTH / 2, 10);
const stripShape = roundedRect(TILE + 2 * BEVEL + .035, TILE + 2 * BEVEL + .035, TILE_R + BEVEL + .017);
stripShape.holes.push(roundedRect(TILE + 2 * BEVEL - .03, TILE + 2 * BEVEL - .03, TILE_R + BEVEL - .015, new THREE.Path()));
const strip = extrude(stripShape, .036, 0, stripMaterial, -.018);
strip.castShadow = false;
glowItems.push({object: strip, color: new THREE.Color('#ff1408'), strength: () => state.edge});

// Логотип: спереди и сзади (развёрнутая копия читается правильно, а не зеркально)
const whiteShapes = strokeShape('#ffffff'), redShapes = strokeShape('#e53935');
const FACE_Z = DEPTH / 2 + BEVEL;
function logo(parent) {
    const w = extrude(whiteShapes, .1, .017, [white, whiteSide], FACE_Z - .02, 6, parent);
    const r = extrude(redShapes, .085, .017, [neonFace, neonSide], FACE_Z + .07, 6, parent);
    glowItems.push({object: r, color: new THREE.Color('#ff1206'), strength: () => state.slash});
    return {w, r};
}
const front = new THREE.Group(), back = new THREE.Group();
back.rotation.y = Math.PI;
tile.add(front, back);
logo(front); logo(back);

// ---------- искры по орбите ----------
const discCanvas = canvas(64, 64), dc = discCanvas.getContext('2d');
g = dc.createRadialGradient(32, 32, 0, 32, 32, 32);
g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
dc.fillStyle = g; dc.fillRect(0, 0, 64, 64);
const disc = new THREE.CanvasTexture(discCanvas);
const orbit = new THREE.Group();
orbit.rotation.set(1.16, 0, -.42); // наклонная орбита: спереди искры проходят перед плиткой, сзади — за ней
scene.add(orbit);
function makeSparks(count, size, tint, radius, spread, laps, brightness) {
    const items = Array.from({length: count}, () => ({a: rand(), r: radius + (rand() - .5) * spread, h: (rand() - .5) * spread * .6,
        laps: laps + (rand() < .3 ? 1 : 0), tw: 1 + Math.floor(rand() * 4), ph: rand() * TAU, trail: rand()}));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({size, map: disc, vertexColors: true, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true}));
    points.frustumCulled = false; orbit.add(points);
    return {items, geometry, points, tint: new THREE.Color(tint), brightness};
}
const sparks = [
    makeSparks(70, .085, '#ff5a40', 1.4, .12, 1, 1.3),
    makeSparks(22, .17, '#ff8a6a', 1.46, .26, 1, .6),
    makeSparks(40, .05, '#ffd8cc', 1.34, .07, 2, 1.1)
];
function updateSparks(t) {
    for (const set of sparks) {
        const pos = set.geometry.attributes.position, col = set.geometry.attributes.color;
        set.items.forEach((s, i) => {
            const angle = TAU * (s.a + s.laps * t);
            pos.setXYZ(i, s.r * Math.cos(angle), s.r * Math.sin(angle), s.h);
            const fade = (.55 + .45 * Math.sin(TAU * s.tw * t + s.ph)) * set.brightness * state.sparks;
            col.setXYZ(i, set.tint.r * fade, set.tint.g * fade, set.tint.b * fade);
        });
        pos.needsUpdate = true; col.needsUpdate = true;
    }
}
sparks.forEach(set => glowItems.push({object: set.points, keep: true}));

// ---------- лучи, ореол, ударная волна, тень ----------
const raysCanvas = canvas(1024, 1024), rc = raysCanvas.getContext('2d');
rc.translate(512, 512);
for (let i = 0; i < 12; i++) {
    rc.save(); rc.rotate(i * TAU / 12);
    g = rc.createLinearGradient(0, 0, 512, 0);
    g.addColorStop(0, 'rgba(255,70,55,.0)'); g.addColorStop(.18, 'rgba(255,70,55,.35)'); g.addColorStop(1, 'rgba(255,40,30,0)');
    rc.fillStyle = g; rc.beginPath(); rc.moveTo(0, 0); rc.lineTo(512, -46 - (i % 3) * 18); rc.lineTo(512, 46 + (i % 3) * 18); rc.closePath(); rc.fill();
    rc.restore();
}
const rays = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({map: texture(raysCanvas), transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: .22}));
rays.position.z = -3.2; scene.add(rays);

const auraCanvas = canvas(512, 512), ac = auraCanvas.getContext('2d');
g = ac.createRadialGradient(256, 256, 10, 256, 256, 256);
g.addColorStop(0, 'rgba(255,60,50,.95)'); g.addColorStop(.35, 'rgba(200,24,30,.45)'); g.addColorStop(1, 'rgba(120,10,16,0)');
ac.fillStyle = g; ac.fillRect(0, 0, 512, 512);
const aura = new THREE.Sprite(new THREE.SpriteMaterial({map: texture(auraCanvas), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: .45}));
aura.scale.set(5.4, 5.4, 1); aura.position.set(.15, -.1, -1.1); scene.add(aura);

const waveCanvas = canvas(512, 512), wc = waveCanvas.getContext('2d');
g = wc.createRadialGradient(256, 256, 150, 256, 256, 256);
g.addColorStop(0, 'rgba(255,80,60,0)'); g.addColorStop(.82, 'rgba(255,60,45,0)'); g.addColorStop(.9, 'rgba(255,200,180,.95)');
g.addColorStop(.95, 'rgba(255,60,45,.45)'); g.addColorStop(1, 'rgba(255,40,30,0)');
wc.fillStyle = g; wc.fillRect(0, 0, 512, 512);
const wave = new THREE.Sprite(new THREE.SpriteMaterial({map: texture(waveCanvas), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0}));
wave.position.set(0, 0, -.5); scene.add(wave);

const shadowCanvas = canvas(512, 256), shc = shadowCanvas.getContext('2d');
g = shc.createRadialGradient(256, 128, 10, 256, 128, 128);
g.addColorStop(0, 'rgba(0,0,0,.8)'); g.addColorStop(1, 'rgba(0,0,0,0)');
shc.fillStyle = g; shc.fillRect(0, 0, 512, 256);
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.9, .55), new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(shadowCanvas),
    transparent: true, depthWrite: false}));
shadow.position.set(0, -1.46, -.5); scene.add(shadow);

// ---------- проход свечения: светятся только неон и искры, остальное — чёрное (с правильным перекрытием) ----------
const black = new THREE.MeshBasicMaterial({color: '#000000'});
const glowMaterials = new Map();
glowItems.forEach(item => { if (!item.keep) glowMaterials.set(item.object, new THREE.MeshBasicMaterial({color: '#000000'})); });
function renderGlow() {
    const saved = [];
    scene.traverse(object => {
        if (object.isMesh && !object.isSprite) {
            saved.push([object, object.material, object.visible]);
            const item = glowItems.find(entry => entry.object === object);
            if (item && !item.keep) {
                const material = glowMaterials.get(object);
                material.color.copy(item.color).multiplyScalar(item.strength());
                object.material = material;
            } else if (object === rays || object === shadow) object.visible = false;
            else object.material = black;
        } else if (object.isSprite) { saved.push([object, object.material, object.visible]); object.visible = false; }
    });
    const bgSaved = scene.background, envSaved = scene.environment, toneSaved = renderer.toneMapping;
    scene.background = new THREE.Color('#000000'); scene.environment = null; renderer.toneMapping = THREE.NoToneMapping;
    renderer.render(scene, camera);
    scene.background = bgSaved; scene.environment = envSaved; renderer.toneMapping = toneSaved;
    for (const [object, material, visible] of saved) { object.material = material; object.visible = visible; }
}

// ---------- хореография ----------
const SPIN_START = .05, SPIN_END = .37, IGNITE = .39;
const state = {slash: 1, edge: 1, sparks: 1};
function pose(t) {
    const spin = easeInOut((t - SPIN_START) / (SPIN_END - SPIN_START));
    const mid = Math.sin(Math.PI * spin);              // 0 до и после разворота, 1 в середине
    const ignite = since(t, IGNITE);                   // время после вспышки, доли петли
    const flash = Math.exp(-ignite / .045) * (t >= IGNITE || t < SPIN_START ? 1 : 0);
    // Покачивание затухает на время разворота, чтобы он шёл чисто
    const idle = 1 - .85 * smooth(mid * 1.6);
    tile.rotation.set(-.07 + .05 * Math.sin(TAU * t * 2) * idle - .16 * mid,
        TAU * spin + .3 * Math.sin(TAU * t + .5) * idle,
        .025 * Math.sin(TAU * t) * idle);
    tile.position.set(0, .035 * Math.sin(TAU * t * 2 + .4) + .09 * mid, 0);
    const punch = 1 + .045 * Math.exp(-Math.pow(ignite / .035, 2)) * (t >= IGNITE ? 1 : 0);
    tile.scale.setScalar(punch);
    // Неон гаснет на развороте и вспыхивает после него
    const breathe = .1 * Math.sin(TAU * t * 2 - .6);
    state.slash = Math.max(.25, 1.05 + breathe - .8 * mid) + 2.6 * flash;
    state.edge = Math.max(.2, .8 + breathe - .6 * mid) + 1.8 * flash;
    state.sparks = .75 + .25 * Math.sin(TAU * t) + 1.2 * flash;
    neonFace.emissiveIntensity = .55 * state.slash; neonSide.emissiveIntensity = .45 * state.slash;
    slashLight.intensity = 2.2 * state.slash;
    slashLight.position.set(.55, -.62, FACE_Z + .45).applyEuler(tile.rotation);
    aura.material.opacity = .42 + .06 * breathe * 5 + .35 * flash;
    aura.position.x = .15 + .12 * Math.sin(TAU * t);
    // Ударная волна после вспышки
    const w = ignite / .22;
    wave.material.opacity = t >= IGNITE && w < 1 ? Math.pow(1 - w, 1.6) * .8 : 0;
    wave.scale.setScalar(2.4 + 2.8 * smooth(w));
    rays.rotation.z = -TAU / 4 * t; // узор лучей повторяется через 90°
    rays.material.opacity = .2 + .05 * Math.sin(TAU * t) + .18 * flash;
    key.position.set(-3 + 1.4 * Math.sin(TAU * t - .4), 4, 5 + .7 * Math.cos(TAU * t));
    sweep.offset.x = .25 - t;
    shadow.scale.x = 1 + .05 * Math.cos(TAU * t * 2) - .25 * mid;
    shadow.material.opacity = 1 - .45 * mid;
    updateSparks(t);
}

// ---------- кадр: красота + свечение + виньетка ----------
const glowCanvas = canvas(SIZE, SIZE), gctx = glowCanvas.getContext('2d');
const frame = canvas(SIZE, SIZE), fctx = frame.getContext('2d');
function composite() {
    fctx.globalCompositeOperation = 'source-over'; fctx.filter = 'none'; fctx.globalAlpha = 1;
    fctx.drawImage(renderer.domElement, 0, 0);
    fctx.globalCompositeOperation = 'screen';
    for (const [radius, alpha] of [[SIZE / 110, .45], [SIZE / 38, .75], [SIZE / 14, .6], [SIZE / 6, .32]]) {
        fctx.filter = `blur(${radius}px)`; fctx.globalAlpha = alpha; fctx.drawImage(glowCanvas, 0, 0);
    }
    fctx.filter = 'none'; fctx.globalAlpha = 1;
    // Виньетка: края темнее, центр не трогаем
    fctx.globalCompositeOperation = 'multiply';
    const v = fctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * .32, SIZE / 2, SIZE / 2, SIZE * .74);
    v.addColorStop(0, '#ffffff'); v.addColorStop(1, '#5a5a5e');
    fctx.fillStyle = v; fctx.fillRect(0, 0, SIZE, SIZE);
    fctx.globalCompositeOperation = 'source-over';
}
function renderFrame(index) {
    pose((index % LOOP) / LOOP);
    renderGlow();
    gctx.clearRect(0, 0, SIZE, SIZE); gctx.drawImage(renderer.domElement, 0, 0);
    renderer.render(scene, camera);
    composite();
}

// ---------- уменьшение и GIF ----------
const half = canvas(SIZE / 2, SIZE / 2), hctx = half.getContext('2d');
const small = canvas(GIF_SIZE, GIF_SIZE), sctx = small.getContext('2d', {willReadFrequently: true});
hctx.imageSmoothingQuality = 'high'; sctx.imageSmoothingQuality = 'high';
function downscale() {
    hctx.drawImage(frame, 0, 0, SIZE / 2, SIZE / 2);
    sctx.drawImage(half, 0, 0, GIF_SIZE, GIF_SIZE);
    return sctx.getImageData(0, 0, GIF_SIZE, GIF_SIZE).data;
}
const savePng = (c, file) => fs.writeFileSync(file, Buffer.from(c.toDataURL('image/png').split(',')[1], 'base64'));

(async () => {
    fs.mkdirSync(OUT, {recursive: true});
    log(`v4: geometry white ${whiteShapes.length}, red ${redShapes.length}; ${LOOP} frames @ ${FPS} fps, GIF ${GIF_SIZE}px`);
    if (PREVIEW) {
        // Лист из 8 кадров и вид в размере Discord (иконка 120 и 60 пикселей)
        const sheet = canvas(4 * 384, 2 * 384), shctx = sheet.getContext('2d');
        const discord = canvas(560, 140), dctx = discord.getContext('2d');
        dctx.fillStyle = '#2b2d31'; dctx.fillRect(0, 0, 560, 140);
        const picks = [0, .1, .18, .26, .34, .4, .5, .75];
        picks.forEach((t, k) => {
            renderFrame(Math.round(t * LOOP));
            shctx.drawImage(frame, (k % 4) * 384, Math.floor(k / 4) * 384, 384, 384);
            if (k < 4) { dctx.save(); rrPath(dctx, 10 + k * 135, 10, 120, 120, 10); dctx.clip(); dctx.drawImage(frame, 10 + k * 135, 10, 120, 120); dctx.restore(); }
        });
        savePng(sheet, path.join(OUT, `${NAME}-sheet.png`));
        savePng(discord, path.join(OUT, `${NAME}-discord.png`));
        renderFrame(Math.round(.55 * LOOP));
        savePng(frame, path.join(OUT, `${NAME}-poster.png`));
        ipcRenderer.send('done', 0);
        return;
    }
    const {GIFEncoder, quantize, applyPalette} = require(GIFENC);
    const frames = [];
    let seam = 0;
    for (let index = 0; index <= LOOP; index++) {
        renderFrame(index);
        const data = downscale();
        if (index < LOOP) frames.push(new Uint8ClampedArray(data));
        else for (let i = 0; i < data.length; i++) seam = Math.max(seam, Math.abs(data[i] - frames[0][i]));
        if (index === Math.round(.55 * LOOP)) savePng(frame, path.join(OUT, `${NAME}-poster.png`));
        if (index % 25 === 0) log(`frame ${index}/${LOOP}`);
    }
    log(`loop seam: max channel difference ${seam}`);

    // Общая палитра (255 цветов + прозрачный) по выборке пикселей всех кадров
    const step = 5, sample = [];
    frames.forEach((data, k) => { if (k % 2 === 0) for (let i = 0; i < data.length; i += 4 * step) sample.push(data[i], data[i + 1], data[i + 2], 255); });
    const palette = quantize(new Uint8Array(sample), 255, {format: 'rgb565'});
    while (palette.length < 255) palette.push([0, 0, 0]);
    const TRANSPARENT = 255;
    const fullPalette = [...palette, [0, 0, 0]];
    const bayer = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map(v => (v / 64 - .5) * DITHER);
    const gif = GIFEncoder();
    const shown = new Uint8Array(GIF_SIZE * GIF_SIZE * 3);
    const tol2 = TOLERANCE * TOLERANCE * 3;
    let changedTotal = 0;
    frames.forEach((data, k) => {
        const dithered = new Uint8ClampedArray(data.length);
        for (let y = 0, i = 0; y < GIF_SIZE; y++) for (let x = 0; x < GIF_SIZE; x++, i += 4) {
            const d = bayer[(y & 7) * 8 + (x & 7)];
            dithered[i] = data[i] + d; dithered[i + 1] = data[i + 1] + d; dithered[i + 2] = data[i + 2] + d; dithered[i + 3] = 255;
        }
        const index = applyPalette(dithered, palette, 'rgb565');
        if (k > 0) {
            for (let p = 0; p < index.length; p++) {
                const c = palette[index[p]], o = p * 3;
                const dr = c[0] - shown[o], dg = c[1] - shown[o + 1], db = c[2] - shown[o + 2];
                if (dr * dr + dg * dg + db * db <= tol2) index[p] = TRANSPARENT;
                else { shown[o] = c[0]; shown[o + 1] = c[1]; shown[o + 2] = c[2]; changedTotal++; }
            }
        } else {
            for (let p = 0; p < index.length; p++) { const c = palette[index[p]]; shown.set(c, p * 3); }
        }
        gif.writeFrame(index, GIF_SIZE, GIF_SIZE, k === 0
            ? {palette: fullPalette, delay: Math.round(1000 / FPS), repeat: 0}
            : {delay: Math.round(1000 / FPS), transparent: true, transparentIndex: TRANSPARENT, dispose: 1});
    });
    gif.finish();
    const bytes = gif.bytes();
    fs.writeFileSync(path.join(OUT, `${NAME}.gif`), bytes);
    const report = {frames: LOOP, fps: FPS, gifSize: GIF_SIZE, bytes: bytes.length, tolerance: TOLERANCE, dither: DITHER,
        changedPixelsPerFrame: Math.round(changedTotal / (LOOP - 1)), loopSeam: seam};
    fs.writeFileSync(path.join(__dirname, 'encoding-report.json'), JSON.stringify(report, null, 2));
    log(`GIF: ${(bytes.length / 1048576).toFixed(2)} MB → ${path.join(OUT, `${NAME}.gif`)}`);
    ipcRenderer.send('done', 0);
})().catch(error => { log(error.stack || String(error)); ipcRenderer.send('done', 1); });
