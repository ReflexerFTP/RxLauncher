// Генератор иконок RxLauncher: SVG -> PNG (через Chromium) -> ICO
// Запуск: electron resources/logo/genicon.js
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SVG = path.join(__dirname, "rxlogo.svg");

// Собрать .ico из массива PNG-буферов (PNG-entries, поддерживается Windows Vista+)
function buildIco(images) {
    // images: [{ size, buf }]
    const count = images.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(count, 4);

    const dirEntries = [];
    const imageDatas = [];
    let offset = 6 + count * 16;

    for (const img of images) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
        entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
        entry.writeUInt8(0, 2);  // colors
        entry.writeUInt8(0, 3);  // reserved
        entry.writeUInt16LE(1, 4);   // planes
        entry.writeUInt16LE(32, 6);  // bpp
        entry.writeUInt32LE(img.buf.length, 8);  // size
        entry.writeUInt32LE(offset, 12);         // offset
        offset += img.buf.length;
        dirEntries.push(entry);
        imageDatas.push(img.buf);
    }

    return Buffer.concat([header, ...dirEntries, ...imageDatas]);
}

async function run() {
    const svg = fs.readFileSync(SVG, "utf8");
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

    const win = new BrowserWindow({
        width: 1024,
        height: 1024,
        show: false,
        transparent: true,
        frame: false,
        webPreferences: { offscreen: false },
    });

    const html = `<!DOCTYPE html><html><head><style>
        html,body{margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden}
        img{width:1024px;height:1024px;display:block}
    </style></head><body><img src="${dataUrl}"/></body></html>`;

    await win.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
    await new Promise((r) => setTimeout(r, 600));

    // Базовый снимок 1024
    const image = await win.capturePage();
    const basePng = image.toPNG();

    const base = nativeImage.createFromBuffer(basePng);

    // Главная PNG-иконка приложения (512)
    const png512 = base.resize({ width: 512, height: 512, quality: "best" }).toPNG();
    fs.writeFileSync(path.join(ROOT, "web", "assets", "icon.png"), png512);

    // Размеры для .ico
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const icoImages = icoSizes.map((s) => ({
        size: s,
        buf: base.resize({ width: s, height: s, quality: "best" }).toPNG(),
    }));
    const ico = buildIco(icoImages);
    fs.writeFileSync(path.join(ROOT, "resources", "icon.ico"), ico);

    // Превью для проверки
    fs.writeFileSync(path.join(__dirname, "preview.png"), png512);

    console.log("ICON OK: web/assets/icon.png (512), resources/icon.ico (" + icoSizes.join(",") + ")");
    win.destroy();
    app.quit();
}

app.whenReady().then(run).catch((e) => {
    console.error("ICON FAIL", e);
    app.exit(1);
});
