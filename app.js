let isAppInDev = process.env.LAUNCHER_IN_DEV !== undefined;
let isAppInTest = process.env.LAUNCHER_IN_TEST !== undefined;

if (isAppInDev && !process.argv.includes("noreload")) {
    require('electron-reloader')(module);
}

// Загрузка модулей
let startTime = performance.now();
const {app, ipcMain, BrowserWindow, globalShortcut, dialog, safeStorage, shell, nativeImage, Tray, Menu, clipboard} = require("electron");

// Chromium manages V8 memory itself. Forcing GC on focus changes caused UI stalls,
// so the renderer only collects once while the window is hidden (see RxOptimizer).
app.commandLine.appendSwitch("js-flags", "--expose-gc");
const {autoUpdater} = require("electron-updater");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const colors = require("colors");
const pjson = require("./package.json");
// Jimp тяжёлый — подключаем только когда нужно нарезать голову скина
let jimpModule = null;
const getJimp = () => jimpModule || (jimpModule = require("jimp"));
const {assertSecureWindowsUpdater, createStrictWindowsSignatureVerifier} = require("./updateSecurity");
const {createLauncherBranding} = require("./launcherBranding");
const {createMinecraftSkinService} = require("./minecraftSkinService");
require('console-stamp')(console);
const userDataPath = app.getPath("userData");
const accountStore = require("./accountStore").createAccountStore(path.join(userDataPath, "accounts.json"), safeStorage);
const launcherConfigPath = path.join(userDataPath, "config.json");
const gameFileSafety = require("./gameFileSafety").createGameFileSafety(launcherConfigPath);
const launcherBranding = createLauncherBranding({app, shell, nativeImage});
const initialLauncherAvatarId = launcherBranding.readSelectedAvatarId(launcherConfigPath);
launcherBranding.applyAppUserModelId();
const minecraftSkinService = createMinecraftSkinService({
    cacheRoot: path.join(userDataPath, "skins", "cache"),
    userAgent: `MaxRx/RxLauncher/${pjson.version} (https://rxlauncher.xyz)`
});
const minecraftSkinProfiles = new Map();
let minecraftSkinApplyQueue = Promise.resolve();
const MINECRAFT_SKIN_EXPORT_COPY = Object.freeze({
    ru: {title: "Сохранить текстуру Minecraft", filter: "PNG-текстура"},
    en: {title: "Save Minecraft texture", filter: "PNG texture"}
});
const curseForgeKeyPath = path.join(userDataPath, "curseforge-api-key.bin");
// Сессия аккаунта RxLauncher (друзья): токен зашифрован средствами Windows
const rxAccountTokenPath = path.join(userDataPath, "rx-account.bin");
const CURSEFORGE_API_BASE = "https://api.curseforge.com";

const normalizeLauncherAccountUuid = (value) => {
    const uuid = String(value || "").trim().toLowerCase();
    return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5a-f0-9][a-f0-9]{3}-[89ab0-9a-f][a-f0-9]{3}-[a-f0-9]{12})$/i.test(uuid)
        ? uuid
        : "";
};

const resolveSkinProfile = (payload = {}) => {
    const profileId = String(payload.profileId || "").replaceAll("-", "").toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(profileId)) return null;
    const memoryProfile = minecraftSkinProfiles.get(profileId);
    if (memoryProfile) return memoryProfile;
    if (typeof payload.nickname !== "string") return null;
    try {
        const cached = minecraftSkinService.getCachedSkin(payload.nickname);
        return cached && cached.profileId === profileId ? cached : null;
    } catch (_) {
        return null;
    }
};

const normalizeMinecraftSkinError = (code, fallback = "unknown") => {
    const normalized = typeof code === "string" ? code : fallback;
    const aliases = {
        invalid_png: "invalid_texture",
        hash_mismatch: "invalid_texture",
        invalid_texture_hash: "invalid_texture",
        untrusted_texture_url: "invalid_texture",
        invalid_profile: "invalid_response",
        invalid_cache: "invalid_response",
        response_too_large: "invalid_response",
        untrusted_redirect: "invalid_response",
        http_error: "service_unavailable",
        unknown_error: "unknown",
        invalid_destination: "export_failed",
        destination_exists: "export_failed"
    };
    return aliases[normalized] || normalized || fallback;
};

const writeAccountLauncherSkin = async (accountUuid, profile) => {
    const normalizedAccountUuid = normalizeLauncherAccountUuid(accountUuid);
    if (!normalizedAccountUuid) return {success: false, error: "no_active_account"};
    const accountsPath = path.join(userDataPath, "accounts.json");
    let accounts;
    try {
        const stats = fs.statSync(accountsPath);
        if (!stats.isFile() || stats.size <= 0 || stats.size > 2 * 1024 * 1024) {
            return {success: false, error: "no_active_account"};
        }
        accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    } catch (_) {
        return {success: false, error: "no_active_account"};
    }
    const account = accounts?.[accountUuid] || accounts?.[normalizedAccountUuid];
    if (!account || !["local", "elyby"].includes(account.type)) {
        return {success: false, error: "unsupported_account"};
    }

    const profilesDirectory = path.join(userDataPath, "skins", "profiles");
    const headsDirectory = path.join(userDataPath, "skins", "heads");
    fs.mkdirSync(profilesDirectory, {recursive: true});
    fs.mkdirSync(headsDirectory, {recursive: true});
    const textureTarget = path.join(profilesDirectory, `${normalizedAccountUuid}.png`);
    const headTarget = path.join(headsDirectory, `${normalizedAccountUuid}.png`);
    const operationId = crypto.randomUUID();
    const textureTemporary = `${textureTarget}.${process.pid}.${operationId}.part`;
    const headTemporary = `${headTarget}.${process.pid}.${operationId}.part.png`;
    const accountsTemporary = `${accountsPath}.${process.pid}.${operationId}.part`;
    const replaceFile = (temporaryPath, targetPath) => {
        try {
            fs.renameSync(temporaryPath, targetPath);
        } catch (error) {
            if (!["EEXIST", "EPERM"].includes(error?.code) || !fs.existsSync(targetPath)) throw error;
            fs.unlinkSync(targetPath);
            fs.renameSync(temporaryPath, targetPath);
        }
    };

    try {
        fs.copyFileSync(profile.texturePath, textureTemporary);
        const {Jimp, ResizeStrategy} = getJimp();
        const skinImage = await Jimp.read(profile.texturePath);
        const head = skinImage.clone().crop({x: 8, y: 8, w: 8, h: 8});
        const hat = skinImage.clone().crop({x: 40, y: 8, w: 8, h: 8});
        head.composite(hat, 0, 0).resize({w: 128, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR});
        fs.writeFileSync(headTemporary, await head.getBuffer("image/png"));
        replaceFile(textureTemporary, textureTarget);
        replaceFile(headTemporary, headTarget);

        account.launcherSkin = {
            version: 1,
            source: "mojang",
            sourceNickname: profile.nickname,
            profileId: profile.profileId,
            model: profile.model === "slim" ? "slim" : "default",
            textureHash: profile.textureHash,
            sha256: profile.sha256,
            updatedAt: Date.now()
        };
        // The account may have refreshed its token while the skin was decoded.
        const latestAccounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
        if (!latestAccounts[accountUuid]) return {success: false, error: "no_active_account"};
        latestAccounts[accountUuid] = {...latestAccounts[accountUuid], launcherSkin: account.launcherSkin};
        fs.writeFileSync(accountsTemporary, JSON.stringify(latestAccounts, null, "\t"), {encoding: "utf8", flag: "w"});
        replaceFile(accountsTemporary, accountsPath);
        return {success: true, path: textureTarget, headPath: headTarget};
    } catch (error) {
        console.warn(`Failed to apply launcher skin [account=${normalizedAccountUuid}] [error=${error.message}]`);
        return {success: false, error: "apply_failed"};
    } finally {
        for (const temporaryPath of [textureTemporary, headTemporary, accountsTemporary]) {
            try {
                if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            } catch (_) {}
        }
    }
};

// === Network compatibility service: begin ===
// Проверяем только доступность официальных сервисов Minecraft. Ответ 401/404
// тоже означает, что соединение установлено; права аккаунта здесь не меняются.
const NETWORK_COMPATIBILITY_HTTP_TIMEOUT = 3200;
const NETWORK_COMPATIBILITY_ENDPOINTS = [
    {name: "authserver", url: "https://authserver.mojang.com/"},
    {name: "sessionserver", url: "https://sessionserver.mojang.com/session/minecraft/profile/00000000-0000-0000-0000-000000000000"},
    {name: "minecraftservices", url: "https://api.minecraftservices.com/minecraft/profile"}
];

