// Админка аккаунтов RxLauncher в лаунчере (только группа «Админ»): поиск игроков, группы, бан, ник, пароль, удаление.
// То же самое есть на сайте: rxlauncher.xyz/account/
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

    static open = async () => {
        if (RxAccount.user?.group !== "admin") return;
        const $modal = RxAdminUI.$modal();
        $modal.find("[data-admin-query]").val("");
        $modal.find("[data-admin-group]").val("");
        RxAdminUI.users = [];
        RxAdminUI.render();
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
        $modal.on("click", "[data-admin-action]", function () { RxAdminUI.action($(this).closest("[data-admin-id]").attr("data-admin-id"), $(this).attr("data-admin-action")); });
    };
}

$(RxAdminUI.init);
