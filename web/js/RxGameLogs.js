// Логи Minecraft по запускам: у каждого клиента свой журнал (их может быть запущено несколько сразу).
// Каждый запуск сохраняется в %APPDATA%\rxclient\game-logs\<id>.log, список — в index.json.
// Консоль показывает лог выбранного клиента, а прошлые запуски можно открыть и отсортировать.
class RxGameLogs {
    static DIR = () => path.join(USERDATA_PATH, "game-logs");
    static INDEX = () => path.join(RxGameLogs.DIR(), "index.json");
    static MAX_LINES = 5000;          // в памяти на один запуск
    static MAX_SESSIONS = 60;         // сколько прошлых запусков хранить
    static MAX_TOTAL_BYTES = 200 * 1024 * 1024;
    static MAX_FILE_BYTES = 32 * 1024 * 1024; // дальше лог одного запуска на диск не пишется
    static FLUSH_MS = 1500;

    static running = new Map(); // id → session
    static index = null;
    static listeners = new Set();

    static onChange = (listener) => RxGameLogs.listeners.add(listener);

    static emit = (type, session, lines = []) => {
        RxGameLogs.listeners.forEach(listener => {
            try { listener(type, session, lines); } catch (_) {}
        });
    };

    static readIndex = () => {
        if (RxGameLogs.index) return RxGameLogs.index;
        try {
            const parsed = JSON.parse(fs.readFileSync(RxGameLogs.INDEX(), "utf8"));
            RxGameLogs.index = Array.isArray(parsed?.sessions) ? parsed.sessions.filter(item => RxGameLogs.validId(item?.id)) : [];
        } catch (_) {
            RxGameLogs.index = [];
        }
        return RxGameLogs.index;
    };

    static writeIndex = () => {
        try {
            fs.mkdirSync(RxGameLogs.DIR(), {recursive: true});
            fs.writeFileSync(RxGameLogs.INDEX(), JSON.stringify({sessions: RxGameLogs.readIndex()}));
        } catch (error) {
            RxCollector.writeLog(`GameLogs: Index write failed [error=${error?.message || error}]`);
        }
    };

    static validId = (id) => typeof id === "string" && /^[0-9]{13}-[0-9a-z]{1,8}$/.test(id);

    static fileOf = (id) => path.join(RxGameLogs.DIR(), `${id}.log`);

    // Новый запуск. info: {title, version, loader, nickname, gameDirectory}
    static begin = (info = {}) => {
        const startedAt = Date.now();
        const session = {
            id: `${startedAt}-${Math.random().toString(36).slice(2, 7)}`,
            title: String(info.title || info.version || "Minecraft").slice(0, 80),
            version: String(info.version || "").slice(0, 40),
            loader: String(info.loader || "").slice(0, 24),
            nickname: String(info.nickname || "").slice(0, 32),
            gameDirectory: String(info.gameDirectory || ""),
            startedAt,
            endedAt: 0,
            exitCode: null,
            pid: 0,
            size: 0,
            lineCount: 0,
            running: true,
            lines: [],
            pending: [],
            timer: 0,
            writing: Promise.resolve()
        };
        RxGameLogs.running.set(session.id, session);
        RxGameLogs.readIndex().unshift(RxGameLogs.meta(session));
        RxGameLogs.prune();
        RxGameLogs.writeIndex();
        RxGameLogs.emit("begin", session);
        return session;
    };

    static meta = (session) => ({
        id: session.id, title: session.title, version: session.version, loader: session.loader, nickname: session.nickname,
        startedAt: session.startedAt, endedAt: session.endedAt, exitCode: session.exitCode, size: session.size, lineCount: session.lineCount
    });

    static setPid = (session, pid) => {
        if (!session) return;
        session.pid = Number(pid) || 0;
        RxGameLogs.emit("update", session);
    };

