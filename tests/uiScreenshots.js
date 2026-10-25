// Скриншоты всех разделов лаунчера — для сравнения интерфейса до и после правок.
// Запуск: electron ./tests/uiScreenshots.js [папка] [ширина]x[высота]
const {app, BrowserWindow, ipcMain} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs-electron");

const args = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const outDir = path.resolve(args[0] || path.join(os.tmpdir(), "rxlaunch-ui-shots"));
const [width, height] = String(args[1] || "1400x900").split("x").map(Number);
fs.mkdirSync(outDir, {recursive: true});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-ui-shots-"));
process.env.USERPROFILE = tempRoot;
process.env.APPDATA = path.join(tempRoot, "AppData", "Roaming");
app.setPath("userData", path.join(tempRoot, "user-data"));

let markReady;
const ready = new Promise(resolve => { markReady = resolve; });
ipcMain.on("isAppInDev", event => { event.returnValue = true; });
ipcMain.on("isAppInTest", event => { event.returnValue = false; });
ipcMain.on("get-userdata-path", event => { event.returnValue = app.getPath("userData"); });
ipcMain.on("launcher-ready", () => markReady());
for (const channel of ["console-log", "discord-rpc-settings", "discord-rpc-game-start", "discord-rpc-game-update", "discord-rpc-game-stop",
    "game-process-state", "appear-main-window", "disappear-main-window", "hide-main-window", "maximize-main-window", "close-main-window",
    "reload-main-window", "focus-fix"]) ipcMain.on(channel, () => {});
for (const channel of ["save-dialog", "open-dialog"]) ipcMain.handle(channel, async () => false);
ipcMain.handle("curseforge-key-status", async () => ({configured: false}));
ipcMain.handle("curseforge-request", async () => ({success: false, status: 0, error: "offline"}));
ipcMain.handle("minecraft-skin-lookup", async () => ({success: true, found: false}));
ipcMain.handle("server-catalog-connectivity", async () => false);
ipcMain.handle("server-status-query", async () => ({online: false}));
ipcMain.handle("discord-rpc-status", async () => ({connected: false}));
ipcMain.handle("network-compatibility-check", async () => ({ok: true}));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// [имя файла, код для показа раздела]
const STAGES = [
    ["home", `RxModals.switchModal("content")`],
    ["catalog", `RxModals.switchModal("catalog")`],
    ["instances", `RxModals.switchModal("instances")`],
    ["mods", `RxModals.switchModal("mods")`],
    ["mods-catalog", `RxModals.switchModal("mods").then(() => $('#modal-mods [data-mods-view="catalog"]').click())`],
    ["skins", `RxModals.switchModal("skins")`],
    ["servers", `RxModals.switchModal("servers")`],
    ["statistics", `RxModals.switchModal("statistics")`],
    ["screenshots", `RxModals.switchModal("screenshots")`],
    ["console", `RxModals.switchModal("console")`],
    ["friends", `RxModals.switchModal("friends")`],
    ["settings", `RxModals.switchModal("settings")`],
    ["settings-personalization", `$('#modal-settings .tabs .tab[data-tab="personalization"]').click()`],
    ["settings-game", `$('#modal-settings .tabs .tab[data-tab="game"]').click()`],
    ["settings-java", `$('#modal-settings .tabs .tab[data-tab="java"]').click()`],
    ["settings-startup", `$('#modal-settings .tabs .tab[data-tab="startup"]').click()`],
    ["settings-about", `$('#modal-settings .tabs .tab[data-tab="about"]').click()`],
    ["home-again", `RxModals.switchModal("content")`],
    ["accounts", `RxAccountsUI.open()`],
    ["versions", `RxModals.hideCurrentOverlay().then(() => RxVersionsUI.open())`],
    ["palette", `RxModals.hideCurrentOverlay().then(() => typeof RxCommandPalette !== "undefined" && RxCommandPalette.open())`]
];

app.whenReady().then(async () => {
    ejs.listen();
    const window = new BrowserWindow({width, height, show: false, frame: false, webPreferences: {nodeIntegration: true, contextIsolation: false}});
    const errors = [];
    window.webContents.on("console-message", (event, details) => {
        const {level, message} = details && typeof details === "object" ? details : event;
        if (["warning", "error"].includes(level) && !/Autofill|DevTools|THREE\.WebGLProgram/i.test(message)) errors.push(message);
    });
    await window.loadURL(`file://${path.join(__dirname, "..", "web", "index.ejs").replace(/\\/g, "/")}`);
    await Promise.race([ready, delay(15000)]);
    window.showInactive();
    await delay(1500);
    await window.webContents.executeJavaScript(`(() => {
        RxConfig.write("activeVersion", "fabric-1.21.4");
        RxAccountsManager.addLocalAccount("Steve");
        RxAccountsUI.reloadAccountSelect();
        RxVersionsUI.loadVersions();
        RxToasts.removeAll();
    })()`);
    await delay(800);

    for (const [name, code] of STAGES) {
        try {
            const exists = await window.webContents.executeJavaScript(`(async () => {
                const name = ${JSON.stringify(name)};
                const modal = (${JSON.stringify(code)}.match(/switchModal\\("(\\w+)"\\)/) || [])[1];
                if (modal && !document.querySelector("#modal-" + modal)) return false;
                await (${code});
                RxToasts.removeAll();
                return true;
            })()`);
            if (!exists) continue;
            await delay(700);
            const image = await window.webContents.capturePage();
            fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
        } catch (error) {
            errors.push(`${name}: ${error.message}`);
        }
    }
    fs.writeFileSync(path.join(outDir, "errors.json"), JSON.stringify(errors, null, 2));
    console.log(JSON.stringify({outDir, errors}, null, 2));
    window.destroy();
    app.exit(0);
}).catch(error => {
    console.error(error);
    app.exit(1);
});
