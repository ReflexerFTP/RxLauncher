class RxStatisticsUI {
    static period = "all";
    static nickname = "all";
    static sessionPage = 1;
    static sessionPageSize = 5;
    static refreshTimer = null;

    static locale = () => {
        return String(RxTranslator.getCurrentLanguage() || "ru").toLowerCase() === "en" ? "en-US" : "ru-RU";
    };

    static init = () => {
        $("#stats-nickname-filter").attr("aria-label", MESSAGES.statistics.profile);

        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "statistics") return;
            RxStatisticsUI.render(true);
            clearInterval(RxStatisticsUI.refreshTimer);
            RxStatisticsUI.refreshTimer = setInterval(() => {
                if (RxModals.isModalShown("statistics")) RxStatisticsUI.render(false);
            }, 15000);
        });

        $(document).on("hideModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "statistics") return;
            clearInterval(RxStatisticsUI.refreshTimer);
            RxStatisticsUI.refreshTimer = null;
        });

        document.addEventListener("rxStatisticsUpdated", () => {
            if (RxModals.isModalShown("statistics")) RxStatisticsUI.render(false);
        });

        $("#stats-period-tabs").on("click", ".stats-period-btn", function () {
            if ($(this).hasClass("active")) return;
            RxStatisticsUI.period = String($(this).data("period") || "all");
            RxStatisticsUI.sessionPage = 1;
            $("#stats-period-tabs .stats-period-btn").removeClass("active");
            $(this).addClass("active");
            RxStatisticsUI.render(false);
        });

        $("#stats-nickname-filter").on("change", function () {
            RxStatisticsUI.nickname = String($(this).val() || "all");
            RxStatisticsUI.sessionPage = 1;
            RxStatisticsUI.render(false);
        });

        $("#stats-session-prev").on("click", () => {
            if (RxStatisticsUI.sessionPage > 1) {
                RxStatisticsUI.sessionPage--;
                RxStatisticsUI.render(false);
            }
        });

        $("#stats-session-next").on("click", () => {
            RxStatisticsUI.sessionPage++;
            RxStatisticsUI.render(false);
        });

        $("#stats-refresh-button").on("click", () => RxStatisticsUI.render(true));
        $("#stats-open-folder-button").on("click", () => openExternal(path.dirname(RxPlayStats.getStoragePath())));
        $("#stats-export-button").on("click", () => RxStatisticsUI.exportStatistics());
    };

    static formatNumber = (value) => new Intl.NumberFormat(RxStatisticsUI.locale()).format(Number(value) || 0);

    static formatDuration = (seconds, compact = false) => {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        if (compact) {
            if (hours > 0) return `${hours} ${MESSAGES.statistics.units.hoursShort} ${minutes} ${MESSAGES.statistics.units.minutesShort}`;
            return `${minutes} ${MESSAGES.statistics.units.minutesShort}`;
        }
        if (hours > 0) return `${hours} ${MESSAGES.statistics.units.hours} ${minutes} ${MESSAGES.statistics.units.minutes}`;
        if (minutes > 0) return `${minutes} ${MESSAGES.statistics.units.minutes}`;
        return `${total} ${MESSAGES.statistics.units.seconds}`;
    };

    static formatDate = (timestamp) => {
        if (!timestamp) return "—";
        return new Intl.DateTimeFormat(RxStatisticsUI.locale(), {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
        }).format(new Date(timestamp));
    };

    static updateNicknameOptions = (options) => {
        const $select = $("#stats-nickname-filter");
        const current = RxStatisticsUI.nickname;
        const existing = new Set($select.find("option").map((_, option) => option.value).get());
        options.forEach(name => {
            if (!existing.has(name)) $select.append($("<option>").val(name).text(name));
        });
        if (current !== "all" && !options.includes(current)) RxStatisticsUI.nickname = "all";
        $select.val(RxStatisticsUI.nickname);
    };

    // Сколько дней показывать на графике активности для выбранного периода
    static chartDays = () => ({"30d": 30, "7d": 7})[RxStatisticsUI.period] || 14;

    static CALENDAR_WEEKS = 16;

    static render = (refreshOptions = false) => {
        const snapshot = RxPlayStats.getDashboard({
            period: RxStatisticsUI.period,
            nickname: RxStatisticsUI.nickname
        });
        if (refreshOptions) RxStatisticsUI.updateNicknameOptions(snapshot.nicknameOptions);
        const set = (key, value) => $(`#modal-statistics [data-stat-value='${key}']`).text(value);
        const totals = snapshot.totals;

        set("playtime", RxStatisticsUI.formatDuration(totals.playSeconds, true));
        set("sessions", RxStatisticsUI.formatNumber(totals.sessions));
        set("avgSession", MESSAGES.statistics.avgSession.replace("{0}",
            RxStatisticsUI.formatDuration(totals.sessions ? totals.playSeconds / totals.sessions : 0, true)));
        set("kills", RxStatisticsUI.formatNumber(totals.kills));
        set("deaths", RxStatisticsUI.formatNumber(totals.deaths));
        set("bestStreak", RxStatisticsUI.formatNumber(totals.bestKillStreak));
        set("kd", Number(snapshot.kd || 0).toLocaleString(RxStatisticsUI.locale(), {maximumFractionDigits: 2}));
        $("#stats-live-pill").toggleClass("active", snapshot.active);
        $("#stats-storage-path").text(snapshot.storagePath).attr("title", snapshot.storagePath);

        RxStatisticsUI.renderActivity(snapshot.days);
        // Календарь всегда за последние недели, независимо от выбранного периода
        RxStatisticsUI.renderCalendar(RxStatisticsUI.period === "all"
            ? snapshot.days
            : RxPlayStats.getDashboard({period: "all", nickname: RxStatisticsUI.nickname}).days);
        ["servers", "worlds", "versions", "nicknames"].forEach(type => RxStatisticsUI.renderRanking(type, snapshot.rankings[type] || []));
        RxStatisticsUI.renderSessions(snapshot.sessions);

        $("#stats-migration-note").toggle(
            snapshot.legacyMigrated && RxStatisticsUI.period === "all" && RxStatisticsUI.nickname === "all"
        );
        return snapshot;
    };

    // Понятное имя версии: «Fabric 1.21.4», у сборки — её название
    static versionName = (versionId) => {
        try {
            return RxVersionsManager.versionToDisplayName(versionId) || versionId;
        } catch (_) {
            return versionId;
        }
    };

    static emptyState = (text) => $("<div>").addClass("st-empty")
        .append($("<span>").addClass("material-symbols-outlined").text("hourglass_empty"), $("<span>").text(text));

    static renderRanking = (type, items) => {
        const $list = $(`#modal-statistics [data-ranking="${type}"] .st-rank-list`);
        $list.empty();
        if (!items.length) {
            $list.append(RxStatisticsUI.emptyState(MESSAGES.statistics.noDataYet));
            return;
        }
        const maximum = Math.max(1, items[0].playSeconds);
        items.forEach((item, index) => {
            const name = type === "versions" ? RxStatisticsUI.versionName(item.name) : item.name;
            const percent = Math.max(3, Math.round((item.playSeconds / maximum) * 100));
            $list.append($("<div>").addClass("st-rank-row").append(
                $("<span>").addClass("st-rank-num").text(index + 1),
                $("<span>").addClass("st-rank-name").text(name).attr("title", name),
                $("<span>").addClass("st-rank-time").text(RxStatisticsUI.formatDuration(item.playSeconds, true)),
                $("<div>").addClass("st-rank-track").append($("<div>").addClass("st-rank-progress").css("width", `${percent}%`))
            ));
        });
    };

    static lastDays = (count) => {
        const now = new Date();
        return Array.from({length: count}, (_, index) => {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index));
            return {date, key: RxPlayStats.dayKey(date.getTime())};
        });
    };

    // Столбцы по дням с сеткой по часам и подсказкой при наведении
    static renderActivity = (days) => {
        const $chart = $("#stats-activity-chart");
        $chart.empty();
        const count = RxStatisticsUI.chartDays();
        const values = RxStatisticsUI.lastDays(count).map(item => ({...item, seconds: Number(days[item.key]?.playSeconds) || 0}));
        const total = values.reduce((sum, item) => sum + item.seconds, 0);
        $("#modal-statistics [data-stat-value='activityHint']").text(MESSAGES.statistics.lastDays.replace("{0}", count));
        $("#modal-statistics [data-stat-value='activityTotal']").text(total ? RxStatisticsUI.formatDuration(total, true) : "");

        // Шкала: круглое число часов (или минут, если играли мало)
        const maximum = Math.max(...values.map(item => item.seconds));
        const step = maximum >= 3 * 3600 ? 3600 * Math.ceil(maximum / 3600 / 3) : maximum >= 3600 ? 1800 : 600;
        const top = Math.max(step * 3, Math.ceil(maximum / step) * step);
        for (let line = step; line <= top; line += step) {
            const units = MESSAGES.statistics.units;
            const lineLabel = line % 3600 === 0 ? `${line / 3600} ${units.hoursShort}` : line < 3600 ? `${line / 60} ${units.minutesShort}` : RxStatisticsUI.formatDuration(line, true);
            $chart.append($("<div>").addClass("st-grid-line").css("bottom", `calc(20px + (100% - 20px) * ${line / top})`)
                .append($("<span>").text(lineLabel)));
        }

        const weekday = new Intl.DateTimeFormat(RxStatisticsUI.locale(), {weekday: "short"});
        const fullDate = new Intl.DateTimeFormat(RxStatisticsUI.locale(), {weekday: "long", day: "numeric", month: "long"});
        values.forEach((item, index) => {
            const height = item.seconds > 0 ? Math.max(3, (item.seconds / top) * 100) : 0;
            const label = count > 14 ? (index % 3 === (count - 1) % 3 ? String(item.date.getDate()) : "") : `${weekday.format(item.date).slice(0, 2)} ${item.date.getDate()}`;
            $chart.append($("<div>").addClass("st-bar-column").toggleClass("today", index === values.length - 1).append(
                $("<div>").addClass("st-bar-tip").text(item.seconds ? RxStatisticsUI.formatDuration(item.seconds, true) : MESSAGES.statistics.noPlay)
                    .append($("<small>").text(fullDate.format(item.date))),
                $("<div>").addClass("st-bar").toggleClass("empty", !item.seconds).css("height", item.seconds ? `${height}%` : "3px"),
                $("<span>").addClass("st-bar-label").text(label)
            ));
        });
    };

    // Календарь игры за последние недели: столбец — неделя, клетка — день
    static renderCalendar = (days) => {
        const $calendar = $("#stats-calendar");
        $calendar.empty();
        const today = new Date();
        const todayKey = RxPlayStats.dayKey(today.getTime());
        const weekStart = (today.getDay() + 6) % 7; // понедельник = 0
        const total = RxStatisticsUI.CALENDAR_WEEKS * 7;
        const cells = RxStatisticsUI.lastDays(total - (6 - weekStart));
        const maximum = Math.max(1, ...cells.map(item => Number(days[item.key]?.playSeconds) || 0));
        const format = new Intl.DateTimeFormat(RxStatisticsUI.locale(), {day: "numeric", month: "long"});
        let played = 0;
        cells.forEach(item => {
            const seconds = Number(days[item.key]?.playSeconds) || 0;
            if (seconds) played++;
            const level = seconds ? Math.min(4, 1 + Math.floor((seconds / maximum) * 3.999)) : 0;
            $calendar.append($("<i>").attr({"data-level": level, title: `${format.format(item.date)} · ${seconds ? RxStatisticsUI.formatDuration(seconds, true) : MESSAGES.statistics.noPlay}`})
                .toggleClass("today", item.key === todayKey));
        });
        // Оставшиеся дни текущей недели
        for (let index = weekStart + 1; index < 7; index++) $calendar.append($("<i>").addClass("future"));
        $("#modal-statistics [data-stat-value='calendarHint']").text(
            MESSAGES.statistics.calendarHint.replace("{0}", RxStatisticsUI.CALENDAR_WEEKS).replace("{1}", played));
    };

    static sessionContext = (session) => {
        const topServer = Object.entries(session.serverSeconds || {}).sort(([, a], [, b]) => b - a)[0];
        if (topServer) return {icon: "dns", name: topServer[0], type: MESSAGES.statistics.server};
        const topWorld = Object.entries(session.worldSeconds || {}).sort(([, a], [, b]) => b - a)[0];
        if (topWorld) return {icon: "landscape", name: topWorld[0], type: MESSAGES.statistics.world};
        return {icon: "sports_esports", name: MESSAGES.statistics.mainMenu, type: MESSAGES.statistics.session};
    };

    static renderSessions = (sessions) => {
        const $list = $("#stats-session-list");
        $list.empty();
        const pageCount = Math.max(1, Math.ceil(sessions.length / RxStatisticsUI.sessionPageSize));
        RxStatisticsUI.sessionPage = Math.min(Math.max(1, RxStatisticsUI.sessionPage), pageCount);
        const start = (RxStatisticsUI.sessionPage - 1) * RxStatisticsUI.sessionPageSize;
        const pageItems = sessions.slice(start, start + RxStatisticsUI.sessionPageSize);
        $("#stats-session-page").text(`${RxStatisticsUI.sessionPage} / ${pageCount}`);
        $("#stats-session-prev").prop("disabled", RxStatisticsUI.sessionPage <= 1);
        $("#stats-session-next").prop("disabled", RxStatisticsUI.sessionPage >= pageCount);

        if (!pageItems.length) {
            $list.append(RxStatisticsUI.emptyState(MESSAGES.statistics.noSessions));
            return;
        }

        pageItems.forEach(session => {
            const context = RxStatisticsUI.sessionContext(session);
            const state = ["running", "interrupted"].includes(session.endReason) ? session.endReason : "completed";
            $list.append($("<div>").addClass("st-session").append(
                $("<span>").addClass("st-session-icon material-symbols-outlined").text(context.icon).attr("title", context.type),
                $("<div>").addClass("st-session-copy").append(
                    $("<strong>").text(context.name).attr("title", context.name),
                    $("<span>").text(`${RxStatisticsUI.versionName(session.versionId)} · ${session.nickname}`)
                ),
                $("<span>").addClass(`st-session-state ${state}`).attr("data-session-state", state).text(MESSAGES.statistics[state]),
                $("<div>").addClass("st-session-combat").append(
                    $("<span>").attr("title", MESSAGES.statistics.kills).append($("<span>").addClass("material-symbols-outlined").text("swords"), document.createTextNode(session.kills)),
                    $("<span>").attr("title", MESSAGES.statistics.deaths).append($("<span>").addClass("material-symbols-outlined").text("skull"), document.createTextNode(session.deaths))
                ),
                $("<div>").addClass("st-session-time").append(
                    $("<strong>").text(RxStatisticsUI.formatDuration(session.playSeconds, true)),
                    $("<span>").text(RxStatisticsUI.formatDate(session.startedAt))
                )
            ));
        });
    };

    static exportStatistics = async () => {
        RxPlayStats.checkpoint(true);
        const date = RxPlayStats.dayKey();
        const target = await ipcRenderer.invoke("save-dialog", {
            title: MESSAGES.statistics.export,
            defaultPath: `RxLaunch-statistics-${date}.json`,
            filters: [{name: "JSON", extensions: ["json"]}]
        });
        if (!target) return false;
        try {
            fs.copyFileSync(RxPlayStats.getStoragePath(), target);
            RxToasts.create(MESSAGES.statistics.exported, "download_done", path.basename(target));
            return true;
        } catch (error) {
            RxCollector.writeLog(`Statistics: Export failed [error=${error.message}]`);
            RxToasts.create(MESSAGES.statistics.exportFailed, "error");
            return false;
        }
    };
}

$(RxStatisticsUI.init);
