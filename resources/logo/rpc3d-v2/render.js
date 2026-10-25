const fs = require('node:fs');
const path = require('node:path');
const {ipcRenderer} = require('electron');
const SIZE = Number(process.env.RX_RPC_SIZE || 1024);
const FRAMES = Number(process.env.RX_RPC_FRAMES || 181);
const sourcePath = process.env.RX_RPC_SOURCE || path.resolve(__dirname, '../rxlogo.svg');
const svg = new DOMParser().parseFromString(fs.readFileSync(sourcePath, 'utf8'), 'image/svg+xml');
const scale = 2.20 / 880;
const point = (x, y) => [scale * (x - 512), scale * (512 - y)];

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
const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
renderer.setSize(SIZE, SIZE);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#09090b');
const camera = new THREE.PerspectiveCamera(29, 1, .1, 30);
camera.position.set(0, .035, 5.8); camera.lookAt(0, 0, 0);

// A neutral studio environment produces broad reflections, not coloured gradients on the mark.
const envCanvas = document.createElement('canvas'); envCanvas.width = 2048; envCanvas.height = 1024;
const ctx = envCanvas.getContext('2d');
ctx.fillStyle = '#17171b'; ctx.fillRect(0,0,2048,1024);
function softbox(x,y,w,h,color) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 60;
    ctx.fillStyle = color; ctx.fillRect(x,y,w,h); ctx.restore();
}
softbox(160,250,330,340,'#ffffff');
softbox(1100,350,140,490,'#bcbcc6');
softbox(600,40,850,95,'#eeeeef');
softbox(1750,560,110,290,'#8f1717');
const envTexture = new THREE.CanvasTexture(envCanvas);
envTexture.mapping = THREE.EquirectangularReflectionMapping;
envTexture.colorSpace = THREE.SRGBColorSpace;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(envTexture).texture;
envTexture.dispose(); pmrem.dispose();
const key = new THREE.DirectionalLight('#ffffff', 3.1);
key.position.set(-3,4,5); key.castShadow = true;
key.shadow.mapSize.set(2048,2048); key.shadow.camera.left=-2.4; key.shadow.camera.right=2.4;
key.shadow.camera.top=2.4; key.shadow.camera.bottom=-2.4; key.shadow.bias=-.0003; key.shadow.normalBias=.015;
scene.add(key, new THREE.HemisphereLight('#e4e4ec','#17171b',.9));
const fill = new THREE.DirectionalLight('#d4d4df', .65); fill.position.set(4,1,4); scene.add(fill);
const redLight = new THREE.DirectionalLight('#e53935', .38); redLight.position.set(2,-1,1); scene.add(redLight);
const group = new THREE.Group(); scene.add(group);
function extrude(shape, depth, bevel, material, z) {
    const geometry = new THREE.ExtrudeGeometry(shape,{depth,steps:1,curveSegments:48,bevelEnabled:true,
        bevelSize:bevel,bevelThickness:bevel,bevelSegments:5});
    const mesh = new THREE.Mesh(geometry, material); mesh.position.z = z;
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
}
const graphite = new THREE.MeshPhysicalMaterial({color:'#111114',metalness:.34,roughness:.34,clearcoat:.65,clearcoatRoughness:.28,envMapIntensity:1.05});
const rimMaterial = new THREE.MeshPhysicalMaterial({color:'#33333b',metalness:.9,roughness:.22,envMapIntensity:1.4});
const white = new THREE.MeshPhysicalMaterial({color:'#ffffff',metalness:.13,roughness:.23,clearcoat:.5,clearcoatRoughness:.2,envMapIntensity:.85});
const red = new THREE.MeshPhysicalMaterial({color:'#e53935',metalness:.08,roughness:.24,clearcoat:.9,clearcoatRoughness:.18,envMapIntensity:.7});
const whiteSide = new THREE.MeshPhysicalMaterial({color:'#93939e',metalness:.55,roughness:.3,envMapIntensity:1});
const redSide = new THREE.MeshPhysicalMaterial({color:'#8f1717',metalness:.25,roughness:.25,envMapIntensity:.9});
extrude(roundedRect(2.18,2.18,208*scale), .16, .028, graphite, -.12);
extrude(roundedRect(2.192,2.192,208*scale), .018, .015, rimMaterial, -.076);
const whiteShapes = strokeShape('#ffffff'), redShapes = strokeShape('#e53935');
extrude(whiteShapes,.078,.012,[white,whiteSide],.058);
extrude(redShapes,.065,.012,[red,redSide],.137);

// A soft contact shadow and a restrained red reflection keep the floating slab grounded.
const shadowCanvas = document.createElement('canvas'); shadowCanvas.width=512; shadowCanvas.height=256;
const shadowCtx = shadowCanvas.getContext('2d');
const grad = shadowCtx.createRadialGradient(256,128,10,256,128,128);
grad.addColorStop(0,'rgba(0,0,0,.7)'); grad.addColorStop(1,'rgba(0,0,0,0)');
shadowCtx.fillStyle=grad; shadowCtx.fillRect(0,0,512,256);
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.7,.58),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(shadowCanvas),transparent:true,depthWrite:false}));
shadow.position.set(0,-1.25,-.36); scene.add(shadow);
const bgCanvas = document.createElement('canvas'); bgCanvas.width=1024; bgCanvas.height=1024;
const bgctx = bgCanvas.getContext('2d');
bgctx.fillStyle='#09090b'; bgctx.fillRect(0,0,1024,1024);
const bggrad=bgctx.createRadialGradient(750,700,0,750,700,700);
bggrad.addColorStop(0,'rgba(92,14,18,.25)'); bggrad.addColorStop(1,'rgba(9,9,11,0)');
bgctx.fillStyle=bggrad; bgctx.fillRect(0,0,1024,1024);
scene.background = new THREE.CanvasTexture(bgCanvas); scene.background.colorSpace=THREE.SRGBColorSpace;
function renderFrame(index) {
    const phase= index / 180 * Math.PI * 2;
    group.rotation.set(-.065+.06*Math.cos(phase), .065+.29*Math.sin(phase), .018*Math.sin(phase*2));
    group.position.y=.025*Math.sin(phase*2);
    key.position.x=-3+1.6*Math.sin(phase-.4);
    key.position.z=5+.7*Math.cos(phase);
    shadow.scale.x=1+.035*Math.cos(phase*2);
    renderer.render(scene,camera);
}
(async () => {
    ipcRenderer.send('log', `3D geometry ready: white ${whiteShapes.length} part(s), red ${redShapes.length} part(s)`);
    const previewOnly = process.env.RX_RPC_PREVIEW === 'yes';
    const indices = previewOnly ? [0,30,60,90,120,150] : Array.from({length:FRAMES}, (_,i)=>i);
    for (const index of indices) {
        renderFrame(index);
        const data=renderer.domElement.toDataURL('image/png').split(',')[1];
        await new Promise(resolve=>{ipcRenderer.once('saved',resolve);ipcRenderer.send('frame',index,data);});
    }
    ipcRenderer.send('done',0);
})().catch(error=>{ipcRenderer.send('log',error.stack||String(error));ipcRenderer.send('done',1);});