const checkOfficialNetworkConnectivity = async (timeoutMs = NETWORK_COMPATIBILITY_HTTP_TIMEOUT) => {
    const safeTimeout = Number.isFinite(Number(timeoutMs))
        ? Math.min(10000, Math.max(250, Math.round(Number(timeoutMs))))
        : NETWORK_COMPATIBILITY_HTTP_TIMEOUT;
    const startedAt = Date.now();
    const checks = await Promise.all(NETWORK_COMPATIBILITY_ENDPOINTS.map(async (endpoint) => {
        try {
            const response = await fetch(endpoint.url, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "User-Agent": `MaxRx/RxLauncher/${pjson.version} (https://rxlauncher.xyz)`
                },
                signal: AbortSignal.timeout(safeTimeout)
            });
            return {name: endpoint.name, reachable: true, status: Number(response.status) || 0};
        } catch (error) {
            return {name: endpoint.name, reachable: false, status: 0, error: String(error?.message || error)};
        }
    }));
    const reachable = checks.filter((check) => check.reachable).length;
    const result = {
        reachable: reachable > 0,
        reachableCount: reachable,
        total: checks.length,
        checkedAt: Date.now(),
        duration: Date.now() - startedAt,
        checks: checks.map(({name, reachable: isReachable, status}) => ({name, reachable: isReachable, status}))
    };
    console.log(`Official network preflight [reachable=${result.reachable}] [count=${reachable}/${checks.length}] [duration=${result.duration}ms]`);
    return result;
};
// === Network compatibility service: end ===

// === Minecraft server status service: begin ===
const SERVER_STATUS_PRIMARY_BASE = "https://api.mcsrvstat.us/3/";
const SERVER_STATUS_SECONDARY_BASE = "https://api.mcstatus.io/v2/status/java/";
const SERVER_STATUS_FALLBACK_BASE = "https://www.minecraftpinger.com/api/v1/";
const SERVER_STATUS_ICON_BASE = "https://api.mcsrvstat.us/icon/";
const SERVER_STATUS_CACHE_TTL = 120000;
const SERVER_STATUS_ERROR_CACHE_TTL = 15000;
const SERVER_STATUS_HTTP_TIMEOUT = 7500;
const SERVER_CATALOG_CONNECTIVITY_TIMEOUT = 3200;
const SERVER_STATUS_DIRECT_ATTEMPT_TIMEOUT = 6500;
const SERVER_STATUS_ICON_MAX_BYTES = 512 * 1024;
const serverStatusCache = new Map();
let serverStatusGameDig = null;

const normalizeMinecraftAddress = (value) => {
    const address = String(value || "").trim().toLowerCase();
    if (!address || address.length > 255 || /[\s/\\?#@]/.test(address)) return "";

    const bracketedIpv6 = address.match(/^\[([0-9a-f:]+)](?::(\d{1,5}))?$/i);
    if (bracketedIpv6) {
        const port = bracketedIpv6[2] ? Number(bracketedIpv6[2]) : 25565;
        return port > 0 && port <= 65535 ? address : "";
    }

    const hostAndPort = address.match(/^([a-z0-9._-]+)(?::(\d{1,5}))?$/i);
    if (!hostAndPort) return "";
    const port = hostAndPort[2] ? Number(hostAndPort[2]) : 25565;
    if (port < 1 || port > 65535 || hostAndPort[1].startsWith(".") || hostAndPort[1].endsWith(".")) return "";
    return address;
};

const fetchServerStatusResponse = async (url, accept = "application/json", timeoutMs = SERVER_STATUS_HTTP_TIMEOUT) => {
    const response = await fetch(url, {
        headers: {
            "Accept": accept,
            "User-Agent": `MaxRx/RxLauncher/${pjson.version} (https://rxlauncher.xyz)`
        },
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
};

const fetchServerStatusJson = async (url, timeoutMs = SERVER_STATUS_HTTP_TIMEOUT) => {
    const response = await fetchServerStatusResponse(url, "application/json", timeoutMs);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("json")) {
        throw new Error(`Unexpected content type: ${contentType}`);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new Error(`Invalid JSON: ${error.message}`);
    }
};

const normalizeServerStatusText = (value, maxLength = 300) => {
    const text = Array.isArray(value) ? value.join("\n") : String(value || "");
    return text
        .replace(/\u00a7[0-9a-fk-or]/gi, "")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, maxLength);
};

const normalizeServerStatusIcon = (value) => {
    if (typeof value !== "string" || value.length > SERVER_STATUS_ICON_MAX_BYTES * 2) return "";
    return /^data:image\/png;base64,[a-z0-9+/=\r\n]+$/i.test(value) ? value : "";
};

const checkServerCatalogConnectivity = async (timeoutMs = SERVER_CATALOG_CONNECTIVITY_TIMEOUT) => {
    const safeTimeout = Number.isFinite(Number(timeoutMs))
        ? Math.min(10000, Math.max(250, Math.round(Number(timeoutMs))))
        : SERVER_CATALOG_CONNECTIVITY_TIMEOUT;
    const encodedAddress = encodeURIComponent("play.funtime.su");
    const probes = [
        {provider: "mcsrvstat.us", url: SERVER_STATUS_PRIMARY_BASE + encodedAddress},
        {provider: "mcstatus.io", url: SERVER_STATUS_SECONDARY_BASE + encodedAddress},
        {provider: "minecraftpinger.com", url: SERVER_STATUS_FALLBACK_BASE + encodedAddress}
    ];
    const startedAt = Date.now();

    try {
        const provider = await Promise.any(probes.map(async probe => {
            const response = await fetch(probe.url, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "User-Agent": `MaxRx/RxLauncher/${pjson.version} (https://rxlauncher.xyz)`
                },
                signal: AbortSignal.timeout(safeTimeout)
            });
            // Any real HTTP response proves network connectivity. Provider HTTP
            // errors are handled later as status errors and must not lock the tab.
            return `${probe.provider}:${response.status}`;
        }));
        console.log(`Server catalog connectivity [reachable=true] [provider=${provider}] [duration=${Date.now() - startedAt}ms]`);
        return true;
    } catch (error) {
        const failures = Array.isArray(error?.errors) ? error.errors : [error];
        const reasons = failures.map(failure => failure?.message || String(failure)).join(" | ").slice(0, 500);
        console.warn(`Server catalog connectivity [reachable=false] [duration=${Date.now() - startedAt}ms] [errors=${reasons}]`);
        return false;
    }
};

const normalizePrimaryServerStatus = (address, data = {}) => ({
    reachable: true,
    online: data.online === true,
    address,
    players: {
        online: Math.max(0, Number(data.players?.online) || 0),
        max: Math.max(0, Number(data.players?.max) || 0)
    },
    motd: normalizeServerStatusText(data.motd?.clean),
    version: normalizeServerStatusText(data.version || data.protocol?.name, 100),
    icon: normalizeServerStatusIcon(data.icon),
    ping: null,
    provider: "mcsrvstat.us",
    checkedAt: Date.now()
});

const normalizeSecondaryServerStatus = (address, data = {}) => ({
    reachable: true,
    online: data.online === true,
    address,
    players: {
        online: Math.max(0, Number(data.players?.online) || 0),
        max: Math.max(0, Number(data.players?.max) || 0)
    },
    motd: normalizeServerStatusText(data.motd?.clean || data.motd?.raw),
    version: normalizeServerStatusText(data.version?.name_clean || data.version?.name_raw, 100),
    icon: normalizeServerStatusIcon(data.icon),
    ping: null,
    provider: "mcstatus.io",
    checkedAt: Date.now()
});

const normalizeFallbackServerStatus = (address, data = {}) => {
    const server = data && typeof data.server === "object" ? data.server : null;
    return {
        reachable: true,
        online: server !== null && server.online !== false,
        address,
        players: {
            online: Math.max(0, Number(server?.players?.online) || 0),
            max: Math.max(0, Number(server?.players?.max) || 0)
        },
        motd: normalizeServerStatusText(server?.motd),
        version: normalizeServerStatusText(server?.version, 100),
        icon: normalizeServerStatusIcon(server?.favicon),
        ping: Number.isFinite(Number(server?.ping)) ? Math.max(0, Math.round(Number(server.ping))) : null,
        provider: "minecraftpinger.com",
        checkedAt: Date.now()
    };
};

const splitMinecraftAddress = (address) => {
    const ipv6 = address.match(/^\[([0-9a-f:]+)](?::(\d{1,5}))?$/i);
    if (ipv6) return {host: ipv6[1], port: ipv6[2] ? Number(ipv6[2]) : null};
    const hostAndPort = address.match(/^([a-z0-9._-]+)(?::(\d{1,5}))?$/i);
    return hostAndPort
        ? {host: hostAndPort[1], port: hostAndPort[2] ? Number(hostAndPort[2]) : null}
        : null;
};

