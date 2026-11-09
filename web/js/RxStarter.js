let gameStarting = false;      // последний запуск дошёл до старта процесса Java
let launchInProgress = false;  // идёт подготовка запуска (загрузки) — одновременно только одна
let assetsVerifyOffset = 0;
let startAssetsInterval = 0;
let gamePid = false;           // PID последнего запущенного клиента или false, если игра не идёт

// Запуск Minecraft. Клиентов можно запустить сколько угодно: пока один играет, кнопка «Играть» снова доступна.
// Готовится к запуску одновременно только один (иначе две загрузки пишут в одни файлы).
// «Главный» клиент — первый из запущенных: по нему статистика, статус в Discord и у друзей;
// когда он закрывается, главным становится следующий.
class RxStarter {
    static running = new Map(); // pid → RxStarter

    constructor(versionId, versionType, versionNumber) {
        this.versionId = versionId
        this.versionType = versionType;
        this.versionNumber = versionNumber;
        this.config = {};
        this.gameRoot = "";
        this.gameDirectory = "";
        this.launchNickname = "Player";
        this.launchServer = "";
        this.sourceId = "";
        this.displayName = "";
        this.statsSessionStarted = false;
        this.gamePid = 0;
        this.killedManually = false;
        this.crashSession = null;
        this.logSession = null;
    }

    // Отмена запуска до старта игры. Загрузки прерываются, интерфейс сразу возвращается в обычный режим,
    // а процесс игры, если он всё же появится, тут же закрывается.
    // Новый запуск возможен, когда отменённый действительно завершится — чтобы две загрузки не писали в одни файлы.
    static cancelRequested = false;

    static cancel = async () => {
        if (!launchInProgress || gameStarting || RxStarter.cancelRequested) return false;
        RxStarter.cancelRequested = true;
        RxCollector.writeLog("Starter: Launch cancelled by user");
        RxDownloader.abortAll();
        $("#cancelLaunchButton").hide();
        RxFlyout.setUIStartMode(false);
        await RxFlyout.changeMode("idle");
        RxStarter.updateRunningUI();
        RxToasts.create(MESSAGES.starter.cancelled, "cancel");
        return true;
    }

    static finishCancel = () => {
        RxStarter.cancelRequested = false;
        launchInProgress = false;
        gameStarting = false;
        assetsVerifyOffset = 0;
        startAssetsInterval = 0;
        RxCollector.writeLog("Starter: Cancelled launch settled");
    }

    static runningList = () => [...RxStarter.running.values()];

    static isRunning = () => RxStarter.running.size > 0;

    static primary = () => RxStarter.runningList()[0] || null;

    // Кнопка «Закрыть игру»: один клиент — закрыть его, несколько — выбрать какой
    static kill = async () => {
        const list = RxStarter.runningList();
        if (!list.length) return false;
        if (list.length === 1) return list[0].stop();
        const t = MESSAGES.starter.stopChoice || {};
        const result = await RxDialog.open({
            icon: "stop_circle",
            title: t.title || "Какой клиент закрыть?",
            choices: list.map((starter, index) => ({icon: "sports_esports", title: starter.displayName, value: index,
                text: `${starter.launchNickname} · ${new Date(starter.logSession?.startedAt || Date.now()).toLocaleTimeString().slice(0, 5)}`})),
            buttons: [{id: "all", text: t.all || "Закрыть все", danger: true}, {id: "cancel", text: MESSAGES.commons?.cancel || "Отмена"}]
        });
        if (result?.button === "all") {
            list.forEach(starter => starter.stop());
            return true;
        }
        if (result?.button === "choice" && list[result.value]) return list[result.value].stop();
        return false;
    }

    static killPid = (pid) => RxStarter.running.get(Number(pid))?.stop() || false;

    stop = () => {
        if (!this.gamePid) return false;
        this.killedManually = true;
        treeKill(this.gamePid);
        return true;
    }

