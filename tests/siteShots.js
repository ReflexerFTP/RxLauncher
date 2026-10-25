// Скриншоты лаунчера с демо-данными для сайта: electron ./tests/siteShots.js <папка>
const {app, BrowserWindow, ipcMain} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs-electron");

const outDir = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) || path.join(os.tmpdir(), "rxlaunch-site-shots"));
// Двойная плотность пикселей — скриншоты чёткие на экранах с высоким разрешением
const SCALE = Number(process.env.RX_SHOT_SCALE || 2);
fs.mkdirSync(outDir, {recursive: true});
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-site-shots-"));
process.env.USERPROFILE = tempRoot;
process.env.APPDATA = path.join(tempRoot, "AppData", "Roaming");
app.setPath("userData", path.join(tempRoot, "user-data"));

let markReady;
const ready = new Promise(resolve => { markReady = resolve; });
ipcMain.on("isAppInDev", event => { event.returnValue = true; });
ipcMain.on("isAppInTest", event => { event.returnValue = false; });
ipcMain.on("get-userdata-path", event => { event.returnValue = app.getPath("userData"); });
ipcMain.on("launcher-ready", () => markReady());
for (const channel of ["console-log", "discord-rpc-settings", "game-process-state", "appear-main-window", "disappear-main-window", "focus-fix"]) ipcMain.on(channel, () => {});
ipcMain.handle("curseforge-key-status", async () => ({configured: false}));
ipcMain.handle("server-catalog-connectivity", async () => false);
ipcMain.handle("minecraft-skin-lookup", async () => ({success: true, found: false}));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const STAGES = [
    ["home", `RxModals.switchModal("content")`, 1200],
    ["catalog", `(RxCatalog.state.type = "modpack", RxModals.switchModal("catalog").then(() => new Promise(resolve => setTimeout(resolve, 3000))).then(() => { window.__packHits = [...RxCatalog.hits.values()]; }))`, 500],
    ["catalog-details", `RxCatalog.openDetails($("#modal-catalog .cat-card").first().attr("data-project"))`, 3000],
    ["catalog-shaders", `(RxCatalog.closeDetails(), RxCatalog.switchType("shader"))`, 3500],
    ["instances", `(window.__makeInstances(), RxModals.switchModal("instances"))`, 1500],
    ["together", `(RxModals.switchModal("together").then(() => { $("#modal-together [data-join-code]").val(RxShare.encode({v: 1, n: "Выживание с друзьями", g: "1.21.1", l: "fabric", m: ["AANobbMI", "P7dR8mSH", "gvQqBUqZ", "mOgUt4GM"], r: ["abcdEFGH"], s: ["HVnmMxH1"], by: "Steve", sv: "play.example.org"})); RxTogetherUI.check(); }))`, 800],
    ["statistics", `(window.__seedStats(), RxModals.switchModal("statistics"))`, 1200],
    ["skins", `RxModals.switchModal("skins")`, 2500],
    ["crash", `RxModals.switchModal("content").then(() => new Promise(resolve => setTimeout(resolve, 800))).then(() => RxCrashUI.show(window.__crashReport()))`, 1200],
    ["launch-check", `(RxCrashUI.hide(), RxDialog.confirm({icon: "report", title: MESSAGES.launchCheck.title, text: MESSAGES.launchCheck.text.replace("{0}", 2),
        items: [{icon: "error", level: "error", title: "Sodium Extra", text: "Не хватает зависимости: sodium"}, {icon: "error", level: "error", title: "Create", text: "Мод для Minecraft 1.20.1, выбран 1.21.1"}],
        cancelText: MESSAGES.dialog.cancel, extraButton: {text: MESSAGES.launchCheck.openMods, icon: "extension"}, confirmText: MESSAGES.launchCheck.playAnyway}) && null)`, 600],
    ["versions", `(RxDialog.close(), RxVersionsUI.open())`, 1200]
];

