// Каналы ipcRenderer, которые в Electron были в главном процессе, но не требуют прав ядра: проверки сети и статус
// серверов Minecraft (HTTPS-сервисы + прямой Server List Ping в ядре). Сеть — через ядро (без CORS)
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

// ---------- статус серверов ----------
const PRIMARY = "https://api.mcsrvstat.us/3/";
const SECONDARY = "https://api.mcstatus.io/v2/status/java/";
const FALLBACK = "https://www.minecraftpinger.com/api/v1/";
const ICON = "https://api.mcsrvstat.us/icon/";
const CACHE_TTL = 120000, ERROR_TTL = 15000, ICON_MAX = 512 * 1024;
const cache = new Map();

const normalizeAddress = value => {
    const address = String(value || "").trim().toLowerCase();
    if (!address || address.length > 255 || /[\s/\\?#@]/.test(address)) return "";
    const ipv6 = address.match(/^\[([0-9a-f:]+)](?::(\d{1,5}))?$/i);
    if (ipv6) {
        const port = ipv6[2] ? Number(ipv6[2]) : 25565;
        return port > 0 && port <= 65535 ? address : "";
    }
    const hostAndPort = address.match(/^([a-z0-9._-]+)(?::(\d{1,5}))?$/i);
    if (!hostAndPort) return "";
    const port = hostAndPort[2] ? Number(hostAndPort[2]) : 25565;
    if (port < 1 || port > 65535 || hostAndPort[1].startsWith(".") || hostAndPort[1].endsWith(".")) return "";
    return address;
};
const text = (value, max = 300) => (Array.isArray(value) ? value.join("\n") : String(value || ""))
    .replace(/§[0-9a-fk-or]/gi, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const icon = value => typeof value === "string" && value.length <= ICON_MAX * 2 && /^data:image\/png;base64,[a-z0-9+/=\r\n]+$/i.test(value) ? value : "";
const json = async url => {
    const response = await request(url);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers["content-type"] || "").toLowerCase();
    if (type && !type.includes("json")) throw new Error(`Unexpected content type: ${type}`);
    return JSON.parse(response.body.toString("utf8"));
};
// Текст MOTD из JSON-компонента чата (прямой опрос)
const chatText = component => {
    if (typeof component === "string") return component;
    if (!component || typeof component !== "object") return "";
    return `${component.text || ""}${(component.extra || []).map(chatText).join("")}`;
};

const providers = {
    primary: async address => {
        const data = await json(PRIMARY + encodeURIComponent(address));
        return {reachable: true, online: data.online === true, address, players: {online: Math.max(0, Number(data.players?.online) || 0), max: Math.max(0, Number(data.players?.max) || 0)},
            motd: text(data.motd?.clean), version: text(data.version || data.protocol?.name, 100), icon: icon(data.icon), ping: null, provider: "mcsrvstat.us", checkedAt: Date.now()};
    },
    secondary: async address => {
        const data = await json(SECONDARY + encodeURIComponent(address));
        return {reachable: true, online: data.online === true, address, players: {online: Math.max(0, Number(data.players?.online) || 0), max: Math.max(0, Number(data.players?.max) || 0)},
            motd: text(data.motd?.clean || data.motd?.raw), version: text(data.version?.name_clean || data.version?.name_raw, 100), icon: icon(data.icon), ping: null, provider: "mcstatus.io", checkedAt: Date.now()};
    },
    fallback: async address => {
        const data = await json(FALLBACK + encodeURIComponent(address));
        const server = data && typeof data.server === "object" ? data.server : null;
        return {reachable: true, online: server !== null && server.online !== false, address,
            players: {online: Math.max(0, Number(server?.players?.online) || 0), max: Math.max(0, Number(server?.players?.max) || 0)},
            motd: text(server?.motd), version: text(server?.version, 100), icon: icon(server?.favicon),
            ping: Number.isFinite(Number(server?.ping)) ? Math.max(0, Math.round(Number(server.ping))) : null, provider: "minecraftpinger.com", checkedAt: Date.now()};
    },
    direct: async address => {
        const ipv6 = address.match(/^\[([0-9a-f:]+)](?::(\d{1,5}))?$/i);
        const [host, port] = ipv6 ? [ipv6[1], ipv6[2]] : address.split(":");
        const {status, ping} = await bridge.value("net.mcping", {host, port: port ? Number(port) : 25565, timeout: 6500});
        return {reachable: true, online: true, address, players: {online: Math.max(0, Number(status.players?.online) || 0), max: Math.max(0, Number(status.players?.max) || 0)},
            motd: text(chatText(status.description)), version: text(status.version?.name, 100), icon: icon(status.favicon), ping, provider: "direct", checkedAt: Date.now()};
    }
};
const run = async (provider, address) => {
    try { return await providers[provider](address); } catch (_) { return null; }
};
const withIcon = async (address, result) => {
    if (result?.icon) return result;
    try {
        const response = await request(ICON + encodeURIComponent(address), {accept: "image/png", maxBytes: ICON_MAX});
        const bytes = response.body;
        if (response.status === 200 && String(response.headers["content-type"] || "").startsWith("image/png") && bytes.length > 8
            && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
            return {...result, icon: `data:image/png;base64,${bytes.toString("base64")}`};
        }
    } catch (_) {}
    return result;
};

const serverStatusQuery = async (rawAddress, force = false, options = {}) => {
    const address = normalizeAddress(rawAddress);
    if (!address) return {reachable: false, online: false, address: "", error: "invalid_address"};
    const allowDirect = options && options.allowDirect === true;
    const key = `${address}|direct:${allowDirect ? 1 : 0}`;
    const cached = cache.get(key);
    if (!force && cached?.promise) return cached.promise;
    if (!force && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    const promise = (async () => {
        const primary = await run("primary", address);
        if (primary?.online) return withIcon(address, primary);
        const [secondary, fallback] = await Promise.all([run("secondary", address), run("fallback", address)]);
        const online = [secondary, fallback].find(result => result?.online);
        if (online) return withIcon(address, online);
        if (allowDirect) {
            const direct = await run("direct", address);
            if (direct?.online) return withIcon(address, direct);
        }
        const reachable = [primary, secondary, fallback].find(result => result?.reachable === true);
        return withIcon(address, reachable || {reachable: false, online: false, address, error: "network_unavailable", checkedAt: Date.now()});
    })();
    cache.set(key, {promise, expiresAt: Date.now() + ERROR_TTL});
    const value = await promise;
    cache.set(key, {value, expiresAt: Date.now() + (value.reachable ? CACHE_TTL : ERROR_TTL)});
    return value;
};

const serverCatalogConnectivity = async (timeoutMs = 3200) => {
    const timeout = Math.min(10000, Math.max(250, Math.round(Number(timeoutMs) || 3200)));
    const address = encodeURIComponent("play.funtime.su");
    try {
        await Promise.any([PRIMARY, SECONDARY, FALLBACK].map(base => withTimeout(request(base + address, {timeout}), timeout + 500)));
        return true;
    } catch (_) {
        return false;
    }
};

// ---------- Discord Rich Presence (транспорт — discord.rs в ядре) ----------
const RPC = {
    largeImage: "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v3.gif",
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

// ---------- скины Minecraft (minecraftSkinService.js, сеть — через ядро) ----------
// fetch для сервиса скинов: ответ целиком от ядра в виде, похожем на Response
const coreFetch = async (url, init = {}) => {
    const {value, payload} = await bridge.call("http.request", {url: String(url), method: init.method || "GET", headers: init.headers || {}, timeout: 8000,
        maxBytes: 8 * 1024 * 1024, compress: true}, null, {signal: init.signal});
    const body = Buffer.from(payload);
    const headers = value.headers || {};
    return {status: value.status, ok: value.status >= 200 && value.status < 300, url: value.url, body: null,
        headers: {get: name => headers[String(name).toLowerCase()] ?? null},
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => body.toString("utf8"), json: async () => JSON.parse(body.toString("utf8"))};
};
let skinService = null;
const skinProfiles = new Map();
let skinApplyQueue = Promise.resolve();
const userDataPath = () => bridge.syncValue("app.paths").userData;
const skins = () => {
    if (!skinService) {
        const {createMinecraftSkinService} = require("../../minecraftSkinService");
        skinService = createMinecraftSkinService({cacheRoot: require("path").join(userDataPath(), "skins", "cache"), userAgent: USER_AGENT(), fetchImpl: coreFetch});
    }
    return skinService;
};
const SKIN_ERRORS = {invalid_png: "invalid_texture", hash_mismatch: "invalid_texture", invalid_texture_hash: "invalid_texture", untrusted_texture_url: "invalid_texture",
    invalid_profile: "invalid_response", invalid_cache: "invalid_response", response_too_large: "invalid_response", untrusted_redirect: "invalid_response",
    http_error: "service_unavailable", unknown_error: "unknown", invalid_destination: "export_failed", destination_exists: "export_failed"};
const skinError = (code, fallback = "unknown") => {
    const value = typeof code === "string" ? code : fallback;
    return SKIN_ERRORS[value] || value || fallback;
};
const skinProfile = (payload = {}) => {
    const profileId = String(payload.profileId || "").replaceAll("-", "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(profileId)) return null;
    if (skinProfiles.has(profileId)) return skinProfiles.get(profileId);
    if (typeof payload.nickname !== "string") return null;
    try {
        const cached = skins().getCachedSkin(payload.nickname);
        return cached && cached.profileId === profileId ? cached : null;
    } catch (_) {
        return null;
    }
};
const accountUuid = value => {
    const uuid = String(value || "").trim().toLowerCase();
    return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5a-f0-9][a-f0-9]{3}-[89ab0-9a-f][a-f0-9]{3}-[a-f0-9]{12})$/i.test(uuid) ? uuid : "";
};
// Скин из поиска — на локальный профиль: текстура и голова 128×128 в папке лаунчера, ссылка в accounts.json
const applySkin = async (uuidValue, profile) => {
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const {Jimp, ResizeStrategy} = require("jimp");
    const uuid = accountUuid(uuidValue);
    if (!uuid) return {success: false, error: "no_active_account"};
    const base = userDataPath();
    const accountsPath = path.join(base, "accounts.json");
    let accounts;
    try {
        const stat = fs.statSync(accountsPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) return {success: false, error: "no_active_account"};
        accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    } catch (_) {
        return {success: false, error: "no_active_account"};
    }
    const account = accounts?.[uuidValue] || accounts?.[uuid];
    if (!account || !["local", "elyby"].includes(account.type)) return {success: false, error: "unsupported_account"};
    const textureTarget = path.join(base, "skins", "profiles", `${uuid}.png`);
    const headTarget = path.join(base, "skins", "heads", `${uuid}.png`);
    fs.mkdirSync(path.dirname(textureTarget), {recursive: true});
    fs.mkdirSync(path.dirname(headTarget), {recursive: true});
    const operation = crypto.randomUUID();
    const textureTemp = `${textureTarget}.${operation}.part`, headTemp = `${headTarget}.${operation}.part.png`, accountsTemp = `${accountsPath}.${operation}.part`;
    try {
        fs.copyFileSync(profile.texturePath, textureTemp);
        const skin = await Jimp.read(profile.texturePath);
        const head = skin.clone().crop({x: 8, y: 8, w: 8, h: 8});
        const hat = skin.clone().crop({x: 40, y: 8, w: 8, h: 8});
        head.composite(hat, 0, 0).resize({w: 128, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR});
        fs.writeFileSync(headTemp, await head.getBuffer("image/png"));
        fs.renameSync(textureTemp, textureTarget);
        fs.renameSync(headTemp, headTarget);
        const launcherSkin = {version: 1, source: "mojang", sourceNickname: profile.nickname, profileId: profile.profileId,
            model: profile.model === "slim" ? "slim" : "default", textureHash: profile.textureHash, sha256: profile.sha256, updatedAt: Date.now()};
        // Аккаунт мог обновить токен, пока картинка обрабатывалась
        const latest = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
        if (!latest[uuidValue]) return {success: false, error: "no_active_account"};
        latest[uuidValue] = {...latest[uuidValue], launcherSkin};
        fs.writeFileSync(accountsTemp, JSON.stringify(latest, null, "\t"));
        fs.renameSync(accountsTemp, accountsPath);
        return {success: true, path: textureTarget, headPath: headTarget};
    } catch (error) {
        console.warn(`Failed to apply launcher skin [error=${error.message}]`);
        return {success: false, error: "apply_failed"};
    } finally {
        for (const temp of [textureTemp, headTemp, accountsTemp]) {
            try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
        }
    }
};
const skinHandlers = {
    "minecraft-skin-lookup": async nickname => {
        const result = await skins().lookupSkinSafe(nickname);
        if (!result.ok) {
            if (["not_found", "skin_not_set"].includes(result.error?.code)) return {success: true, found: false};
            return {success: false, error: skinError(result.error?.code, "unknown")};
        }
        skinProfiles.set(result.profileId, result);
        if (skinProfiles.size > 64) skinProfiles.delete(skinProfiles.keys().next().value);
        return {success: true, found: true, profile: {name: result.nickname, id: result.profileId, model: result.model, skinPath: result.texturePath,
            fromCache: result.source === "cache" || result.stale === true, updatedAt: result.cachedAt}};
    },
    "minecraft-skin-export": async (payload = {}) => {
        const profile = skinProfile(payload);
        if (!profile) return {success: false, error: "cache_miss"};
        const name = String(profile.nickname || "minecraft-skin").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "minecraft-skin";
        const copy = String(payload.language || "").toLowerCase() === "en" ? {title: "Save Minecraft texture", filter: "PNG texture"} : {title: "Сохранить текстуру Minecraft", filter: "PNG-текстура"};
        const target = await bridge.value("ipc", {channel: "save-dialog", args: [{title: copy.title, defaultPath: `${name}.png`, filters: [{name: copy.filter, extensions: ["png"]}]}]});
        if (!target) return {success: false, canceled: true};
        const exported = await skins().exportTextureSafe(profile.textureHash, target, {overwrite: true});
        return exported.ok ? {success: true, path: exported.path} : {success: false, error: skinError(exported.error?.code, "export_failed")};
    },
    "minecraft-skin-apply": async (payload = {}) => {
        const profile = skinProfile(payload);
        if (!profile) return {success: false, error: "cache_miss"};
        const task = skinApplyQueue.catch(() => undefined).then(() => applySkin(payload.accountUuid, profile));
        skinApplyQueue = task.catch(() => undefined);
        return task;
    }
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
    ...skinHandlers,
    ...discordHandlers,
    "network-compatibility-check": networkCompatibilityCheck,
    "server-status-query": serverStatusQuery,
    "server-catalog-connectivity": serverCatalogConnectivity
};
