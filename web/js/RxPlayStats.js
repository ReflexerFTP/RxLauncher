class RxPlayStats {
    static SCHEMA_VERSION = 2;
    static HEARTBEAT_INTERVAL = 15000;
    static MAX_CHECKPOINT_GAP_SECONDS = 300;
    static MAX_STATS_FILE_SIZE = 5 * 1024 * 1024;
    static MAX_LOG_BUFFER_SIZE = 64 * 1024;

    static data = null;
    static currentSession = null;
    static heartbeatTimer = null;
    static logBuffers = {stdout: "", stderr: "", merged: ""};
    static logDecoders = {stdout: null, stderr: null, merged: null};
    static recentLogEvents = new Map();
    static worldLocksAtLaunch = {};
    static vanillaStatsAtLaunch = {};
    static worldDiscoveryTimers = [];

    static getStoragePath = () => path.join(USERDATA_PATH, "play-statistics.json");
    static getBackupPath = () => path.join(USERDATA_PATH, "play-statistics.backup.json");

    static createTotals = () => ({
        playSeconds: 0,
        sessions: 0,
        kills: 0,
        deaths: 0,
        bestKillStreak: 0
    });

    static createEmptyData = () => {
        const now = Date.now();
        return {
            schemaVersion: RxPlayStats.SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now,
            detailedTrackingSince: now,
            totals: RxPlayStats.createTotals(),
            dimensions: {
                versions: {},
                nicknames: {},
                servers: {},
                worlds: {}
            },
            days: {},
            sessions: [],
            activeSession: null,
            migration: {
                legacyGameStatistics: false,
                legacyPlaySeconds: 0,
                legacySessions: 0
            }
        };
    };

    static number = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
    };

    static cleanText = (value, maxLength = 120) => String(value || "")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .replace(/§[0-9a-fk-or]/gi, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);

    static safeObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

    static normalizeTotals = (value) => {
        const source = RxPlayStats.safeObject(value);
        return {
            playSeconds: RxPlayStats.number(source.playSeconds),
            sessions: RxPlayStats.number(source.sessions),
            kills: RxPlayStats.number(source.kills),
            deaths: RxPlayStats.number(source.deaths),
            bestKillStreak: RxPlayStats.number(source.bestKillStreak)
        };
    };

    static normalizeCounterMap = (value) => {
        const source = RxPlayStats.safeObject(value);
        const result = {};
        Object.entries(source).forEach(([key, rawRecord]) => {
            if (["__proto__", "prototype", "constructor"].includes(key)) return;
            const record = RxPlayStats.safeObject(rawRecord);
            const name = RxPlayStats.cleanText(record.name || key);
            if (!name) return;
            result[key] = {
                name,
                playSeconds: RxPlayStats.number(record.playSeconds),
                sessions: RxPlayStats.number(record.sessions),
                kills: RxPlayStats.number(record.kills),
                deaths: RxPlayStats.number(record.deaths),
                bestKillStreak: RxPlayStats.number(record.bestKillStreak),
                lastPlayed: RxPlayStats.number(record.lastPlayed)
            };
        });
        return result;
    };

    static normalizeStringCounterMap = (value) => {
        const source = RxPlayStats.safeObject(value);
        const result = Object.create(null);
        Object.entries(source).forEach(([key, rawValue]) => {
            if (["__proto__", "prototype", "constructor"].includes(key)) return;
            const amount = RxPlayStats.number(rawValue);
            const cleanKey = RxPlayStats.cleanText(key, 160);
            if (amount > 0 && cleanKey) {
                Object.defineProperty(result, cleanKey, {value: amount, enumerable: true, writable: true, configurable: true});
            }
        });
        return result;
    };

    static normalizeWorldEventMap = (value) => {
        const source = RxPlayStats.safeObject(value);
        const result = Object.create(null);
        Object.entries(source).forEach(([rawName, rawRecord]) => {
            if (["__proto__", "prototype", "constructor"].includes(rawName)) return;
            const name = RxPlayStats.cleanText(rawName, 120).toLocaleLowerCase("en-US");
            if (!name) return;
            const record = RxPlayStats.safeObject(rawRecord);
            Object.defineProperty(result, name, {value: {
                kills: RxPlayStats.number(record.kills),
                deaths: RxPlayStats.number(record.deaths)
            }, enumerable: true, writable: true, configurable: true});
        });
        return result;
    };

    static normalizeDailyCombatMap = (value) => {
        const result = {};
        Object.entries(RxPlayStats.safeObject(value)).forEach(([day, rawRecord]) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
            const record = RxPlayStats.safeObject(rawRecord);
            result[day] = {
                kills: RxPlayStats.number(record.kills),
                deaths: RxPlayStats.number(record.deaths),
                bestKillStreak: RxPlayStats.number(record.bestKillStreak)
            };
        });
        return result;
    };

    static normalizeDailyContextMap = (value) => {
        const result = {};
        Object.entries(RxPlayStats.safeObject(value)).forEach(([day, rawRecord]) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
            const record = RxPlayStats.safeObject(rawRecord);
            result[day] = {
                servers: RxPlayStats.normalizeStringCounterMap(record.servers),
                worlds: RxPlayStats.normalizeStringCounterMap(record.worlds)
            };
        });
        return result;
    };

    static normalizeSession = (value, isActive = false) => {
        const source = RxPlayStats.safeObject(value);
        const startedAt = RxPlayStats.number(source.startedAt, Date.now());
        const session = {
            id: RxPlayStats.cleanText(source.id, 80) || `session-${startedAt}`,
            startedAt,
            endedAt: isActive ? 0 : RxPlayStats.number(source.endedAt, startedAt),
            lastCheckpointAt: RxPlayStats.number(source.lastCheckpointAt, startedAt),
            playSeconds: RxPlayStats.number(source.playSeconds),
            versionId: RxPlayStats.cleanText(source.versionId, 100) || "unknown",
            nickname: RxPlayStats.cleanText(source.nickname, 32) || "Player",
            gameDirectory: typeof source.gameDirectory === "string" ? path.normalize(source.gameDirectory) : "",
            playerUuid: RxPlayStats.cleanText(source.playerUuid, 40),
            pid: RxPlayStats.number(source.pid),
            kills: RxPlayStats.number(source.kills),
            deaths: RxPlayStats.number(source.deaths),
            currentKillStreak: RxPlayStats.number(source.currentKillStreak),
            bestKillStreak: RxPlayStats.number(source.bestKillStreak),
            serverSeconds: RxPlayStats.normalizeStringCounterMap(source.serverSeconds),
            worldSeconds: RxPlayStats.normalizeStringCounterMap(source.worldSeconds),
            dailySeconds: RxPlayStats.normalizeStringCounterMap(source.dailySeconds),
            dailyCombat: RxPlayStats.normalizeDailyCombatMap(source.dailyCombat),
            dailyContexts: RxPlayStats.normalizeDailyContextMap(source.dailyContexts),
            eventsByWorld: RxPlayStats.normalizeWorldEventMap(source.eventsByWorld),
            sources: {
                logKills: RxPlayStats.number(source.sources?.logKills),
                logDeaths: RxPlayStats.number(source.sources?.logDeaths),
                vanillaKills: RxPlayStats.number(source.sources?.vanillaKills),
                vanillaDeaths: RxPlayStats.number(source.sources?.vanillaDeaths)
            },
            currentContext: null,
            pendingServer: null,
            exitCode: typeof source.exitCode === "number" ? source.exitCode : null,
            endReason: RxPlayStats.cleanText(source.endReason, 40) || (isActive ? "running" : "closed")
        };

        const context = RxPlayStats.safeObject(source.currentContext);
        if (["server", "world"].includes(context.type)) {
            const contextName = RxPlayStats.cleanText(context.name);
            if (contextName) session.currentContext = {type: context.type, name: contextName};
        }

        const pending = RxPlayStats.safeObject(source.pendingServer);
        const pendingName = RxPlayStats.normalizeServer(pending.name);
        if (pendingName) {
            session.pendingServer = {
                name: pendingName,
                detectedAt: RxPlayStats.number(pending.detectedAt, startedAt),
                source: pending.source === "log" ? "log" : "selected"
            };
        }
        return session;
    };

    static normalizeData = (value) => {
        const source = RxPlayStats.safeObject(value);
        const empty = RxPlayStats.createEmptyData();
        const dimensions = RxPlayStats.safeObject(source.dimensions);
        const days = {};
        Object.entries(RxPlayStats.safeObject(source.days)).forEach(([day, rawDay]) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
            days[day] = RxPlayStats.normalizeTotals(rawDay);
        });

        return {
            ...empty,
            schemaVersion: RxPlayStats.SCHEMA_VERSION,
            createdAt: RxPlayStats.number(source.createdAt, empty.createdAt),
            updatedAt: RxPlayStats.number(source.updatedAt, empty.updatedAt),
            detailedTrackingSince: RxPlayStats.number(source.detailedTrackingSince, source.createdAt || empty.createdAt),
            totals: RxPlayStats.normalizeTotals(source.totals),
            dimensions: {
                versions: RxPlayStats.normalizeCounterMap(dimensions.versions),
                nicknames: RxPlayStats.normalizeCounterMap(dimensions.nicknames),
                servers: RxPlayStats.normalizeCounterMap(dimensions.servers),
                worlds: RxPlayStats.normalizeCounterMap(dimensions.worlds)
            },
            days,
            sessions: Array.isArray(source.sessions)
                ? source.sessions.filter(item => item && typeof item === "object").map(item => RxPlayStats.normalizeSession(item))
                : [],
            activeSession: source.activeSession && typeof source.activeSession === "object"
                ? RxPlayStats.normalizeSession(source.activeSession, true)
                : null,
            migration: {
                legacyGameStatistics: source.migration?.legacyGameStatistics === true,
                legacyPlaySeconds: RxPlayStats.number(source.migration?.legacyPlaySeconds),
                legacySessions: RxPlayStats.number(source.migration?.legacySessions)
            }
        };
    };

    static getAllStats = () => {
        if (RxPlayStats.data) return RxPlayStats.data;

        const statsPath = RxPlayStats.getStoragePath();
        const backupPath = RxPlayStats.getBackupPath();
        let loaded = null;
        if (fs.existsSync(statsPath)) {
            try {
                loaded = JSON.parse(fs.readFileSync(statsPath, "utf8"));
            } catch (error) {
                const corruptPath = path.join(
                    path.dirname(statsPath),
                    `play-statistics.corrupt-${Date.now()}.json`
                );
                try {
                    fs.renameSync(statsPath, corruptPath);
                    RxCollector.writeLog(`Statistics: Corrupted file backed up [path=${corruptPath}]`);
                } catch (backupError) {
                    try {
                        fs.copyFileSync(statsPath, corruptPath);
                        fs.unlinkSync(statsPath);
                        RxCollector.writeLog(`Statistics: Corrupted file backed up [path=${corruptPath}]`);
                    } catch (copyError) {
                        RxCollector.writeLog(`Statistics: Failed to back up corrupted file [error=${copyError.message}]`);
                    }
                }
                RxCollector.writeLog(`Statistics: Failed to read storage [error=${error.message}]`);
            }
        }

        if (!loaded && fs.existsSync(backupPath)) {
            try {
                loaded = JSON.parse(fs.readFileSync(backupPath, "utf8"));
                RxCollector.writeLog(`Statistics: Restored data from backup [path=${backupPath}]`);
            } catch (error) {
                RxCollector.writeLog(`Statistics: Backup could not be read [error=${error.message}]`);
            }
        }

        RxPlayStats.data = RxPlayStats.normalizeData(loaded || RxPlayStats.createEmptyData());
        RxPlayStats.recoverInterruptedSession();
        RxPlayStats.migrateLegacyStatistics();
        RxPlayStats.saveStats();
        return RxPlayStats.data;
    };

    static recoverInterruptedSession = () => {
        if (!RxPlayStats.data?.activeSession) return false;
        const recovered = RxPlayStats.normalizeSession(RxPlayStats.data.activeSession);
        recovered.endedAt = Math.max(recovered.startedAt, recovered.lastCheckpointAt);
        recovered.currentKillStreak = 0;
        recovered.currentContext = null;
        recovered.pendingServer = null;
        recovered.endReason = "interrupted";
        if (!RxPlayStats.data.sessions.some(item => item.id === recovered.id)) {
            RxPlayStats.data.sessions.push(recovered);
        }
        RxPlayStats.data.activeSession = null;
        RxCollector.writeLog(`Statistics: Recovered interrupted session [id=${recovered.id}]`);
        return true;
    };

    static migrateLegacyStatistics = () => {
        if (!RxPlayStats.data || RxPlayStats.data.migration.legacyGameStatistics === true) return false;
        const legacy = RxConfig.read("gameStatistics", {});
        let migratedSeconds = 0;
        let migratedSessions = 0;

        Object.entries(RxPlayStats.safeObject(legacy)).forEach(([versionId, rawRecord]) => {
            const record = RxPlayStats.safeObject(rawRecord);
            const seconds = RxPlayStats.number(record.inGame);
            const sessions = RxPlayStats.number(record.starts);
            const lastPlayed = RxPlayStats.number(record.lastStart);
            const dimension = RxPlayStats.touchDimension("versions", versionId, lastPlayed || Date.now());
            dimension.playSeconds += seconds;
            dimension.sessions += sessions;
            dimension.lastPlayed = Math.max(dimension.lastPlayed, lastPlayed);
            migratedSeconds += seconds;
            migratedSessions += sessions;
        });

        RxPlayStats.data.totals.playSeconds += migratedSeconds;
        RxPlayStats.data.totals.sessions += migratedSessions;
        RxPlayStats.data.migration.legacyGameStatistics = true;
        RxPlayStats.data.migration.legacyPlaySeconds = migratedSeconds;
        RxPlayStats.data.migration.legacySessions = migratedSessions;
        if (migratedSeconds > 0 || migratedSessions > 0) {
            RxCollector.writeLog(`Statistics: Migrated legacy data [seconds=${migratedSeconds}] [sessions=${migratedSessions}]`);
        }
        return true;
    };

    static saveStats = () => {
        if (!RxPlayStats.data) return false;
        const statsPath = RxPlayStats.getStoragePath();
        const backupPath = RxPlayStats.getBackupPath();
        const tmpPath = `${statsPath}.tmp`;
        RxPlayStats.data.updatedAt = Date.now();
        RxPlayStats.data.activeSession = RxPlayStats.currentSession;

        try {
            fs.mkdirSync(path.dirname(statsPath), {recursive: true});
            if (fs.existsSync(statsPath)) {
                try {
                    fs.copyFileSync(statsPath, backupPath);
                } catch (_) {}
            }
            fs.writeFileSync(tmpPath, JSON.stringify(RxPlayStats.data, null, 2), "utf8");
            try {
                fs.renameSync(tmpPath, statsPath);
            } catch (_) {
                // Windows cannot atomically rename over an existing file.
                // Remove only the already-backed-up primary, then promote the
                // complete temporary file. Startup falls back to the backup if
                // power is lost in this very small replacement window.
                if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath);
                fs.renameSync(tmpPath, statsPath);
            }
            return true;
        } catch (error) {
            RxCollector.writeLog(`Statistics: Save failed [error=${error.message}]`);
            try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch (_) {}
            return false;
        }
    };

    static makeKey = (type, value) => {
        const normalized = RxPlayStats.cleanText(value).toLocaleLowerCase("en-US");
        return crypto.createHash("sha256").update(`${type}\u0000${normalized}`).digest("hex").slice(0, 24);
    };

    static touchDimension = (type, name, now = Date.now()) => {
        RxPlayStats.getAllStats();
        const cleanName = RxPlayStats.cleanText(name);
        if (!cleanName || !RxPlayStats.data.dimensions[type]) return null;
        const key = RxPlayStats.makeKey(type, cleanName);
        if (!RxPlayStats.data.dimensions[type][key]) {
            RxPlayStats.data.dimensions[type][key] = {
                name: cleanName,
                playSeconds: 0,
                sessions: 0,
                kills: 0,
                deaths: 0,
                bestKillStreak: 0,
                lastPlayed: now
            };
        }
        const record = RxPlayStats.data.dimensions[type][key];
        record.lastPlayed = Math.max(record.lastPlayed, now);
        return record;
    };

    static dayKey = (timestamp = Date.now()) => {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    };

    static touchDay = (timestamp = Date.now()) => {
        const key = RxPlayStats.dayKey(timestamp);
        if (!RxPlayStats.data.days[key]) RxPlayStats.data.days[key] = RxPlayStats.createTotals();
        return RxPlayStats.data.days[key];
    };

    static touchSessionCombatDay = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return null;
        const key = RxPlayStats.dayKey(timestamp);
        if (!session.dailyCombat[key]) session.dailyCombat[key] = {kills: 0, deaths: 0, bestKillStreak: 0};
        return session.dailyCombat[key];
    };

    static touchSessionContextDay = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return null;
        const key = RxPlayStats.dayKey(timestamp);
        if (!session.dailyContexts[key]) {
            session.dailyContexts[key] = {
                servers: Object.create(null),
                worlds: Object.create(null)
            };
        }
        return session.dailyContexts[key];
    };

    static incrementSessionCounter = (map, name, amount) => {
        const cleanName = RxPlayStats.cleanText(name, 160);
        if (!cleanName || amount <= 0) return;
        const previous = Object.prototype.hasOwnProperty.call(map, cleanName) ? map[cleanName] : 0;
        Object.defineProperty(map, cleanName, {
            value: RxPlayStats.number(previous) + amount,
            enumerable: true,
            writable: true,
            configurable: true
        });
    };

    static onGameLaunch = (payload = {}) => {
        RxPlayStats.getAllStats();
        if (typeof payload === "string") payload = {versionId: payload};
        if (RxPlayStats.currentSession) RxPlayStats.onGameClose({reason: "restarted"});

        const now = Date.now();
        const versionId = RxPlayStats.cleanText(payload.versionId, 100) || "unknown";
        const nickname = RxPlayStats.cleanText(payload.nickname, 32) || "Player";
        const gameDirectory = typeof payload.gameDirectory === "string" ? path.normalize(payload.gameDirectory) : "";
        const initialServer = RxPlayStats.normalizeServer(payload.server);

        RxPlayStats.currentSession = RxPlayStats.normalizeSession({
            id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `session-${now}-${Math.random()}`,
            startedAt: now,
            lastCheckpointAt: now,
            versionId,
            nickname,
            gameDirectory,
            playerUuid: payload.playerUuid,
            pid: payload.pid,
            endReason: "running",
            pendingServer: initialServer ? {name: initialServer, detectedAt: now, source: "selected"} : null
        }, true);

        RxPlayStats.data.activeSession = RxPlayStats.currentSession;
        RxPlayStats.data.totals.sessions++;
        RxPlayStats.touchDimension("versions", versionId, now).sessions++;
        RxPlayStats.touchDimension("nicknames", nickname, now).sessions++;
        RxPlayStats.touchDay(now).sessions++;
        RxPlayStats.worldLocksAtLaunch = RxPlayStats.scanWorldLocks(gameDirectory);
        RxPlayStats.vanillaStatsAtLaunch = RxPlayStats.scanVanillaStatistics(gameDirectory, RxPlayStats.currentSession.playerUuid);
        RxPlayStats.logBuffers = {stdout: "", stderr: "", merged: ""};
        RxPlayStats.logDecoders = {stdout: null, stderr: null, merged: null};
        RxPlayStats.recentLogEvents.clear();
        RxPlayStats.clearWorldDiscoveryTimers();

        clearInterval(RxPlayStats.heartbeatTimer);
        RxPlayStats.heartbeatTimer = setInterval(() => RxPlayStats.checkpoint(true), RxPlayStats.HEARTBEAT_INTERVAL);
        RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        RxCollector.writeLog(`Statistics: Session started [version=${versionId}] [nickname=${nickname}]`);
        return true;
    };

    static checkpoint = (save = false, timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;

        if (session.pendingServer?.source === "log" && timestamp - session.pendingServer.detectedAt >= 12000) {
            RxPlayStats.confirmPendingServer(timestamp);
        }

        let elapsedSeconds = Math.floor((timestamp - session.lastCheckpointAt) / 1000);
        if (elapsedSeconds < 0) {
            session.lastCheckpointAt = timestamp;
            return false;
        }
        if (elapsedSeconds === 0) {
            if (save) RxPlayStats.saveStats();
            return false;
        }
        const wasCapped = elapsedSeconds > RxPlayStats.MAX_CHECKPOINT_GAP_SECONDS;
        elapsedSeconds = Math.min(elapsedSeconds, RxPlayStats.MAX_CHECKPOINT_GAP_SECONDS);
        const intervalStart = wasCapped ? timestamp - elapsedSeconds * 1000 : session.lastCheckpointAt;
        session.lastCheckpointAt = wasCapped ? timestamp : session.lastCheckpointAt + elapsedSeconds * 1000;
        RxPlayStats.addPlayTime(elapsedSeconds, intervalStart, timestamp);
        if (save) RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        return elapsedSeconds;
    };

    static addPlayTime = (seconds, startedAt, endedAt) => {
        const session = RxPlayStats.currentSession;
        if (!session || seconds <= 0) return;
        session.playSeconds += seconds;
        RxPlayStats.data.totals.playSeconds += seconds;

        const records = [
            RxPlayStats.touchDimension("versions", session.versionId, endedAt),
            RxPlayStats.touchDimension("nicknames", session.nickname, endedAt)
        ];
        if (session.currentContext) {
            const dimensionName = session.currentContext.type === "server" ? "servers" : "worlds";
            records.push(RxPlayStats.touchDimension(dimensionName, session.currentContext.name, endedAt));
            RxPlayStats.incrementSessionCounter(
                session.currentContext.type === "server" ? session.serverSeconds : session.worldSeconds,
                session.currentContext.name,
                seconds
            );
        }
        records.filter(Boolean).forEach(record => record.playSeconds += seconds);

        let remaining = seconds;
        let cursor = startedAt;
        while (remaining > 0) {
            const cursorDate = new Date(cursor);
            const nextMidnight = new Date(
                cursorDate.getFullYear(),
                cursorDate.getMonth(),
                cursorDate.getDate() + 1
            ).getTime();
            const segment = Math.min(remaining, Math.max(1, Math.ceil((nextMidnight - cursor) / 1000)));
            const segmentDay = RxPlayStats.dayKey(cursor);
            RxPlayStats.touchDay(cursor).playSeconds += segment;
            RxPlayStats.incrementSessionCounter(session.dailySeconds, segmentDay, segment);
            if (session.currentContext) {
                const dailyContexts = RxPlayStats.touchSessionContextDay(cursor);
                const contextMap = session.currentContext.type === "server" ? dailyContexts.servers : dailyContexts.worlds;
                RxPlayStats.incrementSessionCounter(contextMap, session.currentContext.name, segment);
            }
            remaining -= segment;
            cursor += segment * 1000;
        }
    };

    static setContext = (type, name, timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        const cleanName = RxPlayStats.cleanText(name);
        const current = session.currentContext;
        if (current?.type === type && current?.name.toLocaleLowerCase("en-US") === cleanName.toLocaleLowerCase("en-US")) {
            return false;
        }

        RxPlayStats.checkpoint(false, timestamp);
        session.currentContext = type && cleanName ? {type, name: cleanName} : null;
        if (session.currentContext) {
            const dimensionName = type === "server" ? "servers" : "worlds";
            RxPlayStats.touchDimension(dimensionName, cleanName, timestamp).sessions++;
        }
        RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        return true;
    };

    static normalizeServer = (value, rawPort = null) => {
        let server = RxPlayStats.cleanText(value, 100).replace(/^\//, "").toLowerCase();
        if (!server) return "";
        if (rawPort !== null && rawPort !== undefined) {
            const port = Number(rawPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
            if (server.startsWith("[") && server.endsWith("]")) server = server.slice(1, -1);
            if (server.includes(":")) server = `[${server}]`;
            if (port !== 25565) server += `:${port}`;
        }
        if (!/^[a-z0-9._:\[\]-]+$/i.test(server)) return "";
        return server.slice(0, 100);
    };

    static detectServer = (line) => {
        if (/ServerStatusPinger|multiplayer\/ServerSelectionList/i.test(line)) return "";
        const commaMatch = line.match(/\bConnecting to\s+(?:\/)?(.+?)\s*,\s*(\d{1,5})(?:\s|$)/i);
        if (commaMatch) return RxPlayStats.normalizeServer(commaMatch[1], commaMatch[2]);
        const colonMatch = line.match(/\bConnecting to\s+(?:\/)?(\[[0-9a-f:]+\]|[a-z0-9._-]+):(\d{1,5})(?:\s|$)/i);
        if (colonMatch) return RxPlayStats.normalizeServer(colonMatch[1], colonMatch[2]);
        return "";
    };

    static queueServer = (server, timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session || !server) return false;
        RxPlayStats.setContext(null, "", timestamp);
        session.pendingServer = {name: server, detectedAt: timestamp, source: "log"};
        RxPlayStats.saveStats();
        return true;
    };

    static confirmPendingServer = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session?.pendingServer) return false;
        const server = session.pendingServer.name;
        session.pendingServer = null;
        return RxPlayStats.setContext("server", server, timestamp);
    };

    static clearServer = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        const hadPendingServer = Boolean(session.pendingServer);
        session.pendingServer = null;
        if (session.currentContext?.type === "server") return RxPlayStats.setContext(null, "", timestamp);
        if (hadPendingServer) {
            RxPlayStats.saveStats();
            RxPlayStats.emitUpdate();
            return true;
        }
        return false;
    };

    static attachGameProcess = (childProcess, sessionId = RxPlayStats.currentSession?.id || "") => {
        if (!childProcess || typeof childProcess !== "object") return false;
        if (childProcess.stdout?.on) {
            childProcess.stdout.on("data", chunk => {
                if (RxPlayStats.currentSession?.id === sessionId) RxPlayStats.handleGameLog(chunk, "stdout");
            });
        }
        if (childProcess.stderr?.on) {
            childProcess.stderr.on("data", chunk => {
                if (RxPlayStats.currentSession?.id === sessionId) RxPlayStats.handleGameLog(chunk, "stderr");
            });
        }
        return Boolean(childProcess.stdout?.on || childProcess.stderr?.on);
    };

    static handleGameLog = (rawChunk, stream = "merged") => {
        if (!RxPlayStats.currentSession) return false;
        const streamName = ["stdout", "stderr", "merged"].includes(stream) ? stream : "merged";
        let chunk = "";
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(rawChunk) && typeof require === "function") {
            if (!RxPlayStats.logDecoders[streamName]) {
                const {StringDecoder} = require("string_decoder");
                RxPlayStats.logDecoders[streamName] = new StringDecoder("utf8");
            }
            chunk = RxPlayStats.logDecoders[streamName].write(rawChunk);
        } else {
            chunk = String(rawChunk || "");
        }
        if (!chunk) return false;
        RxPlayStats.logBuffers[streamName] = (RxPlayStats.logBuffers[streamName] || "") + chunk;
        const lines = RxPlayStats.logBuffers[streamName].split(/\r?\n/);
        RxPlayStats.logBuffers[streamName] = lines.pop() || "";
        lines.forEach(line => RxPlayStats.handleGameLogLine(line));
        if (RxPlayStats.logBuffers[streamName].length > RxPlayStats.MAX_LOG_BUFFER_SIZE) {
            RxPlayStats.handleGameLogLine(RxPlayStats.logBuffers[streamName].slice(-RxPlayStats.MAX_LOG_BUFFER_SIZE));
            RxPlayStats.logBuffers[streamName] = "";
        }
        return true;
    };

    static handleGameLogLine = (rawLine) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        const line = RxPlayStats.cleanText(rawLine, 2000);
        if (!line) return false;
        const now = Date.now();
        const isChatLine = /\[CHAT\]|ChatComponent/i.test(line);

        if (!isChatLine) {
            const detectedServer = RxPlayStats.detectServer(line);
            if (detectedServer) RxPlayStats.queueServer(detectedServer, now);

            // Do not treat generic network stack messages as a failed game
            // connection: skin/resource downloads can time out while the
            // player is successfully online. Only the explicit multiplayer
            // screen message is authoritative here.
            const connectionFailed = /(?:Couldn't|Could not|Failed|Unable) connect to (?:the )?server|(?:Couldn't|Could not|Failed|Unable) to connect to (?:the )?server/i.test(line);
            if (connectionFailed) {
                RxPlayStats.clearServer(now);
            } else if (session.pendingServer && /Loaded\s+\d+\s+advancements|Time from main menu to in-game/i.test(line)) {
                RxPlayStats.confirmPendingServer(now);
            }

            if (/Disconnected from server|Client disconnected|Connection lost|Disconnecting from|Lost connection/i.test(line)) {
                RxPlayStats.clearServer(now);
            }

            if (/Starting integrated minecraft server/i.test(line)) {
                RxPlayStats.clearServer(now);
                if (session.currentContext) RxPlayStats.setContext(null, "", now);
                RxPlayStats.scheduleWorldDiscovery(now);
            } else if (!session.currentContext && /ServerLevel\[([^\]]+)\]/i.test(line)) {
                const match = line.match(/ServerLevel\[([^\]]+)\]/i);
                if (match?.[1]) RxPlayStats.setContext("world", match[1], now);
            }

            if (/Stopping server|Stopping integrated server|Unloading level/i.test(line) && session.currentContext?.type === "world") {
                RxPlayStats.setContext(null, "", now);
            }
        } else if (session.pendingServer) {
            // Receiving an actual chat component is strong evidence that the
            // selected server finished loading, but chat text must never drive
            // connection/world lifecycle detection itself.
            RxPlayStats.confirmPendingServer(now);
        }

        RxPlayStats.detectCombatEvent(line, now);
        return true;
    };

    static isDuplicateEvent = (eventKey, timestamp) => {
        const key = crypto.createHash("sha1").update(eventKey).digest("hex");
        const previous = RxPlayStats.recentLogEvents.get(key) || 0;
        RxPlayStats.recentLogEvents.set(key, timestamp);
        for (const [oldKey, oldTimestamp] of RxPlayStats.recentLogEvents.entries()) {
            if (timestamp - oldTimestamp > 10000) RxPlayStats.recentLogEvents.delete(oldKey);
        }
        return timestamp - previous < 2500;
    };

    static detectCombatEvent = (line, timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session || !/(?:\[CHAT\]|ChatComponent|Server thread\/INFO)/i.test(line)) return false;
        const nickname = session.nickname.toLocaleLowerCase("en-US");
        let killer = "";
        let victim = "";
        let match = line.match(/\[🗡\]\s*Игрок\s+([A-Za-z0-9_]{2,16})\s+убил\s+([A-Za-z0-9_]{2,16})!/iu);
        if (match) {
            killer = match[1];
            victim = match[2];
        } else {
            match = line.match(/\[🗡\]\s*Игрок\s+([A-Za-z0-9_]{2,16})\s+погиб!/iu);
            if (match && match[1].toLocaleLowerCase("en-US") === nickname) {
                if (!RxPlayStats.isDuplicateEvent(`death:${nickname}`, timestamp)) RxPlayStats.recordDeath("server-log", timestamp);
                return true;
            }

            const message = line.replace(/^.*?(?:\[CHAT\]\s*|ChatComponent\/\]:\s*)/i, "");
            const englishPatterns = [
                /^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_]{2,16})\s+(?:was slain by|was shot by|was blown up by|was fireballed by|was impaled by|was pummeled by|was killed by|was squashed by|was poked to death by|was skewered by)\s+([A-Za-z0-9_]{2,16})(?:\b|\s+using)/i,
                /^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_]{2,16})\s+didn't want to live in the same world as\s+([A-Za-z0-9_]{2,16})/i
            ];
            for (const pattern of englishPatterns) {
                const englishMatch = message.match(pattern);
                if (englishMatch) {
                    victim = englishMatch[1];
                    killer = englishMatch[2];
                    break;
                }
            }
            if (!killer && !victim) {
                const ownDeathPattern = new RegExp(`^(?:\\[[^\\]]{1,24}\\]\\s*)*${RxPlayStats.escapeRegExp(session.nickname)}\\s+(?:died|drowned|burned to death|went up in flames|hit the ground too hard|fell from a high place|blew up|starved to death|suffocated in a wall|withered away|froze to death|was killed by magic|tried to swim in lava|was struck by lightning)`, "i");
                if (ownDeathPattern.test(message)) {
                    if (!RxPlayStats.isDuplicateEvent(`death:${nickname}`, timestamp)) RxPlayStats.recordDeath("vanilla-log", timestamp);
                    return true;
                }
            }
        }

        if (!killer && !victim) return false;
        const killerLower = killer.toLocaleLowerCase("en-US");
        const victimLower = victim.toLocaleLowerCase("en-US");
        if (killerLower === nickname && victimLower !== nickname) {
            if (!RxPlayStats.isDuplicateEvent(`kill:${killerLower}:${victimLower}`, timestamp)) {
                RxPlayStats.recordKill("server-log", timestamp);
            }
        } else if (victimLower === nickname && killerLower !== nickname) {
            if (!RxPlayStats.isDuplicateEvent(`death:${nickname}`, timestamp)) {
                RxPlayStats.recordDeath("server-log", timestamp);
            }
        }
        return true;
    };

    static escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    static updateBestStreak = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return;
        session.bestKillStreak = Math.max(session.bestKillStreak, session.currentKillStreak);
        const dailyCombat = RxPlayStats.touchSessionCombatDay(timestamp);
        dailyCombat.bestKillStreak = Math.max(dailyCombat.bestKillStreak, session.currentKillStreak);
        RxPlayStats.data.totals.bestKillStreak = Math.max(RxPlayStats.data.totals.bestKillStreak, session.bestKillStreak);
        const records = [
            RxPlayStats.touchDimension("versions", session.versionId),
            RxPlayStats.touchDimension("nicknames", session.nickname)
        ];
        if (session.currentContext) {
            records.push(RxPlayStats.touchDimension(
                session.currentContext.type === "server" ? "servers" : "worlds",
                session.currentContext.name
            ));
        }
        records.filter(Boolean).forEach(record => {
            record.bestKillStreak = Math.max(record.bestKillStreak, session.bestKillStreak);
        });
    };

    static updateWorldEvent = (type) => {
        const session = RxPlayStats.currentSession;
        if (session?.currentContext?.type !== "world") return;
        const key = session.currentContext.name.toLocaleLowerCase("en-US");
        if (!Object.prototype.hasOwnProperty.call(session.eventsByWorld, key)) {
            Object.defineProperty(session.eventsByWorld, key, {
                value: {kills: 0, deaths: 0},
                enumerable: true,
                writable: true,
                configurable: true
            });
        }
        session.eventsByWorld[key][type] = RxPlayStats.number(session.eventsByWorld[key][type]) + 1;
    };

    static recordKill = (source = "log", timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        RxPlayStats.checkpoint(false, timestamp);
        session.kills++;
        session.currentKillStreak++;
        session.sources.logKills++;
        RxPlayStats.data.totals.kills++;
        RxPlayStats.touchDay(timestamp).kills++;
        RxPlayStats.touchSessionCombatDay(timestamp).kills++;
        const records = [
            RxPlayStats.touchDimension("versions", session.versionId, timestamp),
            RxPlayStats.touchDimension("nicknames", session.nickname, timestamp)
        ];
        if (session.currentContext) {
            records.push(RxPlayStats.touchDimension(
                session.currentContext.type === "server" ? "servers" : "worlds",
                session.currentContext.name,
                timestamp
            ));
        }
        records.filter(Boolean).forEach(record => record.kills++);
        RxPlayStats.updateWorldEvent("kills");
        RxPlayStats.updateBestStreak(timestamp);
        RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        RxCollector.writeLog(`Statistics: Kill detected [source=${source}] [streak=${session.currentKillStreak}]`);
        return true;
    };

    static recordDeath = (source = "log", timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        RxPlayStats.checkpoint(false, timestamp);
        session.deaths++;
        session.sources.logDeaths++;
        RxPlayStats.data.totals.deaths++;
        RxPlayStats.touchDay(timestamp).deaths++;
        RxPlayStats.touchSessionCombatDay(timestamp).deaths++;
        const records = [
            RxPlayStats.touchDimension("versions", session.versionId, timestamp),
            RxPlayStats.touchDimension("nicknames", session.nickname, timestamp)
        ];
        if (session.currentContext) {
            records.push(RxPlayStats.touchDimension(
                session.currentContext.type === "server" ? "servers" : "worlds",
                session.currentContext.name,
                timestamp
            ));
        }
        records.filter(Boolean).forEach(record => record.deaths++);
        RxPlayStats.updateWorldEvent("deaths");
        RxPlayStats.updateBestStreak(timestamp);
        session.currentKillStreak = 0;
        RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        RxCollector.writeLog(`Statistics: Death detected [source=${source}]`);
        return true;
    };

    static scanWorldLocks = (gameDirectory) => {
        const result = {};
        if (!gameDirectory) return result;
        const savesPath = path.join(gameDirectory, "saves");
        if (!fs.existsSync(savesPath)) return result;
        try {
            fs.readdirSync(savesPath, {withFileTypes: true}).filter(entry => entry.isDirectory()).forEach(entry => {
                const worldPath = path.join(savesPath, entry.name);
                const lockPath = path.join(worldPath, "session.lock");
                const levelPath = path.join(worldPath, "level.dat");
                let modifiedAt = 0;
                try {
                    if (fs.existsSync(lockPath)) modifiedAt = fs.statSync(lockPath).mtimeMs;
                    else if (fs.existsSync(levelPath)) modifiedAt = fs.statSync(levelPath).mtimeMs;
                } catch (_) {}
                if (modifiedAt > 0) result[worldPath] = {name: entry.name, modifiedAt};
            });
        } catch (error) {
            RxCollector.writeLog(`Statistics: World scan failed [error=${error.message}]`);
        }
        return result;
    };

    static discoverCurrentWorld = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session?.gameDirectory) return false;
        const current = RxPlayStats.scanWorldLocks(session.gameDirectory);
        const candidates = Object.entries(current)
            .filter(([worldPath, world]) => world.modifiedAt > (RxPlayStats.worldLocksAtLaunch[worldPath]?.modifiedAt || 0))
            .sort(([, a], [, b]) => b.modifiedAt - a.modifiedAt);
        if (candidates.length === 0) return false;
        const [worldPath, world] = candidates[0];
        RxPlayStats.worldLocksAtLaunch[worldPath] = {...world, path: worldPath};
        return RxPlayStats.setContext("world", world.name, timestamp);
    };

    static clearWorldDiscoveryTimers = () => {
        RxPlayStats.worldDiscoveryTimers.forEach(timer => clearTimeout(timer));
        RxPlayStats.worldDiscoveryTimers = [];
    };

    static scheduleWorldDiscovery = (timestamp = Date.now()) => {
        const sessionId = RxPlayStats.currentSession?.id;
        if (!sessionId) return false;
        RxPlayStats.clearWorldDiscoveryTimers();
        if (RxPlayStats.discoverCurrentWorld(timestamp)) return true;
        [250, 750, 1500, 3000].forEach(delay => {
            const timer = setTimeout(() => {
                if (RxPlayStats.currentSession?.id !== sessionId || RxPlayStats.currentSession.currentContext) return;
                if (RxPlayStats.discoverCurrentWorld(Date.now())) RxPlayStats.clearWorldDiscoveryTimers();
            }, delay);
            RxPlayStats.worldDiscoveryTimers.push(timer);
        });
        return false;
    };

    static readVanillaStatsFile = (filePath) => {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > RxPlayStats.MAX_STATS_FILE_SIZE) return null;
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const custom = RxPlayStats.safeObject(parsed?.stats?.["minecraft:custom"]);
            const directMobKills = custom["minecraft:mob_kills"];
            const directPlayerKills = custom["minecraft:player_kills"];
            const legacyMobKills = parsed?.["stat.mobKills"];
            const legacyPlayerKills = parsed?.["stat.playerKills"];
            let kills = RxPlayStats.number(directMobKills ?? legacyMobKills) + RxPlayStats.number(directPlayerKills ?? legacyPlayerKills);
            if (directMobKills === undefined && directPlayerKills === undefined && legacyMobKills === undefined && legacyPlayerKills === undefined) {
                kills = Object.values(RxPlayStats.safeObject(parsed?.stats?.["minecraft:killed"]))
                    .reduce((sum, value) => sum + RxPlayStats.number(value), 0);
            }
            const deaths = RxPlayStats.number(custom["minecraft:deaths"] ?? parsed?.["stat.deaths"]);
            return {kills, deaths};
        } catch (_) {
            return null;
        }
    };

    static scanVanillaStatistics = (gameDirectory, playerUuid = "") => {
        const result = {};
        if (!gameDirectory) return result;
        const savesPath = path.join(gameDirectory, "saves");
        if (!fs.existsSync(savesPath)) return result;
        try {
            fs.readdirSync(savesPath, {withFileTypes: true}).filter(entry => entry.isDirectory()).forEach(entry => {
                const worldPath = path.join(savesPath, entry.name);
                const statsDirectories = [
                    path.join(worldPath, "stats"),
                    path.join(worldPath, "players", "stats")
                ];
                statsDirectories.forEach(statsDirectory => {
                    if (!fs.existsSync(statsDirectory)) return;
                    const normalizedUuid = String(playerUuid || "").replace(/-/g, "").toLowerCase();
                    fs.readdirSync(statsDirectory, {withFileTypes: true})
                        .filter(file => {
                            if (!file.isFile() || !file.name.toLowerCase().endsWith(".json")) return false;
                            if (!normalizedUuid) return true;
                            return path.basename(file.name, ".json").replace(/-/g, "").toLowerCase() === normalizedUuid;
                        })
                        .forEach(file => {
                            const filePath = path.join(statsDirectory, file.name);
                            const values = RxPlayStats.readVanillaStatsFile(filePath);
                            if (values) result[filePath] = {world: entry.name, ...values};
                        });
                });
            });
        } catch (error) {
            RxCollector.writeLog(`Statistics: Vanilla statistics scan failed [error=${error.message}]`);
        }
        return result;
    };

    static addReconciledCombat = (world, kills, deaths, timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session || (kills <= 0 && deaths <= 0)) return false;
        const cleanWorld = RxPlayStats.cleanText(world) || "Unknown world";
        const records = [
            RxPlayStats.touchDimension("versions", session.versionId, timestamp),
            RxPlayStats.touchDimension("nicknames", session.nickname, timestamp),
            RxPlayStats.touchDimension("worlds", cleanWorld, timestamp)
        ];
        records.filter(Boolean).forEach(record => {
            record.kills += kills;
            record.deaths += deaths;
        });
        session.kills += kills;
        session.deaths += deaths;
        session.sources.vanillaKills += kills;
        session.sources.vanillaDeaths += deaths;
        RxPlayStats.data.totals.kills += kills;
        RxPlayStats.data.totals.deaths += deaths;
        RxPlayStats.touchDay(timestamp).kills += kills;
        RxPlayStats.touchDay(timestamp).deaths += deaths;
        RxPlayStats.touchSessionCombatDay(timestamp).kills += kills;
        RxPlayStats.touchSessionCombatDay(timestamp).deaths += deaths;
        return true;
    };

    static reconcileVanillaStatistics = (timestamp = Date.now()) => {
        const session = RxPlayStats.currentSession;
        if (!session?.gameDirectory) return false;
        const after = RxPlayStats.scanVanillaStatistics(session.gameDirectory, session.playerUuid);
        let changed = false;
        Object.entries(after).forEach(([filePath, current]) => {
            const previous = RxPlayStats.vanillaStatsAtLaunch[filePath] || {kills: 0, deaths: 0};
            const worldEvents = session.eventsByWorld[current.world.toLocaleLowerCase("en-US")] || {kills: 0, deaths: 0};
            const killDelta = Math.max(0, current.kills - previous.kills - RxPlayStats.number(worldEvents.kills));
            const deathDelta = Math.max(0, current.deaths - previous.deaths - RxPlayStats.number(worldEvents.deaths));
            if (killDelta > 0 || deathDelta > 0) {
                changed = RxPlayStats.addReconciledCombat(current.world, killDelta, deathDelta, timestamp) || changed;
            }
        });
        return changed;
    };

    static flushLogBuffer = () => {
        Object.keys(RxPlayStats.logBuffers).forEach(stream => {
            const decodedTail = RxPlayStats.logDecoders[stream]?.end?.() || "";
            const tail = RxPlayStats.logBuffers[stream] + decodedTail;
            RxPlayStats.logBuffers[stream] = "";
            RxPlayStats.logDecoders[stream] = null;
            if (tail) RxPlayStats.handleGameLogLine(tail);
        });
    };

    static onGameClose = (payload = {}) => {
        const session = RxPlayStats.currentSession;
        if (!session) return false;
        if (typeof payload === "string") payload = {reason: payload};
        const closingPid = RxPlayStats.number(payload.pid);
        if (closingPid > 0 && session.pid > 0 && closingPid !== session.pid) return false;
        const now = Date.now();
        RxPlayStats.flushLogBuffer();
        RxPlayStats.checkpoint(false, now);
        RxPlayStats.reconcileVanillaStatistics(now);
        RxPlayStats.updateBestStreak(now);
        clearInterval(RxPlayStats.heartbeatTimer);
        RxPlayStats.heartbeatTimer = null;
        RxPlayStats.clearWorldDiscoveryTimers();

        session.endedAt = now;
        session.currentKillStreak = 0;
        session.currentContext = null;
        session.pendingServer = null;
        session.pid = 0;
        session.exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
        session.endReason = RxPlayStats.cleanText(payload.reason, 40) || "closed";
        RxPlayStats.data.sessions.push(RxPlayStats.normalizeSession(session));
        RxPlayStats.currentSession = null;
        RxPlayStats.data.activeSession = null;
        RxPlayStats.worldLocksAtLaunch = {};
        RxPlayStats.vanillaStatsAtLaunch = {};
        RxPlayStats.saveStats();
        RxPlayStats.emitUpdate();
        RxCollector.writeLog(`Statistics: Session closed [seconds=${session.playSeconds}] [kills=${session.kills}] [deaths=${session.deaths}]`);
        return true;
    };

    static abortSession = (reason = "launch-failed") => RxPlayStats.onGameClose({reason});

    static emitUpdate = () => {
        if (typeof document !== "undefined") {
            document.dispatchEvent(new CustomEvent("rxStatisticsUpdated"));
        }
    };

    static periodCutoff = (period, now = Date.now()) => {
        const date = new Date(now);
        if (period === "today") return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        if (period === "7d") return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 6).getTime();
        if (period === "30d") return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 29).getTime();
        return 0;
    };

    static recordsToRanking = (records) => Object.values(records || {})
        .map(record => ({...record}))
        .sort((a, b) => b.playSeconds - a.playSeconds || b.sessions - a.sessions || a.name.localeCompare(b.name));

    static aggregateSessions = (sessions, cutoffDay = "") => {
        const aggregate = {
            totals: RxPlayStats.createTotals(),
            dimensions: {versions: {}, nicknames: {}, servers: {}, worlds: {}},
            days: {}
        };
        const touch = (type, name) => {
            const key = RxPlayStats.makeKey(type, name);
            if (!aggregate.dimensions[type][key]) {
                aggregate.dimensions[type][key] = {name, playSeconds: 0, sessions: 0, kills: 0, deaths: 0, bestKillStreak: 0, lastPlayed: 0};
            }
            return aggregate.dimensions[type][key];
        };
        const includeDay = day => !cutoffDay || day >= cutoffDay;
        const addContextSeconds = (target, source) => {
            Object.entries(source || {}).forEach(([name, seconds]) => {
                RxPlayStats.incrementSessionCounter(target, name, RxPlayStats.number(seconds));
            });
        };

        sessions.forEach(session => {
            const sessionTimestamp = session.endedAt || session.lastCheckpointAt || session.startedAt;
            const fallbackDay = RxPlayStats.dayKey(sessionTimestamp);
            const dailyPlayEntries = Object.entries(session.dailySeconds || {});
            const dailyCombatEntries = Object.entries(session.dailyCombat || {});
            let filteredPlaySeconds = session.playSeconds;
            let filteredKills = session.kills;
            let filteredDeaths = session.deaths;
            let filteredBestStreak = session.bestKillStreak;

            if (cutoffDay) {
                filteredPlaySeconds = dailyPlayEntries
                    .filter(([day]) => includeDay(day))
                    .reduce((sum, [, seconds]) => sum + RxPlayStats.number(seconds), 0);
                if (dailyPlayEntries.length === 0 && includeDay(fallbackDay)) filteredPlaySeconds = session.playSeconds;

                if (dailyCombatEntries.length > 0) {
                    const includedCombat = dailyCombatEntries.filter(([day]) => includeDay(day));
                    filteredKills = includedCombat.reduce((sum, [, record]) => sum + RxPlayStats.number(record.kills), 0);
                    filteredDeaths = includedCombat.reduce((sum, [, record]) => sum + RxPlayStats.number(record.deaths), 0);
                    filteredBestStreak = includedCombat.reduce(
                        (best, [, record]) => Math.max(best, RxPlayStats.number(record.bestKillStreak)),
                        0
                    );
                } else if (!includeDay(fallbackDay)) {
                    filteredKills = 0;
                    filteredDeaths = 0;
                    filteredBestStreak = 0;
                }
            }

            aggregate.totals.playSeconds += filteredPlaySeconds;
            aggregate.totals.sessions++;
            aggregate.totals.kills += filteredKills;
            aggregate.totals.deaths += filteredDeaths;
            aggregate.totals.bestKillStreak = Math.max(aggregate.totals.bestKillStreak, filteredBestStreak);
            const commonRecords = [touch("versions", session.versionId), touch("nicknames", session.nickname)];
            commonRecords.forEach(record => {
                record.playSeconds += filteredPlaySeconds;
                record.sessions++;
                record.kills += filteredKills;
                record.deaths += filteredDeaths;
                record.bestKillStreak = Math.max(record.bestKillStreak, filteredBestStreak);
                record.lastPlayed = Math.max(record.lastPlayed, sessionTimestamp);
            });

            const filteredContexts = {servers: Object.create(null), worlds: Object.create(null)};
            const dailyContextEntries = Object.entries(session.dailyContexts || {});
            if (cutoffDay && dailyContextEntries.length > 0) {
                dailyContextEntries.filter(([day]) => includeDay(day)).forEach(([, contexts]) => {
                    addContextSeconds(filteredContexts.servers, contexts.servers);
                    addContextSeconds(filteredContexts.worlds, contexts.worlds);
                });
            } else if (cutoffDay) {
                const ratio = session.playSeconds > 0 ? Math.min(1, filteredPlaySeconds / session.playSeconds) : 0;
                Object.entries(session.serverSeconds || {}).forEach(([name, seconds]) => {
                    RxPlayStats.incrementSessionCounter(filteredContexts.servers, name, Math.round(seconds * ratio));
                });
                Object.entries(session.worldSeconds || {}).forEach(([name, seconds]) => {
                    RxPlayStats.incrementSessionCounter(filteredContexts.worlds, name, Math.round(seconds * ratio));
                });
            } else {
                addContextSeconds(filteredContexts.servers, session.serverSeconds);
                addContextSeconds(filteredContexts.worlds, session.worldSeconds);
            }

            Object.entries(filteredContexts.servers).forEach(([name, seconds]) => {
                const record = touch("servers", name);
                record.playSeconds += seconds;
                record.sessions++;
                record.lastPlayed = Math.max(record.lastPlayed, sessionTimestamp);
            });
            Object.entries(filteredContexts.worlds).forEach(([name, seconds]) => {
                const record = touch("worlds", name);
                record.playSeconds += seconds;
                record.sessions++;
                record.lastPlayed = Math.max(record.lastPlayed, sessionTimestamp);
            });

            const includedDays = new Set();
            dailyPlayEntries.filter(([day]) => includeDay(day)).forEach(([day, seconds]) => {
                if (!aggregate.days[day]) aggregate.days[day] = RxPlayStats.createTotals();
                aggregate.days[day].playSeconds += seconds;
                includedDays.add(day);
            });
            dailyCombatEntries.filter(([day]) => includeDay(day)).forEach(([day, record]) => {
                if (!aggregate.days[day]) aggregate.days[day] = RxPlayStats.createTotals();
                aggregate.days[day].kills += RxPlayStats.number(record.kills);
                aggregate.days[day].deaths += RxPlayStats.number(record.deaths);
                aggregate.days[day].bestKillStreak = Math.max(
                    aggregate.days[day].bestKillStreak,
                    RxPlayStats.number(record.bestKillStreak)
                );
                includedDays.add(day);
            });
            if (includedDays.size === 0 && includeDay(fallbackDay)) includedDays.add(fallbackDay);
            includedDays.forEach(day => {
                if (!aggregate.days[day]) aggregate.days[day] = RxPlayStats.createTotals();
                aggregate.days[day].sessions++;
            });
        });
        return aggregate;
    };

    static projectSessionForPeriod = (session, cutoffDay = "") => {
        if (!cutoffDay) return session;
        const aggregate = RxPlayStats.aggregateSessions([session], cutoffDay);
        const toCounterMap = records => {
            const result = Object.create(null);
            Object.values(records || {}).forEach(record => {
                if (record.playSeconds > 0) RxPlayStats.incrementSessionCounter(result, record.name, record.playSeconds);
            });
            return result;
        };
        return {
            ...session,
            playSeconds: aggregate.totals.playSeconds,
            kills: aggregate.totals.kills,
            deaths: aggregate.totals.deaths,
            bestKillStreak: aggregate.totals.bestKillStreak,
            serverSeconds: toCounterMap(aggregate.dimensions.servers),
            worldSeconds: toCounterMap(aggregate.dimensions.worlds)
        };
    };

    static getDashboard = (filters = {}) => {
        RxPlayStats.getAllStats();
        if (RxPlayStats.currentSession) RxPlayStats.checkpoint(false);
        const now = Date.now();
        const period = ["all", "30d", "7d", "today"].includes(filters.period) ? filters.period : "all";
        const nickname = RxPlayStats.cleanText(filters.nickname, 32);
        const nicknameLower = nickname && nickname !== "all" ? nickname.toLocaleLowerCase("en-US") : "";
        const cutoff = RxPlayStats.periodCutoff(period, now);
        const cutoffDay = cutoff > 0 ? RxPlayStats.dayKey(cutoff) : "";
        const allSessions = RxPlayStats.data.sessions.concat(RxPlayStats.currentSession ? [RxPlayStats.currentSession] : []);
        const filteredSessions = allSessions.filter(session => {
            const timestamp = session.endedAt || session.lastCheckpointAt || session.startedAt;
            const nicknameMatches = !nicknameLower || session.nickname.toLocaleLowerCase("en-US") === nicknameLower;
            if (!nicknameMatches) return false;
            if (!cutoffDay) return true;
            const recordedDays = [
                ...Object.keys(session.dailySeconds || {}),
                ...Object.keys(session.dailyCombat || {}),
                ...Object.keys(session.dailyContexts || {})
            ];
            return recordedDays.some(day => day >= cutoffDay) || timestamp >= cutoff;
        });

        const useAllTimeTotals = period === "all" && !nicknameLower;
        const aggregate = useAllTimeTotals
            ? {totals: RxPlayStats.data.totals, dimensions: RxPlayStats.data.dimensions, days: RxPlayStats.data.days}
            : RxPlayStats.aggregateSessions(filteredSessions, cutoffDay);
        const visibleSessions = filteredSessions.map(session => RxPlayStats.projectSessionForPeriod(session, cutoffDay));
        const nicknameOptions = RxPlayStats.recordsToRanking(RxPlayStats.data.dimensions.nicknames).map(record => record.name);

        return {
            period,
            nickname: nicknameLower ? nickname : "all",
            totals: {...aggregate.totals},
            kd: aggregate.totals.deaths > 0
                ? Math.round((aggregate.totals.kills / aggregate.totals.deaths) * 100) / 100
                : aggregate.totals.kills,
            rankings: {
                servers: RxPlayStats.recordsToRanking(aggregate.dimensions.servers).slice(0, 5),
                nicknames: RxPlayStats.recordsToRanking(aggregate.dimensions.nicknames).slice(0, 5),
                worlds: RxPlayStats.recordsToRanking(aggregate.dimensions.worlds).slice(0, 5),
                versions: RxPlayStats.recordsToRanking(aggregate.dimensions.versions).slice(0, 5)
            },
            days: {...aggregate.days},
            sessions: visibleSessions.sort((a, b) => (b.endedAt || b.lastCheckpointAt) - (a.endedAt || a.lastCheckpointAt)),
            nicknameOptions: [...new Set(nicknameOptions)],
            detailedTrackingSince: RxPlayStats.data.detailedTrackingSince,
            legacyMigrated: RxPlayStats.data.migration.legacyPlaySeconds > 0 || RxPlayStats.data.migration.legacySessions > 0,
            active: Boolean(RxPlayStats.currentSession),
            updatedAt: RxPlayStats.data.updatedAt,
            storagePath: RxPlayStats.getStoragePath()
        };
    };

    // Совместимость со старым API статистики по версиям.
    static getByID = (versionId) => {
        RxPlayStats.getAllStats();
        const record = RxPlayStats.data.dimensions.versions[RxPlayStats.makeKey("versions", versionId)];
        if (!record) return false;
        return {
            id: versionId,
            parsed: RxVersionsManager.parseVersionID(versionId),
            starts: record.sessions,
            inGame: record.playSeconds,
            lastStart: record.lastPlayed
        };
    };

    static getLegacyVersionList = () => Object.values(RxPlayStats.data?.dimensions?.versions || {}).map(record => ({
        id: record.name,
        parsed: RxVersionsManager.parseVersionID(record.name),
        starts: record.sessions,
        inGame: record.playSeconds,
        lastStart: record.lastPlayed
    }));

    static getByLastStarted = () => {
        RxPlayStats.getAllStats();
        return RxPlayStats.getLegacyVersionList().sort((a, b) => b.lastStart - a.lastStart);
    };

    static getByIngameTime = () => {
        RxPlayStats.getAllStats();
        return RxPlayStats.getLegacyVersionList().sort((a, b) => b.inGame - a.inGame);
    };
}

if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
        if (RxPlayStats.currentSession) {
            RxPlayStats.checkpoint(false);
            RxPlayStats.saveStats();
        }
    });
}
