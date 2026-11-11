// Вход через Microsoft (лицензионный Minecraft): код устройства → Xbox Live → XSTS → сервисы Minecraft.
// Пароль лаунчер не видит: игрок вводит короткий код на странице Microsoft в своём браузере.
// Нужен идентификатор приложения Azure (MICROSOFT_CLIENT_ID в renderer.js), одобренный для сервисов Minecraft;
// пока его нет, вход выключен и кнопка в списке профилей не показывается
class RxMicrosoft {
    static AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
    static SCOPE = "XboxLive.signin offline_access";
    static XBOX_USER = "https://user.auth.xboxlive.com/user/authenticate";
    static XBOX_XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";
    static MINECRAFT = "https://api.minecraftservices.com";
    // Токен Minecraft обновляется заранее: игра не должна стартовать с тем, что вот-вот истечёт
    static REFRESH_MARGIN = 10 * 60e3;
    static busy = false;

    static clientId = () => (typeof MICROSOFT_CLIENT_ID === "string" ? MICROSOFT_CLIENT_ID.trim() : "");
    static isAvailable = () => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(RxMicrosoft.clientId());

    static t = (key, fallback) => (typeof MESSAGES !== "undefined" && MESSAGES.microsoft?.[key]) || fallback;

    static fail = (code, message = code) => Object.assign(new Error(message), {code});

    static parse = (response) => {
        let data = {};
        try { data = response.body ? JSON.parse(response.body) : {}; } catch (_) {}
        return {ok: response.ok, status: response.status, data: data && typeof data === "object" ? data : {}};
    };

