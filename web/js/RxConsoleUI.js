// Консоль: лог лаунчера, лог любого из запущенных клиентов Minecraft (RxGameLogs) или прошлого запуска.
// Пока игра идёт, по умолчанию показывается лог игры (последнего запущенного клиента), а не лаунчера.
class RxConsoleUI {
    static lines = [];
    static maxLines = 5000;
    static follow = true;
    static initialized = false;
    static pending = [];
    static frame = 0;
    static source = "auto"; // auto | launcher | id запуска игры
    static sort = "new";

    static t = (key, fallback = "") => MESSAGES.console?.[key] || fallback;

    // Строка лога → {time, level, message}. Лог игры: «[12:34:56] [Render thread/WARN]: текст»,
    // строки стека (at …, Caused by) — ошибки
    static parseLine = rawLine => {
        const clean = String(rawLine || "").replaceAll("undefined", "").trimEnd();
        const game = clean.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[([^\]]*?)\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]:?\s?(.*)$/);
        if (game) {
            const level = {WARN: "warn", ERROR: "error", FATAL: "error"}[game[3]] || "game";
            return {time: game[1], message: `[${game[2]}] ${game[4]}`, level};
        }
        if (/^\s+at\s|^Caused by:|^\s+\.\.\. \d+ more|^[\w.$]+(Exception|Error)(:|$)/.test(clean)) {
            return {time: "", message: clean, level: "error"};
        }
        const timestampMatch = clean.match(/^\[([^\]]+)]\s*/);
        const message = timestampMatch ? clean.slice(timestampMatch[0].length) : clean;
        let level = "info";
        if (/\b(error|exception|fatal|crash|failed|failure)\b/i.test(message)) level = "error";
        else if (/\b(warn|warning|deprecated|retry)\b/i.test(message)) level = "warn";
        else if (/\b(render thread|minecraft|game exit|starter:|server thread)\b/i.test(message)) level = "game";
        return {
            time: timestampMatch ? timestampMatch[1] : "",
            message,
            level
        };
    };

    // Какой лог показан сейчас: "launcher" или id запуска игры
    static current = () => {
        if (RxConsoleUI.source !== "auto") return RxConsoleUI.source;
        const running = [...RxGameLogs.running.values()];
        return running.length ? running[running.length - 1].id : "launcher";
    };

    static currentSession = () => {
        const id = RxConsoleUI.current();
        if (id === "launcher") return null;
        return RxGameLogs.running.get(id) || RxGameLogs.readIndex().find(item => item.id === id) || null;
    };

    // Новые строки журнала лаунчера (RxCollector.writeLog)
    static append = raw => {
        if (RxConsoleUI.current() !== "launcher") return false;
        return RxConsoleUI.push(raw);
    };

    static push = raw => {
        const parsed = (Array.isArray(raw) ? raw : String(raw || "").split(/\r?\n/)).filter(line => String(line).trim()).map(RxConsoleUI.parseLine);
        if (parsed.length === 0) return false;
        RxConsoleUI.lines.push(...parsed);
        if (RxConsoleUI.lines.length > RxConsoleUI.maxLines) RxConsoleUI.lines.splice(0, RxConsoleUI.lines.length - RxConsoleUI.maxLines);

        if (!RxModals.isModalShown("console") || document.hidden) return true;
        RxConsoleUI.pending.push(...parsed);
        if (RxConsoleUI.frame) return true;
        RxConsoleUI.frame = requestAnimationFrame(RxConsoleUI.flush);
        return true;
    };

    static flush = () => {
        RxConsoleUI.frame = 0;
        const parsed = RxConsoleUI.pending.splice(0);
        if (!parsed.length || !RxModals.isModalShown("console") || document.hidden) return;
        const $list = $("#modal-console [data-console-lines]");
        if ($list.length === 0) return;
        const query = String($("#modal-console [data-console-search]").val() || "").trim().toLowerCase();
        const filter = String($("#modal-console [data-console-filter]").val() || "all");
        const $wrapper = $("#modal-console .console-wrapper");
        const nearBottom = !$wrapper[0] || ($wrapper[0].scrollHeight - $wrapper.scrollTop() - $wrapper.innerHeight()) < 90;
        const fragment = document.createDocumentFragment();
        let shown = 0;
        parsed.forEach(line => {
            if (!RxConsoleUI.matches(line, query, filter)) return;
            fragment.appendChild(RxConsoleUI.createLineNode(line)[0]);
            shown++;
        });
        $list[0].appendChild(fragment);
        while ($list.children().length > RxConsoleUI.maxLines) $list.children().first().remove();
        if (shown) $("#modal-console [data-console-empty]").prop("hidden", true);
        RxConsoleUI.updateStatus();
        if (RxConsoleUI.follow && nearBottom) RxConsoleUI.scrollToBottom();
    };

    static matches = (line, query, filter) => {
        if (filter !== "all" && line.level !== filter) return false;
        return !query || `${line.time} ${line.message}`.toLowerCase().includes(query);
    };

    static createLineNode = line => {
        const $line = $("<div>").addClass(`console-line level-${line.level}`);
        const shortTime = line.time.includes("T") ? line.time.slice(11, 19) : line.time.slice(0, 19);
        $line.append($("<span>").addClass("console-line-time").text(shortTime));
        $line.append($("<span>").addClass("console-line-level").text(({error: "ERR", warn: "WRN", game: "GAME", info: "LOG"})[line.level]));
        $line.append($("<span>").addClass("console-line-message").text(line.message));
        return $line;
    };

    static render = () => {
        RxConsoleUI.pending.length = 0;
        const query = String($("#modal-console [data-console-search]").val() || "").trim().toLowerCase();
        const filter = String($("#modal-console [data-console-filter]").val() || "all");
        const $list = $("#modal-console [data-console-lines]").empty();
        const fragment = document.createDocumentFragment();
        const visible = RxConsoleUI.lines.filter(line => RxConsoleUI.matches(line, query, filter));
        visible.forEach(line => fragment.appendChild(RxConsoleUI.createLineNode(line)[0]));
        if ($list[0]) $list[0].appendChild(fragment);
        $("#modal-console [data-console-empty]").prop("hidden", visible.length > 0);
        RxConsoleUI.updateStatus();
        if (RxConsoleUI.follow) RxConsoleUI.scrollToBottom();
        return true;
    };

    // Перечитать строки выбранного источника
    static load = () => {
        const id = RxConsoleUI.current();
        const text = id === "launcher" ? LAST_LOG : RxGameLogs.read(id);
        RxConsoleUI.lines = String(text || "").split(/\r?\n/).filter(line => line.trim()).slice(-RxConsoleUI.maxLines).map(RxConsoleUI.parseLine);
        RxConsoleUI.renderSources();
        return RxConsoleUI.render();
    };

    static renderAll = () => RxConsoleUI.load();

    static formatDuration = (ms) => {
        const minutes = Math.max(0, Math.round(ms / 60000));
        if (minutes < 1) return `< 1 ${MESSAGES.starter?.min || "мин"}`;
        if (minutes < 60) return `${minutes} ${MESSAGES.starter?.min || "мин"}`;
        return `${Math.floor(minutes / 60)} ${RxConsoleUI.t("hoursShort", "ч")} ${minutes % 60} ${MESSAGES.starter?.min || "мин"}`;
    };

    static sessionLabel = (item, running = false) => {
        const started = new Date(item.startedAt);
        const pad = (value) => String(value).padStart(2, "0");
        const time = `${pad(started.getHours())}:${pad(started.getMinutes())}`;
        const date = `${pad(started.getDate())}.${pad(started.getMonth() + 1)}`;
        const parts = [running ? `▶ ${item.title}` : `${date} ${time} · ${item.title}`];
        if (item.nickname) parts.push(item.nickname);
        if (running) parts.push(time);
        else {
            if (item.endedAt) parts.push(RxConsoleUI.formatDuration(item.endedAt - item.startedAt));
            if (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0) parts.push(RxConsoleUI.t("crashed", "вылет"));
        }
        return parts.join(" · ");
    };

    // Список источников: «Сейчас» (запущенные клиенты и лаунчер) и «Прошлые запуски»
    static renderSources = () => {
        const select = $("#modal-console [data-console-source]")[0];
        if (!select) return;
        const current = RxConsoleUI.current();
        const running = [...RxGameLogs.running.values()];
        const history = RxGameLogs.history(RxConsoleUI.sort);
        const option = (value, label) => {
            const element = document.createElement("option");
            element.value = value;
            element.textContent = label;
            return element;
        };
        const now = document.createElement("optgroup");
        now.label = RxConsoleUI.t("now", "Сейчас");
        running.forEach(item => now.appendChild(option(item.id, RxConsoleUI.sessionLabel(item, true))));
        now.appendChild(option("launcher", RxConsoleUI.t("launcherLog", "Лаунчер")));
        select.replaceChildren(now);
        if (history.length) {
            const past = document.createElement("optgroup");
            past.label = RxConsoleUI.t("history", "Прошлые запуски");
            history.forEach(item => past.appendChild(option(item.id, RxConsoleUI.sessionLabel(item))));
            select.appendChild(past);
        }
        select.value = [...select.options].some(item => item.value === current) ? current : "launcher";
        RxSelect.refresh(select);

        const session = RxConsoleUI.currentSession();
        const live = current === "launcher" || Boolean(session && RxGameLogs.running.has(session.id));
        $("#modal-console [data-console-live]").toggleClass("paused", !live)
            .find("span").text(live ? RxConsoleUI.t("live", "В реальном времени") : RxConsoleUI.t("archived", "Сохранённый лог"));
        const pid = session && RxGameLogs.running.has(session.id) ? session.pid : 0;
        $("#modal-console [data-console-action=stop]").prop("hidden", !pid).attr("data-pid", pid || "");
        let info = "";
        if (session && !RxGameLogs.running.has(session.id)) {
            const code = session.exitCode;
            info = code === 0 ? RxConsoleUI.t("exitOk", "Закрыта нормально")
                : code === null || code === undefined ? "" : RxConsoleUI.t("exitCode", "Код выхода {0}").replace("{0}", code);
        } else if (session) {
            info = session.pid ? `PID ${session.pid}` : "";
        }
        $("#modal-console [data-console-info]").text(info);
        const sortSelect = $("#modal-console [data-console-sort]")[0];
        if (sortSelect) (sortSelect.rxSelect?.wrapper || sortSelect).style.display = history.length < 2 ? "none" : "";
    };

    // Открыть консоль с логом конкретного запуска (краш, «показывать консоль при запуске»)
    static showSession = (id) => {
        if (id && RxGameLogs.validId(id)) RxConsoleUI.source = id;
        RxModals.switchModal("console");
        RxConsoleUI.load();
    };

    static updateStatus = () => {
        $("#modal-console [data-console-count]").text(RxConsoleUI.lines.length);
        $("#modal-console [data-console-follow]").toggleClass("active", RxConsoleUI.follow)
            .find("span:last-child").text(RxConsoleUI.follow
                ? RxConsoleUI.t("followOn", "Автопрокрутка")
                : RxConsoleUI.t("followOff", "Прокрутка выключена"));
    };

    static scrollToBottom = () => {
        const wrapper = $("#modal-console .console-wrapper")[0];
        if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    };

    static copy = async () => {
        const visibleText = $("#modal-console [data-console-lines] .console-line").map(function () {
            return $(this).text();
        }).get().join("\n");
        const id = RxConsoleUI.current();
        await navigator.clipboard.writeText(visibleText || (id === "launcher" ? String(LAST_LOG || "") : RxGameLogs.read(id)));
        RxToasts.create(MESSAGES.console.copied, "content_copy");
    };

    // Очистить экран. Прошлый запуск — удалить его сохранённый лог
    static clear = async () => {
        const id = RxConsoleUI.current();
        if (id === "launcher") {
            global.LAST_LOG = "";
        } else if (!RxGameLogs.running.has(id)) {
            const result = await RxDialog.open({
                icon: "delete", title: RxConsoleUI.t("deleteTitle", "Удалить этот лог?"),
                buttons: [{id: "cancel", text: MESSAGES.commons?.cancel || "Отмена"}, {id: "delete", text: RxConsoleUI.t("delete", "Удалить"), danger: true, primary: true}]
            });
            if (result?.button !== "delete") return false;
            RxGameLogs.remove(id);
            RxConsoleUI.source = "auto";
            return RxConsoleUI.load();
        }
        RxConsoleUI.lines = [];
        RxConsoleUI.render();
        return true;
    };

    // Папка логов: для лаунчера — логи игры в её папке, для запусков — сохранённые логи запусков
    static openDirectory = () => {
        const logsPath = RxConsoleUI.current() === "launcher" ? path.join(GAME_DATA, "logs") : RxGameLogs.DIR();
        if (!fs.existsSync(logsPath)) fs.mkdirSync(logsPath, {recursive: true});
        openExternal(logsPath);
    };

    static bind = () => {
        RxConsoleUI.initialized = true;
        RxConsoleUI.load();
        const $modal = $("#modal-console");
        $modal.on("input", "[data-console-search]", RxConsoleUI.render);
        $modal.on("change", "[data-console-filter]", RxConsoleUI.render);
        $modal.on("change", "[data-console-source]", function () {
            const value = String($(this).val() || "launcher");
            // Выбран последний запущенный клиент — консоль и дальше сама переключается на новые
            const running = [...RxGameLogs.running.values()];
            RxConsoleUI.source = running.length && running[running.length - 1].id === value ? "auto" : value;
            RxConsoleUI.load();
        });
        $modal.on("change", "[data-console-sort]", function () {
            RxConsoleUI.sort = String($(this).val() || "new");
            RxConsoleUI.renderSources();
        });
        $modal.on("click", "[data-console-action]", function () {
            const action = $(this).data("console-action");
            if (action === "copy") RxConsoleUI.copy();
            if (action === "clear") RxConsoleUI.clear();
            if (action === "folder") RxConsoleUI.openDirectory();
            if (action === "stop") RxStarter.killPid($(this).attr("data-pid"));
            if (action === "follow") {
                RxConsoleUI.follow = !RxConsoleUI.follow;
                RxConsoleUI.updateStatus();
                if (RxConsoleUI.follow) RxConsoleUI.scrollToBottom();
            }
        });
        RxGameLogs.onChange((type, session, lines) => {
            if (type === "lines") {
                if (RxConsoleUI.current() === session.id) RxConsoleUI.push(lines);
                return;
            }
            // Клиент запустился: при «авто» сразу показываем его лог; закрылся — обновляем список
            if (type === "begin" && RxConsoleUI.source === "auto") return RxConsoleUI.load();
            RxConsoleUI.renderSources();
        });
        document.addEventListener("showModalEvent", event => {
            if (event.detail?.modal === "console") {
                RxConsoleUI.load();
                requestAnimationFrame(RxConsoleUI.scrollToBottom);
            }
        });
    };
}

window.updateConsole = () => RxConsoleUI.load();
$(RxConsoleUI.bind);
