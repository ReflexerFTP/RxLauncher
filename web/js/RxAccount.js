// Аккаунт RxLauncher на rxlauncher.xyz: ник + пароль (регистрация — на сайте). Ник можно менять — друзья сразу видят новый,
// а игровой профиль с этим ником переименовывается вместе с ним. Токен сессии хранит главный процесс (safeStorage)
class RxAccount {
    static NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
    static USER_KEY = "rxAccountUser";
    static token = "";
    static user = null; // {id, nick, group, created}

    static api = (route) => `${SITE_URL}/api/${route}`;
    static isLoggedIn = () => Boolean(RxAccount.token && RxAccount.user?.nick);
    static changed = () => document.dispatchEvent(new CustomEvent("rxAccountChanged"));

    // Запрос к API. Ошибка содержит code: badNick, nickTaken, wrongLogin, tooMany, offline …
    static call = async (route, body = {}) => {
        let response;
        try {
            response = await RxHttp.text(RxAccount.api(route), {
                method: "POST", body, timeout: 15000, maxBytes: 1024 * 1024,
                headers: {"Accept": "application/json", ...(RxAccount.token ? {"Authorization": `Bearer ${RxAccount.token}`} : {})}
            });
        } catch (error) {
            throw Object.assign(new Error(error?.message || "offline"), {code: "offline"});
        }
        let data = null;
        try { data = JSON.parse(response.body); } catch (_) {}
        if (data?.ok === true) return data;
        const code = data?.error || (response.status === 429 ? "tooMany" : "offline");
        // Сессию отозвали (сменили пароль на другом ПК, удалили аккаунт) — выходим
        if (code === "noSession" && RxAccount.token) await RxAccount.forget();
        throw Object.assign(new Error(code), {code});
    };

    static errorText = (error) => MESSAGES.friends.errors[error?.code] || MESSAGES.friends.errors.offline;

    static load = async () => {
        try {
            RxAccount.token = String(await ipcRenderer.invoke("rx-account-token", {action: "get"}) || "");
        } catch (_) {
            RxAccount.token = "";
        }
        const user = RxConfig.read(RxAccount.USER_KEY, null);
        RxAccount.user = RxAccount.token && user && typeof user.nick === "string" ? user : null;
        if (!RxAccount.user) RxAccount.token = "";
        return RxAccount.isLoggedIn();
    };

    static remember = async (token, user) => {
        RxAccount.token = token;
        RxAccount.user = {id: user.id, nick: user.nick, group: user.group || "player", created: user.created};
        RxConfig.write(RxAccount.USER_KEY, RxAccount.user);
        await ipcRenderer.invoke("rx-account-token", {action: "set", token});
        RxAccount.changed();
    };

    // Свежие данные с сервера: ник могли сменить на другом ПК или на сайте, группу — выдать в админке
    static setUser = (user) => {
        if (!user?.nick || !RxAccount.user) return;
        const group = user.group || "player";
        if (user.nick === RxAccount.user.nick && group === RxAccount.user.group) return;
        const previous = RxAccount.user.nick;
        RxAccount.user = {...RxAccount.user, nick: user.nick, group};
        RxConfig.write(RxAccount.USER_KEY, RxAccount.user);
        if (previous !== user.nick) RxAccount.renameProfile(previous, user.nick);
        RxAccount.changed();
    };

    static forget = async () => {
        RxAccount.token = "";
        RxAccount.user = null;
        RxConfig.write(RxAccount.USER_KEY, null);
        try { await ipcRenderer.invoke("rx-account-token", {action: "clear"}); } catch (_) {}
        RxAccount.changed();
    };

    // Игровой (пиратский) профиль с ником аккаунта: создать, если нет, и сделать активным
    static useProfile = (nick) => {
        try {
            const find = () => Object.values(RxAccountsManager.getAccounts()).find(account => account.type === "local" && account.nickname.toLowerCase() === nick.toLowerCase());
            if (!find()) RxAccountsManager.addLocalAccount(nick);
            const profile = find();
            if (profile) RxAccountsManager.setActiveAccount(profile.uuid);
        } catch (error) {
            RxCollector.writeLog(`RxAccount: Profile sync failed [error=${error?.message || error}]`);
        }
    };

    static renameProfile = (from, to) => {
        try {
            const profile = Object.values(RxAccountsManager.getAccounts()).find(account => account.type === "local" && account.nickname.toLowerCase() === from.toLowerCase());
            if (profile) RxAccountsManager.renameLocalAccount(profile.uuid, to);
            else RxAccount.useProfile(to);
        } catch (error) {
            RxCollector.writeLog(`RxAccount: Profile rename failed [error=${error?.message || error}]`);
        }
    };

    static login = async (nick, password) => {
        const data = await RxAccount.call("account/login", {nick, password});
        await RxAccount.remember(data.token, data.user);
        RxAccount.useProfile(data.user.nick);
        RxCollector.writeLog(`RxAccount: Logged in [nick=${data.user.nick}]`);
        return data.user;
    };

    static logout = async () => {
        try { await RxAccount.call("account/logout"); } catch (_) {}
        await RxAccount.forget();
    };

    static rename = async (nick) => {
        const previous = RxAccount.user.nick;
        const data = await RxAccount.call("account/rename", {nick});
        RxAccount.user = {...RxAccount.user, nick: data.user.nick, group: data.user.group || RxAccount.user.group};
        RxConfig.write(RxAccount.USER_KEY, RxAccount.user);
        RxAccount.renameProfile(previous, data.user.nick);
        RxCollector.writeLog(`RxAccount: Renamed [from=${previous}] [to=${data.user.nick}]`);
        RxAccount.changed();
        return data.user;
    };

    static changePassword = (password, newPassword) => RxAccount.call("account/password", {password, newPassword});

    static deleteAccount = async (password) => {
        await RxAccount.call("account/delete", {password});
        await RxAccount.forget();
    };
}
