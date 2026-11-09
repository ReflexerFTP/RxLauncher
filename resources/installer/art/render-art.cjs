// Рендер картинок установщика: electron resources/installer/art/render-art.cjs
// Пишет installer-art.png — картинку окна установщика.
const {app, BrowserWindow, nativeImage} = require("electron");
const fs = require("fs");
const path = require("path");

const resources = path.resolve(__dirname, "..", "..");
const out = (name) => path.join(resources, name);

app.whenReady().then(async () => {
    const win = new BrowserWindow({show: false, width: 800, height: 600, webPreferences: {offscreen: false}});
    await win.loadFile(path.join(__dirname, "render.html"));
    const grab = async (expression) => nativeImage.createFromDataURL(await win.webContents.executeJavaScript(expression));

    // Панель окна: 300×460 DIP, рисуем в 2×
    const portrait = await grab("renderPortrait(600, 920)");
    fs.writeFileSync(out("installer/installer-art.png"), portrait.toPNG());

    console.log("ART OK");
    app.exit(0);
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
