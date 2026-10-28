class RxLaunchConfigurator {
    static RX_CLIENT_MIN_VERSION = "1.21.4";
    static RX_CLIENT_ALLOWED_LOADERS = ["fabric", "neoforge", "forge", "quilt"];
    static RX_CLIENT_FEATURED_MOD = "fancymenu";
    static RX_CLIENT_TEMPLATE_DIR = path.join(__dirname, "assets", "rxclient");
    static RX_CLIENT_BUNDLED_MODS_DIR = path.join(__dirname, "assets", "rxclient", "mods");
    static RX_CLIENT_TEMPLATE_LAYOUT_FILES = ["title_screen_layout.txt"];
    static RX_CLIENT_LAYOUT_SOURCE_CANDIDATES = ["title_screen_layout.txt", "rx_title.txt"];
    static RX_CLIENT_STALE_LAYOUT_FILES = ["rx_title.txt", "rx_alt_manager.txt"];
    static RX_CLIENT_VERSION_CACHE = {};
    static ZIP_EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
    static ZIP64_EOCD_SIGNATURE = [0x50, 0x4b, 0x06, 0x06];

    static createConfigForVersion = async (version, javaVersion, loaderVersion = "") => {
        RxCollector.writeLog(`Config: Preparing launch config [version=${version}] [java=${javaVersion}]`);
        if (version.split("-").length < 2) {
            return false;
        }

        const versionParsed = RxVersionsManager.parseVersionID(version);
        const rxClientMeta = await RxLaunchConfigurator.resolveRxClientLaunchMeta(versionParsed);

        const maxMemory = RxMemoryAdvisor.launchMemoryMb();
        let resultConfig = {
            memory: {
                min: Math.min(1500, maxMemory), // -Xms не может быть больше -Xmx
                max: maxMemory
            }
        };
        RxCollector.writeLog(`Config: Memory ${maxMemory} MB [auto=${RxMemoryAdvisor.isEnabled()}]`);

        const activeAccount = RxAccountsManager.getActiveAccount();
        resultConfig.authorization = await RxAccountsManager.getAccountMCLCData(activeAccount);
        if (resultConfig.authorization) {
            RxCollector.addSecrets(resultConfig.authorization.access_token, resultConfig.authorization.client_token);
        }
        if (!resultConfig.authorization) {
            RxCollector.writeLog("Configurator: authorization config data is NULL!");
            return false;
        }

        if (RxConfig.read("autoSelectJava", true) === true) {
            resultConfig.javaPath = RxJavaManager.getPath(javaVersion);
        } else {
            resultConfig.javaPath = RxConfig.read("selectedJava");
        }

        RxCollector.writeLog("Config: Prepared first version");

        const moddedLaunchConfig = await RxLaunchConfigurator.getModdedLaunchConfig(rxClientMeta.launchType, versionParsed.name, loaderVersion);
        if (!moddedLaunchConfig || typeof moddedLaunchConfig !== "object") {
            RxCollector.writeLog("Config: Failed to get modded launch config");
            return false;
        }

        const launchRootPath = (typeof moddedLaunchConfig.root === "string" && moddedLaunchConfig.root.length > 0)
            ? moddedLaunchConfig.root
            : GAME_DATA;
        const removedCorruptedJars = RxLaunchConfigurator.cleanupCorruptedLaunchJars(launchRootPath, rxClientMeta.launchType, version);
        if (removedCorruptedJars > 0) {
            RxCollector.writeLog(`Config: Removed corrupted launch jars [count=${removedCorruptedJars}]`);
        }

        RxCollector.writeLog(`Config: Prepared modded launch config [type=${rxClientMeta.launchType}]`);
        resultConfig = {...moddedLaunchConfig, ...resultConfig};
        resultConfig = RxLaunchConfigurator.applySettingsFixesToConfig(versionParsed, resultConfig);
        RxCollector.writeLog("Config: Fixes applied");

        resultConfig = RxLaunchConfigurator.applyRuntimeEnhancements(resultConfig);
        RxCollector.writeLog("Config: Runtime enhancements applied");

        resultConfig = await RxLaunchConfigurator.applyRxClientLobbyMode(versionParsed, rxClientMeta, resultConfig);

        RxCollector.writeLog("Config: Setup of authlib-injector and resolving promises");
        return RxLaunchConfigurator.setupAuthlib(resultConfig, activeAccount);
    }

    static resolveRxClientLaunchMeta = async (versionParsed) => {
        const rxEnabled = RxConfig.read("rxClientLobbyMode", false) === true;
        const baseVersion = RxLaunchConfigurator.resolveGameVersion(versionParsed.name);

        let meta = {
            enabled: rxEnabled,
            launchType: versionParsed.type,
            sourceType: versionParsed.type,
            gameVersion: baseVersion,
            supportedVersion: false,
            fancyMenuVersion: null,
            resolvedLoader: null,
            useBundledMods: false,
            bundledMods: []
        };

        if (!rxEnabled) {
            return meta;
        }

        // Своя версия запускается как есть — без подмены загрузчика ради лобби
        if (versionParsed.type === "custom") {
            meta.enabled = false;
            return meta;
        }

        if (!baseVersion || !RxLaunchConfigurator.isVersionSupportedByRxClient(baseVersion)) {
            RxCollector.writeLog(`RxClient: Disabled for unsupported game version [version=${versionParsed.name}]`);
            return meta;
        }

        meta.supportedVersion = true;

        const loaderPriority = RxLaunchConfigurator.getRxClientLoaderPriority(versionParsed.type);
        const bundledMeta = RxLaunchConfigurator.resolveBundledRxClientMeta(baseVersion, loaderPriority);
        if (bundledMeta) {
            meta.launchType = bundledMeta.loader;
            meta.resolvedLoader = bundledMeta.loader;
            meta.useBundledMods = true;
            meta.bundledMods = bundledMeta.files;
            RxCollector.writeLog(`RxClient: Using bundled lobby mods [version=${baseVersion}] [loader=${bundledMeta.loader}] [files=${bundledMeta.files.length}]`);
            return meta;
        }

        for (const loader of loaderPriority) {
            const versionData = await RxLaunchConfigurator.getModrinthVersionForProject(RxLaunchConfigurator.RX_CLIENT_FEATURED_MOD, baseVersion, loader);
            if (versionData) {
                meta.launchType = loader;
                meta.resolvedLoader = loader;
                meta.fancyMenuVersion = versionData;
                RxCollector.writeLog(`RxClient: Found FancyMenu build [version=${baseVersion}] [loader=${loader}] [id=${versionData.id}]`);
                return meta;
            }
        }

        RxCollector.writeLog(`RxClient: No FancyMenu build found [version=${baseVersion}] [loaders=${loaderPriority.join(",")}]`);
        return meta;
    }

    static getRxClientLoaderPriority = (versionType) => {
        switch (versionType) {
            case "fabric":
                return ["fabric", "quilt", "forge", "neoforge"];
            case "quilt":
                return ["quilt", "fabric", "forge", "neoforge"];
            case "forge":
            case "forgeOptiFine":
                return ["forge", "neoforge", "fabric"];
            case "neoforge":
                return ["neoforge", "forge", "fabric"];
            case "vanilla":
            default:
                // Vanilla cannot load mods directly, so we switch to Fabric first.
                return ["fabric", "forge", "neoforge", "quilt"];
        }
    }

    static getBundledRxClientLoaderDir = (gameVersion, loader) => {
        return path.join(RxLaunchConfigurator.RX_CLIENT_BUNDLED_MODS_DIR, gameVersion, loader);
    }

    static getBundledRxClientCacheRoot = () => {
        if (typeof USERDATA_PATH !== "string" || USERDATA_PATH.length === 0) {
            return null;
        }
        return path.join(USERDATA_PATH, "cache", "rxclient", "mods");
    }

    static copyFileWithFallback = (sourcePath, targetPath) => {
        try {
            fs.copyFileSync(sourcePath, targetPath);
            return true;
        } catch (_) {
            try {
                const data = fs.readFileSync(sourcePath);
                fs.writeFileSync(targetPath, data);
                return true;
            } catch (e) {
                RxCollector.writeLog(`Config: Failed to copy file [src=${sourcePath}] [dst=${targetPath}] [error=${e}]`);
                return false;
            }
        }
    }

    static ensureBundledRxClientModsCached = (gameVersion) => {
        const cacheRoot = RxLaunchConfigurator.getBundledRxClientCacheRoot();
        if (!cacheRoot) {
            return false;
        }

        const sourceVersionDir = path.join(RxLaunchConfigurator.RX_CLIENT_BUNDLED_MODS_DIR, gameVersion);
        if (!fs.existsSync(sourceVersionDir)) {
            return false;
        }

        const cacheVersionDir = path.join(cacheRoot, gameVersion);
        const cacheManifestPath = path.join(cacheVersionDir, "manifest.json");
        if (fs.existsSync(cacheManifestPath)) {
            return true;
        }

        try {
            RxLaunchConfigurator.copyDirectoryRecursive(sourceVersionDir, cacheVersionDir);
            RxCollector.writeLog(`RxClient: Bundled mods cached [version=${gameVersion}] [dir=${cacheVersionDir}]`);
            return true;
        } catch (e) {
            RxCollector.writeLog(`RxClient: Failed to cache bundled mods [version=${gameVersion}] [error=${e}]`);
            return false;
        }
    }

    static getBundledRxClientLoaderCandidates = (gameVersion, loader) => {
        const candidates = [];
        const cacheRoot = RxLaunchConfigurator.getBundledRxClientCacheRoot();
        if (cacheRoot) {
            candidates.push(path.join(cacheRoot, gameVersion, loader));
        }
        candidates.push(RxLaunchConfigurator.getBundledRxClientLoaderDir(gameVersion, loader));
        return [...new Set(candidates)];
    }

    static getBundledRxClientManifestPath = (loaderDirPath) => {
        return path.join(loaderDirPath, "manifest.json");
    }

    static getBundledRxClientMods = (gameVersion, loader) => {
        const candidates = RxLaunchConfigurator.getBundledRxClientLoaderCandidates(gameVersion, loader);
        for (const loaderDir of candidates) {
            if (!fs.existsSync(loaderDir)) {
                continue;
            }

            let filenames = [];
            const manifestPath = RxLaunchConfigurator.getBundledRxClientManifestPath(loaderDir);
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                    if (Array.isArray(manifest.files)) {
                        filenames = manifest.files
                            .map((entry) => {
                                if (typeof entry === "string") {
                                    return entry;
                                }
                                if (entry && typeof entry.filename === "string") {
                                    return entry.filename;
                                }
                                return null;
                            })
                            .filter(Boolean);
                    }
                } catch (e) {
                    RxCollector.writeLog(`RxClient: Failed to parse bundled manifest [file=${manifestPath}] [error=${e}]`);
                }
            }

            if (filenames.length === 0) {
                filenames = fs.readdirSync(loaderDir).filter((name) => name.toLowerCase().endsWith(".jar"));
            }

            const result = [];
            filenames.forEach((filename) => {
                const safeName = path.basename(filename);
                if (!safeName.toLowerCase().endsWith(".jar")) {
                    return;
                }

                const sourcePath = path.join(loaderDir, safeName);
                if (!fs.existsSync(sourcePath)) {
                    return;
                }

                result.push({
                    filename: safeName,
                    sourcePath: sourcePath
                });
            });

            if (result.length > 0) {
                return result;
            }
        }

        return [];
    }

    static resolveBundledRxClientMeta = (gameVersion, loadersOrder) => {
        RxLaunchConfigurator.ensureBundledRxClientModsCached(gameVersion);
        const loaders = Array.isArray(loadersOrder) ? loadersOrder : [];
        for (const loader of loaders) {
            const bundledFiles = RxLaunchConfigurator.getBundledRxClientMods(gameVersion, loader);
            if (bundledFiles.length === 0) {
                continue;
            }

            const hasFancyMenu = bundledFiles.some((entry) => /^fancymenu[_-].*\.jar$/i.test(entry.filename));
            if (!hasFancyMenu) {
                continue;
            }

            return {
                loader: loader,
                files: bundledFiles
            };
        }
        return null;
    }

    static resolveGameVersion = (versionName) => {
        if (typeof versionName !== "string") {
            return null;
        }
        const match = versionName.match(/\d+\.\d+(?:\.\d+)?/);
        if (!match) {
            return null;
        }
        return match[0];
    }

    static parseVersionParts = (version) => {
        if (typeof version !== "string") {
            return null;
        }
        const matched = version.match(/^\d+(?:\.\d+){1,2}$/);
        if (!matched) {
            return null;
        }
        return matched[0].split(".").map((part) => parseInt(part, 10));
    }

    static compareVersionParts = (left, right) => {
        if (!Array.isArray(left) || !Array.isArray(right)) {
            return 0;
        }

        const maxLength = Math.max(left.length, right.length);
        for (let i = 0; i < maxLength; i++) {
            const l = Number.isFinite(left[i]) ? left[i] : 0;
            const r = Number.isFinite(right[i]) ? right[i] : 0;
            if (l > r) {
                return 1;
            }
            if (l < r) {
                return -1;
            }
        }
        return 0;
    }

    static isVersionSupportedByRxClient = (version) => {
        const current = RxLaunchConfigurator.parseVersionParts(version);
        const minAllowed = RxLaunchConfigurator.parseVersionParts(RxLaunchConfigurator.RX_CLIENT_MIN_VERSION);
        if (!current || !minAllowed) {
            return false;
        }
        return RxLaunchConfigurator.compareVersionParts(current, minAllowed) === 0;
    }

    static getRxClientManagedModsStatePath = (gameDirectory) => {
        return path.join(gameDirectory, "config", "rxclient_managed_mods.json");
    }

    static readRxClientManagedMods = (gameDirectory) => {
        const statePath = RxLaunchConfigurator.getRxClientManagedModsStatePath(gameDirectory);
        if (!fs.existsSync(statePath)) {
            return [];
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
            if (Array.isArray(parsed.files)) {
                return parsed.files.map((item) => path.basename(item));
            }
        } catch (e) {
            RxCollector.writeLog(`RxClient: Failed to parse managed mods state [error=${e}]`);
        }

        return [];
    }

    static writeRxClientManagedMods = (gameDirectory, files) => {
        const statePath = RxLaunchConfigurator.getRxClientManagedModsStatePath(gameDirectory);
        const uniqueFiles = [...new Set(
            (Array.isArray(files) ? files : [])
                .filter(Boolean)
                .map((item) => path.basename(item))
        )];

        fs.mkdirSync(path.dirname(statePath), {recursive: true});
        fs.writeFileSync(statePath, JSON.stringify({
            files: uniqueFiles,
            updatedAt: Date.now()
        }, null, 2), "utf8");
    }

    static cleanupStaleFancyMenuMods = (modsPath, keepFiles = []) => {
        if (!fs.existsSync(modsPath)) {
            return 0;
        }

        const keepSet = new Set((keepFiles || []).map((item) => item.toLowerCase()));
        let removed = 0;
        fs.readdirSync(modsPath).forEach((fileName) => {
            const normalized = fileName.toLowerCase();
            if (!/^fancymenu-.*\.jar$/i.test(fileName)) {
                return;
            }
            if (keepSet.has(normalized)) {
                return;
            }

            const fullPath = path.join(modsPath, fileName);
            try {
                fs.unlinkSync(fullPath);
                removed++;
            } catch (e) {
                RxCollector.writeLog(`RxClient: Failed to remove stale FancyMenu [file=${fullPath}] [error=${e}]`);
            }
        });

        return removed;
    }

    static removeRxClientManagedMods = (gameDirectory) => {
        const modsPath = path.join(gameDirectory, "mods");
        const statePath = RxLaunchConfigurator.getRxClientManagedModsStatePath(gameDirectory);
        let managedFiles = RxLaunchConfigurator.readRxClientManagedMods(gameDirectory);
        let removed = 0;

        if (managedFiles.length === 0 && fs.existsSync(modsPath)) {
            // Fallback for old installs without managed-mod manifest.
            managedFiles = fs.readdirSync(modsPath).filter((fileName) => /^fancymenu-.*\.jar$/i.test(fileName));
        }

        managedFiles.forEach((fileName) => {
            const safeName = path.basename(fileName);
            const filePath = path.join(modsPath, safeName);
            if (!fs.existsSync(filePath)) {
                return;
            }
            try {
                fs.unlinkSync(filePath);
                removed++;
            } catch (e) {
                RxCollector.writeLog(`RxClient: Failed to remove managed mod [file=${filePath}] [error=${e}]`);
            }
        });

        RxLaunchConfigurator.cleanupStaleFancyMenuMods(modsPath, []);

        if (fs.existsSync(statePath)) {
            try {
                fs.unlinkSync(statePath);
            } catch (e) {
                RxCollector.writeLog(`RxClient: Failed to remove managed mods state [file=${statePath}] [error=${e}]`);
            }
        }

        RxCollector.writeLog(`RxClient: Managed mods cleanup complete [removed=${removed}] [dir=${modsPath}]`);
        return removed;
    }

    static resolveGameDirectoryForCurrentActiveVersion = () => {
        const activeVersion = RxVersionsManager.getActiveVersion();
        if (!activeVersion || activeVersion === "none") {
            return GAME_DATA;
        }

        const parsedActive = RxVersionsManager.parseVersionID(activeVersion);
        if (parsedActive.type === "pack") {
            return path.join(GAME_DATA, "modpacks", parsedActive.name);
        }

        if (RxConfig.read("fullySeparatedStorage") === true) {
            return path.join(GAME_DATA, "home", `${parsedActive.type}-${parsedActive.name}`);
        }

        if (RxConfig.read("separatedStorage") === true) {
            return path.join(GAME_DATA, "home", parsedActive.id);
        }

        return GAME_DATA;
    }

    static getPreferredRxClientLoaders = (versionType = "vanilla") => {
        const fromVersion = RxLaunchConfigurator.getRxClientLoaderPriority(versionType)
            .filter((loader) => RxLaunchConfigurator.RX_CLIENT_ALLOWED_LOADERS.includes(loader));
        const allAllowed = RxLaunchConfigurator.RX_CLIENT_ALLOWED_LOADERS.filter((loader) => !fromVersion.includes(loader));
        return [...fromVersion, ...allAllowed];
    }

    static resolveRxClientVersionId = async (preferredType = "vanilla") => {
        const targetVersion = RxLaunchConfigurator.RX_CLIENT_MIN_VERSION;
        const versionsMap = await RxVersionsManager.getAllVersionsAvailable(["release"]);
        const loadersOrder = RxLaunchConfigurator.getPreferredRxClientLoaders(preferredType);

        for (const loader of loadersOrder) {
            if (Array.isArray(versionsMap[loader]) && versionsMap[loader].includes(targetVersion)) {
                return `${loader}-${targetVersion}`;
            }
        }

        return null;
    }

    static enforceRxClientCompatibleActiveVersion = async (showToast = false) => {
        if (RxConfig.read("rxClientLobbyMode", false) !== true) {
            return true;
        }

        const activeVersion = RxVersionsManager.getActiveVersion();
        const parsedActive = (activeVersion && activeVersion !== "none")
            ? RxVersionsManager.parseVersionID(activeVersion)
            : {type: "vanilla"};
        const targetVersionId = await RxLaunchConfigurator.resolveRxClientVersionId(parsedActive.type);

        if (!targetVersionId) {
            if (showToast) {
                RxToasts.create("Rx Client", "error", `Не найдена поддерживаемая сборка ${RxLaunchConfigurator.RX_CLIENT_MIN_VERSION} для Fabric/NeoForge/Forge`);
            }
            return false;
        }

        if (activeVersion !== targetVersionId) {
            RxVersionsManager.setActiveVersion(targetVersionId);
            RxVersionsUI.loadVersions();
            if (showToast) {
                RxToasts.create("Rx Client", "auto_fix_high", `Автовыбор версии: ${RxVersionsManager.versionToDisplayName(targetVersionId)}`);
            }
        }

        return true;
    }

    static buildModrinthVersionQuery = (projectId, gameVersion, loader = null) => {
        let query = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=[%22${encodeURIComponent(gameVersion)}%22]`;
        if (loader) {
            query += `&loaders=[%22${encodeURIComponent(loader)}%22]`;
        }
        return query;
    }

    static getModrinthVersionForProject = async (projectId, gameVersion, loader, allowLoaderFallback = false) => {
        const cacheKey = `${projectId}:${gameVersion}:${loader}:fallback=${allowLoaderFallback}`;
        if (typeof RxLaunchConfigurator.RX_CLIENT_VERSION_CACHE[cacheKey] !== "undefined") {
            return RxLaunchConfigurator.RX_CLIENT_VERSION_CACHE[cacheKey];
        }

        let [isSuccess, response] = await RxRequests.get(RxLaunchConfigurator.buildModrinthVersionQuery(projectId, gameVersion, loader));
        if (!isSuccess || !Array.isArray(response) || response.length === 0) {
            if (allowLoaderFallback) {
                [isSuccess, response] = await RxRequests.get(RxLaunchConfigurator.buildModrinthVersionQuery(projectId, gameVersion));
            }
        }

        let selected = null;
        if (isSuccess && Array.isArray(response) && response.length > 0) {
            selected = response[0];
        }

        RxLaunchConfigurator.RX_CLIENT_VERSION_CACHE[cacheKey] = selected;
        return selected;
    }

    static pickPrimaryFile = (versionData) => {
        if (!versionData || !Array.isArray(versionData.files) || versionData.files.length === 0) {
            return null;
        }
        const primary = versionData.files.find((file) => file.primary === true);
        return primary || versionData.files[0];
    }

    static ensureModFileDownloaded = async (versionData, modsPath) => {
        const fileData = RxLaunchConfigurator.pickPrimaryFile(versionData);
        if (!fileData || !fileData.url || !fileData.filename) {
            RxCollector.writeLog(`RxClient: Failed to resolve file in version data [id=${versionData?.id}]`);
            return false;
        }

        const outputPath = path.join(modsPath, fileData.filename);
        let isValidExisting = false;
        if (fs.existsSync(outputPath)) {
            if (fileData.hashes?.sha1) {
                isValidExisting = RxAssets.verifyFile(outputPath, fileData.hashes.sha1);
            } else {
                isValidExisting = true;
            }
        }

        if (isValidExisting) {
            RxCollector.writeLog(`RxClient: Mod already exists [file=${fileData.filename}]`);
            return true;
        }

        RxCollector.writeLog(`RxClient: Downloading mod [file=${fileData.filename}] [url=${fileData.url}]`);
        await RxDownloader.downloadFile(fileData.url, outputPath, fileData.filename, true);
        return true;
    }

    static collectRequiredModrinthVersions = async (rootVersion, gameVersion, loader) => {
        let queue = [rootVersion];
        let visitedVersionIds = new Set();
        let visitedProjectIds = new Set();
        let result = [];

        while (queue.length > 0) {
            const currentVersion = queue.shift();
            if (!currentVersion || visitedVersionIds.has(currentVersion.id)) {
                continue;
            }
            visitedVersionIds.add(currentVersion.id);
            result.push(currentVersion);

            if (!Array.isArray(currentVersion.dependencies)) {
                continue;
            }

            for (const dep of currentVersion.dependencies) {
                if (!dep || dep.dependency_type !== "required") {
                    continue;
                }

                let depVersion = null;
                if (dep.version_id) {
                    const [isSuccess, response] = await RxRequests.get(`https://api.modrinth.com/v2/version/${dep.version_id}`);
                    if (isSuccess && response?.id) {
                        depVersion = response;
                    }
                } else if (dep.project_id) {
                    if (visitedProjectIds.has(dep.project_id)) {
                        continue;
                    }
                    visitedProjectIds.add(dep.project_id);
                    depVersion = await RxLaunchConfigurator.getModrinthVersionForProject(dep.project_id, gameVersion, loader, true);
                }

                if (depVersion && !visitedVersionIds.has(depVersion.id)) {
                    queue.push(depVersion);
                }
            }
        }

        return result;
    }

    static installBundledRxClientMods = (modsPath, bundledMods = []) => {
        const managedFiles = [];
        (Array.isArray(bundledMods) ? bundledMods : []).forEach((entry) => {
            if (!entry || typeof entry.filename !== "string" || typeof entry.sourcePath !== "string") {
                return;
            }

            const safeName = path.basename(entry.filename);
            const sourcePath = entry.sourcePath;
            if (!fs.existsSync(sourcePath)) {
                RxCollector.writeLog(`RxClient: Bundled mod missing [file=${sourcePath}]`);
                return;
            }

            if (!RxLaunchConfigurator.isJarArchiveHealthy(sourcePath)) {
                RxCollector.writeLog(`RxClient: Bundled mod is corrupted [file=${sourcePath}]`);
                return;
            }

            const targetPath = path.join(modsPath, safeName);
            let shouldCopy = true;
            if (fs.existsSync(targetPath) && RxLaunchConfigurator.isJarArchiveHealthy(targetPath)) {
                try {
                    const sourceSize = fs.statSync(sourcePath).size;
                    const targetSize = fs.statSync(targetPath).size;
                    if (sourceSize === targetSize) {
                        shouldCopy = false;
                    }
                } catch (_) {}
            }

            if (shouldCopy) {
                RxLaunchConfigurator.copyFileWithFallback(sourcePath, targetPath);
            }

            managedFiles.push(safeName);
        });

        return [...new Set(managedFiles)];
    }

    static resolveGameDirectoryForLaunch = (versionData, rxMeta, config) => {
        if (config?.overrides?.gameDirectory) {
            return config.overrides.gameDirectory;
        }

        if (RxConfig.read("fullySeparatedStorage") === true) {
            return path.join(GAME_DATA, "home", `${rxMeta.launchType}-${versionData.name}`);
        }

        return GAME_DATA;
    }

    static copyDirectoryRecursive = (sourceDir, targetDir, excludedTopLevelEntries = []) => {
        if (!fs.existsSync(sourceDir)) {
            return;
        }

        fs.mkdirSync(targetDir, {recursive: true});
        const excluded = new Set((excludedTopLevelEntries || []).map((entry) => entry.toLowerCase()));
        fs.readdirSync(sourceDir, {withFileTypes: true}).forEach((item) => {
            if (excluded.has(item.name.toLowerCase())) {
                return;
            }
            const srcPath = path.join(sourceDir, item.name);
            const dstPath = path.join(targetDir, item.name);
            if (item.isDirectory()) {
                RxLaunchConfigurator.copyDirectoryRecursive(srcPath, dstPath);
            } else {
                RxLaunchConfigurator.copyFileWithFallback(srcPath, dstPath);
            }
        });
    }

    static ensureFancyMenuOptions = (fancyMenuDir) => {
        const optionsPath = path.join(fancyMenuDir, "options.txt");

        if (!fs.existsSync(optionsPath)) {
            fs.writeFileSync(
                optionsPath,
                "##[customization]\n\nB:modpack_mode = 'true';\nB:show_customization_overlay = 'false';\nB:advanced_customization_mode = 'false';\n",
                "utf8"
            );
            return;
        }

        let content = fs.readFileSync(optionsPath, "utf8");

        if (content.match(/B:modpack_mode\s*=\s*'(true|false)'/gim)) {
            content = content.replace(/B:modpack_mode\s*=\s*'(true|false)';?/gim, "B:modpack_mode = 'true';");
        } else {
            if (!content.endsWith("\n")) {
                content += "\n";
            }
            content += "B:modpack_mode = 'true';\n";
        }

        if (content.match(/B:show_customization_overlay\s*=\s*'(true|false)'/gim)) {
            content = content.replace(/B:show_customization_overlay\s*=\s*'(true|false)';?/gim, "B:show_customization_overlay = 'false';");
        } else {
            content += "B:show_customization_overlay = 'false';\n";
        }

        if (content.match(/B:advanced_customization_mode\s*=\s*'(true|false)'/gim)) {
            content = content.replace(/B:advanced_customization_mode\s*=\s*'(true|false)';?/gim, "B:advanced_customization_mode = 'false';");
        } else {
            content += "B:advanced_customization_mode = 'false';\n";
        }

        fs.writeFileSync(optionsPath, content, "utf8");
    }

    static ensureRxClientLayoutFile = (customizationDir) => {
        const sourceLayoutName = RxLaunchConfigurator.RX_CLIENT_LAYOUT_SOURCE_CANDIDATES.find((layoutName) => {
            return fs.existsSync(path.join(RxLaunchConfigurator.RX_CLIENT_TEMPLATE_DIR, layoutName));
        });
        if (!sourceLayoutName) {
            RxCollector.writeLog("RxClient: Source layout not found in template directory");
            return false;
        }

        const sourceLayoutPath = path.join(RxLaunchConfigurator.RX_CLIENT_TEMPLATE_DIR, sourceLayoutName);
        const targetLayoutPath = path.join(customizationDir, "title_screen_layout.txt");

        fs.mkdirSync(customizationDir, {recursive: true});
        const copied = RxLaunchConfigurator.copyFileWithFallback(sourceLayoutPath, targetLayoutPath);
        if (!copied) {
            return false;
        }

        if (!fs.existsSync(targetLayoutPath)) {
            RxCollector.writeLog(`RxClient: Target layout was not created [file=${targetLayoutPath}]`);
            return false;
        }

        return true;
    }

    static ensureRxClientCustomGuiRegistry = (fancyMenuDir) => {
        const customGuiScreensPath = path.join(fancyMenuDir, "custom_gui_screens.txt");
        const content = `type = custom_gui_screens

overridden_screens {
}
`;

        fs.writeFileSync(customGuiScreensPath, content, "utf8");
    }

    static ensureRxClientCustomizableMenus = (fancyMenuDir) => {
        const customizableMenusPath = path.join(fancyMenuDir, "customizablemenus.txt");
        const content = `type = customizablemenus

net.minecraft.class_442 {
}

net.minecraft.client.gui.screens.TitleScreen {
}
`;

        fs.writeFileSync(customizableMenusPath, content, "utf8");
    }

    static ensureRxClientUserVariables = (fancyMenuDir) => {
        const userVariablesPath = path.join(fancyMenuDir, "user_variables.db");
        const content = `type = user_variables

variable {
 name = rx_alt_open
 value = 0
 reset_on_launch = false
}

variable {
 name = rx_alt_added
 value = 0
 reset_on_launch = false
}

variable {
 name = rx_alt_name
 value = Player
 reset_on_launch = false
}

variable {
 name = rx_alt_last
 value = none
 reset_on_launch = false
}

variable {
 name = rx_alt_1
 value = -
 reset_on_launch = false
}

variable {
 name = rx_alt_2
 value = -
 reset_on_launch = false
}

variable {
 name = rx_alt_3
 value = -
 reset_on_launch = false
}
`;

        fs.writeFileSync(userVariablesPath, content, "utf8");
    }

    static ensureRxClientModMenuConfig = (gameDirectory) => {
        const modMenuConfigPath = path.join(gameDirectory, "config", "modmenu.json");
        let config = {};

        if (fs.existsSync(modMenuConfigPath)) {
            try {
                config = JSON.parse(fs.readFileSync(modMenuConfigPath, "utf8"));
            } catch (e) {
                RxCollector.writeLog(`RxClient: Failed to parse Mod Menu config [error=${e}]`);
            }
        }

        config.modify_title_screen = false;
        config.button_update_badge = false;

        fs.mkdirSync(path.dirname(modMenuConfigPath), {recursive: true});
        fs.writeFileSync(modMenuConfigPath, JSON.stringify(config, null, 2), "utf8");
    }

    static drawRxClientRoundedRect = (Jimp, image, x, y, width, height, radius, color) => {
        const layer = new Jimp({width, height, color: 0x00000000});
        layer.scan(0, 0, width, height, function (px, py) {
            const dx = px < radius ? radius - px : (px >= width - radius ? px - (width - radius - 1) : 0);
            const dy = py < radius ? radius - py : (py >= height - radius ? py - (height - radius - 1) : 0);
            if ((dx * dx) + (dy * dy) <= radius * radius) {
                this.setPixelColor(color, px, py);
            }
        });
        image.composite(layer, x, y);
    }

    static renderRxClientAltPanel = async (assetsTargetDir) => {
        try {
            const {Jimp, rgbaToInt, loadFont, HorizontalAlign} = require("jimp");
            const {SANS_32_WHITE, SANS_16_WHITE} = require("jimp/fonts");
            const rgba = (r, g, b, a = 255) => rgbaToInt(r, g, b, a);
            const image = new Jimp({width: 600, height: 440, color: 0x00000000});
            const font32 = await loadFont(SANS_32_WHITE);
            const font16 = await loadFont(SANS_16_WHITE);
            const drawRounded = (x, y, width, height, radius, color) => {
                RxLaunchConfigurator.drawRxClientRoundedRect(Jimp, image, x, y, width, height, radius, color);
            };

            drawRounded(0, 0, 600, 440, 24, rgba(42, 40, 52, 238));
            drawRounded(2, 2, 596, 436, 22, rgba(67, 64, 82, 205));
            drawRounded(24, 94, 552, 226, 18, rgba(34, 33, 45, 228));

            for (let i = 0; i < 8; i++) {
                const x = 42 + i * 66;
                image.scan(x, 112, 1, 188, function (px, py) {
                    if ((py - 112) % 2 === 0) {
                        this.setPixelColor(rgba(95, 91, 119, 75), px, py);
                    }
                });
            }

            image.print({font: font16, x: 42, y: 104, text: "Type your nickname and click Add", maxWidth: 380, maxHeight: 24});
            image.print({font: font32, x: 0, y: 180, text: {
                text: "ALT manager",
                alignmentX: HorizontalAlign.CENTER
            }, maxWidth: 600, maxHeight: 40});
            image.print({font: font16, x: 0, y: 222, text: {
                text: "New nicknames are saved for this profile",
                alignmentX: HorizontalAlign.CENTER
            }, maxWidth: 600, maxHeight: 24});
            image.print({font: font16, x: 42, y: 344, text: "Saved in ALT list variables", maxWidth: 500, maxHeight: 22});

            fs.mkdirSync(assetsTargetDir, {recursive: true});
            await image.write(path.join(assetsTargetDir, "alt_panel.png"));
        } catch (e) {
            RxCollector.writeLog(`RxClient: Failed to render alt panel [error=${e}]`);
        }
    }

    static setupRxClientFancyMenuFiles = async (gameDirectory) => {
        const templateDir = RxLaunchConfigurator.RX_CLIENT_TEMPLATE_DIR;
        const missingLayout = RxLaunchConfigurator.RX_CLIENT_TEMPLATE_LAYOUT_FILES.find((file) => {
            return !fs.existsSync(path.join(templateDir, file));
        });
        if (missingLayout) {
            RxCollector.writeLog(`RxClient: Template layout not found [file=${missingLayout}]`);
            return false;
        }

        const fancyMenuDir = path.join(gameDirectory, "config", "fancymenu");
        const customizationDir = path.join(fancyMenuDir, "customization");
        const assetsSourceDir = templateDir;
        const assetsTargetDir = path.join(fancyMenuDir, "assets", "rxclient");

        fs.mkdirSync(customizationDir, {recursive: true});
        fs.mkdirSync(assetsTargetDir, {recursive: true});

        const layoutReady = RxLaunchConfigurator.ensureRxClientLayoutFile(customizationDir);
        if (!layoutReady) {
            return false;
        }

        RxLaunchConfigurator.RX_CLIENT_STALE_LAYOUT_FILES.forEach((layoutFile) => {
            const staleLayout = path.join(customizationDir, layoutFile);
            if (fs.existsSync(staleLayout)) {
                fs.unlinkSync(staleLayout);
            }
        });

        RxLaunchConfigurator.copyDirectoryRecursive(assetsSourceDir, assetsTargetDir, ["mods"]);
        [...RxLaunchConfigurator.RX_CLIENT_TEMPLATE_LAYOUT_FILES, ...RxLaunchConfigurator.RX_CLIENT_STALE_LAYOUT_FILES].forEach((layoutFile) => {
            const copiedLayout = path.join(assetsTargetDir, layoutFile);
            if (fs.existsSync(copiedLayout)) {
                fs.unlinkSync(copiedLayout);
            }
        });
        await RxLaunchConfigurator.renderRxClientAltPanel(assetsTargetDir);

        RxLaunchConfigurator.ensureFancyMenuOptions(fancyMenuDir);
        RxLaunchConfigurator.ensureRxClientCustomGuiRegistry(fancyMenuDir);
        RxLaunchConfigurator.ensureRxClientCustomizableMenus(fancyMenuDir);
        RxLaunchConfigurator.ensureRxClientUserVariables(fancyMenuDir);
        RxLaunchConfigurator.ensureRxClientModMenuConfig(gameDirectory);
        RxCollector.writeLog(`RxClient: FancyMenu layout synced [dir=${fancyMenuDir}]`);
        return true;
    }

    static applyRxClientLobbyMode = async (versionData, rxMeta, config) => {
        if (rxMeta.enabled !== true) {
            const gameDirectory = RxLaunchConfigurator.resolveGameDirectoryForLaunch(versionData, rxMeta, config);
            RxLaunchConfigurator.removeRxClientManagedMods(gameDirectory);
            return config;
        }

        if (rxMeta.supportedVersion !== true) {
            RxToasts.create("Rx Client", "error", `Работает только на версии ${RxLaunchConfigurator.RX_CLIENT_MIN_VERSION}`);
            return config;
        }

        if (!rxMeta.resolvedLoader || (rxMeta.useBundledMods !== true && !rxMeta.fancyMenuVersion)) {
            RxToasts.create("Rx Client", "error", `Для версии ${rxMeta.gameVersion} не найден совместимый FancyMenu`);
            return config;
        }

        const gameDirectory = RxLaunchConfigurator.resolveGameDirectoryForLaunch(versionData, rxMeta, config);
        const modsPath = path.join(gameDirectory, "mods");
        fs.mkdirSync(modsPath, {recursive: true});

        try {
            let managedFiles = [];
            if (rxMeta.useBundledMods === true) {
                managedFiles = RxLaunchConfigurator.installBundledRxClientMods(modsPath, rxMeta.bundledMods);
                if (managedFiles.length === 0) {
                    throw new Error("Bundled mods installation produced empty file list");
                }
            } else {
                const requiredVersions = await RxLaunchConfigurator.collectRequiredModrinthVersions(rxMeta.fancyMenuVersion, rxMeta.gameVersion, rxMeta.resolvedLoader);
                for (const modVersion of requiredVersions) {
                    const fileData = RxLaunchConfigurator.pickPrimaryFile(modVersion);
                    if (fileData?.filename) {
                        managedFiles.push(fileData.filename);
                    }
                    await RxLaunchConfigurator.ensureModFileDownloaded(modVersion, modsPath);
                }
            }

            const previousManagedFiles = RxLaunchConfigurator.readRxClientManagedMods(gameDirectory);
            const keepSet = new Set(managedFiles.map((name) => name.toLowerCase()));
            previousManagedFiles.forEach((oldName) => {
                const normalized = oldName.toLowerCase();
                if (keepSet.has(normalized)) {
                    return;
                }
                const oldPath = path.join(modsPath, path.basename(oldName));
                if (fs.existsSync(oldPath)) {
                    try {
                        fs.unlinkSync(oldPath);
                    } catch (e) {
                        RxCollector.writeLog(`RxClient: Failed to remove stale managed mod [file=${oldPath}] [error=${e}]`);
                    }
                }
            });

            RxLaunchConfigurator.cleanupStaleFancyMenuMods(modsPath, managedFiles);
            RxLaunchConfigurator.writeRxClientManagedMods(gameDirectory, managedFiles);
            await RxLaunchConfigurator.setupRxClientFancyMenuFiles(gameDirectory);
            RxCollector.writeLog(`RxClient: In-game lobby prepared [loader=${rxMeta.resolvedLoader}] [version=${rxMeta.gameVersion}]`);
        } catch (e) {
            console.error(e);
            RxCollector.writeLog(`RxClient: Failed to prepare in-game lobby [error=${e}]`);
            RxToasts.create("Rx Client", "error", "Не удалось подготовить внутриигровое меню");
        }

        return config;
    }

    static setupAuthlib = async (config, activeAccount) => {
        let configResult = config;
        const accountData = RxAccountsManager.getAccount(activeAccount);
        if (!accountData || accountData.type !== "elyby") {
            return configResult;
        }

        const authlibInjectorPath = path.join(GAME_DATA, "cache", "authlib-injector.jar");
        if (!fs.existsSync(authlibInjectorPath)) {
            await RxDownloader.downloadFile(AUTHLIB_INJECTOR_URL, authlibInjectorPath);
        }

        configResult.customArgs.push(`-javaagent:${authlibInjectorPath.replaceAll(/\\/gi, "/")}=ely.by`);
        if (IS_APP_IN_DEV) {
            configResult.customArgs.push("-Dauthlibinjector.debug=verbose,authlib");
        }
        return configResult;
    }

    static applySettingsFixesToConfig = (versionData, config) => {
        let configResult = config;

        if (!Array.isArray(configResult.customArgs)) {
            configResult.customArgs = [];
        }
        if (!Array.isArray(configResult.customLaunchArgs)) {
            configResult.customLaunchArgs = [];
        }
        if (typeof configResult.overrides !== "object" || configResult.overrides === null) {
            configResult.overrides = {};
        }

        if (!!selectedServerFromList) {
            configResult.customLaunchArgs.push("--server");
            configResult.customLaunchArgs.push(selectedServerFromList.split(":")[0]);
            configResult.customLaunchArgs.push("--port");
            configResult.customLaunchArgs.push(selectedServerFromList.split(":")[1]);
        }

        let javaArgs = RxConfig.read("javaStartParams", "").toString().trim();
        if (javaArgs.length > 0) {
            configResult.customArgs = configResult.customArgs.concat(javaArgs.split(/\s+/).filter(Boolean));
        }
        // Свои JVM-аргументы сборки — после общих, чтобы перекрывать их
        const instanceJavaArgs = String(RxInstancesUI.activeManifest()?.javaArgs || "").trim();
        if (instanceJavaArgs.length > 0) {
            configResult.customArgs = configResult.customArgs.concat(instanceJavaArgs.split(/\s+/).filter(Boolean));
        }

        let gameArgs = RxConfig.read("gameStartParams", "").toString().trim();

        const xmsValue = gameArgs.match(/\-Xms.*(M|G)/gmi);
        if (xmsValue && xmsValue.length >= 1) {
            const isGiga = xmsValue[0].slice(-1).toString().toUpperCase() === "G";
            let xmsNumVal = parseInt(xmsValue[0].replaceAll(/[^0-9]/g, ""));
            if (isGiga) {
                xmsNumVal = xmsNumVal * 1024;
            }
            // -Xms из параметров не может превышать -Xmx (иначе Java не стартует)
            configResult.memory.min = Math.min(xmsNumVal, Number(configResult.memory.max) || xmsNumVal);
            gameArgs = gameArgs.replace(xmsValue[0], "").trim();
        }

        if (gameArgs.length > 0) {
            configResult.customLaunchArgs = configResult.customLaunchArgs.concat(gameArgs.split(/\s+/).filter(Boolean));
        }

        configResult.window = {};
        configResult.window.fullscreen = RxConfig.read("gameInFullscreen");

        const separatedPath = path.join(GAME_DATA, "home", "");
        if (!fs.existsSync(separatedPath)) {
            fs.mkdirSync(separatedPath, {recursive: true});
        }

        if (RxConfig.read("separatedStorage") === true && RxConfig.read("fullySeparatedStorage") === false) {
            configResult.overrides.gameDirectory = path.join(GAME_DATA, "home", versionData.id);
        }

        const parsedActive = RxVersionsManager.parseVersionID(RxVersionsManager.getActiveVersion());
        if (parsedActive.type === "pack") {
            configResult.overrides.gameDirectory = path.join(GAME_DATA, "modpacks", parsedActive.name);
        }

        // Сколько файлов MCLC качает одновременно (с 1 потоком тысячи ассетов шли по одному)
        configResult.overrides.maxSockets = RxGameFiles.CONCURRENCY;
        RxCollector.writeLog("Config: Applied user settings");
        return configResult;
    }

    static applyRuntimeEnhancements = (config) => {
        let configResult = config;

        if (RxConfig.read("rxPerformanceMode", false) === true) {
            configResult = RxLaunchConfigurator.applyRxPerformanceProfile(configResult);
        }

        if (RxConfig.read("networkCompatibilityMode", false) === true) {
            configResult = RxLaunchConfigurator.applyNetworkCompatibilityProfile(configResult);
        }

        return configResult;
    }

    static applyNetworkCompatibilityProfile = (config) => {
        if (!Array.isArray(config.customArgs)) {
            config.customArgs = [];
        }

        const networkFlags = [
            "-Djava.net.preferIPv4Stack=true",
            "-Djava.net.preferIPv6Addresses=false",
            "-Dsun.net.client.defaultConnectTimeout=15000",
            "-Dsun.net.client.defaultReadTimeout=30000"
        ];
        networkFlags.forEach((flag) => RxLaunchConfigurator.pushUniqueJvmFlag(config.customArgs, flag));
        RxCollector.writeLog("Config: Network compatibility mode enabled (IPv4 preference and safe timeouts)");
        return config;
    }

    static applyRxPerformanceProfile = (config) => {
        if (!Array.isArray(config.customArgs)) {
            config.customArgs = [];
        }

        const perfFlags = [
            "-XX:+UseG1GC",
            "-XX:+ParallelRefProcEnabled",
            "-XX:+DisableExplicitGC",
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:MaxGCPauseMillis=50",
            "-XX:G1NewSizePercent=20",
            "-XX:G1MaxNewSizePercent=60",
            "-XX:G1ReservePercent=20",
            "-XX:InitiatingHeapOccupancyPercent=15",
            "-XX:G1HeapRegionSize=16M",
            "-XX:+PerfDisableSharedMem"
        ];

        perfFlags.forEach((flag) => {
            RxLaunchConfigurator.pushUniqueJvmFlag(config.customArgs, flag);
        });

        RxCollector.writeLog("Config: Rx performance profile enabled");
        return config;
    }

    static pushUniqueJvmFlag = (args, flag) => {
        const normalizedTarget = RxLaunchConfigurator.normalizeJvmFlagKey(flag);
        const hasFlag = args.some((arg) => {
            if (arg === flag) {
                return true;
            }
            return RxLaunchConfigurator.normalizeJvmFlagKey(arg) === normalizedTarget;
        });

        if (!hasFlag) {
            args.push(flag);
        }
    }

    static normalizeJvmFlagKey = (arg) => {
        if (typeof arg !== "string") {
            return "";
        }
        const basePart = arg.split("=")[0].trim();
        return basePart.replace(/:\+|:\-/g, ":");
    }

    static collectJarFilesRecursive = (directoryPath, result = []) => {
        if (!fs.existsSync(directoryPath)) {
            return result;
        }

        let entries = [];
        try {
            entries = fs.readdirSync(directoryPath, {withFileTypes: true});
        } catch (e) {
            RxCollector.writeLog(`Config: Failed to read directory [dir=${directoryPath}] [error=${e}]`);
            return result;
        }

        entries.forEach((entry) => {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                RxLaunchConfigurator.collectJarFilesRecursive(entryPath, result);
                return;
            }
            if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
                result.push(entryPath);
            }
        });

        return result;
    }

    static hasZipSignatureInBuffer = (buffer, signature) => {
        if (!Buffer.isBuffer(buffer) || !Array.isArray(signature) || signature.length !== 4) {
            return false;
        }

        for (let i = buffer.length - 4; i >= 0; i--) {
            if (
                buffer[i] === signature[0]
                && buffer[i + 1] === signature[1]
                && buffer[i + 2] === signature[2]
                && buffer[i + 3] === signature[3]
            ) {
                return true;
            }
        }

        return false;
    }

    static isJarArchiveHealthy = (jarPath) => {
        let fd = null;
        try {
            if (!fs.existsSync(jarPath)) {
                return false;
            }

            const stat = fs.statSync(jarPath);
            if (!stat.isFile() || stat.size < 22) {
                return false;
            }

            fd = fs.openSync(jarPath, "r");
            const head = Buffer.alloc(4);
            fs.readSync(fd, head, 0, 4, 0);
            if (head[0] !== 0x50 || head[1] !== 0x4b) {
                return false;
            }

            const tailSize = Math.min(stat.size, 65557);
            const tail = Buffer.alloc(tailSize);
            fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);

            const hasZipEocd = RxLaunchConfigurator.hasZipSignatureInBuffer(tail, RxLaunchConfigurator.ZIP_EOCD_SIGNATURE);
            const hasZip64Eocd = RxLaunchConfigurator.hasZipSignatureInBuffer(tail, RxLaunchConfigurator.ZIP64_EOCD_SIGNATURE);
            return hasZipEocd || hasZip64Eocd;
        } catch (e) {
            RxCollector.writeLog(`Config: Jar integrity check failed [jar=${jarPath}] [error=${e}]`);
            return false;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (_) {}
            }
        }
    }

    static getCriticalLoaderLibraryRoots = (rootPath, launchType) => {
        switch (launchType) {
            case "fabric":
                return [path.join(rootPath, "libraries", "net", "fabricmc", "fabric-loader")];
            case "quilt":
                return [path.join(rootPath, "libraries", "org", "quiltmc", "quilt-loader")];
            case "forge":
            case "forgeOptiFine":
                return [path.join(rootPath, "libraries", "net", "minecraftforge", "forge")];
            case "neoforge":
                return [path.join(rootPath, "libraries", "net", "neoforged", "neoforge")];
            case "vanilla":
            default:
                return [];
        }
    }

    static cleanupCorruptedLaunchJars = (rootPath, launchType, versionId) => {
        const jarsToCheck = [];
        const libraryRoots = RxLaunchConfigurator.getCriticalLoaderLibraryRoots(rootPath, launchType);

        libraryRoots.forEach((libraryRoot) => {
            RxLaunchConfigurator.collectJarFilesRecursive(libraryRoot, jarsToCheck);
        });

        const versionJarPath = path.join(rootPath, "versions", versionId, `${versionId}.jar`);
        if (fs.existsSync(versionJarPath)) {
            jarsToCheck.push(versionJarPath);
        }

        const uniqueJars = [...new Set(jarsToCheck)];
        let removed = 0;
        uniqueJars.forEach((jarPath) => {
            if (RxLaunchConfigurator.isJarArchiveHealthy(jarPath)) {
                return;
            }

            try {
                fs.unlinkSync(jarPath);
                removed++;
                RxCollector.writeLog(`Config: Removed corrupted jar [file=${jarPath}]`);
            } catch (e) {
                RxCollector.writeLog(`Config: Failed to remove corrupted jar [file=${jarPath}] [error=${e}]`);
            }
        });

        return removed;
    }

    static getModdedLaunchConfig = async (type, version, loaderVersion = "") => {
        const separated = RxConfig.read("fullySeparatedStorage") === true;
        // Custom manifests remain in the shared versions folder.
        const gameData = type !== "custom" && separated
            ? path.join(GAME_DATA, "home", `${type}-${version}`) : GAME_DATA;
        try {
            const result = await ipcRenderer.invoke("generate-mclc-config", {type, version, loaderVersion, gameData});
            if (result && type === "custom" && separated) {
                result.overrides = {...(result.overrides || {}), gameDirectory: path.join(GAME_DATA, "home", `custom-${version}`)};
            }
            RxCollector.writeLog("Config: We got modded launch config");
            return result;
        } catch (error) {
            RxCollector.writeLog(`Config: Modded launch config failed [error=${error.message}]`);
            return false;
        }
    }
}
