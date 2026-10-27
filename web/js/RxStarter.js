let gameStarting = false;
let launchInProgress = false;
let assetsVerifyOffset = 0;
let startAssetsInterval = 0;
let gamePid = false;
let killedManually = false;

class RxStarter {
    constructor(versionId, versionType, versionNumber) {
        this.versionId = versionId
        this.versionType = versionType;
        this.versionNumber = versionNumber;
        this.config = {};
        this.gameRoot = "";
        this.launchNickname = "Player";
        this.launchServer = "";
        this.statsSessionStarted = false;
        this.gamePid = 0;
    }

    // Отмена запуска до старта игры. MCLC не умеет прерывать свои загрузки, поэтому:
    // UI сразу возвращается в обычный режим, а процесс игры, если он всё же появится, тут же закрывается.
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
        RxToasts.create(MESSAGES.starter.cancelled, "cancel");
        return true;
    }

    static finishCancel = () => {
        RxStarter.cancelRequested = false;
        launchInProgress = false;
        gameStarting = false;
        gamePid = false;
        assetsVerifyOffset = 0;
        startAssetsInterval = 0;
        RxCollector.writeLog("Starter: Cancelled launch settled");
    }

    static kill = () => {
        if (gamePid === false || gameStarting === false) {
            return false;
        }
        RxDiscordRpc.stopGame();
        treeKill(gamePid);
        killedManually = true;
        return true;
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
        let versionDisplayName = RxVersionsManager.versionToDisplayName();
        RxFlyout.setText(MESSAGES.starter.configuring, versionDisplayName);
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
        this.config = configuration;
        RxCollector.writeLog(`Starter: Configuration ready`);

        // Библиотеки и ассеты — заранее и параллельно, MCLC затем только проверит их
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

    launch = async () => {
        let useProgress = false;
        this.launchServer = RxDiscordRpc.sanitizeServer(selectedServerFromList || "");
        selectedServerFromList = false;
        // Готовим UI
        RxFlyout.setUIStartMode(true);
        let versionDisplayName = RxVersionsManager.versionToDisplayName();
        RxFlyout.setText(MESSAGES.starter.preparingGame, versionDisplayName);
        await RxFlyout.changeMode("progress");

        // Создаём клиент игры
        RxCollector.writeLog(`Starter: UI preparation completed, starting game`);
        let launcher = new Client();
        const gameDirectory = this.config?.overrides?.gameDirectory || this.config?.root || this.gameRoot;
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
            RxToasts.create(RxServersUI.message("syncFailed", "Не удалось обновить список серверов Minecraft"), "warning");
        }
        try {
            launcher.launch(this.config).then(childProcess => {
                // Запуск отменили, пока шли загрузки — игру не показываем
                if (RxStarter.cancelRequested) {
                    if (childProcess?.pid) {
                        killedManually = true;
                        treeKill(Number(childProcess.pid));
                    }
                    return RxStarter.finishCancel();
                }
                if (!childProcess || !Number.isInteger(Number(childProcess.pid)) || Number(childProcess.pid) <= 0) {
                    throw new Error("Minecraft process was not created");
                }
                $("#cancelLaunchButton").hide();
                gamePid = Number(childProcess.pid);
                this.gamePid = gamePid;
                this.statsSessionStarted = RxPlayStats.onGameLaunch({
                    versionId: RxVersionsManager.getActiveVersion(),
                    nickname: this.launchNickname,
                    server: this.launchServer,
                    gameDirectory,
                    playerUuid: this.config?.authorization?.uuid || "",
                    pid: gamePid
                });
                RxPlayStats.attachGameProcess(childProcess, RxPlayStats.currentSession?.id || "");
                ipcRenderer.send("game-process-state", {active: true, pid: gamePid});
                if (RxConfig.read("hideLauncherOnStart", true) === true) {
                    RxUI.disappearMainWindow();
                }
                RxDiscordRpc.startGame({
                    nickname: this.launchNickname,
                    server: this.launchServer,
                    version: this.versionNumber,
                    loaderType: this.versionType
                });
            }).catch(error => {
                RxStarter.recoverFromLaunchFailure(error);
            });
        } catch (error) {
            return RxStarter.recoverFromLaunchFailure(error);
        }

        RxCrashAnalyzer.beginSession({gameRoot: this.gameRoot, gameDirectory, versionId: this.versionId});
        launcher.on('debug', (e) => {
            RxCrashAnalyzer.record(e);
            if (IS_APP_IN_DEV) {
                console.log(e);
            }
            RxCollector.writeLog(e);
        });
        launcher.on('data', (e) => {
            RxCrashAnalyzer.record(e);
            RxDiscordRpc.handleGameLog(e);
            if (IS_APP_IN_DEV) {
                console.log(e);
            }
            // Проверки для смены статуса запуска
            if (e.match(/Sound engine started/gim) !== null || e.match(/OpenAL initialized/gim) !== null || e.match(/Created\: 512x512 textures-atlas/gim) !== null) {
                RxFlyout.setText(MESSAGES.starter.started, versionDisplayName);
            }
            if (e.match(/Stopping!/gim) !== null) {
                RxFlyout.setText(MESSAGES.starter.closing, versionDisplayName);
                RxUI.appearMainWindow();
            }
            RxCollector.writeLog(e);
        });
        launcher.on('close', (exitCode) => {
            const closedPid = this.gamePid || Number(gamePid) || 0;
            RxDiscordRpc.stopGame();
            if (this.statsSessionStarted || RxPlayStats.currentSession) {
                RxPlayStats.onGameClose({exitCode, reason: killedManually ? "stopped" : "closed", pid: closedPid});
                this.statsSessionStarted = false;
            }
            ipcRenderer.send("game-process-state", {active: false, pid: closedPid});
            // Удаляем OptiFine
            if(this.versionType === "forgeOptiFine"){
                RxAssets.removeOptiFine(this.versionNumber, this.gameRoot);
            }
            // Копии миров, в которых играли, — в фоне, игра уже закрыта и файлы не заняты
            RxWorldBackups.afterGame(gameDirectory, RxCrashAnalyzer.session?.startedAt || Date.now()).catch(error => {
                RxCollector.writeLog(`WorldBackups: After-game backup failed [error=${error}]`);
            });

            gamePid = false;
            this.gamePid = 0;
            gameStarting = false;
            launchInProgress = false;
            assetsVerifyOffset = 0;
            startAssetsInterval = 0;

            // Показываем все нужные элементы
            $("#stopGameButton").hide();
            RxUI.appearMainWindow();
            setTimeout(() => {
                RxFlyout.setUIStartMode(false);
                RxFlyout.changeMode("idle");
            }, 1000);

            // Игра упала (не остановлена вручную) — разбираем причину и показываем окно с решением
            if(!killedManually && Number(exitCode) !== 0){
                if (RxConfig.read("consoleOnCrash") === true) {
                    RxModals.switchModal("console");
                }
                RxCrashAnalyzer.onGameExit(exitCode).catch(error => {
                    RxCollector.writeLog(`Crash: Analysis failed [error=${error?.stack || error}]`);
                });
            }
            killedManually = false;
            if (IS_APP_IN_DEV) {
                console.log("Game exit code: " + exitCode);
            }
            RxCollector.writeLog("Game exit code: " + exitCode);
        });
        launcher.on("arguments", (e) => {
            if (RxStarter.cancelRequested) return;
            $("#cancelLaunchButton").hide();
            gameStarting = true;
            $("#stopGameButton").show();
            // Показываем консоль
            if (RxConfig.read("consoleOnStart") === true) {
                RxModals.switchModal("console");
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

    static recoverFromLaunchFailure = async (error) => {
        const errorText = error instanceof Error ? error.stack || error.message : String(error);
        $("#cancelLaunchButton").hide();
        // Ошибка — следствие отмены (прерванная загрузка): интерфейс уже сброшен, тост не нужен
        if (RxStarter.cancelRequested) {
            RxCollector.writeLog(`Starter: Cancelled launch stopped [error=${errorText}]`);
            RxPlayStats.abortSession("launch-cancelled");
            return RxStarter.finishCancel();
        }
        RxCollector.writeLog(`Starter: Launch failed [error=${errorText}]`);
        gamePid = false;
        gameStarting = false;
        launchInProgress = false;
        assetsVerifyOffset = 0;
        startAssetsInterval = 0;
        RxDiscordRpc.stopGame();
        RxPlayStats.abortSession("launch-failed");
        ipcRenderer.send("game-process-state", {active: false, pid: 0});
        $("#stopGameButton").hide();
        RxFlyout.setUIStartMode(false);
        await RxFlyout.changeMode("idle");
        RxUI.appearMainWindow();
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
            if (launchInProgress || gameStarting || gamePid !== false) {
                RxCollector.writeLog("Starter: Ignored duplicate launch while Minecraft is already starting or running");
                return false;
            }
            launchInProgress = true;
            $("#cancelLaunchButton").show();
            if (typeof versionId !== "string" || versionId === "none") {
                return RxStarter.recoverFromLaunchFailure("No active version selected");
            }

            let parsedVersion = RxVersionsManager.parseVersionID(versionId);
            if (!parsedVersion || !parsedVersion.type || !parsedVersion.name) {
                return RxStarter.recoverFromLaunchFailure(`Invalid version id: ${versionId}`);
            }

            let starter = new RxStarter(versionId, parsedVersion.type, parsedVersion.name);
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
