// Каналы ipcRenderer, которые обслуживает сам интерфейс и которым не нужны права ядра: проверка сети,
// статус в Discord, миниатюры скриншотов. Сеть — через ядро (без CORS)
const bridge = require("./bridge");
const {Buffer} = require("buffer");

const USER_AGENT = () => `MaxRx/RxLauncher/${typeof LAUNCHER_VERSION === "string" ? LAUNCHER_VERSION : "3"} (https://rxlauncher.xyz)`;
const request = async (url, {timeout = 7500, accept = "application/json", maxBytes = 2 * 1024 * 1024} = {}) => {
    const {value, payload} = await bridge.call("http.request", {url, method: "GET", timeout, maxBytes, compress: true, headers: {"Accept": accept, "User-Agent": USER_AGENT()}});
    return {status: value.status, headers: value.headers || {}, body: Buffer.from(payload)};
};
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms))]);

// ---------- проверка сети (официальные сервисы Minecraft) ----------
const NETWORK_ENDPOINTS = [
    {name: "authserver", url: "https://authserver.mojang.com/"},
    {name: "sessionserver", url: "https://sessionserver.mojang.com/session/minecraft/profile/00000000-0000-0000-0000-000000000000"},
    {name: "minecraftservices", url: "https://api.minecraftservices.com/minecraft/profile"}
];
const networkCompatibilityCheck = async (timeoutMs = 3200) => {
    const timeout = Math.min(10000, Math.max(250, Math.round(Number(timeoutMs) || 3200)));
    const startedAt = Date.now();
    const checks = await Promise.all(NETWORK_ENDPOINTS.map(async endpoint => {
        try {
            const response = await withTimeout(request(endpoint.url, {timeout}), timeout + 500);
            return {name: endpoint.name, reachable: true, status: response.status};
        } catch (_) {
            return {name: endpoint.name, reachable: false, status: 0};
        }
    }));
    const reachable = checks.filter(check => check.reachable).length;
    return {reachable: reachable > 0, reachableCount: reachable, total: checks.length, checkedAt: Date.now(), duration: Date.now() - startedAt, checks};
};