const normalizeDirectServerStatus = (address, data = {}) => {
    const vanillaPayload = data.raw?.vanilla?.raw || {};
    return {
        reachable: true,
        online: true,
        address,
        players: {
            online: Math.max(0, Number(data.numplayers) || 0),
            max: Math.max(0, Number(data.maxplayers) || 0)
        },
        motd: normalizeServerStatusText(data.name),
        version: normalizeServerStatusText(data.version, 100),
        icon: normalizeServerStatusIcon(vanillaPayload.favicon),
        ping: Number.isFinite(Number(data.ping)) ? Math.max(0, Math.round(Number(data.ping))) : null,
        provider: "direct-gamedig",
        checkedAt: Date.now()
    };
};

const runServerStatusProvider = async (provider, address, operation) => {
    const startedAt = Date.now();
    try {
        const result = await operation();
        console.log(`Minecraft status query [provider=${provider}] [address=${address}] [online=${result.online === true}] [players=${result.players?.online || 0}/${result.players?.max || 0}] [motd=${Boolean(result.motd)}] [icon=${Boolean(result.icon)}] [duration=${Date.now() - startedAt}ms]`);
        return result;
    } catch (error) {
        console.warn(`Minecraft status query failed [provider=${provider}] [address=${address}] [duration=${Date.now() - startedAt}ms] [error=${error.message}]`);
        return null;
    }
};

const queryMinecraftServerDirect = async (address) => {
    const target = splitMinecraftAddress(address);
    if (!target) throw new Error("Invalid direct-query address");
    if (!serverStatusGameDig) serverStatusGameDig = require("gamedig").GameDig;
    const data = await serverStatusGameDig.query({
        type: "minecraft",
        host: target.host,
        ...(target.port ? {port: target.port, givenPortOnly: true} : {}),
        maxRetries: 0,
        socketTimeout: 2500,
        attemptTimeout: SERVER_STATUS_DIRECT_ATTEMPT_TIMEOUT,
        requestPlayers: false
    });
    return normalizeDirectServerStatus(address, data);
};

const fetchMinecraftServerIcon = async (address) => {
    const response = await fetchServerStatusResponse(
        SERVER_STATUS_ICON_BASE + encodeURIComponent(address),
        "image/png"
    );
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/png")) throw new Error(`Unexpected content type: ${contentType || "missing"}`);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > SERVER_STATUS_ICON_MAX_BYTES) {
        throw new Error(`Icon is too large: ${declaredSize}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 8 || bytes.length > SERVER_STATUS_ICON_MAX_BYTES) {
        throw new Error(`Invalid icon size: ${bytes.length}`);
    }
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error("Invalid PNG signature");
    return `data:image/png;base64,${bytes.toString("base64")}`;
};

const hydrateMinecraftServerIcon = async (address, result) => {
    if (result?.icon) return result;
    const startedAt = Date.now();
    try {
        const icon = await fetchMinecraftServerIcon(address);
        console.log(`Minecraft status icon fallback [address=${address}] [duration=${Date.now() - startedAt}ms]`);
        return {...result, icon};
    } catch (error) {
        console.warn(`Minecraft status icon fallback failed [address=${address}] [duration=${Date.now() - startedAt}ms] [error=${error.message}]`);
        return result;
    }
};

const queryMinecraftServerStatus = async (rawAddress, force = false, rawOptions = {}) => {
    const address = normalizeMinecraftAddress(rawAddress);
    if (!address) return {reachable: false, online: false, address: "", error: "invalid_address"};
    const allowDirect = rawOptions && typeof rawOptions === "object" && rawOptions.allowDirect === true;
    const cacheKey = `${address}|direct:${allowDirect ? "1" : "0"}`;

    const cached = serverStatusCache.get(cacheKey);
    if (!force && cached?.promise) return cached.promise;
    if (!force && cached?.value && cached.expiresAt > Date.now()) return cached.value;

    const promise = (async () => {
        const primaryResult = await runServerStatusProvider("mcsrvstat.us", address, async () => (
            normalizePrimaryServerStatus(
                address,
                await fetchServerStatusJson(SERVER_STATUS_PRIMARY_BASE + encodeURIComponent(address))
            )
        ));
        if (primaryResult?.online) return hydrateMinecraftServerIcon(address, primaryResult);

        const [secondaryResult, fallbackResult] = await Promise.all([
            runServerStatusProvider("mcstatus.io", address, async () => (
                normalizeSecondaryServerStatus(
                    address,
                    await fetchServerStatusJson(SERVER_STATUS_SECONDARY_BASE + encodeURIComponent(address))
                )
            )),
            runServerStatusProvider("minecraftpinger.com", address, async () => (
                normalizeFallbackServerStatus(
                    address,
                    await fetchServerStatusJson(SERVER_STATUS_FALLBACK_BASE + encodeURIComponent(address))
                )
            ))
        ]);

        const httpsOnlineResult = [secondaryResult, fallbackResult].find(result => result?.online);
        if (httpsOnlineResult) return hydrateMinecraftServerIcon(address, httpsOnlineResult);

        if (allowDirect) {
            const directResult = await runServerStatusProvider(
                "direct-gamedig",
                address,
                () => queryMinecraftServerDirect(address)
            );
            if (directResult?.online) return hydrateMinecraftServerIcon(address, directResult);
        }

        const reachableResult = [primaryResult, secondaryResult, fallbackResult]
            .find(result => result?.reachable === true);
        return hydrateMinecraftServerIcon(address, reachableResult || {
            reachable: false,
            online: false,
            address,
            error: "network_unavailable",
            checkedAt: Date.now()
        });
    })();

    serverStatusCache.set(cacheKey, {promise, expiresAt: Date.now() + SERVER_STATUS_ERROR_CACHE_TTL});
    const value = await promise;
    serverStatusCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + (value.reachable ? SERVER_STATUS_CACHE_TTL : SERVER_STATUS_ERROR_CACHE_TTL)
    });
    return value;
};
// === Minecraft server status service: end ===

const readCurseForgeApiKey = () => {
    const environmentKey = (process.env.RX_CURSEFORGE_API_KEY || "").trim();
    if (environmentKey) return environmentKey;
    if (!fs.existsSync(curseForgeKeyPath) || !safeStorage.isEncryptionAvailable()) return "";
    try {
        return safeStorage.decryptString(fs.readFileSync(curseForgeKeyPath)).trim();
    } catch (error) {
        console.warn(`Failed to decrypt CurseForge API key: ${error.message}`);
        return "";
    }
};

const isAllowedCurseForgeEndpoint = (endpoint) => [
    /^\/v1\/games\/432$/,
    /^\/v1\/mods\/search$/,
    /^\/v1\/mods\/\d+$/,
    /^\/v1\/mods\/\d+\/files$/,
    /^\/v1\/mods\/\d+\/files\/\d+$/,
    /^\/v1\/mods\/\d+\/files\/\d+\/download-url$/,
    /^\/v1\/minecraft\/version$/,
    /^\/v1\/mods\/files$/
].some((pattern) => pattern.test(endpoint));

const curseForgeApiRequest = async (apiKey, endpoint, query = {}, method = "GET", body = null) => {
    if (!apiKey || !isAllowedCurseForgeEndpoint(endpoint)) {
        return {success: false, status: apiKey ? 400 : 401, error: apiKey ? "endpoint_not_allowed" : "api_key_required"};
    }

    const url = new URL(endpoint, CURSEFORGE_API_BASE);
    Object.entries(query || {}).forEach(([key, value]) => {
        if (["string", "number", "boolean"].includes(typeof value)) {
            url.searchParams.set(key, value.toString());
        }
    });

    try {
        const response = await fetch(url, {
            method,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "User-Agent": `MaxRx/RxLauncher/${pjson.version} (https://rxlauncher.xyz)`
            },
            body: method === "POST" ? JSON.stringify(body || {}) : undefined,
            signal: AbortSignal.timeout(20000)
        });
        const responseText = await response.text();
        let responseBody = {};
        try {
            responseBody = responseText ? JSON.parse(responseText) : {};
        } catch (_) {
            responseBody = {message: responseText};
        }
        if (!response.ok) {
            return {success: false, status: response.status, error: responseBody?.message || `HTTP ${response.status}`};
        }
        return {success: true, status: response.status, data: responseBody};
    } catch (error) {
        return {success: false, status: 0, error: error.message};
    }
};

const {forge, neoforge, fabric, quilt, vanilla, liner} = require("tomate-loaders");

