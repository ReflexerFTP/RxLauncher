const ELYBY_ENDPOINT = "https://authserver.ely.by";
const ELYBY_AUTH_URL = "/auth/authenticate";
const ELYBY_REFRESH_URL = "/auth/refresh";
const ELYBY_VALIDATE_URL = "/auth/validate";

class RxElybyManager {
    static request = async (endpoint, body) => {
        const result = await RxHttp.text(ELYBY_ENDPOINT + endpoint, {method: "POST", body, timeout: 15000, maxBytes: 128 * 1024});
        let data = {};
        try { data = result.body ? JSON.parse(result.body) : {}; } catch (_) {}
        if (!result.ok) {
            const error = new Error(data.errorMessage || `HTTP ${result.status}`);
            error.status = result.status;
            throw error;
        }
        return data;
    };

    static loginAccount = async (login, password, totpToken = "") => {
        const clientToken = crypto.randomUUID();
        try {
            const data = await this.request(ELYBY_AUTH_URL, {username: login, password: password + (totpToken ? ":" + totpToken : ""), clientToken, requestUser: true});
            if (!data.accessToken || !data.selectedProfile?.id || !NICKNAME_REGEX.test(data.selectedProfile.name)) throw new Error("Invalid authentication response");
            return [true, data, clientToken];
        } catch (error) {
            const message = /two factor auth/i.test(error.message) ? "REQUIRES_TOTP" : /Invalid credentials/i.test(error.message) ? "INVALID_CREDENTIALS" : error.message;
            return [false, message, clientToken];
        }
    };

    static refreshAccessToken = async (accessToken, clientToken) => {
        try { return [true, await this.request(ELYBY_REFRESH_URL, {accessToken, clientToken, requestUser: true}), clientToken]; }
        catch (error) { return [false, error, clientToken]; }
    };

    static validateAccessToken = async (accessToken, clientToken) => {
        if (!accessToken) return false;
        try { await this.request(ELYBY_VALIDATE_URL, {accessToken, clientToken}); return true; }
        catch (error) {
            if (error.status === 401 || error.status === 403) return false;
            throw error; // A network outage is not an invalid account.
        }
    };

    static getAccountForAuth = async (uuid) => {
        const account = RxAccountsManager.getAccount(uuid);
        if (!account) return false;
        if (!(await this.validateAccessToken(account.accessToken, account.clientToken))) {
            const [ok, result] = await this.refreshAccessToken(account.accessToken, account.clientToken);
            if (!ok) {
                if (result.status !== 401 && result.status !== 403 && account.accessToken) throw result;
                $("#modal-elybyLogin .error").text(MESSAGES.elyby.repeat).show();
                await RxModals.showModal("elybyLogin");
                return false;
            }
            if (!result.accessToken || result.selectedProfile?.id !== account.uuid) throw new Error("Invalid refreshed profile");
            account.accessToken = result.accessToken;
            account.clientToken = result.clientToken || account.clientToken;
            account.nickname = result.selectedProfile.name;
            const accounts = RxAccountsManager.getAccounts();
            accounts[uuid] = account;
            RxAccountsManager.saveAccounts(accounts);
        }
        // xuid и clientId нужны только аккаунтам Microsoft. Без них MCLC подставил бы сюда токены сессии,
        // и те попали бы в аргументы запуска (а значит в журнал) под именами --xuid и --clientId
        return {access_token: account.accessToken, client_token: account.clientToken, uuid: account.uuid, name: account.nickname,
            meta: {type: "mojang", xuid: "0", clientId: "0"}};
    };

    static getHeadURLByPlayerNickname = async (nickname) => {
        if (!NICKNAME_REGEX.test(nickname)) throw new Error("Invalid nickname");
        const response = await RxHttp.open(`https://skinsystem.ely.by/skins/${encodeURIComponent(nickname)}.png`, {timeout: 15000});
        if (!response.ok) { response.stream.resume(); throw new Error(`Skin HTTP ${response.status}`); }
        const bytes = await RxHttp.readAll(response.stream, 4 * 1024 * 1024);
        const image = await Jimp.read(bytes);
        const size = image.bitmap.width / 8;
        if (!Number.isInteger(size) || size < 1 || size > 256 || image.bitmap.height < size * 2) throw new Error("Invalid skin dimensions");
        const filePath = path.join(USERDATA_PATH, "elybySkins", nickname + ".png");
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        await image.crop({x: size, y: size, w: size, h: size}).resize({w: Math.max(40, size), h: Math.max(40, size), mode: require("jimp").ResizeStrategy.NEAREST_NEIGHBOR}).write(filePath);
        return filePath;
    };
}
