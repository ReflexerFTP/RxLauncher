const {app, BrowserWindow, ipcMain} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs-electron");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-electron-smoke-"));
process.env.USERPROFILE = tempRoot;
process.env.APPDATA = path.join(tempRoot, "AppData", "Roaming");
app.setPath("userData", path.join(tempRoot, "user-data"));
let smokeWindow = null;
let lastSmokeResult = null;
const skinsScreenshotPath = path.join(tempRoot, "smoke-skins.png");
let skinsScreenshotPromise = Promise.resolve(false);
let skinsScreenshotError = "";
const personalizationScreenshotPath = path.join(tempRoot, "smoke-personalization.png");
let personalizationScreenshotPromise = Promise.resolve(false);
let personalizationScreenshotError = "";
const redesignScreenshotPaths = Object.fromEntries(["home", "accounts", "mods", "terminal", "fonts", "changelog"].map(stage => [stage, path.join(tempRoot, `smoke-${stage}.png`)]));

let markRendererReady;
const rendererReady = new Promise(resolve => { markRendererReady = resolve; });
const serverStatusQueryCalls = [];
let serverConnectivityCalls = 0;
const minecraftSkinApplyCalls = [];
const smokeFavicon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

ipcMain.on("isAppInDev", event => { event.returnValue = true; });
ipcMain.on("isAppInTest", event => { event.returnValue = false; });
ipcMain.on("get-userdata-path", event => { event.returnValue = app.getPath("userData"); });
ipcMain.on("console-log", () => {});
ipcMain.on("launcher-ready", () => markRendererReady());
ipcMain.on("discord-rpc-settings", () => {});
ipcMain.on("discord-rpc-game-start", () => {});
ipcMain.on("discord-rpc-game-update", () => {});
ipcMain.on("discord-rpc-game-stop", () => {});
ipcMain.on("game-process-state", () => {});
ipcMain.on("appear-main-window", () => {});
ipcMain.on("disappear-main-window", () => {});
ipcMain.on("hide-main-window", () => {});
ipcMain.on("maximize-main-window", () => {});
ipcMain.on("close-main-window", () => {});
ipcMain.on("reload-main-window", () => {});
ipcMain.handle("save-dialog", async () => false);
ipcMain.handle("open-dialog", async () => false);
ipcMain.handle("curseforge-key-status", async () => ({configured: false}));
ipcMain.handle("rx-account-token", async () => "");
ipcMain.handle("minecraft-skin-lookup", async () => ({success: true, found: false}));
ipcMain.handle("minecraft-skin-export", async () => ({success: false, canceled: true}));
ipcMain.handle("minecraft-skin-apply", async (_event, payload) => {
    minecraftSkinApplyCalls.push(payload);
    await new Promise(resolve => setTimeout(resolve, 250));
    return {success: true, path: "smoke-applied-skin.png"};
});
ipcMain.handle("server-catalog-connectivity", async () => ++serverConnectivityCalls > 1);
ipcMain.handle("server-status-query", async (_event, address, force, options) => {
    serverStatusQueryCalls.push({address, force, options});
    const seed = [...String(address)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    if (seed % 2 === 0) {
        return {
            online: true,
            players: {online: 75 + seed % 2400, max: 5000},
            motd: {clean: [`mcsrvstat MOTD for ${address}`, "Live network"]},
            version: "1.8–1.21.4",
            protocol: {name: "1.21.4", version: 769},
            icon: smokeFavicon,
            debug: {ping: true, apiversion: 3}
        };
    }
    return {
        message: "ok",
        server: {
            ip: address,
            port: 25565,
            players: {online: 75 + seed % 2400, max: 5000},
            motd: `minecraftpinger MOTD for ${address}`,
            version: "1.8–1.21.4",
            favicon: smokeFavicon,
            ping: 18 + seed % 45,
            edition: "java"
        }
    };
});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

ipcMain.on("smoke-skins-ready", event => {
    if (!smokeWindow || smokeWindow.isDestroyed() || event.sender !== smokeWindow.webContents) return;
    skinsScreenshotPromise = (async () => {
        smokeWindow.showInactive();
        await delay(350);
        const image = await smokeWindow.webContents.capturePage();
        fs.writeFileSync(skinsScreenshotPath, image.toPNG());
        return true;
    })();
    skinsScreenshotPromise.then(() => {
        if (!event.sender.isDestroyed()) event.sender.send("smoke-skins-captured", {success: true});
    }).catch(error => {
        skinsScreenshotError = error?.message || String(error);
        if (!event.sender.isDestroyed()) {
            event.sender.send("smoke-skins-captured", {success: false, error: skinsScreenshotError});
        }
    });
});

ipcMain.on("smoke-personalization-ready", event => {
    if (!smokeWindow || smokeWindow.isDestroyed() || event.sender !== smokeWindow.webContents) return;
    personalizationScreenshotPromise = (async () => {
        smokeWindow.showInactive();
        await delay(350);
        const image = await smokeWindow.webContents.capturePage();
        fs.writeFileSync(personalizationScreenshotPath, image.toPNG());
        return true;
    })();
    personalizationScreenshotPromise.then(() => {
        if (!event.sender.isDestroyed()) event.sender.send("smoke-personalization-captured", {success: true});
    }).catch(error => {
        personalizationScreenshotError = error?.message || String(error);
        if (!event.sender.isDestroyed()) {
            event.sender.send("smoke-personalization-captured", {
                success: false,
                error: personalizationScreenshotError
            });
        }
    });
});

ipcMain.on("smoke-redesign-ready", async (event, stage) => {
    if (!smokeWindow || smokeWindow.isDestroyed() || event.sender !== smokeWindow.webContents || !redesignScreenshotPaths[stage]) return;
    try {
        smokeWindow.showInactive();
        await delay(220);
        const image = await smokeWindow.webContents.capturePage();
        fs.writeFileSync(redesignScreenshotPaths[stage], image.toPNG());
        if (!event.sender.isDestroyed()) event.sender.send("smoke-redesign-captured", {success: true, stage});
    } catch (error) {
        if (!event.sender.isDestroyed()) event.sender.send("smoke-redesign-captured", {success: false, stage, error: error?.message || String(error)});
    }
});

const accountStore = require("../accountStore").createAccountStore(path.join(app.getPath("userData"), "accounts.json"), require("electron").safeStorage);
ipcMain.on("renderer-template", event => { event.returnValue = require("../rendererTemplate")(); });
ipcMain.on("accounts-read", event => { try { event.returnValue = {ok: true, accounts: accountStore.read()}; } catch (e) { event.returnValue = {ok: false, error: e.message}; } });
ipcMain.on("accounts-write", (event, accounts) => { try { accountStore.write(accounts); event.returnValue = {ok: true}; } catch (e) { event.returnValue = {ok: false, error: e.message}; } });
app.whenReady().then(async () => {
    const errors = [];
    ejs.listen();
    const window = smokeWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, "..", "preload.js")}
    });

    const evaluateIsolated = code => window.webContents.executeJavaScriptInIsolatedWorld(999, [{code}]);
    // Electron 35+ передаёт уровень и текст в объекте события (level: "warning"/"error")
    window.webContents.on("console-message", (event) => {
        const {message} = event;
        const level = {debug: 0, info: 1, warning: 2, error: 3}[event.level] ?? Number(event.level);
        const expectedGpuWarning = /THREE\.WebGLProgram: Program Info Log:[\s\S]*warning X4713: Sample Bias value is limited/i.test(message);
        if (level >= 2 && !/Autofill|DevTools/i.test(message) && !expectedGpuWarning) errors.push(message);
    });
    window.webContents.on("render-process-gone", (_event, details) => errors.push(`renderer gone: ${details.reason}`));

    await window.loadURL(`file://${path.join(__dirname, "..", "web", "index.ejs").replace(/\\/g, "/")}`);
    await Promise.race([
        rendererReady,
        delay(15_000).then(() => { throw new Error("Renderer startup timed out"); })
    ]);
    await delay(1000);
    window.showInactive();
    await delay(250);

    const pageBoundary = await window.webContents.executeJavaScript(`({node: typeof require, process: typeof process, ipc: typeof ipcRenderer, loader: typeof loadRxLibrary, accounts: typeof RxAccountsManager})`);
    if (Object.values(pageBoundary).some(value => value !== "undefined")) throw new Error("Privileged API leaked into the page world");
    const metadataSafety = await evaluateIsolated(`(async () => {
        const original = RxWorldsManager.savesFromDirectory;
        const oldPack = packman__currentModpack;
        const malicious = '<img src=x onerror="window.rxInjected=true">';
        const packRoot = path.join(GAME_DATA, "modpacks", "security-fixture");
        fs.mkdirSync(path.join(packRoot, "saves"), {recursive: true});
        try {
            packman__currentModpack = {id: "security-fixture", files: []};
            RxWorldsManager.savesFromDirectory = async () => [{path: path.join(packRoot, "saves", "world"), name: malicious, icon: false, version: malicious, gamemode: 0, difficulty: 0}];
            RxPackManagerUI.loadWorldsList();
            await new Promise(resolve => setTimeout(resolve, 50));
            const list = document.querySelector("#modal-packManager .worlds-list");
            return {literal: list.textContent.includes(malicious), executable: Boolean(list.querySelector("[onerror], script"))};
        } finally {
            RxWorldsManager.savesFromDirectory = original;
            packman__currentModpack = oldPack;
            fs.rmSync(packRoot, {recursive: true, force: true});
        }
    })()`);
    if (!metadataSafety.literal || metadataSafety.executable) throw new Error("World metadata was interpreted as HTML");

    const result = await evaluateIsolated(`(async () => {
        const captureRedesignStage = stage => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(\`Redesign screenshot timed out: \${stage}\`)), 5000);
            const listener = (_event, payload) => {
                if (payload?.stage !== stage) return;
                ipcRenderer.removeListener("smoke-redesign-captured", listener);
                clearTimeout(timeout);
                if (payload?.success === true) resolve();
                else reject(new Error(payload?.error || \`Screenshot failed: \${stage}\`));
            };
            ipcRenderer.on("smoke-redesign-captured", listener);
            ipcRenderer.send("smoke-redesign-ready", stage);
        });
        RxConfig.write("activeVersion", "fabric-1.18.2");
        RxVersionArtwork.update("fabric-1.18.2");
        await new Promise(resolve => setTimeout(resolve, 800));
        RxConfig.write("activeVersion", "fabric-1.18.2");
        RxVersionArtwork.update("fabric-1.18.2");
        $("#versionSelect .title").text("Fabric 1.18.2");
        $("#versionSelect .description").text(MESSAGES.flyout.version);
        $("#versionSelect, #playButton").show();
        $("#versionSelectPlaceholder").hide();
        const home = {
            release: document.querySelector("#modal-content .hero")?.dataset.release || "",
            title: document.querySelector("[data-hero-title]")?.textContent.trim() || "",
            background: document.querySelector("#modal-content .hero-bg")?.style.backgroundImage || "",
            featuredChanges: document.querySelectorAll("#home-patch-featured .patch-changes li").length,
            modsMenuPresent: Boolean(document.querySelector('.flymenu .item[data-modal="mods"]')),
            packsMenuPresent: Boolean(document.querySelector('.flymenu .item[data-modal="packs"]'))
        };
        RxToasts.removeAll();
        await captureRedesignStage("home");
        RxAccountsManager.addLocalAccount("SmokeOld");
        const smokeAccount = Object.values(RxAccountsManager.getAccounts()).find(account => account.nickname === "SmokeOld");
        await RxAccountsUI.open();
        const editorOpened = smokeAccount ? RxAccountsUI.startEdit(smokeAccount.uuid) : false;
        $("#modal-accounts .acc-item.editing .acc-rename").val("SmokeEdited");
        RxToasts.removeAll();
        await captureRedesignStage("accounts");
        const accountRenameResult = editorOpened ? RxAccountsUI.saveEdit() : false;
        RxAccountsManager.addLocalAccount("SmokeOrder");
        const reversedOrder = Object.keys(RxAccountsManager.getAccounts()).reverse();
        RxAccountsManager.reorderAccounts(reversedOrder);
        const accounts = {
            renameResult: accountRenameResult,
            editorOpened,
            renamed: Object.values(RxAccountsManager.getAccounts()).some(account => account.nickname === "SmokeEdited"),
            originalMissing: !Object.values(RxAccountsManager.getAccounts()).some(account => account.nickname === "SmokeOld"),
            editButtonPresent: Boolean(document.querySelector("#modal-accounts .accounts-list .acc-item .edit")),
            reorderPersisted: Object.keys(RxAccountsManager.getAccounts()).join() === reversedOrder.join()
        };
        await RxAccountsUI.open();
        const modsContext = RxModsManager.getContext();
        fs.mkdirSync(modsContext.modsPath, {recursive: true});
        const smokeModPath = path.join(modsContext.modsPath, "smoke-helper-1.0.jar");
        fs.writeFileSync(smokeModPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
        await RxModals.switchModal("mods");
        RxModsManager.refresh();
        const mods = {
            title: document.querySelector("#modal-mods h1")?.textContent.trim(),
            rows: document.querySelectorAll("#modal-mods .mods-row").length,
            path: document.querySelector("#modal-mods [data-mods-path]")?.textContent.trim() || "",
            validJar: RxModsManager.isValidJar(smokeModPath),
            noPackTab: !document.querySelector('.flymenu .item[data-modal="packs"]')
        };
        RxToasts.removeAll();
        await captureRedesignStage("mods");
        RxModsManager.remove(path.basename(smokeModPath));
        RxCollector.writeLog("SMOKE INSTANT TERMINAL");
        await RxModals.switchModal("console");
        const terminal = {
            title: document.querySelector("#modal-console h1")?.textContent.trim(),
            instantLine: [...document.querySelectorAll("#modal-console .console-line-message")].some(node => node.textContent.includes("SMOKE INSTANT TERMINAL")),
            searchPresent: Boolean(document.querySelector("#modal-console [data-console-search]")),
            liveCount: Number(document.querySelector("#modal-console [data-console-count]")?.textContent || 0)
        };
        RxToasts.removeAll();
        await captureRedesignStage("terminal");
        await RxModals.switchModal("statistics");
        RxPlayStats.onGameLaunch({versionId:"fabric-1.21.4",nickname:"SmokePlayer",server:"play.example.org",gameDirectory:GAME_DATA,playerUuid:"smoke",pid:4242});
        const start = RxPlayStats.currentSession.startedAt;
        RxPlayStats.confirmPendingServer(start + 1000);
        RxPlayStats.checkpoint(true, start + 3661000);
        RxPlayStats.recordKill("smoke", start + 3662000);
        RxPlayStats.recordDeath("smoke", start + 3663000);
        RxStatisticsUI.render(true);
        await new Promise(resolve => setTimeout(resolve, 100));
        const statistics = {
            title: document.querySelector("#modal-statistics h1")?.textContent.trim(),
            playtime: document.querySelector("[data-stat-value='playtime']")?.textContent.trim(),
            kills: document.querySelector("[data-stat-value='kills']")?.textContent.trim(),
            deaths: document.querySelector("[data-stat-value='deaths']")?.textContent.trim(),
            runningLabel: document.querySelector("#stats-session-list [data-session-state]")?.textContent.trim(),
            serverRows: document.querySelectorAll("[data-ranking='servers'] .st-rank-row").length
        };
        await RxModals.switchModal("settings");
        const personalizationTab = document.querySelector('#modal-settings .tabs .tab[data-tab="personalization"]');
        if (personalizationTab && !personalizationTab.classList.contains("active")) personalizationTab.click();
        await new Promise(resolve => setTimeout(resolve, 180));
        const avatarNodes = [...document.querySelectorAll("[data-launcher-avatar]")];
        const brandSourcesBefore = avatarNodes.map(node => node.getAttribute("src") || "");
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Personalization screenshot handshake timed out")), 5000);
            ipcRenderer.once("smoke-personalization-captured", (_event, payload) => {
                clearTimeout(timeout);
                if (payload?.success === true) resolve();
                else reject(new Error(payload?.error || "Personalization screenshot failed"));
            });
            ipcRenderer.send("smoke-personalization-ready");
        });
        const swatch = document.querySelector('#modal-settings .theme-swatches .swatch[data-color="#3b82f6"]');
        if (!swatch) throw new Error("Theme swatch #3b82f6 is missing");
        swatch.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const personalization = {
            currentModal: RxModals.currentModalName(),
            tabActive: document.querySelector('#modal-settings .layout-tab[data-tab="personalization"]')?.classList.contains("active") === true,
            themeColor: RxConfig.read("theme", {}).color,
            activeSwatch: document.querySelector("#modal-settings .theme-swatches .swatch.active")?.dataset.color || "",
            swatchCount: document.querySelectorAll("#modal-settings .theme-swatches .swatch[data-color]").length,
            avatarPickerRemoved: !document.querySelector(".launcher-avatar-option, .launcher-avatar-settings"),
            brandNodeCount: avatarNodes.length,
            brandSourcesBefore,
            allBrandNodesClassic: brandSourcesBefore.length > 0 && brandSourcesBefore.every(source => source.endsWith("assets/icon.png"))
        };
        const assertUI = (condition, message) => { if (!condition) throw new Error(message); };
        const fontTrigger = document.querySelector(".font-picker-trigger");
        fontTrigger.scrollIntoView({block: "center"});
        fontTrigger.click();
        const fontDeadline = Date.now() + 5000;
        while (!document.querySelector(".font-picker-popover") && Date.now() < fontDeadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assertUI(document.querySelectorAll(".font-picker-popover").length === 1, "Font picker did not open");
        assertUI(document.querySelectorAll(".font-picker-item").length >= 2, "Bundled fonts are missing");
        const fonts = {count: document.querySelectorAll(".font-picker-item").length};
        const search = document.querySelector(".font-picker-search input");
        search.value = "Fira Code";
        search.dispatchEvent(new Event("input", {bubbles: true}));
        assertUI(document.querySelectorAll(".font-picker-item:not([hidden])").length === 1, "Font search failed");
        document.querySelector('.font-picker-item[data-font="Fira Code"]').click();
        await new Promise(resolve => setTimeout(resolve, 250));
        assertUI(RxConfig.read("fontFamily") === "Fira Code", "Font selection was not saved");
        assertUI(getComputedStyle(document.querySelector("#modal-settings h1")).fontFamily.includes("Fira Code"), "Selected font was not applied");
        fontTrigger.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const manropeSample = document.querySelector('.font-picker-item[data-font="Manrope"] .font-picker-item-sample');
        assertUI(manropeSample && getComputedStyle(manropeSample).fontFamily.startsWith("Manrope"), "Global font overrides item previews");
        const fontBounds = document.querySelector(".font-picker-popover").getBoundingClientRect();
        assertUI(fontBounds.top >= 0 && fontBounds.left >= 0 && fontBounds.bottom <= innerHeight && fontBounds.right <= innerWidth, "Font picker extends beyond the window");
        await captureRedesignStage("fonts");
        document.querySelector('.font-picker-item[data-font="Manrope"]').click();
        await new Promise(resolve => setTimeout(resolve, 250));
        fontTrigger.click();
        await new Promise(resolve => setTimeout(resolve, 150));
        await RxModals.switchModal("content");
        assertUI(!document.querySelector(".font-picker-popover"), "Font picker remains open outside settings");
        const releaseText = document.querySelector(".hero-release-row").textContent.trim();
        assertUI(/^Minecraft [0-9.]+$/.test(releaseText), "Hero contains extra artwork label: " + releaseText);
        await RxChangelogUI.open();
        const patchIds = RxPatchNotes.getAll().map(patch => patch.id);
        assertUI(document.querySelectorAll(".changelog-rail-item").length === patchIds.length, "Changelog versions missing");
        document.querySelector('[data-changelog-step="older"]').click();
        assertUI(RxChangelogUI.selectedPatch === patchIds[1], "Older patch navigation failed");
        document.querySelector('[data-changelog-step="newer"]').click();
        assertUI(RxChangelogUI.selectedPatch === patchIds[0], "Newer patch navigation failed");
        await captureRedesignStage("changelog");
        const changelog = {versions: patchIds.length, selected: RxChangelogUI.selectedPatch};
        await RxChangelogUI.goBack();
        assertUI(RxModals.currentModalName() === "content", "Changelog did not return to home");
        await RxModals.switchModal("skins");
        const skinViewerDeadline = Date.now() + 4000;
        while (!document.querySelector("#modal-skins [data-skin-viewer-canvas]")?.classList.contains("is-visible")
            && Date.now() < skinViewerDeadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const skins = {
            title: document.querySelector("#modal-skins h1")?.textContent.trim(),
            currentModal: RxModals.currentModalName(),
            steveTextureLoaded: document.querySelector("#modal-skins [data-skin-fallback-image]")?.getAttribute("src")?.includes("default-steve.png") === true,
            searchPresent: Boolean(document.querySelector("#modal-skins [data-skin-search-input]")),
            canvasPresent: Boolean(document.querySelector("#modal-skins [data-skin-viewer-canvas]")),
            viewerVisible: document.querySelector("#modal-skins [data-skin-viewer-canvas]")?.classList.contains("is-visible") === true,
            avatarChoices: document.querySelectorAll(".launcher-avatar-option").length,
            wallpapers: document.querySelectorAll("#modal-settings .wp-item").length
        };
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Skins screenshot handshake timed out")), 5000);
            ipcRenderer.once("smoke-skins-captured", (_event, payload) => {
                clearTimeout(timeout);
                if (payload?.success === true) resolve();
                else reject(new Error(payload?.error || "Skins screenshot failed"));
            });
            ipcRenderer.send("smoke-skins-ready");
        });
        const originalGetActiveAccount = RxAccountsManager.getActiveAccount;
        let skinApplyRace;
        try {
            RxAccountsManager.getActiveAccount = () => "11111111-1111-4111-8111-111111111111";
            RxSkinBrowserUI.renderProfile({
                name: "SmokeSkinA",
                id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                model: "default",
                skinPath: RxSkinBrowserUI.DEFAULT_SKIN_PATH,
                fromCache: false,
                updatedAt: Date.now(),
                isDefault: false
            });
            const firstApplyPromise = RxSkinBrowserUI.apply();
            const busyAfterStart = RxSkinBrowserUI.actionBusy.apply === true;

            RxSkinBrowserUI.renderProfile({
                name: "SmokeSkinB",
                id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                model: "slim",
                skinPath: RxSkinBrowserUI.DEFAULT_SKIN_PATH,
                fromCache: false,
                updatedAt: Date.now(),
                isDefault: false
            });
            const applyButton = document.querySelector('#modal-skins [data-skin-action="apply"]');
            const disabledAfterProfileChange = applyButton?.disabled === true;
            const secondApplyResult = await RxSkinBrowserUI.apply();
            const firstApplyResult = await firstApplyPromise;
            skinApplyRace = {
                busyAfterStart,
                disabledAfterProfileChange,
                secondApplyResult,
                firstApplyResult,
                busyAfterSettle: RxSkinBrowserUI.actionBusy.apply === true,
                disabledAfterSettle: applyButton?.disabled === true,
                selectedProfile: RxSkinBrowserUI.currentProfile?.name || ""
            };
        } finally {
            RxAccountsManager.getActiveAccount = originalGetActiveAccount;
            RxSkinBrowserUI.reset();
        }
        RxConfig.write("serverPrivacyMode", true);
        document.querySelector('.flymenu .item[data-modal="servers"]').click();
        const navigationDeadline = Date.now() + 3000;
        while (RxModals.currentModalName() !== "servers" && Date.now() < navigationDeadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const offlineDeadline = Date.now() + 1000;
        while (document.querySelector("#modal-servers [data-server-offline]").hidden && Date.now() < offlineDeadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const clickNavigation = {
            currentModal: RxModals.currentModalName(),
            activeMenu: document.querySelector(".flymenu .item.active")?.dataset.modal || "",
            serversDisplay: getComputedStyle(document.querySelector("#modal-servers")).display,
            offlineVisible: !document.querySelector("#modal-servers [data-server-offline]").hidden
                && getComputedStyle(document.querySelector("#modal-servers [data-server-offline]")).display !== "none"
        };
        const animationDeadline = Date.now() + 3000;
        while (document.querySelector(".flymenu").style.pointerEvents === "none" && Date.now() < animationDeadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        await RxServersUI.loadList(true);
        RxServersUI.startRefreshTimer();
        const firstServer = RxServersUI.getServers()[0];
        RxServersUI.history.servers[firstServer.address] = [420, 690, 530, 880, 760, 1120].map((online, index) => ({
            at: Date.now() - (5 - index) * 120000,
            online,
            max: 5000
        }));
        RxServersUI.expandedAddress = firstServer.address;
        RxServersUI.render();
        await new Promise(resolve => setTimeout(resolve, 100));
        const placeholderRoots = [
            document.querySelector("#modal-content"),
            document.querySelector("#modal-mods"),
            document.querySelector("#modal-console"),
            document.querySelector("#modal-accounts"),
            document.querySelector("#modal-statistics"),
            document.querySelector("#modal-servers"),
            document.querySelector("#modal-skins"),
            document.querySelector(".news-head"),
            document.querySelector("#modal-changelog")
        ].filter(Boolean);
        const untranslatedPlaceholders = [];
        placeholderRoots.forEach(root => {
            [root, ...root.querySelectorAll("*")].forEach(node => {
                const ownText = [...node.childNodes]
                    .filter(child => child.nodeType === Node.TEXT_NODE)
                    .map(child => child.textContent)
                    .join(" ")
                    .trim();
                const matches = ownText.match(/\{\{[0-9a-zA-Z_.-]+\}\}/g) || [];
                matches.forEach(placeholder => untranslatedPlaceholders.push({
                    placeholder,
                    tag: node.tagName,
                    id: node.id || "",
                    className: typeof node.className === "string" ? node.className : "",
                    modal: node.closest(".modal")?.id || ""
                }));
            });
        });
        return {
            currentModal: RxModals.currentModalName(),
            home,
            accounts,
            mods,
            terminal,
            clickNavigation,
            statistics,
            personalization,
            fonts,
            changelog,
            skins,
            skinApplyRace,
            serverTitle: document.querySelector("#modal-servers h1")?.textContent.trim(),
            serverHeaderHeight: document.querySelector("#modal-servers .server-catalog-header")?.getBoundingClientRect().height || 0,
            serverCards: document.querySelectorAll("#modal-servers .server-card").length,
            serverCategories: [...document.querySelectorAll("#modal-servers .server-card-category")].map(node => node.textContent.trim()),
            expandedCards: document.querySelectorAll("#modal-servers .server-card.expanded").length,
            charts: document.querySelectorAll("#modal-servers .server-chart").length,
            liveLabels: [...document.querySelectorAll("#modal-servers .server-card-live")].map(node => node.textContent.trim()),
            serverMotds: [...document.querySelectorAll("#modal-servers .server-card-motd")].map(node => node.textContent.trim()),
            serverImages: document.querySelectorAll("#modal-servers .server-card-icon img").length,
            serverFallbackIcons: document.querySelectorAll("#modal-servers .server-card-icon-fallback").length,
            privacyMode: RxConfig.read("serverPrivacyMode", false),
            backgroundRefreshActive: RxServersUI.refreshTimer !== null,
            rawPlaceholders: untranslatedPlaceholders.length > 0,
            untranslatedPlaceholders,
            patchHeader: document.querySelector(".news-head-title")?.textContent.trim(),
            visibleModals: [...document.querySelectorAll(".modal:not(.overlay)")].filter(node => getComputedStyle(node).display !== "none").map(node => node.id),
            contentDisplay: getComputedStyle(document.querySelector("#modal-content")).display,
            serversDisplay: getComputedStyle(document.querySelector("#modal-servers")).display,
            patchCards: document.querySelectorAll("#home-patch-list .patch-row").length + (document.querySelector("#home-patch-featured .patch-title") ? 1 : 0),
            statsFile: RxPlayStats.getStoragePath(),
            statsFileExists: fs.existsSync(RxPlayStats.getStoragePath())
        };
    })()`);
    lastSmokeResult = result;
    await skinsScreenshotPromise;
    await personalizationScreenshotPromise;

    if (result.currentModal !== "servers") throw new Error(`Servers modal did not open: ${result.currentModal}`);
    if (result.home.release !== "1.18" || !result.home.background.includes("1.18.png")
        || result.home.featuredChanges < 1 || !result.home.modsMenuPresent || result.home.packsMenuPresent) {
        throw new Error(`Dynamic home redesign failed: ${JSON.stringify(result.home)}`);
    }
    if (!result.accounts.renameResult || !result.accounts.editorOpened || !result.accounts.renamed || !result.accounts.originalMissing || !result.accounts.editButtonPresent || !result.accounts.reorderPersisted) {
        throw new Error(`Account nickname editing failed: ${JSON.stringify(result.accounts)}`);
    }
    if (result.mods.title !== "Моды" || result.mods.rows < 1 || !result.mods.validJar || !result.mods.path || !result.mods.noPackTab) {
        throw new Error(`Mods manager smoke test failed: ${JSON.stringify(result.mods)}`);
    }
    if (result.terminal.title !== "Консоль" || !result.terminal.instantLine || !result.terminal.searchPresent || result.terminal.liveCount < 1) {
        throw new Error(`Live terminal smoke test failed: ${JSON.stringify(result.terminal)}`);
    }
    if (result.clickNavigation.currentModal !== "servers" || result.clickNavigation.activeMenu !== "servers"
        || result.clickNavigation.serversDisplay === "none" || result.clickNavigation.offlineVisible !== true) {
        throw new Error(`Server menu click did not navigate to a visible offline state: ${JSON.stringify(result.clickNavigation)}`);
    }
    if (result.statistics.title !== "Статистика игрока") throw new Error(`Statistics title was not translated: ${result.statistics.title}`);
    if (result.personalization.currentModal !== "settings" || !result.personalization.tabActive
        || result.personalization.themeColor !== "rgb(59, 130, 246)" || result.personalization.activeSwatch !== "#3b82f6"
        || result.personalization.swatchCount !== 12 || !result.personalization.avatarPickerRemoved
        || result.personalization.brandNodeCount < 3 || !result.personalization.allBrandNodesClassic) {
        throw new Error(`Personalization smoke test failed: ${JSON.stringify(result.personalization)}`);
    }
    if (!fs.existsSync(personalizationScreenshotPath) || fs.statSync(personalizationScreenshotPath).size < 1024) {
        throw new Error(`Personalization screenshot is missing or empty: ${personalizationScreenshotPath}${personalizationScreenshotError ? ` (${personalizationScreenshotError})` : ""}`);
    }
    if (result.skins.title !== "Скины игроков" || result.skins.currentModal !== "skins" || !result.skins.steveTextureLoaded
        || !result.skins.searchPresent || !result.skins.canvasPresent || !result.skins.viewerVisible) {
        throw new Error(`Skins tab smoke test failed: ${JSON.stringify(result.skins)}`);
    }
    if (result.skins.avatarChoices !== 0 || result.skins.wallpapers !== 9) {
        throw new Error(`Personalization choices are incomplete: ${JSON.stringify(result.skins)}`);
    }
    if (!result.skinApplyRace.busyAfterStart || !result.skinApplyRace.disabledAfterProfileChange
        || result.skinApplyRace.secondApplyResult !== false || result.skinApplyRace.firstApplyResult !== false
        || result.skinApplyRace.busyAfterSettle || result.skinApplyRace.disabledAfterSettle
        || result.skinApplyRace.selectedProfile !== "SmokeSkinB" || minecraftSkinApplyCalls.length !== 1
        || minecraftSkinApplyCalls[0]?.profileId !== "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
        throw new Error(`Skin apply single-flight regression: ${JSON.stringify({
            state: result.skinApplyRace,
            calls: minecraftSkinApplyCalls
        })}`);
    }
    if (!fs.existsSync(skinsScreenshotPath) || fs.statSync(skinsScreenshotPath).size < 1024) {
        throw new Error(`Skins screenshot is missing or empty: ${skinsScreenshotPath}${skinsScreenshotError ? ` (${skinsScreenshotError})` : ""}`);
    }
    if (result.serverTitle !== "Сервера") throw new Error(`Servers title was not translated: ${result.serverTitle}`);
    if (result.serverHeaderHeight < 46) throw new Error(`Servers header was clipped by flex shrink: ${result.serverHeaderHeight}`);
    if (result.rawPlaceholders) {
        throw new Error(`New UI contains untranslated placeholders: ${JSON.stringify(result.untranslatedPlaceholders)}`);
    }
    if (result.patchHeader !== "Последние патчи") throw new Error(`Patch header was not translated: ${result.patchHeader}`);
    if (result.visibleModals.length !== 1 || result.visibleModals[0] !== "modal-servers" || result.contentDisplay !== "none" || result.serversDisplay === "none") {
        throw new Error(`Modal race detected: ${JSON.stringify(result.visibleModals)}`);
    }
    if (result.statistics.kills !== "1" || result.statistics.deaths !== "1") throw new Error(`Combat counters are wrong: ${result.statistics.kills}/${result.statistics.deaths}`);
    if (result.statistics.runningLabel !== "Сейчас в игре") throw new Error(`Active session label is wrong: ${result.statistics.runningLabel}`);
    if (result.statistics.serverRows !== 1) throw new Error(`Server ranking is missing: ${result.statistics.serverRows}`);
    if (result.serverCards !== 13) throw new Error(`Server catalog is incomplete: ${result.serverCards}`);
    if (!["Anarchy", "Grief", "BoxPvP"].every(category => result.serverCategories.includes(category))) throw new Error(`Server categories are incomplete: ${JSON.stringify(result.serverCategories)}`);
    if (result.expandedCards !== 1 || result.charts < 1) throw new Error(`Server detail chart did not render: expanded=${result.expandedCards}, charts=${result.charts}`);
    if (!result.liveLabels.some(label => /онлайн|online/i.test(label))) throw new Error("Live player counts did not render");
    if (!result.serverMotds.some(label => label.includes("mcsrvstat MOTD")) || !result.serverMotds.some(label => label.includes("minecraftpinger MOTD"))) {
        throw new Error(`Real provider MOTD shapes did not render: ${JSON.stringify(result.serverMotds)}`);
    }
    if (result.serverImages < 1 || result.serverFallbackIcons !== result.serverCards) throw new Error(`Server favicon/fallback layers are missing: images=${result.serverImages}, fallbacks=${result.serverFallbackIcons}`);
    if (result.privacyMode !== true || result.backgroundRefreshActive !== false) throw new Error(`Privacy refresh semantics are wrong: privacy=${result.privacyMode}, timer=${result.backgroundRefreshActive}`);
    if (serverStatusQueryCalls.length === 0) throw new Error("Privacy mode suppressed explicit server status IPC calls");
    if (serverStatusQueryCalls.some(call => call.options?.allowDirect !== false)) throw new Error(`Privacy mode allowed a direct query: ${JSON.stringify(serverStatusQueryCalls)}`);
    if (result.patchCards < 2) throw new Error(`Patch feed did not initialize: ${result.patchCards}`);
    if (!result.statsFileExists) throw new Error(`Statistics file was not written: ${result.statsFile}`);
    const roomsRemoved = await evaluateIsolated(`!document.querySelector("#modal-rooms") && !document.querySelector('.flymenu .item[data-modal="rooms"]')`);
    if (!roomsRemoved) throw new Error("Rooms section must be removed");
    for (const [stage, screenshotPath] of Object.entries(redesignScreenshotPaths)) {
        if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size < 1024) {
            throw new Error(`Redesign screenshot is missing: ${stage} (${screenshotPath})`);
        }
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join(" | ")}`);

    await evaluateIsolated('RxModals.switchModal("servers")');

    window.showInactive();
    await delay(350);
    const paintState = await evaluateIsolated(`(() => {
        const node = document.querySelector("#modal-servers");
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            transform: style.transform,
            width: rect.width,
            height: rect.height,
            x: rect.x,
            y: rect.y,
            classes: node.className,
            activeMenu: document.querySelector(".flymenu .item.active")?.dataset.modal || ""
        };
    })()`);
    if (paintState.display === "none" || paintState.visibility === "hidden" || Number(paintState.opacity) === 0 || paintState.width < 100 || paintState.height < 100) {
        throw new Error(`Servers modal is not paintable: ${JSON.stringify(paintState)}`);
    }
    const screenshotPath = path.join(tempRoot, "server-catalog-smoke.png");
    fs.writeFileSync(screenshotPath, await window.webContents.capturePage().then(image => image.toPNG()));
    fs.writeFileSync(path.join(tempRoot, "smoke-result.json"), JSON.stringify({
        passed: true,
        pageBoundary,
        metadataSafety,
        screenshotPath,
        skinsScreenshotPath,
        personalizationScreenshotPath,
        redesignScreenshotPaths,
        minecraftSkinApplyCalls,
        paintState,
        ...result
    }, null, 2), "utf8");
    console.log(JSON.stringify({
        passed: true,
        screenshotPath,
        skinsScreenshotPath,
        personalizationScreenshotPath,
        redesignScreenshotPaths,
        paintState,
        ...result
    }, null, 2));
    window.destroy();
    smokeWindow = null;
    app.exit(0);
}).catch(async error => {
    const failureScreenshotPath = path.join(tempRoot, "smoke-failure.png");
    const failureResultPath = path.join(tempRoot, "smoke-failure.json");
    let screenshotSaved = false;
    let screenshotError = "";
    try {
        if (smokeWindow && !smokeWindow.isDestroyed()) {
            smokeWindow.showInactive();
            await delay(250);
            const image = await Promise.race([
                smokeWindow.webContents.capturePage(),
                delay(3000).then(() => { throw new Error("Failure screenshot timed out"); })
            ]);
            fs.writeFileSync(failureScreenshotPath, image.toPNG());
            screenshotSaved = true;
        }
    } catch (captureError) {
        screenshotError = captureError?.message || String(captureError);
    }

    const failurePayload = {
        passed: false,
        error: error?.stack || error?.message || String(error),
        screenshotPath: screenshotSaved ? failureScreenshotPath : "",
        skinsScreenshotPath: fs.existsSync(skinsScreenshotPath) ? skinsScreenshotPath : "",
        personalizationScreenshotPath: fs.existsSync(personalizationScreenshotPath) ? personalizationScreenshotPath : "",
        redesignScreenshotPaths: Object.fromEntries(Object.entries(redesignScreenshotPaths).filter(([, screenshotPath]) => fs.existsSync(screenshotPath))),
        screenshotError,
        result: lastSmokeResult
    };
    try {
        fs.writeFileSync(failureResultPath, JSON.stringify(failurePayload, null, 2), "utf8");
    } catch (_) {}
    console.error(`${failurePayload.error}\nSmoke failure result: ${failureResultPath}${screenshotSaved ? `\nSmoke failure screenshot: ${failureScreenshotPath}` : ""}`);
    if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
    smokeWindow = null;
    app.exit(1);
});