// Конфиг MCLC для уже установленной версии загрузчика — без обращения к сети
const buildLocalMclcConfig = (type, version, gameData) => {
    const folderType = type === "forgeOptiFine" ? "forge" : type;
    const custom = `${folderType}-${version}`;
    const versionDir = path.join(gameData, "versions", custom);
    const config = {root: gameData, version: {number: version, type: "release", custom}};
    if (folderType === "fabric" || folderType === "quilt") {
        return fs.existsSync(path.join(versionDir, `${custom}.json`)) ? config : null;
    }
    const installerPath = path.join(versionDir, `${folderType}.jar`);
    return fs.existsSync(installerPath) ? {...config, clientPackage: null, forge: installerPath} : null;
};

// Своя версия: versions/<имя>/<имя>.json. С inheritsFrom MCLC берёт базовую версию и накладывает поверх
const buildCustomMclcConfig = (name, gameData) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(String(name))) return false;
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(gameData, "versions", name, `${name}.json`), "utf8"));
    } catch (_) {
        return false;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    const type = ["release", "snapshot", "old_alpha", "old_beta"].includes(manifest.type) ? manifest.type : "release";
    if (typeof manifest.inheritsFrom === "string" && manifest.inheritsFrom) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(manifest.inheritsFrom)) return false;
        return {root: gameData, version: {number: manifest.inheritsFrom, type, custom: name}};
    }
    // Самостоятельный манифест — запускаем как обычную версию из своей папки
    return {root: gameData, version: {number: name, type}};
};
const DiscordRPC = require("discord-rpc");

let lastLogBack;

// Создаём глобальные переменные для хранения BrowserWindow
let mainWindowObject;
const {onTrusted, handleTrusted} = require("./ipcSecurity").createTrustedIpc(ipcMain, () => mainWindowObject, path.join(__dirname, "web", "index.ejs"));
let gameTray = null;
const showLauncherWindow = () => {
    if (!mainWindowObject || mainWindowObject.isDestroyed()) return;
    mainWindowObject.setSkipTaskbar(false);
    mainWindowObject.show();
    mainWindowObject.focus();
    if (gameTray) { gameTray.destroy(); gameTray = null; }
};
const hideLauncherWindow = () => {
    if (!mainWindowObject || mainWindowObject.isDestroyed()) return;
    if (!gameTray) {
        try {
            const selectedIcon = launcherBranding.resolveAvatarPaths(initialLauncherAvatarId).icoPath;
            const fallbackIcon = path.join(__dirname, "resources", "icon.ico");
            gameTray = new Tray(selectedIcon && fs.existsSync(selectedIcon) ? selectedIcon : fallbackIcon);
            gameTray.setToolTip("RxLauncher — Minecraft запущен");
            gameTray.setContextMenu(Menu.buildFromTemplate([
                {label: "Открыть RxLauncher", click: showLauncherWindow}
            ]));
            gameTray.on("double-click", showLauncherWindow);
        } catch (error) {
            console.warn("Could not create game tray icon", error);
        }
    }
    mainWindowObject.setSkipTaskbar(Boolean(gameTray));
    mainWindowObject.hide();
};
let mainWindow = require("./windows/mainWindow"); // Модуль для создания главного окна
let minecraftGameActive = false;
let activeMinecraftPid = 0;

// Анти-кража истории команд: файл лежит в папке игры только пока игра запущена
const commandHistoryVault = require("./commandHistoryVault").createCommandHistoryVault({
    vaultRoot: path.join(userDataPath, "vault"), safeStorage, log: message => console.log(message)
});
let commandHistoryDirectory = null;
const readLauncherSetting = (key, fallback) => {
    try {
        const value = JSON.parse(fs.readFileSync(launcherConfigPath, "utf8"))[key];
        return typeof value === typeof fallback ? value : fallback;
    } catch (_) {
        return fallback;
    }
};
const commandHistorySettings = () => {
    const enabled = readLauncherSetting("antiTheftCommandHistory", true) === true;
    return {enabled, strip: enabled && readLauncherSetting("stripCommandPasswords", true) === true};
};
// Папка игры из интерфейса — только корень игры или папка внутри него
const acceptedGameDirectory = (supplied) => {
    if (typeof supplied !== "string" || !path.isAbsolute(supplied)) return null;
    try {
        const root = fs.realpathSync(gameFileSafety.configuredRoot());
        const target = path.resolve(supplied);
        if (fs.existsSync(target)) {
            const real = fs.realpathSync(target);
            const relative = path.relative(root, real);
            if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(real).isDirectory()) return null;
            return real;
        }
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
        fs.mkdirSync(target, {recursive: true});
        return target;
    } catch (_) {
        return null;
    }
};
// Все папки игры лаунчера: общая, home/* и modpacks/*
const knownGameDirectories = () => {
    const root = gameFileSafety.configuredRoot();
    const result = [root];
    for (const kind of ["home", "modpacks"]) {
        try {
            for (const entry of fs.readdirSync(path.join(root, kind), {withFileTypes: true})) {
                if (entry.isDirectory()) result.push(path.join(root, kind, entry.name));
            }
        } catch (_) {}
    }
    return result;
};
const protectCommandHistoryEverywhere = async () => {
    const {enabled, strip} = commandHistorySettings();
    if (!enabled) return 0;
    let count = 0;
    for (const dir of knownGameDirectories()) {
        if (minecraftGameActive && commandHistoryDirectory && path.resolve(dir).toLowerCase() === path.resolve(commandHistoryDirectory).toLowerCase()) continue;
        if (!fs.existsSync(path.join(dir, "command_history.txt"))) continue;
        try {
            if ((await commandHistoryVault.protect(dir, {strip})).saved) count++;
        } catch (error) {
            console.log(`CommandHistory: protect failed [error=${error.message}]`);
        }
    }
    return count;
};
const finishCommandHistory = async () => {
    const dir = commandHistoryDirectory;
    if (!dir) return;
    commandHistoryDirectory = null;
    commandHistoryVault.unwatch(dir);
    const {enabled, strip} = commandHistorySettings();
    if (!enabled) return;
    // Игра только что закрылась — даём Windows отпустить файл
    await new Promise(resolve => setTimeout(resolve, 400));
    try {
        const result = await commandHistoryVault.protect(dir, {strip});
        console.log(`CommandHistory: hidden after game [saved=${result.saved}] [lines=${result.lines}]`);
    } catch (error) {
        console.log(`CommandHistory: protect after game failed [error=${error.message}]`);
    }
};
let installUpdateWhenGameCloses = false;
let forceWindowClose = false;
let secureUpdaterEnabled = false;
let verifiedUpdateReady = false;
const DEFAULT_USER_AGENT = "RxLauncher/v" + pjson.version;
const DISCORD_RPC_CLIENT_ID = process.env.RX_DISCORD_CLIENT_ID || "1531981667160555530";
const DISCORD_RPC_LARGE_IMAGE_KEY = process.env.RX_DISCORD_RPC_LARGE_IMAGE_KEY
    || "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v3.gif";
const DISCORD_RPC_TELEGRAM_URL = "https://t.me/rxlauncher";
const DISCORD_RPC_DISCORD_URL = "https://discord.gg/bpRwXsXeuj";
const DISCORD_RPC_RETRY_DELAY = 15000;
const DISCORD_RPC_MIN_UPDATE_INTERVAL = 4200;
const DISCORD_RPC_SMALL_IMAGE_KEYS = {
    vanilla: process.env.RX_DISCORD_RPC_SMALL_IMAGE_VANILLA || "",
    fabric: process.env.RX_DISCORD_RPC_SMALL_IMAGE_FABRIC || "",
    forge: process.env.RX_DISCORD_RPC_SMALL_IMAGE_FORGE || "",
    forgeOptiFine: process.env.RX_DISCORD_RPC_SMALL_IMAGE_FORGE || "",
    neoforge: process.env.RX_DISCORD_RPC_SMALL_IMAGE_NEOFORGE || "",
    quilt: process.env.RX_DISCORD_RPC_SMALL_IMAGE_QUILT || "",
    pack: process.env.RX_DISCORD_RPC_SMALL_IMAGE_PACK || ""
};
// Тексты статуса Discord: коротко и без эмодзи
const DISCORD_RPC_TEXTS = {
    ru: {
        menuDetails: "В лаунчере",
        menuState: "Выбирает, во что сыграть",
        menuStateNamed: "Профиль {nick}",
        gameDetails: "Играет в Minecraft",
        playingAs: "Играет за {nick}",
        inGame: "В игре",
        server: "Сервер {server}",
        imageText: "RxLaunch — лаунчер Minecraft",
        button: "Telegram RxLaunch",
        discordButton: "Discord RxLaunch"
    },
    en: {
        menuDetails: "In the launcher",
        menuState: "Choosing what to play",
        menuStateNamed: "Profile {nick}",
        gameDetails: "Playing Minecraft",
        playingAs: "Playing as {nick}",
        inGame: "In game",
        server: "Server {server}",
        imageText: "RxLaunch — Minecraft launcher",
        button: "RxLaunch on Telegram",
        discordButton: "RxLaunch on Discord"
    }
};

