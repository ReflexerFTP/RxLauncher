class RxDiscordRpc {
    static currentServer = "";

    static getActiveNickname = () => {
        try {
            const activeAccount = RxAccountsManager.getActiveAccount();
            const accountData = RxAccountsManager.getAccount(activeAccount);
            return String(accountData?.nickname || "").trim().slice(0, 32);
        } catch (_) {
            return "";
        }
    };

    // В режиме паранойи Discord видит только «играет в Minecraft» — без ника и сервера
    static getSettings = () => ({
        enabled: RxConfig.read("discordRpcEnabled", true) === true,
        showNickname: RxConfig.read("discordRpcShowNickname", true) === true && !RxPrivacy.isParanoid(),
        showServer: RxConfig.read("discordRpcShowServer", true) === true
            && RxConfig.read("serverPrivacyMode", false) !== true
            && !RxPrivacy.isParanoid(),
        showTime: RxConfig.read("discordRpcShowTime", true) === true,
        nickname: RxDiscordRpc.getActiveNickname(),
        language: typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru"
    });

    static syncSettings = () => {
        const settings = RxDiscordRpc.getSettings();
        if (!settings.showServer) RxDiscordRpc.currentServer = "";
        ipcRenderer.send("discord-rpc-settings", settings);
        return settings;
    };

    static sanitizeServer = (value) => {
        let server = String(value || "")
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .trim()
            .slice(0, 80);
        if (!server || !/^[a-z0-9._:\[\]-]+$/i.test(server)) return "";
        return server;
    };

    static formatServer = (host, rawPort) => {
        let cleanHost = String(host || "").replace(/^\//, "").trim();
        if (cleanHost.startsWith("[") && cleanHost.endsWith("]")) {
            cleanHost = cleanHost.slice(1, -1);
        }
        const port = Number(rawPort);
        if (!cleanHost || !Number.isInteger(port) || port < 1 || port > 65535) return "";
        if (cleanHost.includes(":")) cleanHost = `[${cleanHost}]`;
        return RxDiscordRpc.sanitizeServer(port === 25565 ? cleanHost : `${cleanHost}:${port}`);
    };

    static detectServerFromLog = (rawLine) => {
        const line = String(rawLine || "").replace(/\u001b\[[0-9;]*m/g, " ");
        if (!/\[(?:Render|Client) thread\/INFO\].{0,160}\bConnecting to\b/i.test(line)) return false;
        const commaMatch = line.match(/\bConnecting to\s+(?:\/)?(\[[0-9a-f:]+\]|[a-z0-9._-]+)\s*,\s*(\d{1,5})/i);
        if (commaMatch) return RxDiscordRpc.formatServer(commaMatch[1], commaMatch[2]);
        const portMatch = line.match(/\bConnecting to\s+(?:\/)?([a-z0-9._-]+):(\d{1,5})/i);
        if (portMatch) return RxDiscordRpc.formatServer(portMatch[1], portMatch[2]);
        return false;
    };

    static updateGameServer = (server) => {
        const sanitized = RxDiscordRpc.sanitizeServer(server);
        if (sanitized === RxDiscordRpc.currentServer) return false;
        RxDiscordRpc.currentServer = sanitized;
        ipcRenderer.send("discord-rpc-game-update", {server: sanitized});
        return true;
    };

    static handleGameLog = (rawLine) => {
        if (!RxDiscordRpc.getSettings().showServer) return false;
        const detectedServer = RxDiscordRpc.detectServerFromLog(rawLine);
        if (detectedServer !== false) return RxDiscordRpc.updateGameServer(detectedServer);
        const line = String(rawLine || "");
        if (/\bDisconnected from server\b|\bConnection lost\b|\bDisconnecting from\b/i.test(line)) {
            return RxDiscordRpc.updateGameServer("");
        }
        return false;
    };

    static startGame = (payload = {}) => {
        const settings = RxDiscordRpc.getSettings();
        RxDiscordRpc.currentServer = settings.showServer
            ? RxDiscordRpc.sanitizeServer(payload.server)
            : "";
        ipcRenderer.send("discord-rpc-game-start", {
            nickname: String(payload.nickname || settings.nickname || "Player").trim().slice(0, 32),
            server: RxDiscordRpc.currentServer,
            version: String(payload.version || "").trim().slice(0, 24),
            loaderType: String(payload.loaderType || "vanilla")
        });
    };

    static stopGame = () => {
        RxDiscordRpc.currentServer = "";
        ipcRenderer.send("discord-rpc-game-stop");
    };
}
