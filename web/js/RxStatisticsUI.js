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

    static render = (refreshOptions = false) => {
        const snapshot = RxPlayStats.getDashboard({
            period: RxStatisticsUI.period,
            nickname: RxStatisticsUI.nickname
        });
        if (refreshOptions) RxStatisticsUI.updateNicknameOptions(snapshot.nicknameOptions);

        $("#modal-statistics [data-stat-value='playtime']").text(RxStatisticsUI.formatDuration(snapshot.totals.playSeconds));
        $("#modal-statistics [data-stat-value='sessions']").text(RxStatisticsUI.formatNumber(snapshot.totals.sessions));
        $("#modal-statistics [data-stat-value='kills']").text(RxStatisticsUI.formatNumber(snapshot.totals.kills));
        $("#modal-statistics [data-stat-value='deaths']").text(RxStatisticsUI.formatNumber(snapshot.totals.deaths));
        $("#modal-statistics [data-stat-value='bestStreak']").text(RxStatisticsUI.formatNumber(snapshot.totals.bestKillStreak));
        $("#modal-statistics [data-stat-value='kd']").text(Number(snapshot.kd || 0).toLocaleString(RxStatisticsUI.locale(), {maximumFractionDigits: 2}));
        $("#stats-live-pill").toggleClass("active", snapshot.active);
        $("#stats-storage-path").text(snapshot.storagePath).attr("title", snapshot.storagePath);

        const favoriteWorld = snapshot.rankings.worlds[0];
        $("#modal-statistics [data-stat-value='favoriteWorld']").text(favoriteWorld?.name || "—");
        $("#modal-statistics [data-stat-value='favoriteWorldTime']").text(
            favoriteWorld ? RxStatisticsUI.formatDuration(favoriteWorld.playSeconds, true) : MESSAGES.statistics.noData
        );

        RxStatisticsUI.renderActivity(snapshot.days);
        RxStatisticsUI.renderRanking("servers", snapshot.rankings.servers);
        RxStatisticsUI.renderRanking("nicknames", snapshot.rankings.nicknames);
        RxStatisticsUI.renderRanking("worlds", snapshot.rankings.worlds);
        RxStatisticsUI.renderSessions(snapshot.sessions);

        $("#stats-migration-note").toggle(
            snapshot.legacyMigrated && RxStatisticsUI.period === "all" && RxStatisticsUI.nickname === "all"
        );
        return snapshot;
    };

    static renderRanking = (type, items) => {
        const $list = $(`#modal-statistics .stats-ranking[data-ranking="${type}"] .stats-ranking-list`);
        $list.empty();
        if (!items.length) {
            $list.append($("<div>").addClass("stats-empty-ranking").text(MESSAGES.statistics.noDataYet));
            return;
        }
        const maximum = Math.max(1, items[0].playSeconds);
        items.forEach((item, index) => {
            const percent = Math.max(4, Math.round((item.playSeconds / maximum) * 100));
            const $row = $("<div>").addClass("stats-rank-row");
            $row.append($("<span>").addClass("stats-rank-number").text(index + 1));
            $row.append($("<span>").addClass("stats-rank-name").text(item.name).attr("title", item.name));
            $row.append($("<span>").addClass("stats-rank-time").text(RxStatisticsUI.formatDuration(item.playSeconds, true)));
            const $track = $("<div>").addClass("stats-rank-track");
            $track.append($("<div>").addClass("stats-rank-progress").css("width", `${percent}%`));
            $row.append($track);
            $list.append($row);
        });
    };

    static renderActivity = (days) => {
        const $chart = $("#stats-activity-chart");
        $chart.empty();
        const now = new Date();
        const values = [];
        for (let offset = 13; offset >= 0; offset--) {
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
            const key = RxPlayStats.dayKey(date.getTime());
            values.push({date, key, seconds: Number(days[key]?.playSeconds) || 0});
        }
        const maximum = Math.max(1, ...values.map(item => item.seconds));
        values.forEach((item, index) => {
            const percent = item.seconds > 0 ? Math.max(4, Math.round((item.seconds / maximum) * 100)) : 2;
            const $column = $("<div>").addClass("stats-chart-column").toggleClass("today", index === values.length - 1);
            const $track = $("<div>").addClass("stats-chart-track").attr("title", `${RxStatisticsUI.formatDuration(item.seconds)} · ${item.key}`);
            $track.append($("<div>").addClass("stats-chart-bar").css("height", `${percent}%`));
            $column.append($track);
            $column.append($("<span>").addClass("stats-chart-label").text(item.date.toLocaleDateString(RxStatisticsUI.locale(), {weekday: "short"}).slice(0, 2)));
            $chart.append($column);
        });
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
            $list.append($("<div>").addClass("stats-empty-sessions").text(MESSAGES.statistics.noSessions));
            return;
        }

        pageItems.forEach(session => {
            const context = RxStatisticsUI.sessionContext(session);
            const $row = $("<div>").addClass("stats-session-row");
            const $main = $("<div>").addClass("stats-session-main");
            $main.append($("<strong>").text(session.nickname));
            $main.append($("<span>").text(RxStatisticsUI.formatDate(session.startedAt)));
            const $version = $("<div>").addClass("stats-session-main");
            $version.append($("<strong>").text(session.versionId));
            const sessionState = session.endReason === "running"
                ? MESSAGES.statistics.running
                : session.endReason === "interrupted"
                    ? MESSAGES.statistics.interrupted
                    : MESSAGES.statistics.completed;
            $version.append($("<span>").text(sessionState));
            const $context = $("<div>").addClass("stats-session-context");
            $context.append($("<strong>").text(context.name).attr("title", context.name));
            $context.append($("<span>").text(context.type));
            const $duration = $("<span>").addClass("stats-session-value").text(RxStatisticsUI.formatDuration(session.playSeconds, true));
            const $combat = $("<div>").addClass("stats-session-combat");
            $combat.append($("<span>").append($("<i>").addClass("material-symbols-outlined").text("swords"), document.createTextNode(session.kills)));
            $combat.append($("<span>").append($("<i>").addClass("material-symbols-outlined").text("skull"), document.createTextNode(session.deaths)));
            $row.append($main, $version, $context, $duration, $combat);
            $list.append($row);
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