let discordRpcClient = null;
let discordRpcConnecting = null;
let discordRpcReady = false;
let discordRpcRetryTimer = null;
let discordPresenceRevision = 0;
let discordPresenceDelayCancel = null;
let discordRpcOperationQueue = Promise.resolve();
let discordPresenceMode = "main";
let discordMainNickname = "";
let discordMainStartTimestamp = new Date();
let discordGameStartTimestamp = null;
let discordCurrentGamePayload = {};
let discordLastPresence = null;
let discordLastPresenceSignature = "";
let discordLastPresenceUpdate = 0;
let discordRpcShuttingDown = false;
let discordExitInProgress = false;
let discordRpcSettings = {
    enabled: true,
    showNickname: true,
    showServer: true,
    showTime: true
};

const resolveLoaderDisplayName = (payload = {}) => {
    if (typeof payload.loaderDisplay === "string" && payload.loaderDisplay.trim().length > 0) {
        return payload.loaderDisplay.trim();
    }

    switch (payload.loaderType) {
        case "forge":
            return "Forge";
        case "forgeOptiFine":
            return "Forge + OptiFine";
        case "neoforge":
            return "NeoForge";
        case "fabric":
            return "Fabric";
        case "quilt":
            return "Quilt";
        case "custom":
            return "Custom";
        case "vanilla":
        default:
            return "Vanilla";
    }
};

const resolveLoaderAssetKey = (loaderType = "unknown") => {
    return DISCORD_RPC_SMALL_IMAGE_KEYS[loaderType] || "";
};

const normalizeDiscordSettings = (settings = {}) => ({
    enabled: settings.enabled !== false,
    showNickname: settings.showNickname !== false,
    showServer: settings.showServer !== false,
    showTime: settings.showTime !== false,
    language: settings.language === "en" ? "en" : "ru"
});

const discordText = (key, values = {}) => {
    const dict = DISCORD_RPC_TEXTS[discordRpcSettings.language] || DISCORD_RPC_TEXTS.ru;
    return dict[key].replace(/\{(\w+)}/g, (_, name) => String(values[name] ?? ""));
};

const sanitizeDiscordText = (value, maxLength = 128) => String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const sanitizeDiscordServer = (value) => {
    const server = sanitizeDiscordText(value, 80);
    if (!server || !/^[a-z0-9._:\[\]-]+$/i.test(server)) return "";
    return server;
};

const applyDiscordMainProfile = (payload = {}) => {
    if (Object.prototype.hasOwnProperty.call(payload, "nickname")) {
        discordMainNickname = sanitizeDiscordText(payload.nickname, 32);
    }
};

// Лаунчер:  «В лаунчере» / «Профиль Steve»
// Игра:     «Minecraft 1.21.1 · Fabric» / «Steve · mc.example.net» (или «Играет за Steve», «Сервер …», «В игре»)
const buildDiscordPresence = () => {
    const activity = {
        details: discordText("menuDetails"),
        state: discordText("menuState"),
        largeImageKey: DISCORD_RPC_LARGE_IMAGE_KEY,
        largeImageText: `${discordText("imageText")} · v${pjson.version}`,
        buttons: [
            {label: discordText("discordButton"), url: DISCORD_RPC_DISCORD_URL},
            {label: discordText("button"), url: DISCORD_RPC_TELEGRAM_URL}
        ],
        instance: false
    };

    if (discordPresenceMode === "game") {
        const game = discordCurrentGamePayload;
        const nickname = discordRpcSettings.showNickname ? sanitizeDiscordText(game.nickname, 32) : "";
        const server = discordRpcSettings.showServer ? sanitizeDiscordServer(game.server) : "";
        const loader = game.loaderType && game.loaderType !== "vanilla" ? resolveLoaderDisplayName(game) : "";

        activity.details = game.version
            ? [`Minecraft ${game.version}`, loader].filter(Boolean).join(" · ")
            : discordText("gameDetails");
        if (nickname && server) activity.state = `${nickname} · ${server}`;
        else if (nickname) activity.state = discordText("playingAs", {nick: nickname});
        else if (server) activity.state = discordText("server", {server});
        else activity.state = discordText("inGame");

        const smallImageKey = resolveLoaderAssetKey(game.loaderType);
        if (smallImageKey) {
            activity.smallImageKey = smallImageKey;
            activity.smallImageText = resolveLoaderDisplayName(game);
        }
        if (discordRpcSettings.showTime && discordGameStartTimestamp) {
            activity.startTimestamp = discordGameStartTimestamp;
        }
    } else {
        const nickname = discordRpcSettings.showNickname ? discordMainNickname : "";
        if (nickname) activity.state = discordText("menuStateNamed", {nick: nickname});
        if (discordRpcSettings.showTime) activity.startTimestamp = discordMainStartTimestamp;
    }

    activity.details = activity.details.slice(0, 128);
    activity.state = activity.state.slice(0, 128);
    return activity;
};

const clearDiscordRetry = () => {
    if (discordRpcRetryTimer) clearTimeout(discordRpcRetryTimer);
    discordRpcRetryTimer = null;
};

const interruptDiscordRateDelay = () => {
    if (discordPresenceDelayCancel) discordPresenceDelayCancel();
    discordPresenceDelayCancel = null;
};

const waitForDiscordRateLimit = async (force = false) => {
    if (force) return;
    const waitTime = DISCORD_RPC_MIN_UPDATE_INTERVAL - (Date.now() - discordLastPresenceUpdate);
    if (waitTime <= 0) return;
    await new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (discordPresenceDelayCancel === finish) discordPresenceDelayCancel = null;
            resolve();
        };
        const timer = setTimeout(finish, waitTime);
        discordPresenceDelayCancel = finish;
    });
};

const queueDiscordOperation = (operation) => {
    const queued = discordRpcOperationQueue.catch(() => false).then(operation);
    discordRpcOperationQueue = queued.catch(error => {
        console.warn(`Discord RPC operation failed: ${error.message}`);
        return false;
    });
    return queued;
};

const scheduleDiscordRetry = () => {
    if (discordRpcRetryTimer || discordRpcShuttingDown || !discordRpcSettings.enabled) return;
    discordRpcRetryTimer = setTimeout(() => {
        discordRpcRetryTimer = null;
        updateDiscordPresence(true).then();
    }, DISCORD_RPC_RETRY_DELAY);
};

const ensureDiscordRpcConnected = async () => {
    if (!discordRpcSettings.enabled || discordRpcShuttingDown) return false;
    if (discordRpcReady && discordRpcClient) return true;
    if (discordRpcConnecting) return discordRpcConnecting;

    discordRpcConnecting = (async () => {
        try {
            if (!discordRpcClient) {
                DiscordRPC.register(DISCORD_RPC_CLIENT_ID);
                const client = new DiscordRPC.Client({transport: "ipc"});
                discordRpcClient = client;
                client.on("ready", () => {
                    if (discordRpcClient !== client) return;
                    discordRpcReady = true;
                    clearDiscordRetry();
                    console.log("Discord RPC connected");
                });
                client.on("disconnected", () => {
                    if (discordRpcClient !== client) return;
                    discordRpcReady = false;
                    discordRpcClient = null;
                    console.log("Discord RPC disconnected");
                    scheduleDiscordRetry();
                });
            }

            await discordRpcClient.login({clientId: DISCORD_RPC_CLIENT_ID});
            discordRpcReady = true;
            clearDiscordRetry();
            return true;
        } catch (error) {
            discordRpcReady = false;
            const failedClient = discordRpcClient;
            discordRpcClient = null;
            if (failedClient) {
                failedClient.removeAllListeners();
                try { await failedClient.destroy(); } catch (_) {}
            }
            console.warn(`Discord RPC connection failed: ${error.message}`);
            scheduleDiscordRetry();
            return false;
        } finally {
            discordRpcConnecting = null;
        }
    })();
    return discordRpcConnecting;
};

const setDiscordGamePresence = async (payload = {}) => {
    discordPresenceMode = "game";
    discordGameStartTimestamp = new Date();
    const nickname = sanitizeDiscordText(payload.nickname || "Player", 32) || "Player";
    discordCurrentGamePayload = {
        nickname,
        server: sanitizeDiscordServer(payload.server),
        version: sanitizeDiscordText(payload.version, 24),
        loaderType: /^[a-z]+$/i.test(String(payload.loaderType || "")) ? payload.loaderType : "vanilla"
    };
    if (nickname !== "Player") discordMainNickname = nickname;
    return updateDiscordPresence();
};

const clearDiscordGamePresence = async () => {
    discordPresenceMode = "main";
    discordMainStartTimestamp = new Date();
    discordGameStartTimestamp = null;
    discordCurrentGamePayload = {};
    return updateDiscordPresence();
};

