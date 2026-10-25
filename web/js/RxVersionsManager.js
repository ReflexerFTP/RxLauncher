let fullListPerformance1, fullListPerformance2;
let manifestData = false;
let optiFineManifestPromise = false;

const OPTIFINE_OFFICIAL_ORIGIN = "https://optifine.net";
const OPTIFINE_DOWNLOADS_URL = `${OPTIFINE_OFFICIAL_ORIGIN}/downloads`;
const OPTIFINE_REQUEST_TIMEOUT = 3200;

class RxVersionsManager {
    // Получить все ванильные доступные версии
    static getVanillaVersionsAvailable = async (alllowedType = ["release"]) => {
        const allowedVersionTypes = ["release", "snapshot", "old_beta", "old_alpha"];
        alllowedType = alllowedType || ["release"];

        // Проверяем переменную allowedType
        if (!Array.isArray(alllowedType)) {
            return false;
        }
        if (!allowedVersionTypes.some(v => alllowedType.includes(v))) {
            return false;
        }

        // Делаем вещи
        let result = [];
        let manifest = await vanilla.getVersionManifest();
        manifest.versions.forEach((versionItem) => {
            if (alllowedType.includes(versionItem.type)) {
                result.push(versionItem.id);
            }
        });
        return result;
    }

    // Получить все доступные версии Fabric
    static getFabricVersionsAvailable = async () => {
        let result = [];
        let manifest = await fabric.listSupportedVersions();
        manifest.forEach((versionItem) => {
            if (versionItem.stable === true) {
                result.push(versionItem.version);
            }
        });
        return result;
    }

    // Получить все доступные версии Quilt
    static getQuiltVersionsAvailable = async () => {
        let result = [];
        let manifest = await quilt.listSupportedVersions();
        manifest.forEach((versionItem) => {
            if (versionItem.stable === true) {
                result.push(versionItem.version);
            }
        });
        return result;
    }

    // Получить все доступные версии Forge
    static getForgeVersionsAvailable = async () => {
        let result = [];
        let manifest = await forge.listSupportedVersions();
        manifest.forEach((versionItem) => {
            if (versionItem.stable === true) {
                result.push(versionItem.version);
            }
        });
        return result;
    }

    // Получить все доступные версии NeoForge
    static getNeoForgeVersionsAvailable = async () => {
        let result = [];
        let manifest = await neoforge.listSupportedVersions();
        manifest.forEach((versionItem) => {
            if (versionItem.stable === true) {
                result.push(versionItem.version);
            }
        });
        return result;
    }

    // Получить все доступные версии ForgeOptiFine
    static getOptiFineVersionsAvailable = async () => {
        const manifest = await RxVersionsManager.getOptiFineManifest();
        return Object.keys(manifest?.optifine || {});
    }

