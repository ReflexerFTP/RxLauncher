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
    ["catalog", `RxModals.switchModal("catalog").then(() => new Promise(resolve => setTimeout(resolve, 2500)))`],
    ["catalog-details", `RxCatalog.openDetails($("#modal-catalog .cat-card").first().attr("data-project")).then(() => new Promise(resolve => setTimeout(resolve, 1500)))`],
    ["catalog-mods", `(RxCatalog.closeDetails(), RxCatalog.switchType("mod"), new Promise(resolve => setTimeout(resolve, 2500)))`],
    ["catalog-shaders", `(RxCatalog.switchType("shader"), new Promise(resolve => setTimeout(resolve, 2500)))`],
    ["instances", `RxModals.switchModal("instances")`],
    ["instances-worlds", `RxWorldsUI.setView("worlds")`],
    ["dialog", `RxDialog.confirm({icon: "report", title: "Проверка", text: "Пример диалога", items: [{icon: "error", level: "error", title: "Sodium", text: "Нужен Minecraft 1.21"}], extraButton: {text: "Открыть моды", icon: "extension"}}) && new Promise(resolve => setTimeout(resolve, 300))`],
    ["dialog-closed", `(RxDialog.close(), RxWorldsUI.setView("instances"), new Promise(resolve => setTimeout(resolve, 300)))`],
    ["mods", `RxModals.switchModal("mods")`],
    ["mods-catalog", `RxModals.switchModal("mods").then(() => $('#modal-mods [data-mods-view="catalog"]').click())`],
    ["skins", `RxModals.switchModal("skins")`],
    ["servers", `RxModals.switchModal("servers")`],
    ["statistics", `RxModals.switchModal("statistics")`],
    ["statistics-data", `(() => {
        // Три недели правдоподобной игры: разные ники, версии, серверы и миры
        const day = 86400000;
        const sessions = [];
        const servers = ["mc.hypixel.net", "play.funtime.su", "mc.holyworld.ru"];
        const worlds = ["Выживание", "Креатив", "Хардкор 2"];
        for (let index = 0; index < 34; index++) {
            const startedAt = Date.now() - (index % 21) * day - (index * 37 % 9) * 3600000 - 1800000;
            const playSeconds = 900 + (index * 1373) % 9000;
            const key = RxPlayStats.dayKey(startedAt);
            const online = index % 3 !== 0;
            const context = online ? servers[index % 3] : worlds[index % 3];
            const kills = (index * 7) % 23;
            const deaths = (index * 3) % 6;
            sessions.push({
                id: "demo-" + index, startedAt, endedAt: startedAt + playSeconds * 1000, lastCheckpointAt: startedAt + playSeconds * 1000,
                playSeconds, versionId: ["fabric-1.21.4", "pack-demo_pack", "vanilla-1.21.1", "forge-1.20.1"][index % 4],
                nickname: index % 5 === 0 ? "Alex" : "Steve", kills, deaths, bestKillStreak: Math.min(kills, 4 + index % 7),
                serverSeconds: online ? {[context]: playSeconds} : {}, worldSeconds: online ? {} : {[context]: playSeconds},
                dailySeconds: {[key]: playSeconds}, dailyCombat: {[key]: {kills, deaths, bestKillStreak: Math.min(kills, 4 + index % 7)}},
                dailyContexts: {[key]: online ? {servers: {[context]: playSeconds}, worlds: {}} : {servers: {}, worlds: {[context]: playSeconds}}},
                endReason: "closed"
            });
        }
        const normalized = sessions.map(session => RxPlayStats.normalizeSession(session));
        const aggregate = RxPlayStats.aggregateSessions(normalized, "");
        RxPlayStats.data = {...RxPlayStats.createEmptyData(), sessions: normalized, totals: aggregate.totals, dimensions: aggregate.dimensions, days: aggregate.days};
        RxStatisticsUI.render(true);
        return new Promise(resolve => setTimeout(resolve, 300));
    })()`],
    ["statistics-data-scrolled", `(document.querySelector("#modal-statistics .st-scroll").scrollTop = 99999, new Promise(resolve => setTimeout(resolve, 300)))`],
    ["screenshots", `RxModals.switchModal("screenshots")`],
    ["console", `RxModals.switchModal("console")`],
    ["together", `RxModals.switchModal("together")`],
    ["together-preview", `($("#modal-together [data-join-code]").val(RxShare.encode({v: 1, n: "Выживание с друзьями", g: "1.21.1", l: "fabric", m: ["AANobbMI", "P7dR8mSH"], r: ["abcdEFGH"], s: [], by: "Steve", sv: "play.example.org"})), RxTogetherUI.check(), new Promise(resolve => setTimeout(resolve, 200)))`],
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
    window.webContents.on("console-message", (event) => {
        if (["warning", "error"].includes(event.level) && !/Autofill|DevTools|THREE\.WebGLProgram/i.test(event.message)) errors.push(event.message);
    });
    await window.loadURL(`file://${path.join(__dirname, "..", "web", "index.ejs").replace(/\\/g, "/")}`);
    await Promise.race([ready, delay(15000)]);
    window.showInactive();
    await delay(1500);
    await window.webContents.executeJavaScript(`(() => {
        RxConfig.write("activeVersion", "fabric-1.21.4");
        RxAccountsManager.addLocalAccount("Steve");
        // Пример сборки для экрана «Сборки»
        RxPacks.writeModpackManifest("demo_pack", {id: "demo_pack", uuid: "demo", displayName: "Fabulously Optimized 6.5.0",
            baseVersion: {full: "fabric-1.21.1", type: "fabric", number: "1.21.1"}, files: [], icon: false, created: Date.now(),
            memory: {mode: "auto", mb: 4096}});
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