const updateDiscordPresence = (force = false) => {
    const revision = ++discordPresenceRevision;
    interruptDiscordRateDelay();
    return queueDiscordOperation(async () => {
        if (revision !== discordPresenceRevision || !discordRpcSettings.enabled || discordRpcShuttingDown) return false;
        await waitForDiscordRateLimit(force);
        if (revision !== discordPresenceRevision || !discordRpcSettings.enabled || discordRpcShuttingDown) return false;

        const isConnected = await ensureDiscordRpcConnected();
        if (!isConnected || !discordRpcClient) return false;
        if (revision !== discordPresenceRevision || !discordRpcSettings.enabled || discordRpcShuttingDown) return false;

        const activity = buildDiscordPresence();
        const signature = JSON.stringify(activity);
        if (!force && signature === discordLastPresenceSignature) return true;
        const client = discordRpcClient;
        try {
            await client.setActivity(activity);
            discordLastPresenceUpdate = Date.now();
            if (revision !== discordPresenceRevision || !discordRpcSettings.enabled || discordRpcShuttingDown) return false;
            discordLastPresence = activity;
            discordLastPresenceSignature = signature;
            return true;
        } catch (error) {
            if (discordRpcClient === client) {
                discordRpcClient = null;
                discordRpcReady = false;
            }
            client.removeAllListeners();
            try { await client.destroy(); } catch (_) {}
            console.warn(`Discord RPC update failed: ${error.message}`);
            scheduleDiscordRetry();
            return false;
        }
    });
};

const clearDiscordPresence = (disconnectClient = false) => {
    const revision = ++discordPresenceRevision;
    interruptDiscordRateDelay();
    clearDiscordRetry();
    discordLastPresence = null;
    discordLastPresenceSignature = "";
    return queueDiscordOperation(async () => {
        if (revision !== discordPresenceRevision && !discordRpcShuttingDown) return false;
        const client = discordRpcClient;
        if (!client) return true;
        let cleared = true;
        try {
            await client.clearActivity();
        } catch (_) {
            cleared = false;
        }
        if (disconnectClient && discordRpcClient === client) {
            discordRpcClient = null;
            discordRpcReady = false;
            client.removeAllListeners();
            try { await client.destroy(); } catch (_) {}
        }
        return cleared;
    });
};

const applyDiscordRpcSettings = async (settings = {}) => {
    applyDiscordMainProfile(settings);
    discordRpcSettings = normalizeDiscordSettings(settings);
    if (!discordRpcSettings.showServer) discordCurrentGamePayload.server = "";
    if (!discordRpcSettings.enabled) return clearDiscordPresence(true);
    return updateDiscordPresence();
};

const updateDiscordGamePresence = async (payload = {}) => {
    if (discordPresenceMode !== "game") return false;
    if (Object.prototype.hasOwnProperty.call(payload, "server")) {
        discordCurrentGamePayload.server = sanitizeDiscordServer(payload.server);
    }
    return updateDiscordPresence();
};

const shutdownDiscordRpc = async () => {
    discordRpcShuttingDown = true;
    await clearDiscordPresence(true);
};

