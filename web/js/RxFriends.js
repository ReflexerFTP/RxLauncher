// Друзья: раз в 30 секунд лаунчер сообщает свой статус (в лаунчере / играет: версия, сервер)
// и получает список друзей с их статусами и заявки. В режиме паранойи ничего не отправляется
class RxFriends {
    static INTERVAL = 30000;
    static state = {friends: [], incoming: [], outgoing: []};
    static game = null; // {version, loader, server} пока игра запущена
    static timer = null;
    static syncing = null;
    static again = false;
    static error = null;
    static loaded = false;
    static seenIncoming = null; // id заявок, о которых уже показали уведомление
    static outgoingIds = new Set();

    static enabled = () => RxAccount.isLoggedIn() && !RxPrivacy.isParanoid();
    static invisible = () => RxConfig.read("friendsInvisible", false) === true;
    static showServer = () => RxConfig.read("friendsShowServer", true) === true && RxConfig.read("serverPrivacyMode", false) !== true;
    static changed = () => document.dispatchEvent(new CustomEvent("rxFriendsChanged"));

    static presence = () => {
        if (RxFriends.invisible()) return {status: "invisible"};
        if (!RxFriends.game) return {status: "launcher"};
        return {status: "playing", version: RxFriends.game.version, loader: RxFriends.game.loader, title: RxFriends.game.title,
            server: RxFriends.showServer() ? RxFriends.game.server : ""};
    };

    // ---------- «Кто может копировать мою сборку» ----------
    static COPY_MODES = ["nobody", "friends", "selected"];
    static copyMode = () => RxFriends.COPY_MODES.includes(RxAccount.user?.copyMode) ? RxAccount.user.copyMode : "nobody";

    static saveCopySettings = async (copyMode, allowed = null) => {
        const data = await RxAccount.call("account/settings", {copyMode, ...(allowed ? {allowed} : {})});
        RxAccount.setUser({...RxAccount.user, copyMode: data.settings.copyMode});
        // Разрешили копировать во время игры — отправим сборку сразу
        if (copyMode !== "nobody" && RxFriends.game?.sourceId) RxFriends.uploadPack(RxFriends.game.sourceId);
        return data.settings;
    };

    static copySettings = () => RxAccount.call("account/me").then(data => ({...data.settings, friends: data.friends}));

    // Код запущенной сборки (только файлы с Modrinth) — отправляется, если копировать разрешено хоть кому-то
    static lastPack = "";
    static uploadPack = async (sourceId) => {
        if (!RxFriends.enabled() || RxFriends.copyMode() === "nobody" || !sourceId) return false;
        try {
            const {code, data} = await RxShare.createCode(sourceId, "", {remember: false});
            if (code === RxFriends.lastPack) return true;
            await RxAccount.call("friends/pack", {code, name: data.n});
            RxFriends.lastPack = code;
            RxCollector.writeLog(`Friends: Pack shared [name=${data.n}] [files=${data.m.length + data.r.length + data.s.length}]`);
            return true;
        } catch (error) {
            // Своя версия, Modrinth недоступен и т.п. — просто не делимся
            RxCollector.writeLog(`Friends: Pack not shared [error=${error?.message || error}]`);
            return false;
        }
    };

    // Скопировать сборку друга: код → превью в «Принять приглашение»
    static copyPack = async (id) => (await RxAccount.call("friends/copy", {id})).code;

    static apply = (data) => {
        if (!data || !Array.isArray(data.friends)) return;
        if (data.user) RxAccount.setUser(data.user);
        const incoming = Array.isArray(data.incoming) ? data.incoming : [];
        const outgoing = Array.isArray(data.outgoing) ? data.outgoing : [];
        // Новые заявки и принятые наши — короткое уведомление
        if (RxFriends.seenIncoming) {
            incoming.filter(item => !RxFriends.seenIncoming.has(item.id))
                .forEach(item => RxToasts.create(MESSAGES.friends.newRequest, "person_add", item.nick, "success"));
            data.friends.filter(friend => RxFriends.outgoingIds.has(friend.id))
                .forEach(friend => RxToasts.create(MESSAGES.friends.accepted, "handshake", friend.nick, "success"));
        }
        RxFriends.seenIncoming = new Set(incoming.map(item => item.id));
        RxFriends.outgoingIds = new Set(outgoing.map(item => item.id));
        RxFriends.state = {friends: data.friends, incoming, outgoing};
        RxFriends.error = null;
        RxFriends.loaded = true;
        RxFriends.changed();
    };

