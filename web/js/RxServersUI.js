class RxServersUI {
    static HISTORY_PATH = path.join(USERDATA_PATH, "server-status-history.json");
    static HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
    static HISTORY_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;
    static REFRESH_INTERVAL_MS = 2 * 60 * 1000;
    static CUSTOM_CONFIG_KEY = "customCatalogServers";
    static BUILTIN_SERVERS = Object.freeze([
        {id: "funtime", name: "FunTime", address: "play.funtime.su", category: "anarchy", flVersion: "vanilla-1.21.4"},
        {id: "holyworld", name: "HolyWorld", address: "hub.holyworld.ru", category: "anarchy", flVersion: "vanilla-1.21.4"},
        {id: "reallyworld", name: "ReallyWorld", address: "mc.reallyworld.me", category: "grief", flVersion: "vanilla-1.21.4"},
        {id: "artygrief", name: "ArtyGrief", address: "mc.artygrief.net", category: "grief", flVersion: "vanilla-1.21.4"},
        {id: "wellmine", name: "WellMine", address: "mc.wellmine.fun", category: "grief", flVersion: "vanilla-1.21.4"},
        {id: "winworld", name: "WinWorld", address: "mc.winworld.pw", category: "grief", flVersion: "vanilla-1.21.4"},
        {id: "infinitybox", name: "InfinityBox", address: "play.infinitybox.pro", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "surebox", name: "SureBox", address: "play.surebox.pro", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "bitbox", name: "BitBox", address: "bitbox.wtf", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "fantasybox", name: "FantasyBox", address: "play.fantasybox.fun", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "godbox", name: "GodBox", address: "mc.godbox.fun", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "reserv", name: "Reserv", address: "play.reserv.fun", category: "boxpvp", flVersion: "vanilla-1.21.4"},
        {id: "overbox", name: "OverBox", address: "play.overbox.fun", category: "boxpvp", flVersion: "vanilla-1.21.4"}
    ]);

    static statuses = new Map();
    static history = null;
    static bound = false;
    static loaded = false;
    static filter = "all";
    static search = "";
    static sort = "online-desc";
    static refreshTimer = null;
    static refreshGeneration = 0;
    static expandedAddress = "";
    static connectivity = {value: false, checkedAt: 0};

    static message = (key, fallback = "") => MESSAGES?.servers?.catalog?.[key] || fallback;

    static locale = () => {
        const language = typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru";
        return language === "ru" ? "ru-RU" : "en-US";
    };

    static formatNumber = (value) => new Intl.NumberFormat(RxServersUI.locale()).format(Math.max(0, Number(value) || 0));

    static normalizeAddress = (value) => {
        if (typeof RxMinecraftServers !== "undefined") {
            try {
                return RxMinecraftServers.normalizeAddress(String(value || ""));
            } catch (_) {
                return "";
            }
        }
        const address = String(value || "").trim().toLowerCase();
        if (!address || address.length > 255 || /[\s/\\?#@]/.test(address)) return "";

        const bracketedIpv6 = address.match(/^\[([0-9a-f:]+)](?::(\d{1,5}))?$/i);
        if (bracketedIpv6) {
            const port = bracketedIpv6[2] ? Number(bracketedIpv6[2]) : 25565;
            return port > 0 && port <= 65535 ? address : "";
        }

        const hostAndPort = address.match(/^([a-z0-9._-]+)(?::(\d{1,5}))?$/i);
        if (!hostAndPort) return "";
        const port = hostAndPort[2] ? Number(hostAndPort[2]) : 25565;
        if (port < 1 || port > 65535 || hostAndPort[1].startsWith(".") || hostAndPort[1].endsWith(".")) return "";
        return address;
    };

    static normalizeName = (value, fallback = "Minecraft Server") => {
        const name = String(value || "")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 48);
        return name || fallback;
    };

    static flattenStatusText = (value, depth = 0, seen = new Set()) => {
        if (depth > 5 || value === null || typeof value === "undefined") return "";
        if (typeof value === "string" || typeof value === "number") return String(value);
        if (Array.isArray(value)) {
            return value.map((item) => RxServersUI.flattenStatusText(item, depth + 1, seen)).filter(Boolean).join("\n");
        }
        if (typeof value !== "object" || seen.has(value)) return "";
        seen.add(value);

        const preferredKeys = ["clean", "text", "motd", "description", "raw", "name"];
        for (const key of preferredKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const primary = RxServersUI.flattenStatusText(value[key], depth + 1, seen);
            if (!primary) continue;
            if (key === "text" && Array.isArray(value.extra)) {
                const extra = RxServersUI.flattenStatusText(value.extra, depth + 1, seen);
                return `${primary}${extra}`;
            }
            return primary;
        }
        return "";
    };

    static cleanStatusText = (value, maxLength = 300) => RxServersUI.flattenStatusText(value)
        .replace(/\u00a7[0-9a-fk-orx]/gi, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n")
        .trim()
        .slice(0, maxLength);

    static normalizeFavicon = (value) => {
        const icon = typeof value === "string" ? value.trim() : "";
        if (!icon || icon.length > 1500000) return "";
        const match = icon.match(/^data:image\/png;base64,([a-z0-9+/=\s]+)$/i);
        if (!match) return "";
        const base64 = match[1].replace(/\s+/g, "");
        if (base64.length < 16 || base64.length % 4 === 1) return "";
        return `data:image/png;base64,${base64}`;
    };

    static normalizeStatusResponse = (address, payload) => {
        const normalizedAddress = RxServersUI.normalizeAddress(address);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return {reachable: false, online: false, address: normalizedAddress, error: "invalid_response", checkedAt: Date.now()};
        }

        const hasServerEnvelope = Object.prototype.hasOwnProperty.call(payload, "server");
        const source = hasServerEnvelope && payload.server && typeof payload.server === "object"
            ? payload.server
            : payload;
        const reachable = typeof payload.reachable === "boolean"
            ? payload.reachable
            : hasServerEnvelope || typeof payload.online === "boolean";
        const online = reachable && (hasServerEnvelope ? source !== payload : payload.online === true);
        const players = source?.players && typeof source.players === "object" ? source.players : payload.players || {};
        const motd = RxServersUI.cleanStatusText(
            source?.motd || source?.description || payload.motd || payload.description,
            300
        );
        const version = RxServersUI.cleanStatusText(
            source?.version || source?.protocol?.name || payload.version || payload.protocol?.name,
            100
        );
        const icon = RxServersUI.normalizeFavicon(
            source?.icon || source?.favicon || payload.icon || payload.favicon
        );
        const pingValue = source?.ping ?? source?.latency ?? payload.ping ?? payload.latency;
        const checkedAt = Number.isFinite(Number(payload.checkedAt)) ? Number(payload.checkedAt) : Date.now();
        const provider = String(payload.provider || (hasServerEnvelope ? "minecraftpinger.com" : "mcsrvstat.us"));

        return {
            reachable,
            online,
            address: normalizedAddress,
            players: {
                online: Math.max(0, Math.round(Number(players?.online) || 0)),
                max: Math.max(0, Math.round(Number(players?.max) || 0))
            },
            motd,
            version,
            icon,
            ping: Number.isFinite(Number(pingValue)) ? Math.max(0, Math.round(Number(pingValue))) : null,
            provider,
            checkedAt,
            error: reachable ? "" : String(payload.error || "invalid_response")
        };
    };

    static iconHue = (address) => {
        let hash = 0;
        for (const character of String(address || "")) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
        return Math.abs(hash) % 360;
    };

    static categoryName = (category) => ({
        anarchy: "Anarchy",
        grief: "Grief",
        boxpvp: "BoxPvP",
        survival: "Survival",
        minigames: "Minigames",
        other: "Minecraft"
    }[category] || "Custom");

    static idForAddress = (address) => {
        let hash = 2166136261;
        for (const char of address) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return `custom-${(hash >>> 0).toString(36)}`;
    };

    static getCustomServers = () => {
        const raw = RxConfig.read(RxServersUI.CUSTOM_CONFIG_KEY, []);
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        return raw.map((item) => {
            const address = RxServersUI.normalizeAddress(item?.address || item?.ip);
            const category = ["anarchy", "grief", "boxpvp"].includes(item?.category) ? item.category : "anarchy";
            if (!address || seen.has(address)) return null;
            seen.add(address);
            return {
                id: RxServersUI.idForAddress(address),
                name: RxServersUI.normalizeName(item?.name, address),
                address,
                category,
                flVersion: String(item?.flVersion || "vanilla-1.21.4"),
                custom: true
            };
        }).filter(Boolean);
    };

    static getServers = () => {
        const seen = new Set();
        // Рекомендованные админом (с сайта) — первыми
        const recommended = typeof RxFeed !== "undefined" ? RxFeed.recommendedServers() : [];
        return [...recommended, ...RxServersUI.BUILTIN_SERVERS, ...RxServersUI.getCustomServers()]
            .map((server) => ({...server, address: RxServersUI.normalizeAddress(server.address)}))
            .filter((server) => {
                if (!server.address || seen.has(server.address)) return false;
                seen.add(server.address);
                return true;
            });
    };

    static findServer = (address) => {
        const normalized = RxServersUI.normalizeAddress(address);
        return RxServersUI.getServers().find((server) => server.address === normalized) || null;
    };

    static bind = () => {
        if (RxServersUI.bound) return true;
        const $modal = $("#modal-servers");
        if ($modal.length === 0) return false;
        RxServersUI.bound = true;

        $modal.on("click", "[data-server-action]", async function (event) {
            event.preventDefault();
            event.stopPropagation();
            const action = $(this).data("server-action");
            const address = $(this).closest("[data-server-address]").data("server-address") || "";

            switch (action) {
                case "refresh":
                    await RxServersUI.refreshServersInfo(true);
                    break;
                case "retry":
                    if (await RxServersUI.canOpen(true)) await RxServersUI.loadList(true);
                    else RxServersUI.notify(RxServersUI.message("noInternetToast", "Нет подключения к интернету"), "wifi_off");
                    break;
                case "retry-server":
                    await RxServersUI.retryServer(address);
                    break;
                case "open-add":
                    RxServersUI.openAddPanel();
                    break;
                case "close-add":
                    RxServersUI.closeAddPanel();
                    break;
                case "save-custom":
                    await RxServersUI.saveCustomServer();
                    break;
                case "expand":
                    RxServersUI.toggleDetails(address);
                    break;
                case "copy":
                    await RxServersUI.copyServerIP(address);
                    break;
                case "add":
                    await RxServersUI.addToMinecraft(address);
                    break;
                case "play":
                    await RxServersUI.playOnServer(address);
                    break;
                case "delete":
                    RxServersUI.deleteCustomServer(address);
                    break;
            }
        });

        $modal.on("click", "[data-server-category]", function () {
            RxServersUI.filter = String($(this).data("server-category") || "all");
            $modal.find("[data-server-category]").removeClass("active");
            $(this).addClass("active");
            RxServersUI.render();
        });

        $modal.on("input", "[data-server-search]", function () {
            RxServersUI.search = String($(this).val() || "").trim().toLowerCase();
            RxServersUI.render();
        });

        $modal.on("change", "[data-server-sort]", function () {
            RxServersUI.sort = String($(this).val() || "online-desc");
            RxServersUI.render();
        });

        $modal.on("keydown", "[data-custom-server-address]", async function (event) {
            if (event.key === "Enter") await RxServersUI.saveCustomServer();
        });

        $modal.on("keydown", ".server-card-main", function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            RxServersUI.toggleDetails($(this).closest("[data-server-address]").data("server-address"));
        });
        return true;
    };

    static canOpen = async (force = false) => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
        const cacheAge = Date.now() - RxServersUI.connectivity.checkedAt;
        if (!force && cacheAge < 15000) return RxServersUI.connectivity.value;
        try {
            const allowDirect = RxConfig.read("serverPrivacyMode", false) !== true;
            const value = await ipcRenderer.invoke("server-catalog-connectivity", force === true, {allowDirect});
            RxServersUI.connectivity = {value: value === true, checkedAt: Date.now()};
            return value === true;
        } catch (error) {
            RxCollector.writeLog(`Servers: Connectivity check failed [error=${error}]`);
            RxServersUI.connectivity = {value: false, checkedAt: Date.now()};
            return false;
        }
    };

    static onShow = async () => {
        RxServersUI.bind();
        await RxServersUI.loadList();
        RxServersUI.startRefreshTimer();
    };

    static onHide = () => {
        RxServersUI.stopRefreshTimer();
        RxServersUI.closeAddPanel();
    };

    static startRefreshTimer = () => {
        RxServersUI.stopRefreshTimer();
        if (RxConfig.read("serverPrivacyMode", false) === true) return;
        RxServersUI.refreshTimer = setInterval(() => {
            if (RxModals.isModalShown("servers")) RxServersUI.refreshServersInfo();
        }, RxServersUI.REFRESH_INTERVAL_MS);
    };

    static stopRefreshTimer = () => {
        if (RxServersUI.refreshTimer) clearInterval(RxServersUI.refreshTimer);
        RxServersUI.refreshTimer = null;
    };

    static showState = (state) => {
        const $modal = $("#modal-servers");
        const offline = state === "offline";
        const error = state === "error";
        const loading = state === "loading";
        const empty = state === "empty";
        $modal.find("[data-server-offline]").prop("hidden", !offline);
        $modal.find("[data-server-error]").prop("hidden", !error);
        $modal.find("[data-server-loading]").prop("hidden", !loading);
        $modal.find("[data-server-empty]").prop("hidden", !empty);
        $modal.find("[data-server-content]").prop("hidden", offline || error || loading || empty);
        $modal.find("[data-server-footer]").prop("hidden", offline || error || loading);
        if (error) {
            $modal.find("[data-server-error-title]").text(
                RxServersUI.message("statusError", "Server status is temporarily unavailable")
            );
            $modal.find("[data-server-error-hint]").text(
                RxServersUI.message("statusErrorHint", "The catalog is available, but status providers did not respond. Try again.")
            );
            $modal.find("[data-server-error-retry]").text(RxServersUI.message("retry", "Retry"));
        }
    };

    static loadList = async (force = false) => {
        if (!RxServersUI.loaded) RxServersUI.showState("loading");
        const online = await RxServersUI.canOpen(force);
        if (!online) {
            RxServersUI.showState("offline");
            return false;
        }

        RxServersUI.loadHistory();
        RxServersUI.loaded = true;
        RxServersUI.render();
        await RxServersUI.refreshServersInfo(force);
        return true;
    };

    static loadHistory = () => {
        if (RxServersUI.history) return RxServersUI.history;
        const clean = {version: 1, updatedAt: Date.now(), servers: {}};
        try {
            if (!fs.existsSync(RxServersUI.HISTORY_PATH)) {
                RxServersUI.history = clean;
                return clean;
            }
            const parsed = JSON.parse(fs.readFileSync(RxServersUI.HISTORY_PATH, "utf8"));
            if (!parsed || typeof parsed !== "object" || typeof parsed.servers !== "object") throw new Error("Invalid history");
            RxServersUI.history = {version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), servers: parsed.servers || {}};
        } catch (error) {
            try {
                fs.copyFileSync(RxServersUI.HISTORY_PATH, `${RxServersUI.HISTORY_PATH}.corrupt-${Date.now()}`);
            } catch (_) {
                // The original file is left untouched if a backup cannot be created.
            }
            RxCollector.writeLog(`Servers: History reset [error=${error}]`);
            RxServersUI.history = clean;
        }
        RxServersUI.pruneHistory();
        return RxServersUI.history;
    };

    static pruneHistory = () => {
        const history = RxServersUI.history || RxServersUI.loadHistory();
        const cutoff = Date.now() - RxServersUI.HISTORY_RETENTION_MS;
        Object.keys(history.servers).forEach((address) => {
            const samples = Array.isArray(history.servers[address]) ? history.servers[address] : [];
            history.servers[address] = samples
                .filter((sample) => Number(sample?.at) >= cutoff && Number.isFinite(Number(sample?.online)))
                .slice(-7200)
                .map((sample) => ({
                    at: Number(sample.at),
                    online: Math.max(0, Math.round(Number(sample.online) || 0)),
                    max: Math.max(0, Math.round(Number(sample.max) || 0))
                }));
            if (history.servers[address].length === 0) delete history.servers[address];
        });
    };

    static saveHistory = () => {
        try {
            RxServersUI.pruneHistory();
            RxServersUI.history.updatedAt = Date.now();
            fs.mkdirSync(path.dirname(RxServersUI.HISTORY_PATH), {recursive: true});
            const temporaryPath = `${RxServersUI.HISTORY_PATH}.tmp`;
            fs.writeFileSync(temporaryPath, JSON.stringify(RxServersUI.history, null, 2), "utf8");
            try {
                fs.renameSync(temporaryPath, RxServersUI.HISTORY_PATH);
            } catch (replaceError) {
                fs.copyFileSync(temporaryPath, RxServersUI.HISTORY_PATH);
                fs.unlinkSync(temporaryPath);
            }
            return true;
        } catch (error) {
            RxCollector.writeLog(`Servers: Failed to save history [error=${error}]`);
            return false;
        }
    };

    static recordSnapshot = (address, status) => {
        if (!status?.online) return false;
        const history = RxServersUI.history || RxServersUI.loadHistory();
        const samples = Array.isArray(history.servers[address]) ? history.servers[address] : [];
        const last = samples[samples.length - 1];
        if (last && Date.now() - Number(last.at) < RxServersUI.HISTORY_SAMPLE_INTERVAL_MS) return false;
        samples.push({
            at: Date.now(),
            online: Math.max(0, Math.round(Number(status.players?.online) || 0)),
            max: Math.max(0, Math.round(Number(status.players?.max) || 0))
        });
        history.servers[address] = samples;
        return true;
    };

    static historyStats = (address) => {
        const samples = [...(RxServersUI.loadHistory().servers[address] || [])].slice(-240);
        if (samples.length === 0) return {samples, peak: 0, average: 0};
        const values = samples.map((sample) => Math.max(0, Number(sample.online) || 0));
        return {
            samples,
            peak: Math.max(...values),
            average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        };
    };

    static sortedAndFilteredServers = () => {
        const matches = RxServersUI.getServers().filter((server) => {
            if (RxServersUI.filter !== "all" && server.category !== RxServersUI.filter) return false;
            if (!RxServersUI.search) return true;
            return `${server.name} ${server.address} ${RxServersUI.categoryName(server.category)}`
                .toLowerCase()
                .includes(RxServersUI.search);
        });

        return matches.sort((left, right) => {
            if (Boolean(left.recommended) !== Boolean(right.recommended)) return left.recommended ? -1 : 1;
            if (RxServersUI.sort === "name") return left.name.localeCompare(right.name, RxServersUI.locale());
            const leftOnline = RxServersUI.statuses.get(left.address)?.online
                ? Number(RxServersUI.statuses.get(left.address).players?.online) || 0
                : -1;
            const rightOnline = RxServersUI.statuses.get(right.address)?.online
                ? Number(RxServersUI.statuses.get(right.address).players?.online) || 0
                : -1;
            if (leftOnline === rightOnline) return left.name.localeCompare(right.name, RxServersUI.locale());
            return RxServersUI.sort === "online-asc" ? leftOnline - rightOnline : rightOnline - leftOnline;
        });
    };

    static fallbackDescription = (server) => server.description || ({
        anarchy: "Anarchy Minecraft Network",
        grief: "Grief Minecraft Network",
        boxpvp: "BoxPvP Minecraft Network"
    }[server.category] || "Minecraft Server");

    static createChart = (samples) => {
        if (!Array.isArray(samples) || samples.length < 2) {
            return $("<div>").addClass("server-chart-empty")
                .text(RxServersUI.message("graphEmpty", "График появится после нескольких измерений"));
        }

        const recent = samples.slice(-72);
        const width = 640;
        const height = 108;
        const top = 7;
        const bottom = 101;
        const maxValue = Math.max(1, ...recent.map((sample) => Number(sample.online) || 0));
        const points = recent.map((sample, index) => {
            const x = recent.length === 1 ? width / 2 : index * width / (recent.length - 1);
            const y = bottom - ((Number(sample.online) || 0) / maxValue) * (bottom - top);
            return [Number(x.toFixed(2)), Number(y.toFixed(2))];
        });

        const namespace = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(namespace, "svg");
        svg.setAttribute("class", "server-chart");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", RxServersUI.message("graphTitle", "История онлайна"));

        [25, 54, 83].forEach((y) => {
            const line = document.createElementNS(namespace, "line");
            line.setAttribute("class", "server-chart-grid");
            line.setAttribute("x1", "0");
            line.setAttribute("x2", String(width));
            line.setAttribute("y1", String(y));
            line.setAttribute("y2", String(y));
            svg.appendChild(line);
        });

        const area = document.createElementNS(namespace, "path");
        area.setAttribute("class", "server-chart-area");
        area.setAttribute("d", `M 0 ${bottom} L ${points.map(([x, y]) => `${x} ${y}`).join(" L ")} L ${width} ${bottom} Z`);
        svg.appendChild(area);

        const polyline = document.createElementNS(namespace, "polyline");
        polyline.setAttribute("class", "server-chart-line");
        polyline.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
        svg.appendChild(polyline);

        const [lastX, lastY] = points[points.length - 1];
        const circle = document.createElementNS(namespace, "circle");
        circle.setAttribute("class", "server-chart-last");
        circle.setAttribute("cx", String(lastX));
        circle.setAttribute("cy", String(lastY));
        circle.setAttribute("r", "5");
        svg.appendChild(circle);
        return $(svg);
    };

    static createCard = (server) => {
        const privacy = RxConfig.read("serverPrivacyMode", false) === true;
        const status = RxServersUI.statuses.get(server.address) || null;
        const online = status?.online === true;
        const failed = status?.reachable === false;
        const history = RxServersUI.historyStats(server.address);
        const current = online ? RxServersUI.formatNumber(status.players?.online) : "—";
        const motd = failed
            ? RxServersUI.message("statusError", "Server status is temporarily unavailable")
            : status?.motd || RxServersUI.fallbackDescription(server);
        const version = status?.version || RxServersUI.message("autoVersion", "Автовыбор");
        const saved = typeof RxMinecraftServers !== "undefined" && RxMinecraftServers.isSaved(server.address);
        const stateClass = failed ? "error" : status ? (online ? "online" : "offline") : "";
        const liveText = online
            ? `${RxServersUI.formatNumber(status.players?.online)} ${RxServersUI.message("online", "online")}`
            : failed
                ? RxServersUI.message("retry", "Retry")
                : status ? RxServersUI.message("offline", "Offline") : "…";

        const $card = $("<article>")
            .addClass("server-card")
            .toggleClass("expanded", RxServersUI.expandedAddress === server.address)
            .attr("role", "listitem")
            .attr("data-server-address", server.address);

        const $main = $("<div>").addClass("server-card-main")
            .attr("data-server-action", "expand")
            .attr("role", "button")
            .attr("tabindex", "0")
            .attr("aria-expanded", RxServersUI.expandedAddress === server.address ? "true" : "false");
        const $icon = $("<div>").addClass("server-card-icon")
            .css("--server-icon-hue", String(RxServersUI.iconHue(server.address)));
        $icon.append($("<span>").addClass("server-card-icon-fallback")
            .attr("aria-hidden", "true")
            .text(server.name.slice(0, 1).toUpperCase()));
        const favicon = RxServersUI.normalizeFavicon(status?.icon);
        if (favicon) {
            const $image = $("<img>").attr({
                src: favicon,
                alt: `${server.name} icon`,
                draggable: "false",
                decoding: "async"
            });
            $image.one("error", function () {
                $(this).remove();
                $icon.addClass("server-card-icon-failed");
            });
            $icon.append($image);
        }
        $icon.append($("<span>").addClass(`server-card-status-dot ${stateClass}`));

        const $copy = $("<div>").addClass("server-card-copy");
        const $titleRow = $("<div>").addClass("server-card-title-row")
            .append($("<span>").addClass("server-card-title").text(server.name))
            .append($("<span>").addClass("server-card-category").text(RxServersUI.categoryName(server.category)));
        if (server.custom) {
            $titleRow.append($("<span>").addClass("server-card-category").text(RxServersUI.message("custom", "Custom")));
        }
        if (server.recommended) {
            $titleRow.append($("<span>").addClass("server-card-category recommended")
                .append($("<span>").addClass("material-symbols-outlined").text("star"))
                .append(document.createTextNode(MESSAGES.feed.recommended)));
        }
        $copy.append($titleRow)
            .append($("<span>").addClass("server-card-address").text(server.address))
            .append($("<span>").addClass("server-card-motd").text(motd.replace(/\s+/g, " ")));
        const $live = failed
            ? $("<button>").attr({type: "button", "data-server-action": "retry-server", title: liveText})
            : $("<span>");
        $live.addClass(`server-card-live ${stateClass}`).text(liveText);
        if (failed) $live.prepend($("<span>").addClass("material-symbols-outlined").text("refresh"));
        $main.append($icon, $copy, $live, $("<span>").addClass("material-symbols-outlined server-card-chevron").text("expand_more"));

        const $details = $("<div>").addClass("server-card-details");
        const $inner = $("<div>").addClass("server-card-details-inner");
        const metric = (label, value) => $("<div>").addClass("server-metric")
            .append($("<span>").text(label), $("<strong>").text(value));
        $inner.append($("<div>").addClass("server-metrics").append(
            metric(RxServersUI.message("current", "Сейчас"), current),
            metric(RxServersUI.message("peak", "Пик"), history.samples.length ? RxServersUI.formatNumber(history.peak) : "—"),
            metric(RxServersUI.message("average", "Средний"), history.samples.length ? RxServersUI.formatNumber(history.average) : "—")
        ));

        const $chartShell = $("<div>").addClass("server-chart-shell");
        $chartShell.append($("<div>").addClass("server-chart-header")
            .append($("<span>").text(RxServersUI.message("graphTitle", "История онлайна")),
                $("<span>").text(`${history.samples.length} ${RxServersUI.message("measurements", "измерений")}`)))
            .append(RxServersUI.createChart(history.samples));
        $inner.append($chartShell);

        const $meta = $("<div>").addClass("server-card-meta");
        $meta.append($("<span>")
            .append($("<span>").addClass("material-symbols-outlined").text("conversion_path"), $("<span>").text(version)));
        if (Number.isFinite(Number(status?.ping))) {
            $meta.append($("<span>")
                .append($("<span>").addClass("material-symbols-outlined").text("speed"), $("<span>").text(`${status.ping} ms`)));
        }
        if (privacy) {
            $meta.append($("<span>")
                .append($("<span>").addClass("material-symbols-outlined").text("lock"),
                    $("<span>").text(MESSAGES.servers.privacyModeEnabled || "Privacy mode")));
        }
        $meta.append($("<span>")
            .append($("<span>").addClass("material-symbols-outlined").text("info"),
                $("<span>").text(RxServersUI.message("observed", "Наблюдения этого ПК"))));
        $inner.append($meta);

        const actionButton = (action, icon, text, extraClass = "") => $("<button>")
            .attr({type: "button", "data-server-action": action})
            .addClass(`server-card-button ${extraClass}`.trim())
            .append($("<span>").addClass("material-symbols-outlined").text(icon), $("<span>").text(text));
        const $actions = $("<div>").addClass("server-card-actions").toggleClass("has-delete", server.custom === true);
        $actions.append(
            actionButton("copy", "content_copy", RxServersUI.message("copy", "Копировать")),
            actionButton("add", saved ? "done" : "playlist_add", saved
                ? RxServersUI.message("added", "Добавлено")
                : RxServersUI.message("addToMinecraft", "В список игры"), saved ? "saved" : "").prop("disabled", saved),
            actionButton("play", "play_arrow", RxServersUI.message("play", "Играть"), "primary")
        );
        if (server.custom) $actions.append(actionButton("delete", "delete", RxServersUI.message("delete", "Удалить"), "danger"));
        $inner.append($actions);
        $details.append($inner);
        return $card.append($main, $details);
    };

    static render = () => {
        const servers = RxServersUI.sortedAndFilteredServers();
        const $list = $("#modal-servers .serversList").empty();
        servers.forEach((server) => $list.append(RxServersUI.createCard(server)));
        RxServersUI.showState(servers.length === 0 ? "empty" : "content");
        return servers.length;
    };

    // Обновить одну карточку на месте, как только пришёл её статус
    static updateCard = (server) => {
        const $old = $(`#modal-servers .serversList [data-server-address="${CSS.escape(server.address)}"]`);
        if ($old.length === 0) return false;
        const $fresh = RxServersUI.createCard(server).addClass("status-arrived");
        $old.replaceWith($fresh);
        return true;
    };

    static runWithConcurrency = async (items, worker, concurrency = 4) => {
        let nextIndex = 0;
        const runners = Array.from({length: Math.min(concurrency, items.length)}, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                await worker(items[index], index);
            }
        });
        await Promise.all(runners);
    };

    static queryServer = async (address, force = false) => {
        try {
            const allowDirect = RxConfig.read("serverPrivacyMode", false) !== true;
            const payload = await ipcRenderer.invoke("server-status-query", address, force === true, {allowDirect});
            return RxServersUI.normalizeStatusResponse(address, payload);
        } catch (error) {
            RxCollector.writeLog(`Servers: Status query failed [address=${address}] [error=${error}]`);
            return {reachable: false, online: false, address, error: "query_failed"};
        }
    };

    static retryServer = async (address) => {
        const server = RxServersUI.findServer(address);
        if (!server) return false;
        const status = await RxServersUI.queryServer(server.address, true);
        RxServersUI.statuses.set(server.address, status);
        if (RxServersUI.recordSnapshot(server.address, status)) RxServersUI.saveHistory();
        RxServersUI.render();
        return status.reachable === true;
    };

    static refreshServersInfo = async (force = false) => {
        if (!RxServersUI.loaded) return RxServersUI.loadList(force);
        if (!(await RxServersUI.canOpen(force))) {
            RxServersUI.showState("offline");
            return false;
        }

        const generation = ++RxServersUI.refreshGeneration;
        const $refreshButton = $("#modal-servers [data-server-action='refresh']").prop("disabled", true).addClass("refreshing");
        const servers = RxServersUI.getServers();
        let reachableResponses = 0;
        let historyChanged = false;
        await RxServersUI.runWithConcurrency(servers, async (server) => {
            const status = await RxServersUI.queryServer(server.address, force);
            if (generation !== RxServersUI.refreshGeneration) return;
            if (status?.reachable) reachableResponses++;
            RxServersUI.statuses.set(server.address, status || {reachable: false, online: false});
            if (RxServersUI.recordSnapshot(server.address, status)) historyChanged = true;
            // Иконка, MOTD и онлайн появляются сразу, не дожидаясь остальных серверов
            if (RxModals.isModalShown("servers")) RxServersUI.updateCard(server);
        }, 6);

        $refreshButton.prop("disabled", false).removeClass("refreshing");
        if (generation !== RxServersUI.refreshGeneration) return false;
        if (historyChanged) RxServersUI.saveHistory();
        if (reachableResponses === 0 && servers.length > 0) {
            RxServersUI.connectivity = {value: true, checkedAt: Date.now()};
            RxServersUI.showState("error");
            return false;
        }
        RxServersUI.connectivity = {value: true, checkedAt: Date.now()};
        RxServersUI.render();
        return true;
    };

    static toggleDetails = (address) => {
        const normalized = RxServersUI.normalizeAddress(address);
        RxServersUI.expandedAddress = RxServersUI.expandedAddress === normalized ? "" : normalized;
        RxServersUI.render();
    };

    static copyServerIP = async (address) => {
        const normalized = RxServersUI.normalizeAddress(address);
        if (!normalized) return false;
        try {
            await navigator.clipboard.writeText(normalized);
            RxServersUI.notify(MESSAGES.servers.ipCopied, "content_copy");
            return true;
        } catch (_) {
            return false;
        }
    };

    static addToMinecraft = async (address) => {
        const server = RxServersUI.findServer(address);
        if (!server || typeof RxMinecraftServers === "undefined") return false;
        try {
            const added = await RxMinecraftServers.add({name: server.name, address: server.address});
            if (added !== false) {
                RxServersUI.notify(RxServersUI.message("serverAdded", "Сервер добавлен в список Minecraft"), "playlist_add_check");
                RxServersUI.render();
                return true;
            }
        } catch (error) {
            RxCollector.writeLog(`Servers: Minecraft list sync failed [error=${error}]`);
        }
        RxServersUI.notify(RxServersUI.message("syncFailed", "Не удалось обновить список Minecraft"), "error");
        return false;
    };

    static playOnServer = async (address, versionId = "") => {
        const server = RxServersUI.findServer(address);
        if (!server) return false;
        if (RxConfig.read("serverPrivacyMode", false) === true) {
            RxToasts.create(MESSAGES.servers.privacyWarning, "shield_lock", server.address, 6000);
            return false;
        }
        if (!(await RxServersUI.canOpen())) {
            RxServersUI.notify(RxServersUI.message("noInternetToast", "Нет подключения к интернету"), "wifi_off");
            return false;
        }

        await RxServersUI.addToMinecraft(server.address);
        let targetVersion = versionId || RxVersionsManager.getActiveVersion();
        if (!targetVersion || targetVersion === "none") targetVersion = server.flVersion || "vanilla-1.21.4";
        selectedServerFromList = server.address;
        RxVersionsManager.setActiveVersion(targetVersion);
        RxFlyout.startSelectedVersion();
        return true;
    };

    static openAddPanel = () => {
        const $panel = $("#modal-servers [data-server-add-panel]");
        $panel.prop("hidden", false);
        setTimeout(() => $panel.find("[data-custom-server-name]").trigger("focus"), 0);
    };

    static closeAddPanel = () => {
        const $panel = $("#modal-servers [data-server-add-panel]");
        $panel.prop("hidden", true);
        $panel.find("input").val("");
    };

    static saveCustomServer = async () => {
        const $modal = $("#modal-servers");
        const address = RxServersUI.normalizeAddress($modal.find("[data-custom-server-address]").val());
        const name = RxServersUI.normalizeName($modal.find("[data-custom-server-name]").val(), address || "Minecraft Server");
        const category = String($modal.find("[data-custom-server-category]").val() || "anarchy");
        if (!address) {
            RxServersUI.notify(RxServersUI.message("invalidAddress", "Проверьте адрес сервера"), "error");
            $modal.find("[data-custom-server-address]").trigger("focus");
            return false;
        }
        if (RxServersUI.getServers().some((server) => server.address === address)) {
            RxServersUI.notify(RxServersUI.message("duplicate", "Этот сервер уже есть в каталоге"), "info");
            return false;
        }

        const customServers = RxServersUI.getCustomServers().map((server) => ({
            name: server.name,
            address: server.address,
            category: server.category,
            flVersion: server.flVersion
        }));
        customServers.push({name, address, category, flVersion: "vanilla-1.21.4"});
        RxConfig.write(RxServersUI.CUSTOM_CONFIG_KEY, customServers);
        RxServersUI.closeAddPanel();
        RxServersUI.notify(RxServersUI.message("customAdded", "Сервер добавлен в каталог"), "add_circle");
        await RxServersUI.addToMinecraft(address);
        const status = await RxServersUI.queryServer(address, true);
        RxServersUI.statuses.set(address, status);
        if (RxServersUI.recordSnapshot(address, status)) RxServersUI.saveHistory();
        RxServersUI.render();
        return true;
    };

    static deleteCustomServer = (address) => {
        const normalized = RxServersUI.normalizeAddress(address);
        const customServers = RxServersUI.getCustomServers()
            .filter((server) => server.address !== normalized)
            .map((server) => ({
                name: server.name,
                address: server.address,
                category: server.category,
                flVersion: server.flVersion
            }));
        RxConfig.write(RxServersUI.CUSTOM_CONFIG_KEY, customServers);
        if (RxServersUI.expandedAddress === normalized) RxServersUI.expandedAddress = "";
        RxServersUI.render();
        return true;
    };

    static notify = (message, icon = "info") => {
        if (typeof RxToasts !== "undefined") RxToasts.create(message, icon);
    };
}
