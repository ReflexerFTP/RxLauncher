// Horizon — Minecraft Java Edition 26.3, переписанный на Rust (github.com/horizon-rust/horizon).
// Включается в настройках («Rust-клиент Horizon»), тогда в списке версий появляется «Horizon 26.3».
// Сборку (с проверкой подписи), файлы игры, подготовку ресурсов и запуск делает ядро (src-tauri/src/horizon.rs);
// здесь — Java для подготовки, аккаунт и конфиг запуска для RxStarter
class RxHorizon {
    static TYPE = "horizon";
    static MINECRAFT = "26.3";
    static ID = `horizon-${RxHorizon.MINECRAFT}`;
    static REPOSITORY = "https://github.com/horizon-rust/horizon";

    static isEnabled = () => RxConfig.read("horizonEnabled", false) === true;

    static dir = () => path.join(GAME_DATA, "horizon");

    static bridge = () => require("../tauri/runtime/bridge");

    // Хоть одна сборка уже скачана и распакована
    static isInstalled = () => {
        try {
            const builds = path.join(RxHorizon.dir(), "builds");
            return fs.readdirSync(builds).some(name => fs.existsSync(path.join(builds, name, ".rx-build.json")));
        } catch (_) {
            return false;
        }
    };

    static displayName = () => `Horizon ${RxHorizon.MINECRAFT}`;

    // Пункт списка версий
    static entry = () => ({
        id: RxHorizon.ID,
        version: RxHorizon.MINECRAFT,
        type: RxHorizon.TYPE,
        displayName: RxHorizon.displayName(),
        installed: RxHorizon.isInstalled()
    });

    static t = (key, fallback) => MESSAGES.horizon?.[key] || fallback;

    // Отмена запуска (кнопка «Отмена»): ядро прерывает загрузку сборки и подготовку ресурсов
    static abort = () => RxHorizon.bridge().value("horizon.cancel", {}).catch(() => {});

    // Сборка Horizon: скачать новую (если вышла) и распаковать. {dir, sha, minecraft, javaMajor, updated}
    static install = async () => {
        let listening = true;
        const stop = RxHorizon.bridge().listen("rx:horizon", data => {
            if (!listening || RxStarter.cancelRequested) return;
            if (data.stage === "download" && data.total > 0) {
                RxDownloader.updateDownloadUI(RxHorizon.displayName(), Math.round(data.current * 100 / data.total), data.current, data.total);
            } else if (data.stage === "unpack") {
                RxFlyout.setProgress(-1);
                RxFlyout.setText(RxHorizon.t("unpacking", "Распаковка Horizon"), MESSAGES.commons.plsWait);
            }
        });
        RxDownloader.activeDownloads.add(RxHorizon.abort);
        try {
            const build = await RxHorizon.bridge().value("horizon.install", {root: GAME_DATA});
            RxCollector.writeLog(`Horizon: Build ${String(build.sha || "").slice(0, 16)} [minecraft=${build.minecraft}] [java=${build.javaMajor}] [updated=${build.updated}]`);
            if (build.updated) RxToasts.create(RxHorizon.t("updated", "Horizon обновлён"), "deployed_code_update", String(build.sha || "").slice(0, 12));
            return build;
        } finally {
            listening = false;
            if (typeof stop === "function") stop();
            RxDownloader.activeDownloads.delete(RxHorizon.abort);
        }
    };

    // Конфиг запуска для RxStarter (вместо RxLaunchConfigurator): Client отправит его в horizon.launch
    static createConfig = async (starter) => {
        RxFlyout.setText(RxHorizon.t("checking", "Проверка Horizon"), RxHorizon.displayName());
        let build;
        try {
            build = await RxHorizon.install();
        } catch (error) {
            if (RxStarter.cancelRequested) return false;
            RxCollector.writeLog(`Horizon: Install failed [code=${error.code || ""}] [error=${error.message}]`);
            RxLaunchConfigurator.lastError = {code: error.code === "horizon_offline" ? "horizon_offline" : "horizon_download"};
            return false;
        }
        if (RxStarter.cancelRequested) return false;
        starter.versionNumber = build.minecraft || RxHorizon.MINECRAFT;

        // Java нужна только horizon-prepare (сама игра — на Rust): версия — из research-lock.json сборки
        const javaVersion = String(build.javaMajor || 25);
        const automaticJava = RxConfig.read("autoSelectJava", true) === true;
        if (automaticJava) await RxJavaManager.install(javaVersion, false);
        const javaPath = automaticJava ? RxJavaManager.getPath(javaVersion) : RxConfig.read("selectedJava", "");
        if (!javaPath || !fs.existsSync(javaPath)) {
            RxCollector.writeLog(`Horizon: Java ${javaVersion} is missing [path=${javaPath}]`);
            return false;
        }

        // Библиотеки и ассеты версии — заранее, с прогрессом и зеркалом; ядро докачает только jar-файлы
        await RxGameFiles.prepare({version: {number: starter.versionNumber}, root: GAME_DATA});
        if (RxStarter.cancelRequested) return false;

        const activeAccount = RxAccountsManager.getActiveAccount();
        const authorization = await RxAccountsManager.getAccountMCLCData(activeAccount);
        if (!authorization) return false;
        RxCollector.addSecrets(authorization.access_token, authorization.client_token);

        RxFlyout.setUIStartMode(true);
        await RxFlyout.changeMode("spinner");
        return {
            horizon: true,
            build: build.dir,
            root: GAME_DATA,
            javaPath,
            authorization,
            accountType: RxAccountsManager.getAccount(activeAccount)?.type || "local",
            gameDirectory: path.join(RxHorizon.dir(), "game"),
            overrides: {gameDirectory: path.join(RxHorizon.dir(), "game")},
            window: {fullscreen: RxConfig.read("gameInFullscreen") === true},
            server: selectedServerFromList || "",
            launcherDiscord: RxConfig.read("discordRpcEnabled", true) === true
        };
    };

    // Ход подготовки ресурсов (первый запуск сборки — несколько минут)
    static onPrepare = (data) => {
        if (typeof data?.fraction === "number") {
            RxFlyout.setProgress(Math.round(data.fraction * 100));
        }
        RxFlyout.setText(RxHorizon.t("preparing", "Подготовка Horizon (первый раз — несколько минут)"),
            data?.message ? String(data.message).slice(0, 120) : MESSAGES.commons.plsWait);
    };

    // Переключатель в настройках: список версий сразу с Horizon или без него
    static init = () => {
        $(document).on("change", '[data-setting="horizonEnabled"] input', () => {
            setTimeout(() => {
                if (!RxHorizon.isEnabled() && RxVersionsManager.getActiveVersion() === RxHorizon.ID) {
                    RxConfig.write("activeVersion", "none");
                }
                RxVersionsUI.loadVersions();
            }, 0);
        });
    };
}