const exitAfterDiscordShutdown = async () => {
    if (discordExitInProgress) return;
    discordExitInProgress = true;
    await Promise.race([
        shutdownDiscordRpc(),
        new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    console.log(colors.blue("Bye Bye"));
    app.exit(0);
};

app.on("before-quit", () => {
    forceWindowClose = true;
    if (gameTray) { gameTray.destroy(); gameTray = null; }
});

// Е-Е-Едем
console.log(colors.inverse("RxLauncher v" + pjson.version + " | Hostname: " + os.hostname() + " | <> by MaxRx"));

app.whenReady().then(() => {
    // История команд, оставшаяся в папках игры (игру закрыли без лаунчера или он упал), — в хранилище
    setTimeout(() => {
        protectCommandHistoryEverywhere()
            .then(count => { if (count) console.log(`CommandHistory: hidden on startup [count=${count}]`); })
            .catch(error => console.log(`CommandHistory: startup sweep failed [error=${error.message}]`));
    }, 3000);
    if (!isAppInDev) {
        console.log(colors.inverse("We are in production mode"));

        // Отключение клавиш для перезагрузки страницы
        app.on('browser-window-focus', function () {
            globalShortcut.register('Control+Shift+I', () => {
                return false;
            });
            globalShortcut.register("CommandOrControl+R", () => {
                return false;
            });
            globalShortcut.register("F5", () => {
                return false;
            });
        });

        app.on('browser-window-blur', function () {
            globalShortcut.unregister('CommandOrControl+R');
            globalShortcut.unregister('F5');
            globalShortcut.unregister('Control+Shift+I');
        });
    } else {
        console.log(colors.inverse("ooo|   Hello, developer   |ooo"));

        // Сброс времени запуска при перезагрузке страницы
        app.on('browser-window-focus', function () {
            globalShortcut.register("CommandOrControl+R", () => {
                startTime = performance.now();
                mainWindowObject.webContents.reloadIgnoringCache();
                return true;
            });
        });

        app.on('browser-window-blur', function () {
            globalShortcut.unregister('CommandOrControl+R');
        });
    }

    // Создаём главное окно
    const initialAvatarPaths = launcherBranding.resolveAvatarPaths(initialLauncherAvatarId);
    mainWindowObject = mainWindow.create({icon: initialAvatarPaths.pngPath}, function (winObj) {
        mainWindowObject = winObj;
        mainWindowObject.webContents.userAgent = DEFAULT_USER_AGENT;
        launcherBranding.applyBranding(mainWindowObject, initialLauncherAvatarId);

        // Фикс для Alt+F4
        mainWindowObject.on("close", (event) => {
            if (minecraftGameActive && !forceWindowClose) {
                event.preventDefault();
                hideLauncherWindow();
            }
        });

        mainWindowObject.on("closed", () => {
            mainWindowObject = null;
            exitAfterDiscordShutdown().then();
        })

        if (!isAppInDev && app.isPackaged) {
            assertSecureWindowsUpdater(autoUpdater, process.platform, pjson.rxlauncherTrustedUpdatePublisher)
                .then(({publisherNames}) => {
                    autoUpdater.verifyUpdateCodeSignature = createStrictWindowsSignatureVerifier(publisherNames);
                    secureUpdaterEnabled = true;
                    verifiedUpdateReady = false;
                    console.log(colors.green(`Secure updater enabled [publisher=${publisherNames.join(" | ")}]`));
                    return autoUpdater.checkForUpdates();
                })
                .catch((error) => {
                    secureUpdaterEnabled = false;
                    verifiedUpdateReady = false;
                    console.log(colors.red(`Secure update check blocked [${error.code || "UPDATE_ERROR"}]: ${error.message}`));
                });
        } else {
            console.log(colors.gray("Update check skipped outside packaged release"));
        }
        console.log(colors.green("Main window created"));
    });

    // Найдено обновление -> отправляем ipc
    autoUpdater.on("update-available", () => {
        if (!secureUpdaterEnabled) return;
        verifiedUpdateReady = false;
        console.log("Found an update, downloading...");
        mainWindowObject.webContents.send("update-available");
    });
    // Файл обновления скачан -> отправляем ipc
    autoUpdater.on("update-downloaded", () => {
        if (!secureUpdaterEnabled) {
            console.log(colors.red("Ignored downloaded update because signed updater validation is disabled"));
            return;
        }
        verifiedUpdateReady = true;
        console.log("Update download completed, waiting for restart");
        mainWindowObject.webContents.send("update-downloaded");
    });

    // Начать установку обновления
    autoUpdater.on("error", (error) => {
        verifiedUpdateReady = false;
        console.log(colors.red(`Updater error: ${error.message || String(error)}`));
    });
    autoUpdater.on("update-cancelled", () => {
        verifiedUpdateReady = false;
        console.log(colors.yellow("Update download was cancelled"));
    });

    onTrusted("install-update", (event) => {
        const trustedSender = mainWindowObject
            && !mainWindowObject.isDestroyed()
            && event.sender === mainWindowObject.webContents
            && event.senderFrame === mainWindowObject.webContents.mainFrame;
        if (!trustedSender) {
            console.log(colors.red("Blocked update installation request from an untrusted renderer"));
            return;
        }
        if (!secureUpdaterEnabled || !verifiedUpdateReady) {
            console.log(colors.red("Blocked update installation: no verified signed update is ready"));
            return;
        }
        if (minecraftGameActive) {
            installUpdateWhenGameCloses = true;
            console.log("Update installation deferred until Minecraft closes");
            if (mainWindowObject && !mainWindowObject.isDestroyed()) {
                mainWindowObject.webContents.send("update-install-deferred");
            }
            return;
        }
        console.log("Installing update...");
        forceWindowClose = true;
        autoUpdater.quitAndInstall();
    });

    // Получить userdataPath
    onTrusted("renderer-template", event => { event.returnValue = require("./rendererTemplate")(); });
    onTrusted("accounts-read", event => {
        try { event.returnValue = {ok: true, accounts: accountStore.read()}; }
        catch (error) { event.returnValue = {ok: false, error: error.message}; }
    });
    onTrusted("accounts-write", (event, accounts) => {
        try { accountStore.write(accounts); event.returnValue = {ok: true}; }
        catch (error) { event.returnValue = {ok: false, error: error.message}; }
    });
    onTrusted("get-userdata-path", (e) => {
        e.returnValue = userDataPath;
    });

    // Получить isInDev
    onTrusted("isAppInDev", (e) => {
        e.returnValue = isAppInDev;
    });

    // Получить isInTest
    onTrusted("isAppInTest", (e) => {
        e.returnValue = isAppInTest;
    });

    onTrusted("discord-rpc-game-start", (e, payload = {}) => {
        setDiscordGamePresence(payload).then();
    });

    onTrusted("discord-rpc-game-update", (e, payload = {}) => {
        updateDiscordGamePresence(payload).then();
    });

    onTrusted("discord-rpc-game-stop", () => {
        clearDiscordGamePresence().then();
    });

    onTrusted("discord-rpc-settings", (e, settings = {}) => {
        applyDiscordRpcSettings(settings).then();
    });

    onTrusted("game-process-state", (_event, payload = {}) => {
        const incomingPid = Number(payload.pid);
        if (payload.active === true && Number.isInteger(incomingPid) && incomingPid > 0) {
            minecraftGameActive = true;
            activeMinecraftPid = incomingPid;
            return;
        }
        if (payload.active !== false) return;
        if (activeMinecraftPid > 0 && incomingPid !== activeMinecraftPid) {
            console.log(colors.yellow(`Ignored stale Minecraft close state [activePid=${activeMinecraftPid}] [incomingPid=${incomingPid}]`));
            return;
        }
        minecraftGameActive = false;
        activeMinecraftPid = 0;
        finishCommandHistory().catch(() => {});
        if (installUpdateWhenGameCloses) {
            installUpdateWhenGameCloses = false;
            if (!secureUpdaterEnabled || !verifiedUpdateReady) {
                console.log(colors.red("Blocked deferred update installation: signed update is no longer ready"));
                return;
            }
            forceWindowClose = true;
            console.log("Minecraft closed, installing deferred update...");
            setTimeout(() => autoUpdater.quitAndInstall(), 350);
            return;
        }
        if (mainWindowObject && !mainWindowObject.isDestroyed() && !mainWindowObject.isVisible()) {
            showLauncherWindow();
        }
    });

    handleTrusted("discord-rpc-status", () => ({
        clientId: DISCORD_RPC_CLIENT_ID,
        ready: discordRpcReady,
        mode: discordPresenceMode,
        mainNickname: discordMainNickname,
        settings: {...discordRpcSettings},
        game: {...discordCurrentGamePayload},
        presence: discordLastPresence ? {...discordLastPresence} : null
    }));

    handleTrusted("server-status-query", (_event, address, force = false, options = {}) => (
        queryMinecraftServerStatus(address, force === true, options)
    ));

    handleTrusted("server-catalog-connectivity", () => checkServerCatalogConnectivity());
    handleTrusted("network-compatibility-check", () => checkOfficialNetworkConnectivity());

    handleTrusted("minecraft-skin-lookup", async (event, nickname) => {
        const trustedSender = mainWindowObject
            && !mainWindowObject.isDestroyed()
            && event.sender === mainWindowObject.webContents
            && event.senderFrame === mainWindowObject.webContents.mainFrame;
        if (!trustedSender) return {success: false, error: "untrusted_sender"};

        const result = await minecraftSkinService.lookupSkinSafe(nickname);
        if (!result.ok) {
            if (["not_found", "skin_not_set"].includes(result.error?.code)) {
                return {success: true, found: false};
            }
            return {
                success: false,
                error: normalizeMinecraftSkinError(result.error?.code, "unknown")
            };
        }
        minecraftSkinProfiles.set(result.profileId, result);
        if (minecraftSkinProfiles.size > 64) {
            minecraftSkinProfiles.delete(minecraftSkinProfiles.keys().next().value);
        }
        return {
            success: true,
            found: true,
            profile: {
                name: result.nickname,
                id: result.profileId,
                model: result.model,
                skinPath: result.texturePath,
                fromCache: result.source === "cache" || result.stale === true,
                updatedAt: result.cachedAt
            }
        };
    });

    handleTrusted("minecraft-skin-export", async (event, payload = {}) => {
        const trustedSender = mainWindowObject
            && !mainWindowObject.isDestroyed()
            && event.sender === mainWindowObject.webContents
            && event.senderFrame === mainWindowObject.webContents.mainFrame;
        if (!trustedSender) return {success: false, error: "untrusted_sender"};
        const profile = resolveSkinProfile(payload);
        if (!profile) return {success: false, error: "cache_miss"};

        const safeName = String(profile.nickname || "minecraft-skin").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "minecraft-skin";
        const dialogCopy = MINECRAFT_SKIN_EXPORT_COPY[String(payload.language || "").toLowerCase()]
            || MINECRAFT_SKIN_EXPORT_COPY.ru;
        const saveResult = await dialog.showSaveDialog(mainWindowObject, {
            title: dialogCopy.title,
            defaultPath: `${safeName}.png`,
            filters: [{name: dialogCopy.filter, extensions: ["png"]}],
            properties: ["showOverwriteConfirmation", "dontAddToRecent"]
        });
        if (saveResult.canceled || !saveResult.filePath) return {success: false, canceled: true};
        const exported = await minecraftSkinService.exportTextureSafe(profile.textureHash, saveResult.filePath, {overwrite: true});
        return exported.ok
            ? {success: true, path: exported.path}
            : {success: false, error: normalizeMinecraftSkinError(exported.error?.code, "export_failed")};
    });

    handleTrusted("minecraft-skin-apply", async (event, payload = {}) => {
        const trustedSender = mainWindowObject
            && !mainWindowObject.isDestroyed()
            && event.sender === mainWindowObject.webContents
            && event.senderFrame === mainWindowObject.webContents.mainFrame;
        if (!trustedSender) return {success: false, error: "untrusted_sender"};
        const profile = resolveSkinProfile(payload);
        if (!profile) return {success: false, error: "cache_miss"};
        // accounts.json is shared by every local profile. Serialising writes
        // prevents two rapid Apply clicks from racing or losing metadata.
        const applyTask = minecraftSkinApplyQueue
            .catch(() => undefined)
            .then(() => writeAccountLauncherSkin(payload.accountUuid, profile));
        minecraftSkinApplyQueue = applyTask.catch(() => undefined);
        return applyTask;
    });

    // Запуск лаунчера завершён
    onTrusted("launcher-ready", (e, settings = {}) => {
        applyDiscordMainProfile(settings);
        discordRpcSettings = normalizeDiscordSettings(settings);
        if (discordRpcSettings.enabled) {
            clearDiscordGamePresence().then();
        } else {
            clearDiscordPresence(true).then();
        }
        let endTime = performance.now();
        console.log("Launcher started in", colors.yellow(((endTime - startTime) / 1000).toFixed(3) + "s"));
    });

    // Закрыть окно лаунчера
    onTrusted("close-main-window", () => {
        if (mainWindowObject && !mainWindowObject.isDestroyed()) {
            mainWindowObject.close();
        } else {
            exitAfterDiscordShutdown().then();
        }
    });

    // Свернуть окно лаунчера
    onTrusted("hide-main-window", () => {
        mainWindowObject.minimize();
    });

    // Перезагрузить окно лаунчера
    onTrusted("reload-main-window", () => {
        mainWindowObject.webContents.reload();
    });

    // Развернуть на весь экран окно лаунчера
    onTrusted("maximize-main-window", () => {
        if (mainWindowObject.isMaximized()) {
            mainWindowObject.unmaximize();
        } else {
            mainWindowObject.maximize();
        }
    });

    // Полностью скрыть окно лаунчера
    onTrusted("disappear-main-window", () => {
        hideLauncherWindow();
    });

    // Показать окно лаунчера
    onTrusted("appear-main-window", () => {
        showLauncherWindow();
    });

    // Фикс для сраного Электрона?
    onTrusted("focus-fix", () => {
        mainWindowObject.blur();
        mainWindowObject.focus();
    });

    // ===== Скриншоты: только картинки внутри папок screenshots =====
    const screenshotThumbs = new Map();

    handleTrusted("screenshot-thumbnail", async (event, file) => {
        file = gameFileSafety.screenshot(file);
        if (!file) return "";
        try {
            const key = `${file}|${fs.statSync(file).mtimeMs}`;
            if (screenshotThumbs.has(key)) return screenshotThumbs.get(key);
            const image = nativeImage.createFromPath(file);
            if (image.isEmpty()) return "";
            const thumb = `data:image/jpeg;base64,${image.resize({width: 384, quality: "good"}).toJPEG(78).toString("base64")}`;
            screenshotThumbs.set(key, thumb);
            // Кэш не растёт бесконечно
            if (screenshotThumbs.size > 400) screenshotThumbs.delete(screenshotThumbs.keys().next().value);
            return thumb;
        } catch (_) {
            return "";
        }
    });

    handleTrusted("screenshot-action", async (event, payload = {}) => {
        const file = gameFileSafety.screenshot(payload.file);
        if (!file) return false;
        try {
            switch (payload.action) {
                case "copy":
                    clipboard.writeImage(nativeImage.createFromPath(file));
                    return true;
                case "reveal":
                    shell.showItemInFolder(file);
                    return true;
                case "delete":
                    await shell.trashItem(file);
                    return true;
                default:
                    return false;
            }
        } catch (_) { return false; }
    });

    // Сборка → в корзину. Только папка modpacks/<id> с manifest.json
    handleTrusted("trash-instance-folder", async (event, payload = {}) => {
        const target = gameFileSafety.folder(payload.root, "modpacks", payload.id, "manifest.json");
        if (!target) return false;
        await shell.trashItem(target);
        return true;
    });

    // Своя версия → в корзину. Только папка версии с манифестом внутри versions/
    handleTrusted("trash-version-folder", async (event, payload = {}) => {
        const target = gameFileSafety.folder(payload.root, "versions", payload.name, `${payload.name}.json`);
        if (!target) return false;
        await shell.trashItem(target);
        return true;
    });

    // Диалог открытия файлов
    handleTrusted("open-dialog", async (event, options) => {
        let result = await dialog.showOpenDialog(options);
        if (result.canceled === true) {
            return false;
        }
        return result.filePaths || result.filePath;
    });

    // Диалог сохранения файлов
    handleTrusted("save-dialog", async (event, options) => {
        let result = await dialog.showSaveDialog(options);
        if (result.canceled === true) {
            return false;
        }
        return result.filePath;
    });

    // Токен аккаунта RxLauncher: без safeStorage хранится только до закрытия лаунчера
    let rxAccountTokenInMemory = "";
    handleTrusted("rx-account-token", (_event, payload = {}) => {
        if (payload?.action === "set") {
            const token = typeof payload.token === "string" && /^rx1_[A-Za-z0-9_-]{43}$/.test(payload.token) ? payload.token : "";
            if (!token) return false;
            rxAccountTokenInMemory = token;
            if (!safeStorage.isEncryptionAvailable()) return true;
            try {
                fs.writeFileSync(rxAccountTokenPath, safeStorage.encryptString(token), {mode: 0o600});
            } catch (error) {
                console.warn(`RxAccount: token save failed [error=${error.message}]`);
            }
            return true;
        }
        if (payload?.action === "clear") {
            rxAccountTokenInMemory = "";
            try { fs.rmSync(rxAccountTokenPath, {force: true}); } catch (_) {}
            return true;
        }
        if (rxAccountTokenInMemory) return rxAccountTokenInMemory;
        if (!fs.existsSync(rxAccountTokenPath) || !safeStorage.isEncryptionAvailable()) return "";
        try {
            return rxAccountTokenInMemory = safeStorage.decryptString(fs.readFileSync(rxAccountTokenPath)).trim();
        } catch (_) {
            return "";
        }
    });

    handleTrusted("curseforge-key-status", () => ({
        configured: readCurseForgeApiKey().length > 0,
        managedByEnvironment: (process.env.RX_CURSEFORGE_API_KEY || "").trim().length > 0,
        secureStorageAvailable: safeStorage.isEncryptionAvailable()
    }));

    handleTrusted("set-curseforge-api-key", async (_event, rawKey) => {
        const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
        if (apiKey.length < 16 || apiKey.length > 512) {
            return {success: false, error: "invalid_key_format"};
        }
        if (!safeStorage.isEncryptionAvailable()) {
            return {success: false, error: "secure_storage_unavailable"};
        }

        const validation = await curseForgeApiRequest(apiKey, "/v1/games/432");
        if (!validation.success) {
            return {success: false, error: validation.status === 401 || validation.status === 403 ? "invalid_key" : validation.error};
        }

        try {
            fs.writeFileSync(curseForgeKeyPath, safeStorage.encryptString(apiKey));
            return {success: true};
        } catch (error) {
            return {success: false, error: error.message};
        }
    });

    handleTrusted("clear-curseforge-api-key", () => {
        if ((process.env.RX_CURSEFORGE_API_KEY || "").trim()) {
            return {success: false, error: "managed_by_environment"};
        }
        try {
            if (fs.existsSync(curseForgeKeyPath)) fs.unlinkSync(curseForgeKeyPath);
            return {success: true};
        } catch (error) {
            return {success: false, error: error.message};
        }
    });

    handleTrusted("curseforge-request", async (_event, payload = {}) => {
        const endpoint = typeof payload.endpoint === "string" ? payload.endpoint : "";
        const method = payload.method === "POST" ? "POST" : "GET";
        const body = method === "POST" && payload.body && typeof payload.body === "object" ? payload.body : null;
        return curseForgeApiRequest(readCurseForgeApiKey(), endpoint, payload.query, method, body);
    });

    // Получить конфиг для MCLC
    // Перед запуском: вернуть историю команд в папку игры и следить, чтобы в неё не попадали пароли
    handleTrusted("command-history-prepare", async (_event, payload = {}) => {
        const dir = acceptedGameDirectory(payload?.gameDirectory);
        if (!dir) return false;
        if (commandHistoryDirectory && commandHistoryDirectory !== dir) commandHistoryVault.unwatch(commandHistoryDirectory);
        commandHistoryDirectory = dir;
        const {strip} = commandHistorySettings();
        try {
            const result = await commandHistoryVault.restore(dir, {strip});
            if (strip) commandHistoryVault.watch(dir);
            console.log(`CommandHistory: ready for game [restored=${result.restored}] [lines=${result.lines}] [strip=${strip}]`);
            return true;
        } catch (error) {
            console.log(`CommandHistory: restore failed [error=${error.message}]`);
            return false;
        }
    });

    // Переключили «Анти-кражу»: спрятать все истории сейчас или вернуть их по местам
    handleTrusted("command-history-setting", async () => {
        if (commandHistorySettings().enabled) return {hidden: await protectCommandHistoryEverywhere()};
        commandHistoryVault.unwatchAll();
        return {released: await commandHistoryVault.releaseAll()};
    });

    handleTrusted("generate-mclc-config", async (_event, data) => {
        const type = data?.type;
        const version = data?.version;
        const gameData = data?.gameData;
        const validVersion = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(value);
        const root = gameFileSafety.configuredRoot();
        const allowedRoot = path.resolve(root);
        const allowedHome = typeof gameData === "string" && validVersion(version)
            && path.resolve(gameData) === path.join(allowedRoot, "home", `${type}-${version}`);
        if (!["vanilla", "custom", "forge", "forgeOptiFine", "neoforge", "fabric", "quilt"].includes(type)
            || !validVersion(version) || (data?.loaderVersion && !validVersion(data.loaderVersion))
            || typeof gameData !== "string" || !path.isAbsolute(gameData)
            || (path.resolve(gameData).toLowerCase() !== allowedRoot.toLowerCase() && !allowedHome)) {
            return false;
        }

        if (type === "vanilla") {
            return {
                version: {
                    type: "release",
                    number: version,
                },
                root: gameData
            };
        }

        if (type === "custom") return buildCustomMclcConfig(version, gameData);
        if (data.loaderVersion) {
            try { return await require("./pinnedLoader").getPinnedLoaderConfig(data); }
            catch (error) {
                console.warn("Pinned loader setup failed:", error.message);
                return false;
            }
        }

        const loaders = {forge, forgeOptiFine: forge, neoforge, fabric, quilt};
        const loader = loaders[type];
        if (!loader) return false;

        // Если версия уже установлена — при недоступной сети запускаем её с диска
        const localConfig = buildLocalMclcConfig(type, version, gameData);
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Loader metadata timeout")), localConfig ? 8000 : 90000);
        });
        try {
            return await Promise.race([Promise.resolve().then(() => loader.getMCLCLaunchConfig({gameVersion: version, rootPath: gameData})), timeout]);
        } catch (error) {
            console.warn(`MCLC config: ${type}-${version} online setup failed (${error?.message || error}), local=${Boolean(localConfig)}`);
            return localConfig || false;
        } finally {
            clearTimeout(timer);
        }
    })
});
