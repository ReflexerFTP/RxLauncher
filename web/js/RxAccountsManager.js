let accountsFilePath = path.join(USERDATA_PATH, "accounts.json");
const NICKNAME_REGEX = /^[a-zA-Z0-9_]{2,16}$/;

class RxAccountsManager {
    // Load accounts and keep only supported account types.
    static getAccounts = () => {
        const result = ipcRenderer.sendSync("accounts-read");
        if (!result?.ok) throw new Error(result?.error || "Account storage is unavailable");
        return this.filterSupportedAccounts(result.accounts);
    }

    // Keep only local and Ely.by accounts.
    static filterSupportedAccounts = (accounts) => {
        const supportedTypes = new Set(["local", "elyby"]);
        let filteredAccounts = {};
        let wasChanged = false;

        Object.entries(accounts || {}).forEach(([uuid, accountData]) => {
            const isValid = accountData
                && typeof accountData === "object"
                && supportedTypes.has(accountData.type)
                && typeof accountData.nickname === "string"
                && NICKNAME_REGEX.test(accountData.nickname);

            if (isValid) {
                filteredAccounts[uuid] = {
                    ...accountData,
                    uuid
                };
            } else {
                wasChanged = true;
            }
        });

        if (wasChanged) {
            this.saveAccounts(filteredAccounts, false);
            RxCollector.writeLog("Accounts: Removed unsupported account types");

            let activeAccount = RxConfig.read("activeAccount", "none");
            if (activeAccount !== "none" && typeof filteredAccounts[activeAccount] === "undefined") {
                RxConfig.write("activeAccount", "none");
            }
        }

        return filteredAccounts;
    }

    static saveAccounts = (accounts, reloadUI = true) => {
        const result = ipcRenderer.sendSync("accounts-write", accounts);
        if (!result?.ok) throw new Error(result?.error || "Account storage could not be saved");
        RxCollector.writeLog("Accounts: Saved successfully");
        if (reloadUI) {
            RxAccountsUI.reloadAccountSelect();
            RxAccountsUI.reloadAccountsManager();
        }
        return true;
    }

    // Сохранить новый порядок профилей (порядок ключей объекта = порядок в списке).
    // UI не перерисовываем: строки уже стоят на своих местах после перетаскивания.
    static reorderAccounts = (orderedUuids) => {
        const accounts = RxAccountsManager.getAccounts();
        const reordered = {};
        (orderedUuids || []).forEach((uuid) => {
            if (accounts[uuid]) reordered[uuid] = accounts[uuid];
        });
        Object.keys(accounts).forEach((uuid) => {
            if (!reordered[uuid]) reordered[uuid] = accounts[uuid];
        });
        RxAccountsManager.saveAccounts(reordered, false);
        RxCollector.writeLog("Accounts: Reordered profiles");
        return true;
    }

    static cleanAccountsList = () => {
        RxCollector.writeLog("Accounts: Cleaned successfull");
        this.saveAccounts({});
        return {};
    }

    static getActiveAccount = () => {
        let activeAccount = RxConfig.read("activeAccount", "none");
        if (activeAccount === "none") {
            return "none";
        }
        if (!RxAccountsManager.isAccountExists(activeAccount)) {
            RxConfig.write("activeAccount", "none");
            return "none";
        }
        return activeAccount;
    }

    static setActiveAccount = (accountId) => {
        if (accountId !== "none" && !RxAccountsManager.isAccountExists(accountId)) {
            return false;
        }
        RxConfig.write("activeAccount", accountId);
        RxAccountsUI.reloadAccountsManager();
        RxAccountsUI.reloadAccountSelect();
        if (typeof RxDiscordRpc !== "undefined") RxDiscordRpc.syncSettings();
        return true;
    }

    static getAccount = (uuid) => {
        return RxAccountsManager.getAccounts()[uuid];
    }

    static isAccountExists = (uuid) => {
        let accounts = RxAccountsManager.getAccounts();
        return typeof accounts[uuid] !== "undefined";
    }

    static isAccountExistsByNickname = (nickname, type, exceptUuid = "") => {
        let accounts = RxAccountsManager.getAccounts();
        let exists = false;
        Object.values(accounts).forEach((acc) => {
            if (acc.uuid !== exceptUuid && acc.nickname.toLowerCase() === String(nickname).toLowerCase() && acc.type === type) {
                exists = true;
            }
        });
        return exists;
    }

    static getAccountMCLCData = async (accountId) => {
        if (!RxAccountsManager.isAccountExists(accountId)) {
            return false;
        }

        let accountData = RxAccountsManager.getAccount(accountId);
        if (accountData.type === "local") {
            return Authenticator.getAuth(accountData.nickname);
        }
        if (accountData.type === "elyby") {
            return RxElybyManager.getAccountForAuth(accountId);
        }
        return false;
    }

    static addLocalAccount = (nickname) => {
        if (typeof nickname !== "string") {
            return false;
        }
        nickname = nickname.trim();
        if (!NICKNAME_REGEX.test(nickname)) {
            return false;
        }

        if (RxAccountsManager.isAccountExistsByNickname(nickname, "local")) {
            RxToasts.create(MESSAGES.accounts.alreadyExists);
            return true;
        }

        let accountUUID = crypto.randomUUID();
        let accountData = {
            type: "local",
            nickname: nickname,
            added: Date.now(),
            uuid: accountUUID
        };

        let accountsList = RxAccountsManager.getAccounts();
        accountsList[accountUUID] = accountData;
        RxAccountsManager.saveAccounts(accountsList);

        RxToasts.create(nickname, "person", MESSAGES.accounts.added);
        return true;
    }

    static renameLocalAccount = (uuid, nickname) => {
        if (typeof nickname !== "string") return false;
        nickname = nickname.trim();
        if (!NICKNAME_REGEX.test(nickname)) return false;

        const accounts = RxAccountsManager.getAccounts();
        const account = accounts[uuid];
        if (!account || account.type !== "local") return false;
        if (RxAccountsManager.isAccountExistsByNickname(nickname, "local", uuid)) {
            RxToasts.create(MESSAGES.accounts.alreadyExists, "person_alert");
            return false;
        }
        if (account.nickname === nickname) return true;

        const previousNickname = account.nickname;
        accounts[uuid] = {...account, nickname, updated: Date.now(), uuid};
        RxAccountsManager.saveAccounts(accounts);
        if (typeof RxDiscordRpc !== "undefined") RxDiscordRpc.syncSettings();
        RxCollector.writeLog(`Accounts: Renamed local profile [from=${previousNickname}] [to=${nickname}]`);
        RxToasts.create(MESSAGES.accounts.renamed, "edit", nickname);
        return true;
    }

    static refreshElybyProfiles = async () => {
        let accounts = RxAccountsManager.getAccounts();
        for (const accountData of Object.values(accounts)) {
            if (accountData.type !== "elyby") {
                continue;
            }

            try {
                await RxElybyManager.getHeadURLByPlayerNickname(accountData.nickname);
            } catch (e) {
                console.log(e);
            }
        }
        return true;
    }

    static deleteAccount = (uuid) => {
        if (RxAccountsManager.isAccountExists(uuid)) {
            let accountsList = RxAccountsManager.getAccounts();
            accountsList[uuid] = null;
            delete accountsList[uuid];

            if (RxAccountsManager.getActiveAccount() === uuid) {
                RxConfig.write("activeAccount", "none");
            }
            RxAccountsManager.saveAccounts(accountsList);
            if (typeof RxDiscordRpc !== "undefined") RxDiscordRpc.syncSettings();
            return true;
        }
        return false;
    }
}