    static getOptiFineFallbackPaths = () => {
        const candidates = [];

        try {
            const appRoot = path.dirname(require.resolve("./../package.json"));
            candidates.push(path.join(appRoot, "web", "assets", "data", "optifine-fallback.json"));
        } catch (_) {}

        if (typeof __dirname === "string") {
            candidates.push(path.join(__dirname, "assets", "data", "optifine-fallback.json"));
            candidates.push(path.join(__dirname, "web", "assets", "data", "optifine-fallback.json"));
        }

        if (typeof process !== "undefined" && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, "app.asar", "web", "assets", "data", "optifine-fallback.json"));
            candidates.push(path.join(process.resourcesPath, "app", "web", "assets", "data", "optifine-fallback.json"));
        }

        if (typeof process !== "undefined" && typeof process.cwd === "function") {
            candidates.push(path.join(process.cwd(), "web", "assets", "data", "optifine-fallback.json"));
        }

        return [...new Set(candidates)];
    }

    static normalizeOptiFineEntry = (version, entry) => {
        if (!entry || typeof version !== "string") return false;

        let file = typeof entry === "string" ? "" : String(entry.file || "").trim();
        if (!file && typeof entry === "string") {
            try {
                file = path.basename(new URL(entry).pathname);
            } catch (_) {
                file = path.basename(entry);
            }
        }

        let decodedFile = file;
        try {
            decodedFile = decodeURIComponent(file);
        } catch (_) {}

        if (
            path.basename(decodedFile) !== decodedFile ||
            !/^OptiFine_[A-Za-z0-9._-]+\.jar$/.test(decodedFile) ||
            !decodedFile.startsWith(`OptiFine_${version}_`)
        ) {
            return false;
        }

        const forge = typeof entry === "object" ? String(entry.forge || "").replace(/^#/, "") : "";
        return {
            file: decodedFile,
            forge,
            page: `${OPTIFINE_OFFICIAL_ORIGIN}/adloadx?f=${encodeURIComponent(decodedFile)}`,
            official: true
        };
    }

    static loadOptiFineFallback = () => {
        for (const fallbackPath of RxVersionsManager.getOptiFineFallbackPaths()) {
            try {
                if (!fs.existsSync(fallbackPath)) continue;
                const parsed = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
                const sourceEntries = parsed?.optifine || parsed;
                const optifine = {};

                for (const [version, entry] of Object.entries(sourceEntries || {})) {
                    const normalized = RxVersionsManager.normalizeOptiFineEntry(version, entry);
                    if (normalized) optifine[version] = normalized;
                }

                if (Object.keys(optifine).length > 0) {
                    return {
                        source: OPTIFINE_DOWNLOADS_URL,
                        fallbackPath,
                        optifine
                    };
                }
            } catch (error) {
                RxCollector.writeLog(`OF: Failed to read fallback manifest [error=${error.message}]`);
            }
        }

        RxCollector.writeLog(`OF: Local fallback manifest not found`);
        return {source: OPTIFINE_DOWNLOADS_URL, optifine: {}};
    }

    static isOfficialOptiFineUrl = (value, allowedPaths = []) => {
        try {
            const parsed = new URL(value);
            const hostname = parsed.hostname.toLowerCase();
            if (parsed.protocol !== "https:" || (hostname !== "optifine.net" && hostname !== "www.optifine.net")) {
                return false;
            }
            return allowedPaths.length === 0 || allowedPaths.includes(parsed.pathname);
        } catch (_) {
            return false;
        }
    }

    static requestOptiFinePage = (url) => {
        const allowedPaths = ["/downloads", "/adloadx"];
        if (!RxVersionsManager.isOfficialOptiFineUrl(url, allowedPaths)) {
            return Promise.resolve(false);
        }

        return RxHttp.text(url, {
            timeout: OPTIFINE_REQUEST_TIMEOUT,
            redirects: 3,
            headers: {"Accept": "text/html,application/xhtml+xml"}
        }).then(response => (
            response.ok && RxVersionsManager.isOfficialOptiFineUrl(response.url, allowedPaths) ? response.body : false
        )).catch(() => false);
    }

    static parseOptiFineDownloadsPage = (html) => {
        const optifine = {};
        if (typeof html !== "string" || html.length === 0) return optifine;

        const headings = [...html.matchAll(/<h2>\s*Minecraft\s+([^<]+?)\s*<\/h2>/gi)];
        for (let index = 0; index < headings.length; index++) {
            const version = headings[index][1].trim();
            if (!/^\d+(?:\.\d+){1,3}$/.test(version)) continue;

            const sectionStart = headings[index].index + headings[index][0].length;
            const sectionEnd = headings[index + 1]?.index ?? html.length;
            const section = html.slice(sectionStart, sectionEnd);
            const rowMatcher = /<tr\b[^>]*class=["'][^"']*\bdownloadLineMain\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
            let rowMatch;

            while ((rowMatch = rowMatcher.exec(section)) !== null) {
                const row = rowMatch[1];
                const forgeMatch = row.match(/class=["']colForge["'][^>]*>\s*Forge\s+([^<]+)/i);
                if (!forgeMatch || /^\s*N\/A\s*$/i.test(forgeMatch[1])) continue;

                const fileMatch = row.match(/adloadx\?f=([^&"'<>]+\.jar)/i);
                if (!fileMatch) continue;

                let file = fileMatch[1].replaceAll("&amp;", "&");
                try {
                    file = decodeURIComponent(file);
                } catch (_) {}

                const normalized = RxVersionsManager.normalizeOptiFineEntry(version, {
                    file,
                    forge: forgeMatch[1].replace(/<[^>]*>/g, "").trim()
                });
                if (normalized) {
                    optifine[version] = normalized;
                    break;
                }
            }
        }

        return optifine;
    }

    static getOptiFineManifest = async (refresh = false) => {
        if (!refresh && manifestData?.optifine) return manifestData;
        if (!refresh && optiFineManifestPromise) return optiFineManifestPromise;

        const fallback = RxVersionsManager.loadOptiFineFallback();
        manifestData = fallback;

        optiFineManifestPromise = (async () => {
            const html = await RxVersionsManager.requestOptiFinePage(OPTIFINE_DOWNLOADS_URL);
            if (!html) {
                RxCollector.writeLog(`OF: Official versions page unavailable, using local fallback`);
                return manifestData;
            }

            const officialEntries = RxVersionsManager.parseOptiFineDownloadsPage(html);
            if (Object.keys(officialEntries).length === 0) {
                RxCollector.writeLog(`OF: Official versions page returned no compatible stable releases, using local fallback`);
                return manifestData;
            }

            manifestData = {
                source: OPTIFINE_DOWNLOADS_URL,
                fallbackPath: fallback.fallbackPath,
                updatedFromOfficial: true,
                optifine: {...fallback.optifine, ...officialEntries}
            };
            return manifestData;
        })();

        try {
            return await optiFineManifestPromise;
        } finally {
            optiFineManifestPromise = false;
        }
    }

    static getCachedOptiFineEntry = (version) => {
        if (!manifestData?.optifine) manifestData = RxVersionsManager.loadOptiFineFallback();
        return RxVersionsManager.normalizeOptiFineEntry(version, manifestData.optifine?.[version]);
    }

    static getOptiFineEntry = async (version) => {
        await RxVersionsManager.getOptiFineManifest();
        return RxVersionsManager.getCachedOptiFineEntry(version);
    }

    static resolveOptiFineDownload = async (version) => {
        const entry = await RxVersionsManager.getOptiFineEntry(version);
        if (!entry) return false;

        const html = await RxVersionsManager.requestOptiFinePage(entry.page);
        if (!html) return false;

        const linkMatcher = /href\s*=\s*["']([^"']*downloadx\?[^"']+)["']/gi;
        let linkMatch;
        while ((linkMatch = linkMatcher.exec(html)) !== null) {
            const rawLink = linkMatch[1].replaceAll("&amp;", "&");
            let resolved;
            try {
                resolved = new URL(rawLink, `${OPTIFINE_OFFICIAL_ORIGIN}/`);
            } catch (_) {
                continue;
            }

            if (
                !RxVersionsManager.isOfficialOptiFineUrl(resolved.href, ["/downloadx"]) ||
                resolved.searchParams.get("f") !== entry.file ||
                !/^[a-z0-9]{8,128}$/i.test(resolved.searchParams.get("x") || "")
            ) {
                continue;
            }

            return {...entry, url: resolved.href};
        }

        return false;
    }

    // Получить все доступные версии игры всех загрузчиков
    static getAllVersionsAvailable = async (vanillaVersionsType = ["release"]) => {
        try {
            // Запускаем все асинхронные операции параллельно
            const results = await Promise.allSettled([
                RxUtils.promiseWithTimeout(RxVersionsManager.getVanillaVersionsAvailable(vanillaVersionsType)),
                RxUtils.promiseWithTimeout(RxVersionsManager.getFabricVersionsAvailable()),
                RxUtils.promiseWithTimeout(RxVersionsManager.getForgeVersionsAvailable()),
                RxUtils.promiseWithTimeout(RxVersionsManager.getNeoForgeVersionsAvailable()),
                RxUtils.promiseWithTimeout(RxVersionsManager.getQuiltVersionsAvailable()),
                RxUtils.promiseWithTimeout(RxVersionsManager.getOptiFineVersionsAvailable()),
            ]);

            // Собираем результаты
            const [
                vanillaVersions,
                fabricVersions,
                forgeVersions,
                neoforgeVersions,
                quiltVersions,
                forgeOptiFineVersions,
            ] = results.map((result) => (result.status === 'fulfilled' ? result.value : []));

            // Возвращаем
            return {
                vanilla: vanillaVersions,
                fabric: fabricVersions,
                forge: forgeVersions,
                neoforge: neoforgeVersions,
                quilt: quiltVersions,
                forgeOptiFine: forgeOptiFineVersions,
            };
        } catch (error) {
            // Если что-то очень сильно пошло не так :)
            console.error('Unexpected error:', error);
            return {
                vanilla: [],
                fabric: [],
                forge: [],
                neoforge: [],
                quilt: [],
                forgeOptiFine: [],
            };
        }
    };

    // Получить список установленных версий
    static getInstalledVersionsList = () => {
        const result = new Set();
        const readDirs = (dirPath) => {
            try {
                return fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
            } catch (_) {
                return [];
            }
        };
        readDirs(path.join(GAME_DATA, "versions")).forEach(name => result.add(name));
        // Версии с полностью раздельным хранилищем лежат в home/<тип>-<версия>
        readDirs(path.join(GAME_DATA, "home")).forEach(name => {
            if (readDirs(path.join(GAME_DATA, "home", name, "versions")).length > 0) result.add(name);
        });
        return [...result];
    }

    static LOADER_TYPES = ["fabric", "forge", "forgeOptiFine", "neoforge", "quilt"];

    // Папка установки в versions/: ForgeOptiFine запускается на обычном Forge
    static installFolderFor = (type, version) => type === "forgeOptiFine" ? `forge-${version}` : `${type}-${version}`;

    // Установленные версии в формате списка UI (работает без интернета)
    static getInstalledVersionEntries = () => {
        const entries = [];
        RxVersionsManager.getInstalledVersionsList().forEach(name => {
            const dash = name.indexOf("-");
            const prefix = dash > 0 ? name.slice(0, dash) : "";
            const isLoader = RxVersionsManager.LOADER_TYPES.includes(prefix) && /^\d/.test(name.slice(dash + 1));

            // Свои версии (OptiFine, fabric-loader-…, импортированные)
            if (!isLoader && typeof RxCustomVersions !== "undefined" && RxCustomVersions.isCustomFolder(name)) {
                const info = RxCustomVersions.getInfo(name);
                entries.push({
                    id: `custom-${name}`,
                    version: info.baseVersion,
                    type: "custom",
                    displayName: name,
                    installed: true,
                    releaseTime: info.releaseTime
                });
                return;
            }

            const type = isLoader ? prefix : "vanilla";
            const version = isLoader ? name.slice(dash + 1) : name;
            if (!/^\d+\.\d+/.test(version)) return;
            // Чистая папка vanilla без манифеста — недокачанная версия
            if (!isLoader && !fs.existsSync(path.join(GAME_DATA, "versions", name, `${name}.json`))) return;
            const id = `${type}-${version}`;
            entries.push({
                id,
                version,
                type,
                displayName: RxVersionsManager.versionToDisplayName(id),
                installed: true
            });
        });
        return entries.sort((a, b) => RxVersionsManager.compareGameVersions(b.version, a.version));
    }

    static compareGameVersions = (left, right) => {
        const a = String(left).split(/[.\-]/).map(part => parseInt(part, 10) || 0);
        const b = String(right).split(/[.\-]/).map(part => parseInt(part, 10) || 0);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
        }
        return 0;
    }

    // Последний удачный онлайн-список версий — на случай, если сеть пропадёт
    static getVersionsCachePath = () => path.join(GAME_DATA, "cache", "rxlauncher-versions.json");

    static mergeWithVersionsCache = (result) => {
        let cache = {};
        try {
            cache = JSON.parse(fs.readFileSync(RxVersionsManager.getVersionsCachePath(), "utf8"));
        } catch (_) {}

        let hasFreshData = false;
        const merged = {};
        Object.keys(result).forEach(key => {
            const online = Array.isArray(result[key]) ? result[key] : [];
            if (online.length > 0) {
                hasFreshData = true;
                merged[key] = online;
            } else {
                merged[key] = Array.isArray(cache[key]) ? cache[key] : [];
            }
        });

        if (hasFreshData) {
            try {
                fs.mkdirSync(path.dirname(RxVersionsManager.getVersionsCachePath()), {recursive: true});
                fs.writeFileSync(RxVersionsManager.getVersionsCachePath(), JSON.stringify(merged));
            } catch (error) {
                RxCollector.writeLog(`VersionManager: Could not save versions cache [error=${error}]`);
            }
        }
        return {versions: merged, offline: result.vanilla.length === 0};
    }

    // Получить избранные версии
    static getFavoriteVersions = () => {
        return RxConfig.read("favoriteVersions", []);
    }

    // Добавить/удалить версию из избранного
    static addOrRemoveFavorite = (versionId) => {
        let favorites = RxVersionsManager.getFavoriteVersions();
        if (favorites.includes(versionId)) {
            favorites.splice(favorites.indexOf(versionId), 1);
        } else {
            favorites.push(versionId);
        }
        return RxConfig.write("favoriteVersions", favorites);
    }

    // Получить полностью подготовленный для UI список версий
    static getPreparedVersions = async () => {
        fullListPerformance1 = performance.now();
        RxCollector.writeLog(`VersionManager: Preparing full versions list`);
        let resultList = [];
        let installedVersions = RxVersionsManager.getInstalledVersionsList();

        let vanillaVersionsType = RxVersionsUI.getVersionsTypeSelected();

        let modpacksList = RxPacks.getPacksList();
        if (modpacksList.length > 0) {
            modpacksList.forEach((pack) => {
                let packData = RxPacks.getModpackManifest(pack);
                resultList.push({
                    id: "pack-" + packData.id,
                    version: packData.baseVersion,
                    type: "pack",
                    displayName: packData.displayName,
                    installed: true
                })
            })
        }

        const merged = RxVersionsManager.mergeWithVersionsCache(await RxVersionsManager.getAllVersionsAvailable(vanillaVersionsType));
        const result = merged.versions;
        RxVersionsManager.lastListOffline = merged.offline;
        // Обработка каждого из видов
        result.vanilla.forEach((item) => {
            // Добавляем ванильную версию
            let vanillaId = `vanilla-${item}`;
            resultList.push({
                id: vanillaId,
                version: item,
                type: "vanilla",
                displayName: RxVersionsManager.versionToDisplayName(vanillaId),
                installed: installedVersions.includes(item)
            })

            // Ищем все остальные совпадающие версии и добавляем в список
            Object.keys(result).forEach(key => {
                if (result[key].includes(item) && key !== "vanilla") {
                    let verId = `${key}-${item}`;
                    resultList.push({
                        id: verId,
                        version: item,
                        type: key,
                        displayName: RxVersionsManager.versionToDisplayName(verId),
                        installed: installedVersions.includes(RxVersionsManager.installFolderFor(key, item))
                    })
                }
            });
        })

        // Установленные версии показываем всегда, даже если сервер их не вернул
        const listedIds = new Set(resultList.map(item => item.id));
        RxVersionsManager.getInstalledVersionEntries().forEach(entry => {
            if (!listedIds.has(entry.id)) resultList.push(entry);
        });

        fullListPerformance2 = performance.now();
        RxCollector.writeLog(`VersionManager: Full list ready in ${fullListPerformance2 - fullListPerformance1} ms`);
        // Возвращаем готовый список
        return resultList;
    };

    // Перевести ID версии в её название
    static versionToDisplayName = (version = null) => {
        if (version === null) {
            version = RxVersionsManager.getActiveVersion();
        }

        // Например: forge-1.16.5
        let parsed = RxVersionsManager.parseVersionID(version);

        let displayType;
        switch (parsed.type) {
            case "forge":
                displayType = "Forge";
                break;
            case "forgeOptiFine":
                displayType = "ForgeOptiFine";
                break;
            case "neoforge":
                displayType = "NeoForge";
                break;
            case "fabric":
                displayType = "Fabric";
                break;
            case "quilt":
                displayType = "Quilt";
                break;
            case "pack":
                let packData = RxPacks.getModpackManifest(parsed.name);
                return `${MESSAGES.versions.pack} ${packData.displayName}`;
            case "custom":
                return parsed.name;
            default:
                displayType = MESSAGES.commons.version;
                break;
        }

        return `${displayType} ${parsed.name}`;
    }

    // Получить активную версию
    static getActiveVersion = () => {
        return RxConfig.read("activeVersion", "none");
    }

    // Задать активную версию
    static setActiveVersion = (version) => {
        if (version.split("-").length < 2) {
            return false;
        }
        RxConfig.write("activeVersion", version);
        RxVersionsUI.reloadButtonUI();
        if (typeof RxVersionArtwork !== "undefined") RxVersionArtwork.update(version);
        if (typeof RxModsManager !== "undefined" && RxModals.isModalShown("mods")) RxModsManager.refresh();
        return true;
    }

    // Получить манифест локальной версии (для 3rdparty)
    static getLocalVersionManifest = (versionName) => {
        let manifestPath = path.join(GAME_DATA, "versions", versionName, `${versionName}.json`);
        if (!fs.existsSync(manifestPath)) {
            return false;
        }
        return JSON.parse(fs.readFileSync(manifestPath));
    }

    // Получить манифест по версии
    static getVersionManifest = async (version) => {
        // Манифест версии не меняется — если он уже скачан, сеть не нужна
        const localManifest = RxVersionsManager.findLocalGameManifest(version);
        if (localManifest) return localManifest;

        let isSuccess = false;
        let verUrl = false;

        let manifest = await vanilla.getVersionManifest();
        manifest.versions.forEach((item) => {
            if (item.id === version) {
                isSuccess = true;
                verUrl = item.url
            }
        });

        if (isSuccess === true && verUrl !== false) {
            let [isSuccess, pkgData] = await RxRequests.get(verUrl);
            if (isSuccess && pkgData) {
                return pkgData;
            }
        }
        return false;
    }

    // Найти скачанный манифест ванильной версии: versions/<версия>/ или папка загрузчика (MCLC кладёт его туда)
    static findLocalGameManifest = (version) => {
        const roots = [GAME_DATA];
        try {
            const homePath = path.join(GAME_DATA, "home");
            if (fs.existsSync(homePath)) fs.readdirSync(homePath).forEach(name => roots.push(path.join(homePath, name)));
        } catch (_) {}

        for (const root of roots) {
            const versionsPath = path.join(root, "versions");
            let folders = [];
            try {
                folders = fs.existsSync(versionsPath) ? fs.readdirSync(versionsPath) : [];
            } catch (_) {}
            const ordered = [version, ...folders.filter(name => name !== version && name.endsWith(`-${version}`))];
            for (const folder of ordered) {
                const manifestPath = path.join(versionsPath, folder, `${version}.json`);
                try {
                    if (!fs.existsSync(manifestPath)) continue;
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                    if (manifest?.id === version) return manifest;
                } catch (_) {}
            }
        }
        return false;
    }

    // Парсинг ID версии
    static parseVersionID = (versionId) => {
        let idSplit = versionId.split("-");
        let versionType = idSplit[0];
        idSplit.shift();
        return {
            type: versionType,
            name: idSplit.join("-"),
            id: versionId
        }
    }
}