    // Под кнопкой «Играть»: пока идут клиенты — «Закрыть игру» (с числом, если их несколько)
    static updateRunningUI = () => {
        const count = RxStarter.running.size;
        const $stop = $("#stopGameButton");
        $(".flyout").toggleClass("games-running", count > 0);
        $stop.toggle(count > 0);
        $stop.find("span:last-child").text(count > 1
            ? (MESSAGES.flyout.stopMany || "Закрыть ({0})").replace("{0}", count)
            : MESSAGES.flyout.stop);
        gamePid = count ? RxStarter.runningList()[count - 1].gamePid : false;
        if (typeof RxConsoleUI !== "undefined") RxConsoleUI.renderSources();
    }

    static loaderTypeToDisplay = (loaderType) => {
        switch (loaderType) {
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
            case "vanilla":
            default:
                return "Vanilla";
        }
    }

    prepare = async () => {
        this.gameRoot = RxUtils.getGameRoot(this.versionId);
        this.sourceId = this.sourceId || this.versionId;
        RxCollector.writeLog(`Starter: Preparing UI to start / prepare()`);

        let accData = RxAccountsManager.getAccount(RxAccountsManager.getActiveAccount());
        if (!accData) {
            RxCollector.writeLog("Starter: Active account is missing");
            return false;
        }
        RxCollector.writeLog(`Starter: Account [type=${accData.type}] [username=${accData.nickname}]`);
        this.launchNickname = accData.nickname;

        // Получить версию игры для пака
        if (this.versionType === "pack") {
            let verSplit = this.versionId.toString().split("-");
            verSplit.shift();
            let modpackData = RxPacks.getModpackManifest(verSplit.join("-"));
            RxInstancesUI.markPlayed(verSplit.join("-"));
            RxCollector.writeLog(`Starter: Starting pack [data=${JSON.stringify(modpackData)}`);
            this.versionNumber = modpackData.baseVersion.number;
            this.versionId = modpackData.baseVersion.full;
            this.versionType = modpackData.baseVersion.type;
            this.loaderVersion = modpackData.baseVersion.loaderVersion || "";
        }

        // Своя версия: Java и Discord берут номер базовой версии Minecraft
        let customJava = "";
        if (this.versionType === "custom") {
            const customInfo = RxCustomVersions.getInfo(this.versionNumber);
            if (!customInfo) {
                RxCollector.writeLog(`Starter: Custom version manifest is missing [name=${this.versionNumber}]`);
                return false;
            }
            this.versionNumber = customInfo.baseVersion;
            customJava = customInfo.javaVersion;
        }

        // Готовим UI
        RxCollector.writeLog(`Starter: id=${this.versionId}; version=${this.versionNumber} type=${this.versionType}`);
        RxFlyout.setUIStartMode(true);
        this.displayName = RxVersionsManager.versionToDisplayName();
        RxFlyout.setText(MESSAGES.starter.configuring, this.displayName);
        await RxFlyout.changeMode("spinner");

        // Получаем версию Java
        RxCollector.writeLog(`Starter: Gathering Java`);
        const automaticJava = RxConfig.read("autoSelectJava", true) === true;
        let javaVersion = customJava || await RxJavaManager.gameVersionToJavaVersion(this.versionNumber);
        if (javaVersion === false) {
            return false;
        }
        RxCollector.writeLog(`Starter: Using Java ${javaVersion}`);
        RxCollector.writeLog(`Starter: Trying to install Java`);

        // Скачиваем, если нужно
        if (automaticJava) await RxJavaManager.install(javaVersion, false);

        // Установка Java завершена, получаем к ней путь
        let javaPath = automaticJava ? RxJavaManager.getPath(javaVersion) : RxConfig.read("selectedJava", "");
        if (!javaPath || !fs.existsSync(javaPath) || !fs.statSync(javaPath).isFile()) {
            RxCollector.writeLog(`Starter: Java installation failed! ${javaPath}`);
            return false;
        }
        RxCollector.writeLog(`Starter: Java installation completed`);

        // Получаем конфигурацию
        let configuration = await RxLaunchConfigurator.createConfigForVersion(this.versionId, javaVersion, this.loaderVersion || "");
        if(!configuration){
            RxCollector.writeLog(`Starter: Error happend with launch config!`);
            return false;
        }
        RxStarter.fitMemory(configuration);
        this.config = configuration;
        RxCollector.writeLog(`Starter: Configuration ready`);

        // Библиотеки и ассеты — заранее и параллельно, ядро затем только проверит их
        await RxGameFiles.prepare(configuration);
        if (RxStarter.cancelRequested) return false;

        // Если версия ForgeOptiFine - скачиваем/переносим файл в моды
        if(this.versionType === "forgeOptiFine"){
            RxCollector.writeLog(`Starter: Preparing OptiFine`);
            const optiFineReady = await RxAssets.setupOptiFine(this.versionNumber, this.gameRoot);
            if (!optiFineReady) {
                RxCollector.writeLog(`Starter: OptiFine preparation failed [version=${this.versionNumber}]`);
                return false;
            }
        }

        // Launch configuration contains access tokens; never log it.
        return configuration;
    }

