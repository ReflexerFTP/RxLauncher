// Админка RxLauncher в лаунчере (только группа «Админ»): поиск игроков, всё об игроке, группы, бан, ник, пароль, удаление,
// статистика. Объявления и рекомендации — на сайте rxlauncher.xyz/account/ (кнопка в шапке)
class RxAdminUI {
    static users = [];
    static total = 0;
    static loading = 0;
    static $modal = () => $("#modal-rxAdmin");
    static t = (key) => MESSAGES.friends.admin[key];
    static escape = (value) => RxDialog.escape(value);

    static ago = (time) => {
        if (!time) return RxAdminUI.t("neverSeen");
        return new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short", year: "numeric"}).format(new Date(time));
    };

    static row = (user) => {
        const esc = RxAdminUI.escape;
        const self = user.id === RxAccount.user?.id;
        const options = RxFriendsUI.GROUPS.map(group => `<option value="${group}"${group === user.group ? " selected" : ""}>${esc(RxFriendsUI.groupName(group))}</option>`).join("");
        const button = (action, icon, title, disabled = false) =>
            `<button class="transparent" data-admin-action="${action}" title="${esc(title)}"${disabled ? " disabled" : ""}><span class="material-symbols-outlined">${icon}</span></button>`;
        return `<div class="rxad-row${user.banned ? " banned" : ""}" data-admin-id="${esc(user.id)}">
            <img alt="" loading="lazy" src="${esc(RxFriendsUI.head(user.nick, 34))}"/>
            <div class="rxad-copy">
                <strong><span class="rxad-dot${user.online ? " on" : ""}"></span>${esc(user.nick)}${user.banned ? `<span class="rxad-ban">${esc(RxAdminUI.t("bannedBadge"))}</span>` : ""}</strong>
                <span>${esc(user.online ? RxAdminUI.t("online") : RxAdminUI.t("seen").replace("{0}", RxAdminUI.ago(user.seen)))}</span>
            </div>
            <select class="rxad-select" data-admin-set-group>${options}</select>
            <div class="rxad-actions">
                ${button("info", "info", RxAdminUI.t("info"))}
                ${button("rename", "edit", RxAdminUI.t("rename"))}
                ${button("password", "key", RxAdminUI.t("resetPassword"))}
                ${button("ban", user.banned ? "lock_open" : "block", user.banned ? RxAdminUI.t("unban") : RxAdminUI.t("ban"), self)}
                ${button("delete", "delete_forever", RxAdminUI.t("delete"), self)}
            </div>
        </div>`;
    };

    static render = () => {
        const $modal = RxAdminUI.$modal();
        $modal.find("[data-admin-list]").html(RxAdminUI.users.length
            ? RxAdminUI.users.map(RxAdminUI.row).join("")
            : `<p class="rxad-empty">${RxAdminUI.escape(RxAdminUI.t("empty"))}</p>`);
        $modal.find("[data-admin-more]").prop("hidden", RxAdminUI.users.length >= RxAdminUI.total);
    };

    static renderStats = (stats) => {
        const chips = [[RxAdminUI.t("total"), stats.users], [RxAdminUI.t("online"), stats.online],
            ...RxFriendsUI.GROUPS.map(group => [RxFriendsUI.groupName(group), stats.groups?.[group] || 0])];
        RxAdminUI.$modal().find("[data-admin-stats]").html(chips.map(([name, value]) =>
            `<span class="rxad-stat"><b>${Number(value) || 0}</b>${RxAdminUI.escape(name)}</span>`).join(""));
    };

