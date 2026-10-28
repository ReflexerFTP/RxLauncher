class RxCollector {
    // Собрать архив отладки
    static collectDebugData = () => {
        RxCollector.writeLog("Collecting debug archive");
        const paranoid = RxPrivacy.isParanoid();
        // В режиме паранойи ID компьютера не читается, а личные данные не попадают в архив
        (paranoid ? Promise.resolve("anonymous") : machineUuid()).then((uniqueId) => {
            let archiveName = `FL_debug-${Date.now()}-${uniqueId}`;
            let archiveDirPath = path.join(USERDATA_PATH, archiveName);
            let filesList = [
                path.join(archiveDirPath, "last.log"),
                path.join(archiveDirPath, "timestamp"),
                path.join(archiveDirPath, "localStorage"),
                path.join(archiveDirPath, "data.json")
            ];
            fs.mkdirSync(archiveDirPath);
            // Журнал уже вычищен при записи, но секреты могли стать известны позже — вычищаем ещё раз
            const scrub = (text) => paranoid ? RxPrivacy.maskUserPaths(RxCollector.redact(text)) : RxCollector.redact(text);
            fs.writeFileSync(filesList[0], scrub(LAST_LOG));
            fs.writeFileSync(filesList[1], Date.now().toString());
            fs.writeFileSync(filesList[2], scrub(JSON.stringify(window.localStorage)));
            const debugInfo = {
                cpu: os.cpus()[0],
                ram: Math.round(os.totalmem() / 1024 / 1024),
                arch: os.arch(),
                win: os.release(),
                hostName: os.hostname(),
                homeDir: os.homedir(),
                appDataDir: USERDATA_PATH,
                resolvedRoot: path.resolve("./"),
                uniqueId: uniqueId,
                version: LAUNCHER_VERSION,
                processVersions: process.versions,
                javas: RxJavaManager.getLocal(),
                packsCount: RxPacks.getPacksList().length,
                settings: RxConfig.readConfig()
            };
            if (paranoid) {
                delete debugInfo.hostName;
                delete debugInfo.homeDir;
                delete debugInfo.uniqueId;
            }
            fs.writeFileSync(filesList[3], scrub(JSON.stringify(debugInfo)));
            const outputPath = path.join(USERDATA_PATH, archiveName + ".zip");
            RxUtils.compressDirectory(outputPath, archiveDirPath).then(() => {
                filesList.forEach(file => {
                    fs.unlinkSync(file);
                })
                fs.rmdirSync(archiveDirPath);
                openExternal(USERDATA_PATH);
            })
        });
    }

    // Значения токенов текущей сессии: вырезаются из журнала, где бы ни встретились (--xuid, --clientId, --session…)
    static secrets = new Set();
    static addSecrets = (...values) => {
        values.forEach(value => { if (typeof value === "string" && value.length >= 8) RxCollector.secrets.add(value); });
        if (RxCollector.secrets.size > 20) RxCollector.secrets = new Set([...RxCollector.secrets].slice(-20));
    };

    static redact = (text) => {
        let line = String(text)
            .replace(/((?:access[_-]?token|client[_-]?token|authorization|password)["\s:=]+)([^"\s,}]+)/gi, "$1[REDACTED]")
            // Аргументы запуска Minecraft, в которых бывают секреты сессии
            .replace(/(--(?:accessToken|clientId|xuid|session|proxyPass)\s+)(\S+)/g, "$1[REDACTED]");
        for (const secret of RxCollector.secrets) if (line.includes(secret)) line = line.split(secret).join("[REDACTED]");
        return line;
    };

    static writeLog = (...data) => {
        let logDate = new Date().toISOString();
        let line = RxCollector.redact(data.join(" "));
        if (typeof RxPrivacy !== "undefined") line = RxPrivacy.maskIfParanoid(line);
        let newPart = "\n" + "[" + logDate + "] " + line
        global.LAST_LOG = global.LAST_LOG + newPart;
        if (global.LAST_LOG.length > 1024 * 1024) {
            global.LAST_LOG = global.LAST_LOG.slice(-768 * 1024);
        }
        if (typeof RxConsoleUI !== "undefined") {
            RxConsoleUI.append(newPart);
        } else if (typeof updateConsole === "function") {
            updateConsole();
        }
    }

    static collectAndSendStats = async () => {
        if (RxConfig.read("sendTechnicalStats", false) !== true) return false;
        if (RxConfig.read("serverPrivacyMode", false) === true) {
            RxCollector.writeLog("Stats skipped: server privacy mode enabled");
            return false;
        }
        // Режим паранойи: не отправляем вообще ничего и не читаем ID компьютера
        if (RxPrivacy.isParanoid()) {
            RxCollector.writeLog("Stats skipped: paranoia mode enabled");
            return false;
        }

        RxCollector.writeLog("Collecting stats");
        machineUuid().then((uniqueId) => {
            let platformInfo = {
                name: os.type(),
                release: os.release(),
                arch: process.arch,
                version: os.version(),
            };

            let cpuSummary = os.cpus();

            let cpuInfo = {
                model: cpuSummary[0].model,
                speed: cpuSummary[0].speed,
                cores: cpuSummary.length,
            };

            let collectedStats = {
                platform: platformInfo,
                totalRAM: Math.round(os.totalmem() / 1024 / 1024),
                cpu: cpuInfo,
                uniqueID: uniqueId,
                version: LAUNCHER_VERSION,
                javas: RxJavaManager.getLocal(),
                packsCount: RxPacks.getPacksList().length,
                versionsInstalledCount: RxVersionsManager.getInstalledVersionsList().length,
                versions: process.versions
            };
            $.get(
                STATS_URL + encodeURIComponent(JSON.stringify(collectedStats)),
                () => {
                    RxCollector.writeLog("Stats sent successfully");
                    return true;
                }
            );
        });
    }

    static setupLogHijacking = () => {
        // Добавляем хэндлинг ошибок
        window.onerror = (errorMsg, url, lineNumber) => {
            RxCollector.writeLog("========================");
            RxCollector.writeLog("window.onerror triggered at", Date.now());
            RxCollector.writeLog("Message:", errorMsg);
            RxCollector.writeLog("URL:", url);
            RxCollector.writeLog("Line number:", lineNumber);
            RxCollector.writeLog("========================");
        };

        window.addEventListener("error", function (e) {
            RxCollector.writeLog("========================");
            RxCollector.writeLog("error event triggered at", Date.now());
            RxCollector.writeLog("Message:", e.error.message);
            RxCollector.writeLog("Full JSON:", JSON.stringify(e));
            RxCollector.writeLog("========================");
        });

        // Заменяем функции консоли
        let oldConsole = console;
        let newConsole = {};
        newConsole.log = function (...log) {
            oldConsole.log(...log);
            RxCollector.writeLog("BROWSER:", ...log);
        };

        newConsole.info = function (...log) {
            oldConsole.info(...log);
            RxCollector.writeLog("BROWSER:", ...log);
        };

        newConsole.warn = function (...log) {
            oldConsole.warn(...log);
            RxCollector.writeLog("BROWSER:", ...log);
        };

        newConsole.error = function (...log) {
            oldConsole.error(...log);
            RxCollector.writeLog("BROWSER:", ...log);
        };
        window.console = newConsole;
        return true;
    }
}