    // Второй и следующие клиенты: памяти даём не больше, чем сейчас свободно (с запасом 1 ГБ системе),
    // иначе Windows начнёт сбрасывать игру в файл подкачки и тормозить будут все клиенты
    static fitMemory = (config) => {
        if (!RxStarter.isRunning() || !config?.memory) return;
        const freeMb = Math.floor(os.freemem() / 1024 / 1024);
        const fit = Math.max(1024, Math.floor((freeMb - 1024) / 512) * 512);
        const max = Number(config.memory.max) || 0;
        if (max > fit) {
            config.memory.max = fit;
            config.memory.min = Math.min(Number(config.memory.min) || 512, fit);
            RxCollector.writeLog(`Starter: Memory lowered for an extra client [${max} -> ${fit} MB] [free=${freeMb} MB]`);
            RxToasts.create((MESSAGES.starter.memoryLowered || "Свободно мало памяти — этому клиенту выделено {0} МБ").replace("{0}", fit), "memory");
        }
    }

    // Этот клиент становится главным: статистика, Discord, друзья
    becomePrimary = () => {
        this.statsSessionStarted = RxPlayStats.onGameLaunch({
            versionId: this.sourceId,
            nickname: this.launchNickname,
            server: this.launchServer,
            gameDirectory: this.gameDirectory,
            playerUuid: this.config?.authorization?.uuid || "",
            pid: this.gamePid
        });
        RxDiscordRpc.startGame({
            nickname: this.launchNickname,
            server: this.launchServer,
            version: this.versionNumber,
            loaderType: this.versionType
        });
        RxFriends.gameStarted({version: this.versionNumber, loaderType: this.versionType, server: this.launchServer, sourceId: this.sourceId});
    }

    isPrimary = () => RxStarter.primary() === this;