    static sync = async () => {
        clearTimeout(RxFriends.timer);
        if (!RxFriends.enabled()) return false;
        // Статус поменялся, пока шёл запрос, — отправим ещё раз сразу после него
        if (RxFriends.syncing) {
            RxFriends.again = true;
            return RxFriends.syncing;
        }
        RxFriends.again = false;
        RxFriends.syncing = (async () => {
            try {
                RxFriends.apply(await RxAccount.call("friends/sync", {presence: RxFriends.presence()}));
                return true;
            } catch (error) {
                RxFriends.error = error;
                RxFriends.changed();
                return false;
            } finally {
                RxFriends.syncing = null;
                if (RxFriends.again) RxFriends.sync();
                else if (RxFriends.enabled()) RxFriends.timer = setTimeout(RxFriends.sync, RxFriends.INTERVAL);
            }
        })();
        return RxFriends.syncing;
    };

    static reset = () => {
        clearTimeout(RxFriends.timer);
        RxFriends.state = {friends: [], incoming: [], outgoing: []};
        RxFriends.seenIncoming = null;
        RxFriends.outgoingIds = new Set();
        RxFriends.loaded = false;
        RxFriends.error = null;
        RxFriends.changed();
    };

    // Действия: после каждого сервер возвращает свежий список
    static act = async (route, body) => {
        const data = await RxAccount.call(route, body);
        RxFriends.apply(data);
        return data;
    };
    static request = (nick) => RxFriends.act("friends/request", {nick});
    static accept = (id) => RxFriends.act("friends/accept", {id});
    static decline = (id) => RxFriends.act("friends/decline", {id});
    static remove = (id) => RxFriends.act("friends/remove", {id});

    // ---------- игра ----------
    static gameStarted = ({version = "", loaderType = "", server = "", sourceId = ""} = {}) => {
        let title = "";
        try {
            const parsed = RxVersionsManager.parseVersionID(sourceId);
            if (parsed.type === "pack") title = RxPacks.getModpackManifest(parsed.name)?.displayName || "";
        } catch (_) {}
        RxFriends.game = {
            version: String(version || "").slice(0, 40),
            loader: String(loaderType || ""),
            server: RxDiscordRpc.sanitizeServer(server),
            title: String(title).slice(0, 48),
            sourceId
        };
        RxFriends.sync();
        RxFriends.uploadPack(sourceId);
    };

    static gameStopped = () => {
        if (!RxFriends.game) return;
        RxFriends.game = null;
        RxFriends.sync();
    };

    // Сервер берём из лога игры, как и для Discord
    static handleGameLog = (line) => {
        if (!RxFriends.game) return;
        let server = RxDiscordRpc.detectServerFromLog(line);
        if (server === false && /\bDisconnected from server\b|\bConnection lost\b|\bDisconnecting from\b/i.test(String(line || ""))) server = "";
        if (server === false || server === RxFriends.game.server) return;
        RxFriends.game.server = server;
        RxFriends.sync();
    };

    static init = async () => {
        await RxAccount.load();
        document.addEventListener("rxAccountChanged", () => RxFriends.enabled() ? RxFriends.sync() : RxFriends.reset());
        // Закрыли лаунчер — сразу «не в сети», не дожидаясь таймаута на сервере
        window.addEventListener("beforeunload", () => {
            if (RxFriends.enabled()) RxAccount.call("friends/offline").catch(() => {});
        });
        if (RxFriends.enabled()) RxFriends.sync();
    };
}

$(RxFriends.init);