    static form = async (url, fields) => RxMicrosoft.parse(await RxHttp.text(url, {
        method: "POST", body: new URLSearchParams(fields).toString(), timeout: 20000, maxBytes: 256 * 1024,
        headers: {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    }));

    static json = async (url, body, headers = {}) => RxMicrosoft.parse(await RxHttp.text(url, {
        method: body === null ? "GET" : "POST", body, timeout: 20000, maxBytes: 512 * 1024, headers: {"Accept": "application/json", ...headers}
    }));

    // ---------- вход Microsoft ----------
    static deviceCode = async () => {
        const {ok, data} = await RxMicrosoft.form(`${RxMicrosoft.AUTHORITY}/devicecode`, {client_id: RxMicrosoft.clientId(), scope: RxMicrosoft.SCOPE});
        if (!ok || typeof data.device_code !== "string" || typeof data.user_code !== "string") throw RxMicrosoft.fail("unavailable", data.error_description || "Device code request failed");
        return {
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri: RxMicrosoft.safeLoginPage(data.verification_uri),
            interval: Math.min(30, Math.max(2, Number(data.interval) || 5)),
            expiresAt: Date.now() + Math.min(1800, Math.max(60, Number(data.expires_in) || 900)) * 1000
        };
    };

    // Страница для ввода кода — только на адресах Microsoft
    static safeLoginPage = (value) => {
        try {
            const url = new URL(String(value));
            if (url.protocol === "https:" && /(^|\.)(microsoft\.com|live\.com|microsoftonline\.com)$/i.test(url.hostname)) return url.href;
        } catch (_) {}
        return "https://www.microsoft.com/link";
    };

    static tokens = (data) => {
        if (typeof data.access_token !== "string" || !data.access_token) throw RxMicrosoft.fail("unavailable", "Token response without access token");
        return {accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : ""};
    };

    // Ждём, пока игрок введёт код в браузере
    static pollToken = async (device, signal = null) => {
        let interval = device.interval;
        while (Date.now() < device.expiresAt) {
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            if (signal?.aborted) throw RxMicrosoft.fail("cancelled");
            let result;
            try {
                result = await RxMicrosoft.form(`${RxMicrosoft.AUTHORITY}/token`, {
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: RxMicrosoft.clientId(), device_code: device.deviceCode
                });
            } catch (_) {
                continue; // сеть моргнула — пробуем снова, пока код действует
            }
            if (result.ok) return RxMicrosoft.tokens(result.data);
            const error = String(result.data.error || "");
            if (error === "authorization_pending") continue;
            if (error === "slow_down") { interval = Math.min(60, interval + 5); continue; }
            if (error === "authorization_declined") throw RxMicrosoft.fail("declined");
            if (error === "expired_token" || error === "bad_verification_code") throw RxMicrosoft.fail("expired");
            throw RxMicrosoft.fail("unavailable", result.data.error_description || error || `HTTP ${result.status}`);
        }
        throw RxMicrosoft.fail("expired");
    };

    static refresh = async (refreshToken) => {
        const {ok, status, data} = await RxMicrosoft.form(`${RxMicrosoft.AUTHORITY}/token`, {
            grant_type: "refresh_token", client_id: RxMicrosoft.clientId(), refresh_token: refreshToken, scope: RxMicrosoft.SCOPE
        });
        if (ok) return RxMicrosoft.tokens(data);
        // Вход отозван или устарел — нужен новый; остальное (сбой сервиса) решает вызывающий
        if (status === 400 || status === 401) throw RxMicrosoft.fail("relogin", data.error_description || data.error || "Refresh token rejected");
        throw RxMicrosoft.fail("unavailable", `HTTP ${status}`);
    };

    // ---------- Xbox Live и Minecraft ----------
    static XSTS_ERRORS = {2148916233: "no_xbox", 2148916235: "region", 2148916236: "adult", 2148916237: "adult", 2148916238: "child"};

    // Сессия Minecraft по токену Microsoft: {accessToken, expiresAt, uuid, nickname}
    static minecraftSession = async (microsoftToken) => {
        const user = await RxMicrosoft.json(RxMicrosoft.XBOX_USER, {
            Properties: {AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${microsoftToken}`},
            RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT"
        });
        const userHash = user.data.DisplayClaims?.xui?.[0]?.uhs;
        if (!user.ok || typeof user.data.Token !== "string" || typeof userHash !== "string") throw RxMicrosoft.fail("unavailable", `Xbox Live HTTP ${user.status}`);

        const xsts = await RxMicrosoft.json(RxMicrosoft.XBOX_XSTS, {
            Properties: {SandboxId: "RETAIL", UserTokens: [user.data.Token]}, RelyingParty: "rp://api.minecraftservices.com/", TokenType: "JWT"
        });
        if (!xsts.ok || typeof xsts.data.Token !== "string") {
            throw RxMicrosoft.fail(RxMicrosoft.XSTS_ERRORS[Number(xsts.data.XErr)] || "unavailable", `XSTS HTTP ${xsts.status} [XErr=${xsts.data.XErr || "-"}]`);
        }

        const login = await RxMicrosoft.json(`${RxMicrosoft.MINECRAFT}/authentication/login_with_xbox`, {identityToken: `XBL3.0 x=${userHash};${xsts.data.Token}`});
        if (!login.ok || typeof login.data.access_token !== "string") {
            // 403 — приложение Azure ещё не одобрено для сервисов Minecraft (aka.ms/AppRegInfo)
            throw RxMicrosoft.fail(login.status === 403 ? "app_not_approved" : "unavailable", `Minecraft login HTTP ${login.status}`);
        }
        if (typeof RxCollector !== "undefined") RxCollector.addSecrets(login.data.access_token);

        const profile = await RxMicrosoft.json(`${RxMicrosoft.MINECRAFT}/minecraft/profile`, null, {"Authorization": `Bearer ${login.data.access_token}`});
        if (profile.status === 404) throw RxMicrosoft.fail("no_game");
        const uuid = String(profile.data.id || "").replace(/-/g, "").toLowerCase();
        if (!profile.ok || !/^[0-9a-f]{32}$/.test(uuid) || !NICKNAME_REGEX.test(profile.data.name || "")) throw RxMicrosoft.fail("unavailable", `Minecraft profile HTTP ${profile.status}`);
        return {
            accessToken: login.data.access_token,
            expiresAt: Date.now() + Math.min(86400, Math.max(60, Number(login.data.expires_in) || 3600)) * 1000,
            uuid,
            nickname: profile.data.name
        };
    };

    // ---------- аккаунт в лаунчере ----------
    static saveAccount = (session, tokens) => {
        const accounts = RxAccountsManager.getAccounts();
        const previous = accounts[session.uuid];
        accounts[session.uuid] = {
            ...(previous?.type === "microsoft" ? previous : {}),
            type: "microsoft", nickname: session.nickname, uuid: session.uuid, added: previous?.added || Date.now(),
            accessToken: session.accessToken, expiresAt: session.expiresAt,
            refreshToken: tokens.refreshToken || previous?.refreshToken || ""
        };
        RxAccountsManager.saveAccounts(accounts);
        return accounts[session.uuid];
    };

    // Данные для запуска игры; false — нужен новый вход (окно входа уже открыто)
    static getAccountForAuth = async (uuid) => {
        let account = RxAccountsManager.getAccount(uuid);
        if (!account || account.type !== "microsoft") return false;
        const fresh = account.accessToken && Date.now() < Number(account.expiresAt || 0) - RxMicrosoft.REFRESH_MARGIN;
        if (!fresh) {
            try {
                if (!account.refreshToken || account.needsReauthentication) throw RxMicrosoft.fail("relogin");
                const tokens = await RxMicrosoft.refresh(account.refreshToken);
                account = RxMicrosoft.saveAccount(await RxMicrosoft.minecraftSession(tokens.accessToken), tokens);
                if (account.uuid !== uuid) throw RxMicrosoft.fail("relogin", "Another profile was returned");
            } catch (error) {
                RxCollector.writeLog(`Microsoft: Session refresh failed [code=${error.code || "error"}] [error=${error.message}]`);
                const stillValid = account.accessToken && Date.now() < Number(account.expiresAt || 0);
                // Сервис недоступен, а токен ещё действует — играем с ним; иначе просим войти заново
                if (!(stillValid && !["relogin", "no_game"].includes(error.code))) {
                    RxToasts.create(RxMicrosoft.t("title", "Аккаунт Microsoft"), "window", RxMicrosoft.errorText(error.code));
                    if (error.code === "relogin" && RxMicrosoft.isAvailable()) RxMicrosoft.login();
                    return false;
                }
            }
        }
        // xuid и clientId «0»: иначе в аргументы запуска (и в журнал) попали бы токены сессии
        return {access_token: account.accessToken, client_token: "", uuid: account.uuid, name: account.nickname,
            meta: {type: "msa", xuid: "0", clientId: "0"}};
    };

    static errorText = (code) => {
        const texts = {
            declined: "Вход отменён на странице Microsoft",
            expired: "Код входа устарел — начните заново",
            no_xbox: "У этой учётной записи Microsoft нет профиля Xbox. Создайте его на xbox.com и повторите вход",
            region: "Xbox Live недоступен в стране этой учётной записи",
            adult: "Учётной записи нужно подтверждение возраста на xbox.com",
            child: "Детскую учётную запись должен добавить в семью взрослый (account.microsoft.com/family)",
            no_game: "На этой учётной записи нет купленного Minecraft: Java Edition",
            app_not_approved: "Вход через Microsoft ещё не подтверждён для RxLauncher. Попробуйте позже",
            relogin: "Войдите в аккаунт Microsoft заново",
            unavailable: "Сервис входа недоступен. Проверьте интернет и попробуйте ещё раз"
        };
        const key = Object.prototype.hasOwnProperty.call(texts, code) ? code : "unavailable";
        return RxMicrosoft.t(key, texts[key]);
    };

    // ---------- окно входа ----------
    static login = async () => {
        if (RxMicrosoft.busy) return false;
        if (!RxMicrosoft.isAvailable()) {
            RxToasts.create(RxMicrosoft.t("notConfigured", "Вход через Microsoft пока не подключён"), "window");
            return false;
        }
        RxMicrosoft.busy = true;
        const abort = new AbortController();
        try {
            const device = await RxMicrosoft.deviceCode();
            try { require("electron").clipboard.writeText(device.userCode); } catch (_) {}

            // Код ждём в фоне; как только игрок подтвердил вход (или код устарел), окно закрывается само
            let settled = false, dialogOpen = false;
            const waiting = RxMicrosoft.pollToken(device, abort.signal).finally(() => {
                settled = true;
                if (dialogOpen) RxDialog.close("done");
            });
            waiting.catch(() => {});
            let opened = false;
            while (!settled) {
                dialogOpen = true;
                const result = await RxDialog.open({
                    icon: "window",
                    title: RxMicrosoft.t("title", "Аккаунт Microsoft"),
                    text: (opened
                        ? RxMicrosoft.t("waiting", "Ждём подтверждения. Введите на открывшейся странице код {0} и войдите в учётную запись Microsoft")
                        : RxMicrosoft.t("intro", "Откройте страницу входа Microsoft и введите код {0} — он уже скопирован. Пароль лаунчер не видит")
                    ).replace("{0}", device.userCode),
                    buttons: [
                        {id: "cancel", text: MESSAGES.dialog?.cancel || "Отмена"},
                        {id: "open", text: opened ? RxMicrosoft.t("openAgain", "Открыть страницу ещё раз") : RxMicrosoft.t("open", "Открыть страницу входа"), icon: "open_in_new", primary: true}
                    ]
                });
                dialogOpen = false;
                if (result.button === "open") {
                    openExternal(device.verificationUri);
                    opened = true;
                    continue;
                }
                if (result.button !== "done") {
                    abort.abort();
                    return false;
                }
            }

            const tokens = await waiting;
            RxToasts.create(RxMicrosoft.t("title", "Аккаунт Microsoft"), "window", RxMicrosoft.t("checking", "Проверяем лицензию Minecraft…"));
            const account = RxMicrosoft.saveAccount(await RxMicrosoft.minecraftSession(tokens.accessToken), tokens);
            RxAccountsManager.setActiveAccount(account.uuid);
            RxToasts.create(account.nickname, "person", MESSAGES.commons?.newAccountAdded || MESSAGES.accounts.added);
            RxCollector.writeLog("Microsoft: Account added");
            return true;
        } catch (error) {
            if (error.code !== "cancelled") {
                RxCollector.writeLog(`Microsoft: Login failed [code=${error.code || "error"}] [error=${error.message}]`);
                RxToasts.create(RxMicrosoft.t("title", "Аккаунт Microsoft"), "window", RxMicrosoft.errorText(error.code));
            }
            return false;
        } finally {
            RxMicrosoft.busy = false;
        }
    };

    // Кнопка «Microsoft» в списке профилей видна, только когда вход подключён
    static init = () => $("#modal-accounts .acc-microsoft").toggle(RxMicrosoft.isAvailable());
}