app.whenReady().then(async () => {
    ejs.listen();
    // Рисуем вне экрана (пользователь окно не видит), а размер и плотность задаём через протокол отладки Chromium:
    // так снимок получается 1400×900 при любом размере монитора
    // Окно показано, но стоит за пределами экрана и не принимает клики — пользователь его не видит и не заденет
    const window = new BrowserWindow({
        width: 1400, height: 900, x: -6000, y: -6000, show: false, frame: false, focusable: false, skipTaskbar: true,
        webPreferences: {nodeIntegration: true, contextIsolation: false, backgroundThrottling: false}
    });
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    window.setPosition(-6000, -6000);
    const cdp = window.webContents.debugger;
    const capture = async () => Buffer.from((await cdp.sendCommand("Page.captureScreenshot", {format: "png", fromSurface: true})).data, "base64");
    await window.loadURL(`file://${path.join(__dirname, "..", "web", "index.ejs").replace(/\\/g, "/")}`);
    await Promise.race([ready, delay(15000)]);
    console.log("loaded");
    cdp.attach("1.3");
    await cdp.sendCommand("Emulation.setDeviceMetricsOverride", {width: 1400, height: 900, deviceScaleFactor: SCALE, mobile: false});
    console.log("emulated");
    await delay(1500);
    await window.webContents.executeJavaScript(`(() => {
        RxConfig.write("activeVersion", "fabric-1.21.4");
        RxAccountsManager.addLocalAccount("Steve");
        RxAccountsManager.setActiveAccount(Object.keys(RxAccountsManager.getAccounts())[0]);
        RxAccountsUI.reloadAccountSelect();
        RxVersionsUI.loadVersions();
        // Сборки: берём настоящие сборки из каталога Modrinth (название и иконка)
        window.__makeInstances = () => {
            const hits = (window.__packHits || []).slice(0, 4);
            const names = hits.length ? hits : [{title: "Выживание с друзьями"}, {title: "Техно-сборка"}];
            names.forEach((hit, index) => {
                const id = "demo_" + index;
                RxPacks.writeModpackManifest(id, {id, uuid: id, displayName: hit.title, created: Date.now() - index * 86400000,
                    lastPlayed: Date.now() - (index * 5 + 1) * 3600000, icon: hit.icon_url || false,
                    baseVersion: {full: ["fabric-1.21.1", "neoforge-1.21.1", "fabric-1.20.1", "forge-1.20.1"][index], type: ["fabric", "neoforge", "fabric", "forge"][index], number: index < 2 ? "1.21.1" : "1.20.1"},
                    memory: {mode: index % 2 ? "manual" : "auto", mb: 6144}, files: []});
                const mods = path.join(GAME_DATA, "modpacks", id, "mods");
                fs.mkdirSync(mods, {recursive: true});
                for (let mod = 0; mod < [48, 132, 21, 87][index]; mod++) fs.writeFileSync(path.join(mods, "mod" + mod + ".jar"), "x");
            });
            RxConfig.write("activeVersion", "pack-demo_0");
        };
        window.__seedStats = () => {
            const day = 86400000;
            const sessions = [];
            const servers = ["mc.hypixel.net", "play.funtime.su", "mc.holyworld.ru"];
            const worlds = ["Выживание", "Креатив", "Хардкор"];
            for (let index = 0; index < 46; index++) {
                const startedAt = Date.now() - (index * 2 % 60) * day - (index * 37 % 9) * 3600000 - 1800000;
                const playSeconds = 900 + (index * 1373) % 9000;
                const key = RxPlayStats.dayKey(startedAt);
                const online = index % 3 !== 0;
                const context = online ? servers[index % 3] : worlds[index % 3];
                const kills = (index * 7) % 23;
                const deaths = (index * 3) % 6;
                sessions.push({id: "demo-" + index, startedAt, endedAt: startedAt + playSeconds * 1000, lastCheckpointAt: startedAt + playSeconds * 1000,
                    playSeconds, versionId: ["fabric-1.21.4", "pack-demo_0", "vanilla-1.21.1", "pack-demo_1"][index % 4],
                    nickname: index % 5 === 0 ? "Alex" : "Steve", kills, deaths, bestKillStreak: Math.min(kills, 4 + index % 7),
                    serverSeconds: online ? {[context]: playSeconds} : {}, worldSeconds: online ? {} : {[context]: playSeconds},
                    dailySeconds: {[key]: playSeconds}, dailyCombat: {[key]: {kills, deaths, bestKillStreak: Math.min(kills, 4 + index % 7)}},
                    dailyContexts: {[key]: online ? {servers: {[context]: playSeconds}, worlds: {}} : {servers: {}, worlds: {[context]: playSeconds}}},
                    endReason: "closed"});
            }
            const normalized = sessions.map(session => RxPlayStats.normalizeSession(session));
            const aggregate = RxPlayStats.aggregateSessions(normalized, "");
            RxPlayStats.data = {...RxPlayStats.createEmptyData(), sessions: normalized, totals: aggregate.totals, dimensions: aggregate.dimensions, days: aggregate.days};
        };
        window.__crashReport = () => ({
            exitCode: 1, exitHex: "0x00000001", time: Date.now(), versionId: "fabric-1.21.1", crashReportPath: "", hsErrPath: "", modsDir: "",
            description: "Mod resolution failed",
            exceptionLine: "net.fabricmc.loader.impl.FormattedException: Mod resolution failed",
            findings: [
                {rule: "missingDep", severity: "error", dependency: "fabric-api", title: RxCrashAnalyzer.t("missingDep", "title", {mod: "Sodium Extra", dep: "Fabric API"}), fix: RxCrashAnalyzer.t("missingDep", "fix", {mod: "Sodium Extra", dep: "Fabric API"}), detail: ""},
                {rule: "outOfMemory", severity: "error", title: RxCrashAnalyzer.t("outOfMemory", "title", {}), fix: RxCrashAnalyzer.t("outOfMemory", "fix", {}), detail: ""}
            ]
        });
        RxToasts.removeAll();
    })()`);
    await delay(800);

    for (const [name, code, wait] of STAGES) {
        try {
            await window.webContents.executeJavaScript(`(async () => { await (${code}); RxToasts.removeAll(); })()`);
            await delay(wait);
            await window.webContents.executeJavaScript(`RxToasts.removeAll()`);
            fs.writeFileSync(path.join(outDir, `${name}.png`), await capture());
            console.log(`shot ${name}`);
        } catch (error) {
            console.error(`${name}: ${error.message}`);
        }
    }
    window.destroy();
    try { fs.rmSync(tempRoot, {recursive: true, force: true}); } catch (_) {}
    app.exit(0);
}).catch(error => {
    console.error(error);
    app.exit(1);
});
