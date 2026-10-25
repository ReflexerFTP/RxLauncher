// Рендер картинок установщика: electron resources/installer/art/render-art.cjs
// Пишет installer-art.png (окно установщика) и тёмные BMP для NSIS (удаление/обновление).
const {app, BrowserWindow, nativeImage} = require("electron");
const fs = require("fs");
const path = require("path");

const resources = path.resolve(__dirname, "..", "..");
const out = (name) => path.join(resources, name);

// 24-битный BMP (снизу вверх, строки выровнены по 4 байта) — формат, который ждёт NSIS
const writeBmp = (image, width, height, file) => {
    const resized = image.resize({width, height, quality: "best"});
    const bgra = resized.toBitmap();
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const buffer = Buffer.alloc(54 + rowSize * height);
    buffer.write("BM", 0, "ascii");
    buffer.writeUInt32LE(buffer.length, 2);
    buffer.writeUInt32LE(54, 10);
    buffer.writeUInt32LE(40, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    buffer.writeUInt16LE(1, 26);
    buffer.writeUInt16LE(24, 28);
    buffer.writeUInt32LE(rowSize * height, 34);
    for (let y = 0; y < height; y++) {
        const row = 54 + (height - 1 - y) * rowSize;
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4;
            buffer[row + x * 3] = bgra[src];
            buffer[row + x * 3 + 1] = bgra[src + 1];
            buffer[row + x * 3 + 2] = bgra[src + 2];
        }
    }
    fs.writeFileSync(file, buffer);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({show: false, width: 800, height: 600, webPreferences: {offscreen: false}});
    await win.loadFile(path.join(__dirname, "render.html"));
    const grab = async (expression) => nativeImage.createFromDataURL(await win.webContents.executeJavaScript(expression));

    // Панель окна: 300×460 DIP, рисуем в 2×
    const portrait = await grab("renderPortrait(600, 920)");
    fs.writeFileSync(out("installer/installer-art.png"), portrait.toPNG());

    // NSIS: боковая картинка 164×314 и шапка 150×57 (рисуем крупнее и уменьшаем — так чище)
    const sidebar = await grab("renderPortrait(492, 942)");
    writeBmp(sidebar, 164, 314, out("installerSidebarRx.bmp"));
    writeBmp(sidebar, 164, 314, out("uninstallerSidebarRx.bmp"));
    const banner = await grab("renderBanner(450, 171)");
    writeBmp(banner, 150, 57, out("installerHeaderRx.bmp"));
    writeBmp(banner, 150, 57, out("uninstallerHeaderRx.bmp"));

    // Превью для проверки
    fs.writeFileSync(out("installerSidebarRx.preview.png"), sidebar.resize({width: 164, height: 314}).toPNG());
    fs.writeFileSync(out("installerHeaderRx.preview.png"), banner.resize({width: 150, height: 57}).toPNG());
    console.log("ART OK");
    app.exit(0);
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
