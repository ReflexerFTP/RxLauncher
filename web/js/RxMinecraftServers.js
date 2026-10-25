class RxMinecraftServers {
    static CONFIG_KEY = "savedCatalogServers";

    static normalizeAddress = (value) => {
        if (typeof value !== "string") {
            throw new TypeError("Minecraft server address must be a string");
        }

        const input = value.trim();
        if (!input || input.length > 320 || /[\s\u0000-\u001f\u007f]/.test(input)) {
            throw new TypeError("Invalid Minecraft server address");
        }
        if (/[\\/@?#]/.test(input)) {
            throw new TypeError("Minecraft server address must not contain a protocol or path");
        }

        let host;
        let port = "";
        let isIpv6 = false;

        if (input.startsWith("[")) {
            const ipv6Match = input.match(/^\[([^\]]+)](?::([0-9]+))?$/);
            if (!ipv6Match || require("net").isIP(ipv6Match[1]) !== 6) {
                throw new TypeError("Invalid bracketed IPv6 server address");
            }
            host = RxMinecraftServers.normalizeIpv6(ipv6Match[1]);
            port = ipv6Match[2] || "";
            isIpv6 = true;
        } else {
            const colonCount = (input.match(/:/g) || []).length;
            if (colonCount > 1) {
                throw new TypeError("IPv6 server addresses must be enclosed in brackets");
            }

            if (colonCount === 1) {
                const separator = input.lastIndexOf(":");
                host = input.slice(0, separator);
                port = input.slice(separator + 1);
            } else {
                host = input;
            }

            host = RxMinecraftServers.normalizeHost(host);
        }

        if (port) {
            if (!/^[0-9]{1,5}$/.test(port)) {
                throw new TypeError("Invalid Minecraft server port");
            }
            const parsedPort = Number(port);
            if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
                throw new RangeError("Minecraft server port must be between 1 and 65535");
            }
            port = String(parsedPort);
        } else if (input.endsWith(":")) {
            throw new TypeError("Minecraft server port is missing");
        }

        return `${isIpv6 ? `[${host}]` : host}${port ? `:${port}` : ""}`;
    };

    static normalizeIpv6 = (host) => {
        const lowerHost = host.toLowerCase();
        try {
            const parsed = new (require("url").URL)(`http://[${lowerHost}]`);
            return parsed.hostname.replace(/^\[|]$/g, "").toLowerCase();
        } catch (error) {
            return lowerHost;
        }
    };

    static normalizeHost = (host) => {
        if (typeof host !== "string" || !host) {
            throw new TypeError("Minecraft server host is missing");
        }

        if (/^[0-9.]+$/.test(host)) {
            const octets = host.split(".");
            if (octets.length !== 4 || octets.some((octet) => !/^[0-9]{1,3}$/.test(octet) || Number(octet) > 255)) {
                throw new TypeError("Invalid IPv4 server address");
            }
            return octets.map((octet) => String(Number(octet))).join(".");
        }

        const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
        const asciiHost = require("url").domainToASCII(withoutTrailingDot).toLowerCase();
        if (!asciiHost || asciiHost.length > 253) {
            throw new TypeError("Invalid Minecraft server domain");
        }

        const labels = asciiHost.split(".");
        if (labels.some((label) => (
            !label
            || label.length > 63
            || !/^[a-z0-9-]+$/.test(label)
            || label.startsWith("-")
            || label.endsWith("-")
        ))) {
            throw new TypeError("Invalid Minecraft server domain");
        }

        return asciiHost;
    };

    static normalizeServer = (server) => {
        const source = typeof server === "string" ? {ip: server} : server;
        if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw new TypeError("Minecraft server must be an object or address string");
        }

        const ip = RxMinecraftServers.normalizeAddress(source.ip || source.address || "");
        const rawName = typeof source.name === "string" ? source.name : "";
        const name = rawName
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 128) || ip;

        return {name, ip};
    };

    static addressKey = (address) => {
        try {
            return RxMinecraftServers.normalizeAddress(address);
        } catch (error) {
            return String(address || "").trim().toLowerCase();
        }
    };

    static getSavedServers = () => {
        const configured = RxConfig.read(RxMinecraftServers.CONFIG_KEY, []);
        if (!Array.isArray(configured)) {
            return [];
        }

        const seen = new Set();
        const result = [];
        configured.forEach((server) => {
            try {
                const normalized = RxMinecraftServers.normalizeServer(server);
                const key = RxMinecraftServers.addressKey(normalized.ip);
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(normalized);
                }
            } catch (error) {
                // Ignore malformed legacy/user-edited entries instead of writing them to servers.dat.
            }
        });
        return result;
    };

    static isSaved = (server) => {
        let key;
        try {
            const address = typeof server === "string" ? server : server?.ip || server?.address;
            key = RxMinecraftServers.addressKey(RxMinecraftServers.normalizeAddress(address));
        } catch (error) {
            return false;
        }
        return RxMinecraftServers.getSavedServers().some((item) => RxMinecraftServers.addressKey(item.ip) === key);
    };

    static add = (server) => {
        const normalized = RxMinecraftServers.normalizeServer(server);
        if (RxMinecraftServers.isSaved(normalized.ip)) {
            return false;
        }

        const saved = RxMinecraftServers.getSavedServers();
        saved.push(normalized);
        RxConfig.write(RxMinecraftServers.CONFIG_KEY, saved);
        return true;
    };

    static createStringTag = (value) => {
        const tag = new NBT.Tags.TAGString();
        tag.setValue(value);
        return tag;
    };

    static createByteTag = (value) => {
        const tag = new NBT.Tags.TAGByte();
        tag.setValue(value);
        return tag;
    };

    static createServerTag = (server) => {
        const tag = new NBT.Tags.TAGCompound();
        tag.setValue({
            name: RxMinecraftServers.createStringTag(server.name),
            ip: RxMinecraftServers.createStringTag(server.ip),
            hidden: RxMinecraftServers.createByteTag(0),
            acceptTextures: RxMinecraftServers.createByteTag(1)
        });
        return tag;
    };

    static createEmptyDocument = () => {
        const document = new NBT();
        const servers = new NBT.Tags.TAGList();
        servers.setValue([]);
        const root = new NBT.Tags.TAGCompound();
        root.setValue({servers});
        root.id = "";
        document.root[""] = root;
        return document;
    };

    static parseDocument = (buffer) => {
        const document = new NBT();
        let parseError = null;
        document.loadFromBuffer(buffer, (error) => {
            parseError = error || null;
        });
        if (parseError) {
            throw parseError;
        }
        return document;
    };

    static getServersList = (document) => {
        const root = document.select("");
        if (!root || root.getType() !== "TAG_Compound") {
            throw new Error("servers.dat does not contain the expected root compound");
        }

        let servers = root.select("servers");
        if (!servers) {
            servers = new NBT.Tags.TAGList();
            servers.setValue([]);
            root.setByName("servers", servers);
        }
        if (servers.getType() !== "TAG_List") {
            throw new Error("servers.dat contains an invalid servers tag");
        }

        for (let index = 0; index < servers.count(); index++) {
            if (servers.selectAt(index)?.getType() !== "TAG_Compound") {
                throw new Error("servers.dat contains a non-compound server entry");
            }
        }
        return servers;
    };

    static writeAtomically = (targetPath, buffer) => {
        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const temporaryPath = `${targetPath}.rxlaunch-tmp-${suffix}`;
        const displacedPath = `${targetPath}.rxlaunch-replace-${suffix}`;
        let fileDescriptor = null;

        try {
            fileDescriptor = fs.openSync(temporaryPath, "wx");
            fs.writeFileSync(fileDescriptor, buffer);
            fs.fsyncSync(fileDescriptor);
            fs.closeSync(fileDescriptor);
            fileDescriptor = null;

            try {
                fs.renameSync(temporaryPath, targetPath);
            } catch (replaceError) {
                if (!fs.existsSync(targetPath)) {
                    throw replaceError;
                }

                fs.renameSync(targetPath, displacedPath);
                try {
                    fs.renameSync(temporaryPath, targetPath);
                } catch (secondError) {
                    if (!fs.existsSync(targetPath) && fs.existsSync(displacedPath)) {
                        fs.renameSync(displacedPath, targetPath);
                    }
                    throw secondError;
                }
                try { fs.unlinkSync(displacedPath); } catch (error) { /* replacement already succeeded */ }
            }
        } finally {
            if (fileDescriptor !== null) {
                try { fs.closeSync(fileDescriptor); } catch (error) { /* already closed */ }
            }
            if (fs.existsSync(temporaryPath)) {
                try { fs.unlinkSync(temporaryPath); } catch (error) { /* best effort cleanup */ }
            }
        }
    };

    static syncToDirectory = (gameDirectory) => {
        if (typeof gameDirectory !== "string" || !gameDirectory.trim() || gameDirectory.includes("\u0000")) {
            throw new TypeError("A valid Minecraft game directory is required");
        }

        const saved = RxMinecraftServers.getSavedServers();
        const resolvedDirectory = path.resolve(gameDirectory);
        const targetPath = path.join(resolvedDirectory, "servers.dat");
        const backupPath = `${targetPath}.rxlaunch-backup`;

        if (saved.length === 0) {
            return {changed: false, added: 0, path: targetPath, backupPath: null};
        }

        fs.mkdirSync(resolvedDirectory, {recursive: true});
        const existed = fs.existsSync(targetPath);
        const originalBuffer = existed ? fs.readFileSync(targetPath) : null;
        const document = existed
            ? RxMinecraftServers.parseDocument(originalBuffer)
            : RxMinecraftServers.createEmptyDocument();
        const serversList = RxMinecraftServers.getServersList(document);

        const existingAddresses = new Set();
        for (let index = 0; index < serversList.count(); index++) {
            const ipTag = serversList.selectAt(index).select("ip");
            if (ipTag && ipTag.getType() === "TAG_String") {
                existingAddresses.add(RxMinecraftServers.addressKey(ipTag.getValue()));
            }
        }

        let added = 0;
        saved.forEach((server) => {
            const key = RxMinecraftServers.addressKey(server.ip);
            if (existingAddresses.has(key)) {
                return;
            }
            serversList.push(RxMinecraftServers.createServerTag(server));
            existingAddresses.add(key);
            added++;
        });

        if (added === 0) {
            return {changed: false, added: 0, path: targetPath, backupPath: null};
        }

        const outputBuffer = document.writeToBuffer();
        if (existed) {
            fs.copyFileSync(targetPath, backupPath);
        }
        try {
            RxMinecraftServers.writeAtomically(targetPath, outputBuffer);
        } catch (error) {
            if (existed && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, targetPath);
            }
            throw error;
        }

        return {
            changed: true,
            added,
            path: targetPath,
            backupPath: existed ? backupPath : null
        };
    };

    static resolveCurrentGameDirectory = () => {
        const activeVersion = RxVersionsManager.getActiveVersion();
        if (!activeVersion || activeVersion === "none") {
            return GAME_DATA;
        }

        if (typeof RxUtils !== "undefined" && typeof RxUtils.getGameRoot === "function") {
            return RxUtils.getGameRoot(activeVersion);
        }

        const parsed = RxVersionsManager.parseVersionID(activeVersion);
        if (parsed.type === "pack") {
            return path.join(GAME_DATA, "modpacks", parsed.name);
        }
        if (RxConfig.read("separatedStorage", false) === true || RxConfig.read("fullySeparatedStorage", false) === true) {
            return path.join(GAME_DATA, "home", activeVersion);
        }
        return GAME_DATA;
    };

    static syncForCurrentVersion = () => {
        return RxMinecraftServers.syncToDirectory(RxMinecraftServers.resolveCurrentGameDirectory());
    };
}