// ---------- Discord Rich Presence (транспорт — discord.rs в ядре) ----------
const RPC = {
    largeImage: "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v4.gif",
    // Адрес картинки можно сменить на сайте, без выпуска лаунчера: {"largeImage": "https://rxlauncher.xyz/…"}
    configUrl: "https://rxlauncher.xyz/rpc.json",
    configRefresh: 6 * 60 * 60e3,
    telegram: "https://t.me/rxlauncher",
    discord: "https://discord.gg/eDF6cUmAfN",
    retryDelay: 15000,
    minInterval: 4200,
    texts: {
        ru: {menuDetails: "В лаунчере", menuState: "Выбирает, во что сыграть", menuStateNamed: "Профиль {nick}", gameDetails: "Играет в Minecraft",
            playingAs: "Играет за {nick}", inGame: "В игре", server: "Сервер {server}", imageText: "RxLaunch — лаунчер Minecraft",
            button: "Telegram RxLaunch", discordButton: "Discord RxLaunch"},
        en: {menuDetails: "In the launcher", menuState: "Choosing what to play", menuStateNamed: "Profile {nick}", gameDetails: "Playing Minecraft",
            playingAs: "Playing as {nick}", inGame: "In game", server: "Server {server}", imageText: "RxLaunch — Minecraft launcher",
            button: "RxLaunch on Telegram", discordButton: "RxLaunch on Discord"}
    }
};
const rpc = {
    settings: {enabled: true, showNickname: true, showServer: true, showTime: true, language: "ru"},
    mode: "main", nickname: "", mainStart: Date.now(), gameStart: null, game: {},
    ready: false, last: null, lastSignature: "", lastUpdate: 0, retryTimer: null, queue: Promise.resolve()
};
const rpcText = (key, values = {}) => (RPC.texts[rpc.settings.language] || RPC.texts.ru)[key].replace(/\{(\w+)}/g, (_, name) => String(values[name] ?? ""));
const rpcClean = (value, max = 128) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const rpcServer = value => {
    const server = rpcClean(value, 80);
    return server && /^[a-z0-9._:\[\]-]+$/i.test(server) ? server : "";
};
const LOADER_NAMES = {forge: "Forge", forgeOptiFine: "Forge + OptiFine", neoforge: "NeoForge", fabric: "Fabric", quilt: "Quilt", custom: "Custom", vanilla: "Vanilla"};
// Картинка статуса с сайта: только https и только rxlauncher.xyz; последняя удачная запоминается до следующего запуска
const RPC_IMAGE_KEY = "rxRpcLargeImage";
const rpcImageAllowed = value => {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" && /(^|\.)rxlauncher\.xyz$/i.test(url.hostname) && !url.username && !url.password && url.href.length <= 512;
    } catch (_) {
        return false;
    }
};
try {
    const saved = localStorage.getItem(RPC_IMAGE_KEY);
    if (saved && rpcImageAllowed(saved)) RPC.largeImage = saved;
} catch (_) {}
let rpcConfigTimer = null;
const rpcLoadConfig = async () => {
    clearTimeout(rpcConfigTimer);
    rpcConfigTimer = setTimeout(rpcLoadConfig, RPC.configRefresh);
    try {
        const response = await request(RPC.configUrl, {timeout: 8000, maxBytes: 16 * 1024});
        if (response.status !== 200) return;
        const image = JSON.parse(response.body.toString("utf8"))?.largeImage;
        if (!rpcImageAllowed(image) || image === RPC.largeImage) return;
        RPC.largeImage = image;
        try { localStorage.setItem(RPC_IMAGE_KEY, image); } catch (_) {}
        rpcUpdate(true);
    } catch (_) {}
};
const rpcActivity = () => {
    const version = typeof LAUNCHER_VERSION === "string" ? LAUNCHER_VERSION : "";
    const activity = {
        details: rpcText("menuDetails"),
        state: rpcText("menuState"),
        assets: {large_image: RPC.largeImage, large_text: `${rpcText("imageText")} · v${version}`},
        buttons: [{label: rpcText("discordButton"), url: RPC.discord}, {label: rpcText("button"), url: RPC.telegram}],
        instance: false
    };
    if (rpc.mode === "game") {
        const game = rpc.game;
        const nickname = rpc.settings.showNickname ? rpcClean(game.nickname, 32) : "";
        const server = rpc.settings.showServer ? rpcServer(game.server) : "";
        const loader = game.loaderType && game.loaderType !== "vanilla" ? (rpcClean(game.loaderDisplay, 40) || LOADER_NAMES[game.loaderType] || "Vanilla") : "";
        activity.details = game.version ? [`Minecraft ${rpcClean(game.version, 40)}`, loader].filter(Boolean).join(" · ") : rpcText("gameDetails");
        if (nickname && server) activity.state = `${nickname} · ${server}`;
        else if (nickname) activity.state = rpcText("playingAs", {nick: nickname});
        else if (server) activity.state = rpcText("server", {server});
        else activity.state = rpcText("inGame");
        if (rpc.settings.showTime && rpc.gameStart) activity.timestamps = {start: rpc.gameStart};
    } else {
        const nickname = rpc.settings.showNickname ? rpc.nickname : "";
        if (nickname) activity.state = rpcText("menuStateNamed", {nick: nickname});
        if (rpc.settings.showTime) activity.timestamps = {start: rpc.mainStart};
    }
    activity.details = activity.details.slice(0, 128);
    activity.state = activity.state.slice(0, 128);
    return activity;
};
const rpcRetry = () => {
    if (rpc.retryTimer || !rpc.settings.enabled) return;
    rpc.retryTimer = setTimeout(() => { rpc.retryTimer = null; rpcUpdate(true); }, RPC.retryDelay);
};
// Обновления по очереди и не чаще раза в 4,2 с (лимит Discord)
const rpcUpdate = (force = false) => {
    rpc.queue = rpc.queue.catch(() => {}).then(async () => {
        if (!rpc.settings.enabled) {
            if (rpc.ready || rpc.last) await bridge.value("discord.clear", {}).catch(() => {});
            rpc.ready = false;
            rpc.last = null;
            rpc.lastSignature = "";
            return;
        }
        const activity = rpcActivity();
        const signature = JSON.stringify(activity);
        if (!force && signature === rpc.lastSignature) return;
        const wait = RPC.minInterval - (Date.now() - rpc.lastUpdate);
        if (wait > 0 && !force) await new Promise(resolve => setTimeout(resolve, wait));
        try {
            await bridge.value("discord.setActivity", {activity});
            rpc.ready = true;
            rpc.last = activity;
            rpc.lastSignature = signature;
            rpc.lastUpdate = Date.now();
        } catch (_) {
            rpc.ready = false;
            rpcRetry();
        }
    });
    return rpc.queue;
};
const discordHandlers = {
    "launcher-ready": (settings = {}) => {
        discordHandlers["discord-rpc-settings"](settings);
        rpcLoadConfig();
        bridge.value("ipc", {channel: "launcher-ready", args: []}).catch(() => {});
    },
    "discord-rpc-settings": (settings = {}) => {
        rpc.settings = {enabled: settings.enabled !== false, showNickname: settings.showNickname !== false, showServer: settings.showServer !== false,
            showTime: settings.showTime !== false, language: settings.language === "en" ? "en" : "ru"};
        if (Object.prototype.hasOwnProperty.call(settings, "nickname")) rpc.nickname = rpcClean(settings.nickname, 32);
        rpcUpdate();
    },
    "discord-rpc-game-start": (payload = {}) => {
        rpc.mode = "game";
        rpc.game = {...payload};
        rpc.gameStart = Date.now();
        rpcUpdate();
    },
    "discord-rpc-game-update": (payload = {}) => {
        rpc.game = {...rpc.game, ...payload};
        rpcUpdate();
    },
    "discord-rpc-game-stop": () => {
        rpc.mode = "main";
        rpc.game = {};
        rpc.gameStart = null;
        rpcUpdate();
    },
    "discord-rpc-status": () => ({clientId: "1531981667160555530", ready: rpc.ready, mode: rpc.mode, mainNickname: rpc.nickname,
        settings: {...rpc.settings}, game: {...rpc.game}, presence: rpc.last ? {...rpc.last} : null})
};

