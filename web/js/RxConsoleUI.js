class RxConsoleUI {
    static lines = [];
    static maxLines = 1800;
    static follow = true;
    static initialized = false;
    static pending = [];
    static frame = 0;

    static parseLine = rawLine => {
        const clean = String(rawLine || "").replaceAll("undefined", "").trimEnd();
        const timestampMatch = clean.match(/^\[([^\]]+)]\s*/);
        const message = timestampMatch ? clean.slice(timestampMatch[0].length) : clean;
        let level = "info";
        if (/\b(error|exception|fatal|crash|failed|failure)\b/i.test(message)) level = "error";
        else if (/\b(warn|warning|deprecated|retry)\b/i.test(message)) level = "warn";
        else if (/\b(render thread|minecraft|game exit|starter:|server thread)\b/i.test(message)) level = "game";
        return {
            time: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
            message,
            level
        };
    };

    static append = raw => {
        const parsed = String(raw || "").split(/\r?\n/).filter(line => line.trim()).map(RxConsoleUI.parseLine);
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
        parsed.forEach(line => {
            if (RxConsoleUI.matches(line, query, filter)) fragment.appendChild(RxConsoleUI.createLineNode(line)[0]);
        });
        $list[0].appendChild(fragment);
        while ($list.children().length > RxConsoleUI.maxLines) $list.children().first().remove();
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
        RxConsoleUI.lines.filter(line => RxConsoleUI.matches(line, query, filter))
            .forEach(line => fragment.appendChild(RxConsoleUI.createLineNode(line)[0]));
        if ($list[0]) $list[0].appendChild(fragment);
        RxConsoleUI.updateStatus();
        if (RxConsoleUI.follow) RxConsoleUI.scrollToBottom();
        return true;
    };

    static renderAll = raw => {
        RxConsoleUI.lines = String(raw || "").split(/\r?\n/).filter(line => line.trim()).map(RxConsoleUI.parseLine).slice(-RxConsoleUI.maxLines);
        return RxConsoleUI.render();
    };

    static updateStatus = () => {
        $("#modal-console [data-console-count]").text(RxConsoleUI.lines.length);
        $("#modal-console [data-console-follow]").toggleClass("active", RxConsoleUI.follow)
            .find("span:last-child").text(RxConsoleUI.follow
                ? (MESSAGES.console?.followOn || "Автопрокрутка")
                : (MESSAGES.console?.followOff || "Прокрутка выключена"));
    };

    static scrollToBottom = () => {
        const wrapper = $("#modal-console .console-wrapper")[0];
        if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    };

    static copy = async () => {
        const visibleText = $("#modal-console [data-console-lines] .console-line").map(function () {
            return $(this).text();
        }).get().join("\n");
        await navigator.clipboard.writeText(visibleText || String(LAST_LOG || ""));
        RxToasts.create(MESSAGES.console.copied, "content_copy");
    };

    static clear = () => {
        global.LAST_LOG = "";
        RxConsoleUI.lines = [];
        RxConsoleUI.render();
        return true;
    };

    static openDirectory = () => {
        const logsPath = path.join(GAME_DATA, "logs");
        if (!fs.existsSync(logsPath)) fs.mkdirSync(logsPath, {recursive: true});
        openExternal(logsPath);
    };

    static bind = () => {
        RxConsoleUI.initialized = true;
        RxConsoleUI.renderAll(LAST_LOG);
        const $modal = $("#modal-console");
        $modal.on("input", "[data-console-search]", RxConsoleUI.render);
        $modal.on("change", "[data-console-filter]", RxConsoleUI.render);
        $modal.on("click", "[data-console-action]", function () {
            const action = $(this).data("console-action");
            if (action === "copy") RxConsoleUI.copy();
            if (action === "clear") RxConsoleUI.clear();
            if (action === "folder") RxConsoleUI.openDirectory();
            if (action === "follow") {
                RxConsoleUI.follow = !RxConsoleUI.follow;
                RxConsoleUI.updateStatus();
                if (RxConsoleUI.follow) RxConsoleUI.scrollToBottom();
            }
        });
        document.addEventListener("showModalEvent", event => {
            if (event.detail?.modal === "console") {
                RxConsoleUI.render();
                requestAnimationFrame(RxConsoleUI.scrollToBottom);
            }
        });
    };
}

window.updateConsole = () => RxConsoleUI.renderAll(LAST_LOG);
$(RxConsoleUI.bind);