    launch = async () => {
        let useProgress = false;
        this.launchServer = RxDiscordRpc.sanitizeServer(selectedServerFromList || "");
        selectedServerFromList = false;
        // Готовим UI
        RxFlyout.setUIStartMode(true);
        const versionDisplayName = this.displayName || RxVersionsManager.versionToDisplayName();
        RxFlyout.setText(MESSAGES.starter.preparingGame, versionDisplayName);
        await RxFlyout.changeMode("progress");

        // Создаём клиент игры
        RxCollector.writeLog(`Starter: UI preparation completed, starting game`);
        let launcher = new Client();
        const gameDirectory = this.config?.overrides?.gameDirectory || this.config?.root || this.gameRoot;
        this.gameDirectory = gameDirectory;
        try {
            if (this.launchServer && !RxMinecraftServers.isSaved(this.launchServer)) {
                RxMinecraftServers.add({name: this.launchServer, address: this.launchServer});
            }
            const syncResult = RxMinecraftServers.syncToDirectory(gameDirectory);
            if (syncResult.changed) {
                RxCollector.writeLog(`Servers: Synced Minecraft list [added=${syncResult.added}] [path=${syncResult.path}]`);
            }
        } catch (error) {
            RxCollector.writeLog(`Servers: Could not sync Minecraft list [error=${error}]`);
            RxToasts.create(MESSAGES.starter.serversSyncFailed || "Не удалось обновить список серверов Minecraft", "warning");
        }
        // Моды проверяются на стилеры прямо перед стартом — в той папке, которую загрузит игра
        if (!(await RxModScan.beforeLaunch(path.join(gameDirectory, "mods")))) {
            RxCollector.writeLog("Starter: Launch stopped by mod scan");
            $("#cancelLaunchButton").hide();
            RxFlyout.setUIStartMode(false);
            await RxFlyout.changeMode("idle");
            RxStarter.finishCancel();
            RxStarter.updateRunningUI();
            return false;
        }
        RxFlyout.setText(MESSAGES.starter.preparingGame, versionDisplayName);
        // Режим слабого ПК: облегчённая графика (только понижаем то, что выше)
        if (RxOptimizer.isLowEnd()) {
            try {
                const changed = require("../lowEndOptions").applyToGameDirectory(gameDirectory);
                if (changed?.length) RxCollector.writeLog(`LowEnd: options.txt [${changed.join(",")}]`);
            } catch (error) {
                RxCollector.writeLog(`LowEnd: options.txt failed [error=${error?.message || error}]`);
            }
        }
        // История команд (command_history.txt) возвращается в папку игры только на время игры
        try {
            await ipcRenderer.invoke("command-history-prepare", {gameDirectory});
        } catch (error) {
            RxCollector.writeLog(`CommandHistory: prepare failed [error=${error?.message || error}]`);
        }

        this.crashSession = RxCrashAnalyzer.beginSession({gameRoot: this.gameRoot, gameDirectory, versionId: this.versionId});
        this.logSession = RxGameLogs.begin({
            title: versionDisplayName, version: this.versionNumber, loader: RxStarter.loaderTypeToDisplay(this.versionType),
            nickname: this.launchNickname, gameDirectory
        });
        try {
            launcher.launch(this.config).then(childProcess => {
                // Запуск отменили, пока шли загрузки — игру не показываем
                if (RxStarter.cancelRequested) {
                    if (childProcess?.pid) {
                        this.killedManually = true;
                        treeKill(Number(childProcess.pid));
                    }
                    return RxStarter.finishCancel();
                }
                if (!childProcess || !Number.isInteger(Number(childProcess.pid)) || Number(childProcess.pid) <= 0) {
                    throw new Error("Minecraft process was not created");
                }
                $("#cancelLaunchButton").hide();
                this.gamePid = Number(childProcess.pid);
                RxStarter.running.set(this.gamePid, this);
                RxGameLogs.setPid(this.logSession, this.gamePid);
                if (RxStarter.running.size === 1) this.becomePrimary();
                ipcRenderer.send("game-process-state", {active: true, pid: this.gamePid});
                if (RxConfig.read("hideLauncherOnStart", true) === true) {
                    RxUI.disappearMainWindow();
                }
                // Процесс запущен — можно готовить следующий клиент
                launchInProgress = false;
                gameStarting = false;
                RxStarter.updateRunningUI();
            }).catch(error => {
                RxStarter.recoverFromLaunchFailure(error, this);
            });
        } catch (error) {
            return RxStarter.recoverFromLaunchFailure(error, this);
        }

        launcher.on('debug', (e) => {
            RxCrashAnalyzer.record(e, this.crashSession);
            RxGameLogs.append(this.logSession, e);
            if (IS_APP_IN_DEV) {
                console.log(e);
            }
            RxCollector.writeLog(e);
        });
        launcher.on('data', (e) => {
            RxCrashAnalyzer.record(e, this.crashSession);
            RxGameLogs.append(this.logSession, e);
            if (this.isPrimary()) {
                RxDiscordRpc.handleGameLog(e);
                RxFriends.handleGameLog(e);
            }
            if (IS_APP_IN_DEV) {
                console.log(e);
            }
            // Игра загрузилась — панель снова в обычном виде, можно запускать следующий клиент
            if (e.match(/Sound engine started/gim) !== null || e.match(/OpenAL initialized/gim) !== null || e.match(/Created\: 512x512 textures-atlas/gim) !== null) {
                if (!launchInProgress) RxStarter.showIdle();
            }
            if (e.match(/Stopping!/gim) !== null && RxStarter.running.size <= 1) {
                RxUI.appearMainWindow();
            }
        });
        launcher.on('close', (exitCode) => {
            const closedPid = this.gamePid;
            const wasPrimary = this.isPrimary();
            RxStarter.running.delete(closedPid);
            RxGameLogs.end(this.logSession, exitCode);
            if (this.statsSessionStarted) {
                RxPlayStats.onGameClose({exitCode, reason: this.killedManually ? "stopped" : "closed", pid: closedPid});
                this.statsSessionStarted = false;
            }
            ipcRenderer.send("game-process-state", {active: false, pid: closedPid, gameDirectory});
            // Главный клиент закрылся — статус берёт следующий из запущенных
            const next = RxStarter.primary();
            if (wasPrimary && next) next.becomePrimary();
            if (!next) {
                RxDiscordRpc.stopGame();
                RxFriends.gameStopped();
            }
            // Удаляем OptiFine, если этой версией больше никто не играет
            if (this.versionType === "forgeOptiFine"
                && !RxStarter.runningList().some(other => other.versionType === "forgeOptiFine" && other.versionNumber === this.versionNumber)) {
                RxAssets.removeOptiFine(this.versionNumber, this.gameRoot);
            }
            // Копии миров, в которых играли, — в фоне, игра уже закрыта и файлы не заняты
            RxWorldBackups.afterGame(gameDirectory, this.crashSession?.startedAt || Date.now()).catch(error => {
                RxCollector.writeLog(`WorldBackups: After-game backup failed [error=${error}]`);
            });

            this.gamePid = 0;
            if (!next) {
                RxUI.appearMainWindow();
            }
            RxStarter.updateRunningUI();
            if (!launchInProgress) {
                setTimeout(() => {
                    if (!launchInProgress) RxStarter.showIdle();
                }, 1000);
            }

            // Игра упала (не остановлена вручную) — разбираем причину и показываем окно с решением
            if(!this.killedManually && Number(exitCode) !== 0){
                if (RxConfig.read("consoleOnCrash") === true) {
                    RxConsoleUI.showSession(this.logSession?.id);
                }
                RxCrashAnalyzer.onGameExit(exitCode, this.crashSession).catch(error => {
                    RxCollector.writeLog(`Crash: Analysis failed [error=${error?.stack || error}]`);
                });
            }
            if (IS_APP_IN_DEV) {
                console.log("Game exit code: " + exitCode);
            }
            RxCollector.writeLog(`Game exit code: ${exitCode} [pid=${closedPid}] [running=${RxStarter.running.size}]`);
        });
        launcher.on("arguments", (e) => {
            if (RxStarter.cancelRequested) return;
            $("#cancelLaunchButton").hide();
            gameStarting = true;
            // Показываем консоль с логом этого клиента
            if (RxConfig.read("consoleOnStart") === true) {
                RxConsoleUI.showSession(this.logSession?.id);
            }
            RxFlyout.changeMode("spinner");
            RxFlyout.setText(MESSAGES.starter.starting, versionDisplayName);
        });
        launcher.on('progress', (e) => {
            if (RxStarter.cancelRequested) return;
            if (e.type === "assets") {
                if (startAssetsInterval === 0) {
                    startAssetsInterval = Date.now();
                }
                if (assetsVerifyOffset === 0 && (Date.now() - startAssetsInterval) > 1000) {
                    assetsVerifyOffset = (e.task - 1);
                }
            } else {
                assetsVerifyOffset = 0;
            }
            if (useProgress === true) {
                let taskOffset = e.task - assetsVerifyOffset;
                let totalOffset = e.total - assetsVerifyOffset;
                let percent = Math.round((taskOffset * 100) / totalOffset);
                RxDownloader.updateDownloadUIText(e.type, percent, taskOffset, totalOffset);
            }
        });
        launcher.on('download-status', (e) => {
            if (RxStarter.cancelRequested) return;
            if ((e.total / 1024 / 1024) >= 4) {
                useProgress = false;
                let percent = Math.round((e.current * 100) / e.total);
                RxDownloader.updateDownloadUI(e.name, percent, e.current, e.total);
            } else {
                useProgress = true;
            }
        });
        return true;
    }