// ---------- скриншоты: миниатюра и копирование — средствами WebView ----------
const screenshotFile = file => typeof file === "string" && /[\\/]screenshots[\\/][^\\/]+\.(png|jpe?g)$/i.test(file) ? file : "";
const thumbnails = new Map();
const screenshotHandlers = {
    "screenshot-thumbnail": async file => {
        const target = screenshotFile(file);
        if (!target) return "";
        try {
            const fs = require("fs");
            const key = `${target}|${fs.statSync(target).mtimeMs}`;
            if (thumbnails.has(key)) return thumbnails.get(key);
            const bytes = await fs.promises.readFile(target);
            const bitmap = await createImageBitmap(new Blob([bytes]));
            const width = Math.min(384, bitmap.width);
            const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d");
            context.imageSmoothingQuality = "high";
            context.drawImage(bitmap, 0, 0, width, height);
            bitmap.close();
            const blob = await canvas.convertToBlob({type: "image/jpeg", quality: 0.78});
            const thumb = `data:image/jpeg;base64,${Buffer.from(new Uint8Array(await blob.arrayBuffer())).toString("base64")}`;
            thumbnails.set(key, thumb);
            if (thumbnails.size > 400) thumbnails.delete(thumbnails.keys().next().value);
            return thumb;
        } catch (_) {
            return "";
        }
    },
    "screenshot-action": async (payload = {}) => {
        const target = screenshotFile(payload.file);
        if (!target) return false;
        if (payload.action === "copy") {
            try {
                const bytes = await require("fs").promises.readFile(target);
                const bitmap = await createImageBitmap(new Blob([bytes]));
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext("2d").drawImage(bitmap, 0, 0);
                bitmap.close();
                await navigator.clipboard.write([new ClipboardItem({"image/png": await canvas.convertToBlob({type: "image/png"})})]);
                return true;
            } catch (_) {
                return false;
            }
        }
        return bridge.value("ipc", {channel: "screenshot-action", args: [payload]});
    }
};

module.exports = {
    ...screenshotHandlers,
    ...discordHandlers,
    "network-compatibility-check": networkCompatibilityCheck
};