    // Строки из вывода игры (секреты вырезаются так же, как в журнале лаунчера)
    static append = (session, chunk) => {
        if (!session || !chunk) return;
        const parsed = String(chunk).split(/\r?\n/).filter(line => line.trim())
            .map(line => RxCollector.redact(line.length > 4000 ? line.slice(0, 4000) : line));
        if (!parsed.length) return;
        session.lines.push(...parsed);
        session.lineCount += parsed.length;
        if (session.lines.length > RxGameLogs.MAX_LINES) session.lines.splice(0, session.lines.length - RxGameLogs.MAX_LINES);
        session.pending.push(...parsed);
        if (!session.timer) session.timer = setTimeout(() => RxGameLogs.flush(session), RxGameLogs.FLUSH_MS);
        RxGameLogs.emit("lines", session, parsed);
    };

    static flush = (session) => {
        if (session.timer) clearTimeout(session.timer);
        session.timer = 0;
        if (!session.pending.length) return session.writing;
        const text = session.pending.splice(0).join("\n") + "\n";
        if (session.size >= RxGameLogs.MAX_FILE_BYTES) return session.writing;
        session.size += new TextEncoder().encode(text).length;
        const file = RxGameLogs.fileOf(session.id);
        session.writing = session.writing
            .then(() => fs.promises.mkdir(RxGameLogs.DIR(), {recursive: true}))
            .then(() => fs.promises.appendFile(file, text, "utf8"))
            .catch(error => RxCollector.writeLog(`GameLogs: Write failed [error=${error?.message || error}]`));
        return session.writing;
    };

    static end = async (session, exitCode) => {
        if (!session || !session.running) return;
        session.running = false;
        session.endedAt = Date.now();
        session.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;
        RxGameLogs.running.delete(session.id);
        await RxGameLogs.flush(session);
        const index = RxGameLogs.readIndex();
        const position = index.findIndex(item => item.id === session.id);
        if (position >= 0) index[position] = RxGameLogs.meta(session);
        RxGameLogs.writeIndex();
        RxGameLogs.emit("end", session);
    };

    // Старые запуски удаляются: не больше MAX_SESSIONS и MAX_TOTAL_BYTES
    static prune = () => {
        const index = RxGameLogs.readIndex();
        index.sort((a, b) => b.startedAt - a.startedAt);
        let total = 0;
        const keep = [];
        for (const item of index) {
            total += Number(item.size) || 0;
            const active = RxGameLogs.running.has(item.id);
            if (active || (keep.length < RxGameLogs.MAX_SESSIONS && total <= RxGameLogs.MAX_TOTAL_BYTES)) keep.push(item);
            else {
                try { fs.unlinkSync(RxGameLogs.fileOf(item.id)); } catch (_) {}
            }
        }
        RxGameLogs.index = keep;
    };

    // Прошлые запуски (без идущих сейчас). sort: new | old | crash | version | long
    static history = (sort = "new") => {
        const list = RxGameLogs.readIndex().filter(item => !RxGameLogs.running.has(item.id));
        const duration = item => (item.endedAt || item.startedAt) - item.startedAt;
        const crashed = item => item.exitCode !== null && item.exitCode !== 0;
        const sorters = {
            new: (a, b) => b.startedAt - a.startedAt,
            old: (a, b) => a.startedAt - b.startedAt,
            crash: (a, b) => (crashed(b) - crashed(a)) || (b.startedAt - a.startedAt),
            version: (a, b) => String(a.version).localeCompare(String(b.version), undefined, {numeric: true}) || (b.startedAt - a.startedAt),
            long: (a, b) => duration(b) - duration(a)
        };
        return list.slice().sort(sorters[sort] || sorters.new);
    };

    static read = (id) => {
        if (!RxGameLogs.validId(id)) return "";
        const live = RxGameLogs.running.get(id);
        if (live) return live.lines.join("\n");
        try {
            return fs.readFileSync(RxGameLogs.fileOf(id), "utf8");
        } catch (_) {
            return "";
        }
    };

    static remove = (id) => {
        if (!RxGameLogs.validId(id) || RxGameLogs.running.has(id)) return false;
        try { fs.unlinkSync(RxGameLogs.fileOf(id)); } catch (_) {}
        RxGameLogs.index = RxGameLogs.readIndex().filter(item => item.id !== id);
        RxGameLogs.writeIndex();
        return true;
    };

    // Последний лог игры — для архива отладки
    static latestFile = () => {
        const latest = RxGameLogs.readIndex()[0];
        return latest ? RxGameLogs.fileOf(latest.id) : "";
    };
}
