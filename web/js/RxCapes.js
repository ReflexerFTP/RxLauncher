// Плащи RxLauncher. Нарисованный или загруженный плащ хранится на rxlauncher.xyz (загружать могут Игрок+ и админы).
// В игре его показывает агент rxcapes.jar: лаунчер подключает его к любой версии и загрузчику, агент спрашивает
// у сервера плащ по нику игрока — поэтому плащи видят только те, кто играет через RxLauncher
class RxCapes {
    // Агент лежит в assets/agents; перед запуском копируется в кэш и сверяется по SHA-256
    static AGENT = Object.freeze({file: "rxcapes.jar", sha256: "36a7244db03b8a948d353723bfb42c3bea4d1939f95e3e672ac004cdd4c625e1"});
    static GROUPS = ["admin", "player_plus"];
    static CONFIG_KEY = "rxCapesInGame";
    static NICK = /^[A-Za-z0-9_]{1,16}$/;

    static enabledInGame = () => RxConfig.read(RxCapes.CONFIG_KEY, true) !== false;
    static setEnabledInGame = (enabled) => RxConfig.write(RxCapes.CONFIG_KEY, enabled === true);
    static isAllowedGroup = (group) => RxCapes.GROUPS.includes(group);

    // Подключить агент к запуску. Любая ошибка здесь не мешает игре запуститься
    static setupLaunch = async (config, activeAccount) => {
        if (!RxCapes.enabledInGame()) return config;
        try {
            const source = path.join(__dirname, "assets", "agents", RxCapes.AGENT.file);
            const target = path.join(GAME_DATA, "cache", `rxcapes-${RxCapes.AGENT.sha256.slice(0, 12)}.jar`);
            const hashes = {sha256: RxCapes.AGENT.sha256};
            if (!await RxHttp.isFileValid(target, hashes)) {
                fs.mkdirSync(path.dirname(target), {recursive: true});
                fs.copyFileSync(source, target);
            }
            if (!await RxHttp.isFileValid(target, hashes)) throw new Error("Unverified cape agent");
            if (!Array.isArray(config.customArgs)) config.customArgs = [];
            config.customArgs.push(`-javaagent:${target.replaceAll("\\", "/")}=${SITE_URL}`);
            RxCollector.writeLog("RxCapes: Agent attached");
            RxCapes.bindGameNick(activeAccount);
        } catch (error) {
            RxCollector.writeLog(`RxCapes: Agent not attached [error=${error?.message || error}]`);
        }
        return config;
    };

    // Игровой ник отличается от ника аккаунта (Ely.by, второй профиль) — плащ будет виден и на нём
    static bindGameNick = (activeAccount) => {
        try {
            if (!RxAccount.isLoggedIn() || !RxCapes.isAllowedGroup(RxAccount.user?.group)) return;
            const nick = String(RxAccountsManager.getAccount(activeAccount)?.nickname || "");
            if (!RxCapes.NICK.test(nick) || nick.toLowerCase() === RxAccount.user.nick.toLowerCase()) return;
            RxAccount.call("capes/nick", {nick}).catch(error => RxCollector.writeLog(`RxCapes: Nick not bound [error=${error?.code || error}]`));
        } catch (_) {}
    };

    static state = () => RxAccount.call("capes/me");
    static save = (pngBase64) => RxAccount.call("capes/save", {png: pngBase64});
    static remove = () => RxAccount.call("capes/delete");
}
