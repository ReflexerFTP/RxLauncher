class RxLaunchConfigurator {
    static ZIP_EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
    static ZIP64_EOCD_SIGNATURE = [0x50, 0x4b, 0x06, 0x06];

    static createConfigForVersion = async (version, javaVersion, loaderVersion = "") => {
        RxCollector.writeLog(`Config: Preparing launch config [version=${version}] [java=${javaVersion}]`);
        if (version.split("-").length < 2) {
            return false;
        }

        const versionParsed = RxVersionsManager.parseVersionID(version);

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

        const moddedLaunchConfig = await RxLaunchConfigurator.getModdedLaunchConfig(versionParsed.type, versionParsed.name, loaderVersion);
        if (!moddedLaunchConfig || typeof moddedLaunchConfig !== "object") {
            RxCollector.writeLog("Config: Failed to get modded launch config");
            return false;
        }

        const launchRootPath = (typeof moddedLaunchConfig.root === "string" && moddedLaunchConfig.root.length > 0)
            ? moddedLaunchConfig.root
            : GAME_DATA;
        const removedCorruptedJars = RxLaunchConfigurator.cleanupCorruptedLaunchJars(launchRootPath, versionParsed.type, version);
        if (removedCorruptedJars > 0) {
            RxCollector.writeLog(`Config: Removed corrupted launch jars [count=${removedCorruptedJars}]`);
        }

        RxCollector.writeLog(`Config: Prepared modded launch config [type=${versionParsed.type}]`);
        resultConfig = {...moddedLaunchConfig, ...resultConfig};
        resultConfig = RxLaunchConfigurator.applySettingsFixesToConfig(versionParsed, resultConfig);
        RxCollector.writeLog("Config: Fixes applied");

        resultConfig = RxLaunchConfigurator.applyRuntimeEnhancements(resultConfig,
            RxConfig.read("autoSelectJava", true) === true ? Number(javaVersion) || 0 : 0);
        RxCollector.writeLog("Config: Runtime enhancements applied");

        RxCollector.writeLog("Config: Setup of authlib-injector and resolving promises");
        resultConfig = await RxLaunchConfigurator.setupAuthlib(resultConfig, activeAccount);
        return RxCapes.setupLaunch(resultConfig, activeAccount);
    }

    static setupAuthlib = async (config, activeAccount) => {
        let configResult = config;
        const accountData = RxAccountsManager.getAccount(activeAccount);
        if (!accountData || accountData.type !== "elyby") {
            return configResult;
        }

        const trusted = require('../runtimeSecurity').AUTHLIB;
        const authlibInjectorPath = path.join(GAME_DATA, 'cache', 'authlib-injector-' + trusted.version + '.jar');
        const hashes = {sha256: trusted.sha256};
        if (!await RxHttp.isFileValid(authlibInjectorPath, hashes)) {
            await RxDownloader.downloadFile(trusted.url, authlibInjectorPath, 'authlib-injector ' + trusted.version, true, hashes, {expectedSize: trusted.size, maxBytes: trusted.size});
        }
        if (!await RxHttp.isFileValid(authlibInjectorPath, hashes)) throw new Error('Unverified authentication agent');

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

    static applyRuntimeEnhancements = (config, javaMajor = 0) => {
        let configResult = config;

        // Экономия ОЗУ — первой: остальные профили не перекрывают её флаги, а дополняют
        if (RxConfig.read("ramSaverMode", true) === true) {
            configResult = RxLaunchConfigurator.applyRamSaverProfile(configResult, javaMajor);
        }

        // Режим слабого ПК — раньше профиля оптимизации, чтобы его значения были главными
        if (RxConfig.read("lowEndMode", false) === true) {
            configResult = RxLaunchConfigurator.applyLowEndProfile(configResult);
        }

        if (RxConfig.read("rxPerformanceMode", false) === true) {
            configResult = RxLaunchConfigurator.applyRxPerformanceProfile(configResult);
        }

        if (RxConfig.read("networkCompatibilityMode", false) === true) {
            configResult = RxLaunchConfigurator.applyNetworkCompatibilityProfile(configResult);
        }

        return configResult;
    }

    // Экономия оперативной памяти: Java не держит лишнюю кучу. Неиспользуемая память возвращается системе
    // (периодическая сборка G1 — Java 12+), куча сжимается после сборок, одинаковые строки хранятся один раз,
    // мягкие ссылки (кеши модов) живут меньше, стартовая куча — 512 МБ вместо 1.5 ГБ (растёт по мере надобности).
    // javaMajor 0 — своя Java игрока, версия неизвестна: только флаги, которые есть и в Java 8
    static RAM_SAVER_FLAGS = ["-XX:+UseStringDeduplication", "-XX:MinHeapFreeRatio=10", "-XX:MaxHeapFreeRatio=30",
        "-XX:SoftRefLRUPolicyMSPerMB=25"];

    static applyRamSaverProfile = (config, javaMajor = 0) => {
        if (!Array.isArray(config.customArgs)) {
            config.customArgs = [];
        }
        // Другой сборщик мусора, выбранный игроком, не трогаем: флаги ниже рассчитаны на G1
        if (config.customArgs.some(arg => /^-XX:\+Use(?!G1GC)\w+GC$/.test(arg))) {
            RxCollector.writeLog("Config: RAM saver skipped (custom GC)");
            return config;
        }
        const flags = ["-XX:+UseG1GC", ...RxLaunchConfigurator.RAM_SAVER_FLAGS];
        if (javaMajor >= 12) flags.push("-XX:G1PeriodicGCInterval=30000");
        flags.forEach(flag => RxLaunchConfigurator.pushUniqueJvmFlag(config.customArgs, flag));
        if (config.memory && Number(config.memory.max) > 0) {
            config.memory.min = Math.min(Number(config.memory.min) || 512, 512, Number(config.memory.max));
        }
        RxCollector.writeLog(`Config: RAM saver profile enabled [java=${javaMajor || "custom"}]`);
        return config;
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

    static applyLowEndProfile = (config) => {
        if (!Array.isArray(config.customArgs)) {
            config.customArgs = [];
        }
        // Если в параметрах выбран другой сборщик мусора, флаги G1 не добавляем — иначе Java не запустится
        const otherGc = config.customArgs.some(arg => /^-XX:\+Use(?!G1GC)\w+GC$/.test(arg));
        require("../lowEndOptions").JVM_FLAGS
            .filter(flag => !otherGc || ["-XX:+DisableExplicitGC", "-XX:+PerfDisableSharedMem"].includes(flag))
            .forEach(flag => RxLaunchConfigurator.pushUniqueJvmFlag(config.customArgs, flag));
        RxCollector.writeLog(`Config: Low-end mode JVM profile enabled [otherGc=${otherGc}]`);
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
            // Без интернета ядро сразу берёт уже установленную версию с диска, не дожидаясь серверов
            const online = typeof RxNetwork === "undefined" || await RxNetwork.check();
            const result = await ipcRenderer.invoke("generate-mclc-config", {type, version, loaderVersion, gameData, offline: !online});
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