    static load = async (reset = true) => {
        const ticket = ++RxAdminUI.loading;
        const $modal = RxAdminUI.$modal();
        try {
            const data = await RxAccount.call("admin/users", {
                query: String($modal.find("[data-admin-query]").val() || "").trim(),
                group: String($modal.find("[data-admin-group]").val() || ""),
                offset: reset ? 0 : RxAdminUI.users.length
            });
            if (ticket !== RxAdminUI.loading) return;
            RxAdminUI.users = reset ? data.users : [...RxAdminUI.users, ...data.users];
            RxAdminUI.total = data.total;
            RxAdminUI.renderStats(data.stats);
            RxAdminUI.render();
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    static replace = (user) => {
        RxAdminUI.users = RxAdminUI.users.map(item => item.id === user.id ? user : item);
        RxAdminUI.render();
        if (user.id === RxAccount.user?.id) RxAccount.setUser(user);
    };

    static setGroup = async ($select, id) => {
        const user = RxAdminUI.users.find(item => item.id === id);
        try {
            const data = await RxAccount.call("admin/group", {id, group: $select.val()});
            RxAdminUI.replace(data.user);
            RxToasts.create(RxAdminUI.t("groupSet").replace("{0}", RxFriendsUI.groupName(data.user.group)), "shield_person", data.user.nick, "success");
            RxAdminUI.load();
        } catch (error) {
            $select.val(user?.group || "player");
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    static action = async (id, action) => {
        const user = RxAdminUI.users.find(item => item.id === id);
        if (!user) return;
        try {
            if (action === "info") return RxAdminUI.openPlayer(id);
            if (action === "rename") {
                const nick = await RxDialog.prompt({icon: "edit", title: RxAdminUI.t("rename"), text: user.nick, value: user.nick,
                    placeholder: MESSAGES.friends.account.nick, confirmText: MESSAGES.accounts.save});
                if (nick === null || nick === user.nick) return;
                if (!RxAccount.NICK_REGEX.test(nick)) return RxToasts.create(MESSAGES.friends.errors.badNick, "warning");
                RxAdminUI.replace((await RxAccount.call("admin/rename", {id, nick})).user);
                RxToasts.create(MESSAGES.friends.renamed, "edit", nick, "success");
            } else if (action === "password") {
                const confirmed = await RxDialog.confirm({icon: "key", title: RxAdminUI.t("resetPassword"),
                    text: RxAdminUI.t("resetText").replace("{0}", user.nick), confirmText: RxAdminUI.t("resetPassword")});
                if (!confirmed) return;
                const data = await RxAccount.call("admin/password", {id});
                require("electron").clipboard.writeText(data.password);
                await RxDialog.open({icon: "key", title: RxAdminUI.t("newPassword").replace("{0}", user.nick), text: RxAdminUI.t("newPasswordText"),
                    items: [{icon: "password", title: data.password, text: RxAdminUI.t("copied")}]});
            } else if (action === "ban") {
                const banned = !user.banned;
                if (banned && !(await RxDialog.confirm({icon: "block", title: RxAdminUI.t("ban"), text: RxAdminUI.t("banText").replace("{0}", user.nick),
                    confirmText: RxAdminUI.t("ban"), danger: true}))) return;
                RxAdminUI.replace((await RxAccount.call("admin/ban", {id, banned})).user);
                RxToasts.create(banned ? RxAdminUI.t("banned") : RxAdminUI.t("unbanned"), banned ? "block" : "lock_open", user.nick, "success");
            } else if (action === "delete") {
                if (!(await RxDialog.confirm({icon: "delete_forever", title: RxAdminUI.t("delete"), text: RxAdminUI.t("deleteText").replace("{0}", user.nick),
                    confirmText: RxAdminUI.t("delete"), danger: true}))) return;
                await RxAccount.call("admin/delete", {id});
                RxToasts.create(RxAdminUI.t("deleted"), "delete_forever", user.nick);
                RxAdminUI.load();
            }
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    // ---------- вкладки ----------
    static showPane = (pane) => {
        const $modal = RxAdminUI.$modal();
        $modal.find("[data-admin-pane]").each(function () { this.hidden = this.dataset.adminPane !== pane; });
        $modal.find("[data-admin-tab]").each(function () { $(this).toggleClass("active", this.dataset.adminTab === (pane === "player" ? "players" : pane)); });
        if (pane === "stats") RxAdminUI.loadStats();
    };

    static hoursText = (seconds) => {
        const minutes = Math.round((Number(seconds) || 0) / 60);
        return minutes < 60 ? RxAdminUI.t("minutesShort").replace("{0}", minutes)
            : RxAdminUI.t("hoursShort").replace("{0}", Math.floor(minutes / 60)).replace("{1}", minutes % 60);
    };
    static dateTime = (time) => time ? new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}).format(new Date(time)) : "—";

    // ---------- всё об игроке ----------
    static openPlayer = async (id) => {
        const $pane = RxAdminUI.$modal().find('[data-admin-pane="player"]');
        RxAdminUI.showPane("player");
        $pane.html('<div class="rxad-loading"><span class="material-symbols-outlined spin">progress_activity</span></div>');
        try {
            const data = await RxAccount.call("admin/user", {id});
            const user = data.user;
            const esc = RxAdminUI.escape;
            const fact = (label, value) => `<div class="rxad-fact"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
            const now = user.presence?.online
                ? (user.presence.status === "playing" ? RxFriendsUI.statusHtml({...user.presence, online: true}) : RxFriendsUI.statusHtml({online: true}))
                : RxFriendsUI.statusHtml({online: false, seen: user.seen, last: user.last});
            const days = Array.from({length: 30}, (_, i) => new Date(Date.now() - (29 - i) * 86400e3).toISOString().slice(0, 10));
            const active = new Set(data.activeDays);
            const copyModes = MESSAGES.friends.copyModes;
            $pane.html(`
                <div class="rxad-player-head">
                    <button class="transparent square small" data-admin-back title="${esc(RxAdminUI.t("back"))}"><span class="material-symbols-outlined">arrow_back</span></button>
                    <img alt="" src="${esc(RxFriendsUI.head(user.nick, 56))}"/>
                    <div class="rxad-player-name">
                        <strong>${esc(user.nick)}${RxFriendsUI.groupBadge(user.group)}${user.banned ? `<span class="rxad-ban">${esc(RxAdminUI.t("bannedBadge"))}</span>` : ""}</strong>
                        <div class="fr-status">${now}</div>
                    </div>
                </div>
                <div class="rxad-facts">
                    ${fact(RxAdminUI.t("playTime"), RxAdminUI.hoursText(user.playSeconds))}
                    ${fact(RxAdminUI.t("friendsCount"), String(data.friends.length))}
                    ${fact(RxAdminUI.t("created"), RxAdminUI.dateTime(user.created))}
                    ${fact(RxAdminUI.t("lastSeen"), RxAdminUI.dateTime(user.seen))}
                    ${fact("Discord", user.discord || RxAdminUI.t("notLinked"))}
                    ${fact(RxAdminUI.t("password"), user.hasPassword ? RxAdminUI.t("passwordSet") : RxAdminUI.t("passwordNone"))}
                    ${fact(RxAdminUI.t("copyMode"), copyModes[user.copyMode] || copyModes.nobody)}
                    ${fact(RxAdminUI.t("renamed"), user.renamed ? RxAdminUI.dateTime(user.renamed) : RxAdminUI.t("never"))}
                </div>
                <div class="rxad-section">${esc(RxAdminUI.t("lastGame"))}</div>
                <div class="fr-status">${user.last?.version ? RxFriendsUI.gameChips(user.last) + `<span class="fr-time">${esc(RxAdminUI.dateTime(user.last.at))}</span>` : "—"}</div>
                <div class="rxad-section">${esc(RxAdminUI.t("activity").replace("{0}", data.activeDays.length))}</div>
                <div class="rxad-days">${days.map(day => `<i class="${active.has(day) ? "on" : ""}" title="${esc(day)}"></i>`).join("")}</div>
                <div class="rxad-section">${esc(RxAdminUI.t("friendsCount"))} · ${data.friends.length}</div>
                <div class="rxad-people">${data.friends.length ? data.friends.map(friend => `<span>${friend.online ? "<i></i>" : ""}${esc(friend.nick)}</span>`).join("") : `<em>${esc(RxAdminUI.t("none"))}</em>`}</div>
                <div class="rxad-section">${esc(RxAdminUI.t("devices"))} · ${data.sessions.length}</div>
                <div class="rxad-sessions">${data.sessions.map(item => `<div><span class="material-symbols-outlined">devices</span>${esc(RxAdminUI.t("signedIn").replace("{0}", RxAdminUI.dateTime(item.created)))}<em>${esc(RxAdminUI.t("used").replace("{0}", RxAdminUI.dateTime(item.used)))}</em></div>`).join("") || `<em>${esc(RxAdminUI.t("none"))}</em>`}</div>
                <div class="rxad-player-actions">
                    <button class="transparent" data-admin-logout-all ${data.sessions.length ? "" : "disabled"}><span class="material-symbols-outlined">logout</span><span>${esc(RxAdminUI.t("logoutAll"))}</span></button>
                </div>`);
            $pane.find("[data-admin-logout-all]").on("click", async () => {
                const confirmed = await RxDialog.confirm({icon: "logout", title: RxAdminUI.t("logoutAll"), text: RxAdminUI.t("logoutAllText").replace("{0}", user.nick), confirmText: RxAdminUI.t("logoutAll")});
                if (!confirmed) return;
                try {
                    await RxAccount.call("admin/sessions/clear", {id});
                    RxToasts.create(RxAdminUI.t("loggedOutAll"), "logout", user.nick, "success");
                    RxAdminUI.openPlayer(id);
                } catch (error) {
                    RxToasts.create(RxAccount.errorText(error), "error", "", "error");
                }
            });
        } catch (error) {
            $pane.html(`<p class="rxad-empty">${RxAdminUI.escape(RxAccount.errorText(error))}</p>`);
        }
    };

    // ---------- статистика ----------
    static bars = (points) => {
        const esc = RxAdminUI.escape;
        const max = Math.max(1, ...points.map(point => point.n));
        return `<div class="rxad-chart">
            <div class="rxad-axis"><span>${max}</span><span>0</span></div>
            <div class="rxad-bars">${points.map(point => `<div class="rxad-bar" title="${esc(point.tip)}"><i style="height:${point.n ? Math.max(3, point.n / max * 100) : 0}%"></i></div>`).join("")}</div>
        </div>
        <div class="rxad-xaxis"><span>${esc(points[0]?.label || "")}</span><span>${esc(points[points.length - 1]?.label || "")}</span></div>`;
    };

    static loadStats = async () => {
        const $pane = RxAdminUI.$modal().find('[data-admin-pane="stats"]');
        const esc = RxAdminUI.escape;
        $pane.html('<div class="rxad-loading"><span class="material-symbols-outlined spin">progress_activity</span></div>');
        try {
            const stats = await RxAccount.call("admin/stats");
            const t = stats.totals;
            const dayLabel = day => new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short"}).format(new Date(day));
            const tile = (value, label, hint = "") => `<div class="rxad-kpi"><b>${esc(value)}</b><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
            const top = (title, items, value) => {
                const max = Math.max(1, ...items.map(item => item.v));
                return `<div class="rxad-top"><div class="rxad-section">${esc(title)}</div>${items.length ? items.map(item => `<div class="rxad-top-row"><span>${esc(item.name)}</span><b>${esc(value(item))}</b><i style="width:${Math.max(4, item.v / max * 100)}%"></i></div>`).join("") : `<em>${esc(RxAdminUI.t("noData"))}</em>`}</div>`;
            };
            // Онлайн по часам за 48 часов (максимум за час из замеров раз в 5 минут)
            const byHour = new Map();
            for (const sample of stats.online) {
                const hour = sample.at - sample.at % 3600e3;
                byHour.set(hour, Math.max(byHour.get(hour) || 0, sample.online));
            }
            const lastHour = Date.now() - Date.now() % 3600e3;
            const hours = Array.from({length: 48}, (_, i) => lastHour - (47 - i) * 3600e3);
            const hourLabel = time => new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}).format(new Date(time));
            const loaders = RxFriendsUI.LOADERS;
            $pane.html(`
                <div class="rxad-kpis">
                    ${tile(t.users, RxAdminUI.t("total"), RxAdminUI.t("weekNew").replace("{0}", stats.registrations.slice(-7).reduce((sum, item) => sum + item.n, 0)))}
                    ${tile(t.online, RxAdminUI.t("online"), RxAdminUI.t("playingNow").replace("{0}", t.playing))}
                    ${tile(t.activeToday, RxAdminUI.t("activeToday"))}
                    ${tile(RxAdminUI.hoursText(t.playSeconds), RxAdminUI.t("playTotal"))}
                </div>
                <div class="rxad-charts">
                    <div><div class="rxad-section">${esc(RxAdminUI.t("chartRegistrations"))}</div>${RxAdminUI.bars(stats.registrations.map(item => ({n: item.n, label: dayLabel(item.day), tip: `${dayLabel(item.day)}: ${item.n}`})))}</div>
                    <div><div class="rxad-section">${esc(RxAdminUI.t("chartActive"))}</div>${RxAdminUI.bars(stats.active.map(item => ({n: item.n, label: dayLabel(item.day), tip: `${dayLabel(item.day)}: ${item.n}`})))}</div>
                </div>
                <div class="rxad-section">${esc(RxAdminUI.t("chartOnline"))}</div>
                ${RxAdminUI.bars(hours.map(hour => ({n: byHour.get(hour) || 0, label: hourLabel(hour), tip: `${hourLabel(hour)}: ${byHour.get(hour) || 0}`})))}
                <div class="rxad-tops">
                    ${top(RxAdminUI.t("topVersions"), stats.topVersions.map(item => ({name: item.name, v: item.n})), item => item.v)}
                    ${top(RxAdminUI.t("topLoaders"), stats.topLoaders.map(item => ({name: loaders[item.name] || item.name, v: item.n})), item => item.v)}
                    ${top(RxAdminUI.t("topServers"), stats.topServers.map(item => ({name: item.name, v: item.n})), item => item.v)}
                    ${top(RxAdminUI.t("topPlayers"), stats.topPlayers.map(item => ({name: item.nick, v: item.playSeconds})), item => RxAdminUI.hoursText(item.v))}
                </div>`);
        } catch (error) {
            $pane.html(`<p class="rxad-empty">${esc(RxAccount.errorText(error))}</p>`);
        }
    };

    static open = async () => {
        if (RxAccount.user?.group !== "admin") return;
        const $modal = RxAdminUI.$modal();
        $modal.find("[data-admin-query]").val("");
        $modal.find("[data-admin-group]").val("");
        RxAdminUI.users = [];
        RxAdminUI.render();
        RxAdminUI.showPane("players");
        await RxModals.showModal("rxAdmin");
        RxAdminUI.load();
    };

    static init = () => {
        const $modal = RxAdminUI.$modal();
        if (!$modal.length) return;
        $modal.find("[data-admin-group]").html(`<option value="">${RxAdminUI.escape(RxAdminUI.t("allGroups"))}</option>`
            + RxFriendsUI.GROUPS.map(group => `<option value="${group}">${RxAdminUI.escape(RxFriendsUI.groupName(group))}</option>`).join(""));
        let timer = 0;
        $modal.on("input", "[data-admin-query]", () => { clearTimeout(timer); timer = setTimeout(() => RxAdminUI.load(), 250); });
        $modal.on("change", "[data-admin-group]", () => RxAdminUI.load());
        $modal.on("click", "[data-admin-more]", () => RxAdminUI.load(false));
        $modal.on("change", "[data-admin-set-group]", function () { RxAdminUI.setGroup($(this), $(this).closest("[data-admin-id]").attr("data-admin-id")); });
        $modal.on("click", "[data-admin-tab]", function () { RxAdminUI.showPane(this.dataset.adminTab); });
        $modal.on("click", "[data-admin-back]", () => RxAdminUI.showPane("players"));
        $modal.on("click", "[data-admin-site]", () => openExternal(`${SITE_URL}/account/`));
        $modal.on("click", "[data-admin-action]", function () { RxAdminUI.action($(this).closest("[data-admin-id]").attr("data-admin-id"), $(this).attr("data-admin-action")); });
    };
}

$(RxAdminUI.init);