    // Обычный вид панели: выбор версии и «Играть» (и «Закрыть игру», если клиенты запущены)
    static showIdle = () => {
        RxFlyout.setUIStartMode(false);
        RxFlyout.changeMode("idle");
        RxStarter.updateRunningUI();
    }

    static recoverFromLaunchFailure = async (error, starter = null) => {
        const errorText = error instanceof Error ? error.stack || error.message : String(error);
        $("#cancelLaunchButton").hide();
        if (starter?.logSession) RxGameLogs.end(starter.logSession, -1);
        // Ошибка — следствие отмены (прерванная загрузка): интерфейс уже сброшен, тост не нужен
        if (RxStarter.cancelRequested) {
            RxCollector.writeLog(`Starter: Cancelled launch stopped [error=${errorText}]`);
            return RxStarter.finishCancel();
        }
        RxCollector.writeLog(`Starter: Launch failed [error=${errorText}]`);
        gameStarting = false;
        launchInProgress = false;
        assetsVerifyOffset = 0;
        startAssetsInterval = 0;
        if (starter?.gamePid) RxStarter.running.delete(starter.gamePid);
        ipcRenderer.send("game-process-state", {active: false, pid: starter?.gamePid || 0, gameDirectory: starter?.gameDirectory || ""});
        if (!RxStarter.isRunning()) {
            RxDiscordRpc.stopGame();
            RxFriends.gameStopped();
            RxUI.appearMainWindow();
        }
        RxFlyout.setUIStartMode(false);
        await RxFlyout.changeMode("idle");
        RxStarter.updateRunningUI();
        RxToasts.create(MESSAGES.starter.failed, "error");
        return false;
    }

    // Просто запустить версию по ID
    static simpleStart = async (versionId) => {
        try {
            if (RxStarter.cancelRequested) {
                RxToasts.create(MESSAGES.starter.cancelWait, "hourglass_top");
                return false;
            }
            if (launchInProgress) {
                RxCollector.writeLog("Starter: Ignored launch while another client is still preparing");
                RxToasts.create(MESSAGES.starter.busy || "Подождите — предыдущий клиент ещё запускается", "hourglass_top");
                return false;
            }
            launchInProgress = true;
            gameStarting = false;
            $("#cancelLaunchButton").show();
            if (typeof versionId !== "string" || versionId === "none") {
                return RxStarter.recoverFromLaunchFailure("No active version selected");
            }

            let parsedVersion = RxVersionsManager.parseVersionID(versionId);
            if (!parsedVersion || !parsedVersion.type || !parsedVersion.name) {
                return RxStarter.recoverFromLaunchFailure(`Invalid version id: ${versionId}`);
            }

            let starter = new RxStarter(versionId, parsedVersion.type, parsedVersion.name);
            starter.sourceId = versionId;
            const configuration = await starter.prepare();
            if (RxStarter.cancelRequested) return RxStarter.finishCancel();
            if (!configuration) {
                return RxStarter.recoverFromLaunchFailure("Launch configuration was not created");
            }

            if (parsedVersion.type === "pack") {
                const packReady = await RxPacks.verifyAndInstall(parsedVersion.name);
                if (packReady === false) {
                    return RxStarter.recoverFromLaunchFailure("Modpack verification failed");
                }
            }
            if (RxStarter.cancelRequested) return RxStarter.finishCancel();
            return starter.launch();
        } catch (error) {
            return RxStarter.recoverFromLaunchFailure(error);
        }
    }
}
