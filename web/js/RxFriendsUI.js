// Карточка «Друзья» в разделе «Играть вместе» и окно аккаунта RxLauncher (вход, пароль, удаление). Регистрация — на сайте
class RxFriendsUI {
    static t = (key) => MESSAGES.friends[key];
    static escape = (value) => RxDialog.escape(value);
    static $card = () => $("#modal-together [data-friends]");
    static $account = () => $("#modal-rxAccount");
    static head = (nick, size = 32) => RxPrivacy.remoteAvatar(`https://minotar.net/helm/${encodeURIComponent(nick || "Steve")}/${size}`);

    static LOADERS = {vanilla: "Vanilla", fabric: "Fabric", quilt: "Quilt", forge: "Forge", forgeOptiFine: "OptiFine", neoforge: "NeoForge"};

    static duration = (since) => {
        const minutes = Math.max(1, Math.round((Date.now() - Number(since || Date.now())) / 60000));
        return minutes < 60 ? RxFriendsUI.t("minutes").replace("{0}", minutes)
            : RxFriendsUI.t("hours").replace("{0}", Math.floor(minutes / 60)).replace("{1}", minutes % 60);
    };

    static statusText = (friend) => {
        if (!friend.online) return RxFriendsUI.t("offline");
        if (friend.status !== "playing") return RxFriendsUI.t("inLauncher");
        const version = [RxFriendsUI.LOADERS[friend.loader] || "", friend.version].filter(Boolean).join(" ");
        return [RxFriendsUI.t("playing"), version, friend.server, RxFriendsUI.duration(friend.since)].filter(Boolean).join(" · ");
    };

    static GROUPS = ["admin", "tester", "player_plus", "player"];
    static GROUP_ICONS = {admin: "shield_person", tester: "science", player_plus: "star", player: "person"};
    static groupName = (group) => RxFriendsUI.t("groups")[group] || RxFriendsUI.t("groups").player;
    // Значок группы с иконкой (у обычных игроков не показывается)
    static groupBadge = (group) => RxFriendsUI.GROUPS.includes(group) && group !== "player"
        ? `<span class="rx-group" data-group="${group}"><span class="material-symbols-outlined">${RxFriendsUI.GROUP_ICONS[group]}</span>${RxFriendsUI.escape(RxFriendsUI.groupName(group))}</span>` : "";

    // «5 мин назад», «3 ч назад», «вчера», «4 дн. назад»
    static ago = (time) => {
        const minutes = Math.max(0, Math.round((Date.now() - Number(time || 0)) / 60000));
        const t = RxFriendsUI.t("ago");
        if (minutes < 2) return t.now;
        if (minutes < 60) return t.minutes.replace("{0}", minutes);
        if (minutes < 24 * 60) return t.hours.replace("{0}", Math.round(minutes / 60));
        const days = Math.round(minutes / 1440);
        return days === 1 ? t.yesterday : t.days.replace("{0}", days);
    };

    static loaderIcon = (loader) => RxFriendsUI.LOADERS[loader] ? `assets/versions/${loader}.webp` : "";

    // Чипы «во что играет»: загрузчик + версия, сборка, сервер
    static gameChips = (game) => {
        const esc = RxFriendsUI.escape;
        const chips = [];
        const version = [RxFriendsUI.LOADERS[game.loader] || "", game.version].filter(Boolean).join(" ");
        if (version) {
            const icon = RxFriendsUI.loaderIcon(game.loader);
            chips.push(`<span class="fr-chip">${icon ? `<img src="${icon}" alt=""/>` : '<span class="material-symbols-outlined">deployed_code</span>'}${esc(version)}</span>`);
        }
        if (game.title) chips.push(`<span class="fr-chip"><span class="material-symbols-outlined">stacks</span>${esc(game.title)}</span>`);
        if (game.server) chips.push(`<span class="fr-chip server"><span class="material-symbols-outlined">dns</span>${esc(game.server)}</span>`);
        return chips.join("");
    };

    static statusHtml = (friend) => {
        const esc = RxFriendsUI.escape;
        if (friend.online && friend.status === "playing") {
            return `<span class="fr-state playing"><i></i>${esc(RxFriendsUI.t("playing"))}</span>${RxFriendsUI.gameChips(friend)}<span class="fr-time">${esc(RxFriendsUI.duration(friend.since))}</span>`;
        }
        if (friend.online) return `<span class="fr-state launcher"><i></i>${esc(RxFriendsUI.t("inLauncher"))}</span>`;
        const seen = friend.seen ? `<span class="fr-time">${esc(RxFriendsUI.t("wasOnline").replace("{0}", RxFriendsUI.ago(friend.seen)))}</span>` : "";
        const last = friend.last?.version
            ? `<span class="fr-last">${esc(RxFriendsUI.t("lastPlayed"))}</span>${RxFriendsUI.gameChips(friend.last)}` : "";
        return `<span class="fr-state"><i></i>${esc(RxFriendsUI.t("offline"))}</span>${seen}${last}`;
    };

    static rank = (friend) => !friend.online ? 2 : friend.status === "playing" ? 0 : 1;

    static button = (action, icon, title, primary = false) => `<button class="${primary ? "" : "transparent"}" data-friend-action="${action}" title="${RxFriendsUI.escape(title)}"><span class="material-symbols-outlined">${icon}</span></button>`;

    static row = (person, kind) => {
        const esc = RxFriendsUI.escape;
        let state = "", status = "", actions = "";
        if (kind === "friend") {
            state = !person.online ? "offline" : person.status === "playing" ? "playing" : "launcher";
            status = RxFriendsUI.statusText(person);
            if (person.online && person.server) {
                actions += RxFriendsUI.button("join", "login", RxFriendsUI.t("join"), true);
                actions += RxFriendsUI.button("copy", "content_copy", RxFriendsUI.t("copyServer"));
            }
            if (person.canCopy) actions += RxFriendsUI.button("pack", "file_copy", RxFriendsUI.t("copyPack").replace("{0}", person.packName || RxFriendsUI.t("packFallback")));
            actions += RxFriendsUI.button("remove", "person_remove", RxFriendsUI.t("remove"));
        } else if (kind === "incoming") {
            status = RxFriendsUI.t("wantsToBeFriends");
            actions = RxFriendsUI.button("accept", "check", RxFriendsUI.t("accept"), true) + RxFriendsUI.button("decline", "close", RxFriendsUI.t("decline"));
        } else {
            state = "offline";
            status = RxFriendsUI.t("requestSent");
            actions = RxFriendsUI.button("cancel", "close", RxFriendsUI.t("cancelRequest"));
        }
        return `<div class="tg-history-row fr-row ${state}" data-friend-id="${esc(person.id)}" data-friend-kind="${kind}">
            <img alt="" loading="lazy" src="${esc(RxFriendsUI.head(person.nick))}"/>
            ${kind === "friend" ? `<span class="fr-dot"></span>` : ""}
            <div class="tg-history-copy"><strong>${esc(person.nick)}${RxFriendsUI.groupBadge(person.group)}</strong><span class="fr-status" title="${esc(status)}">${kind === "friend" ? RxFriendsUI.statusHtml(person) : esc(status)}</span></div>
            ${actions}
        </div>`;
    };

    static render = () => {
        const $card = RxFriendsUI.$card();
        if (!$card.length) return;
        const paranoid = RxPrivacy.isParanoid();
        const logged = RxAccount.isLoggedIn();
        $card.find("[data-friends-guest]").prop("hidden", logged || paranoid);
        $card.find("[data-friends-body]").prop("hidden", !logged || paranoid);
        $card.find("[data-friends-me]").prop("hidden", !logged);
        $card.find("[data-friends-copy-mode]").val(RxFriends.copyMode());
        $card.find("[data-friends-copy-pick]").prop("hidden", RxFriends.copyMode() !== "selected");
        $card.find("[data-friends-option]").each(function () {
            const key = this.dataset.friendsOption;
            this.checked = RxConfig.read(key, key === "friendsShowServer") === true;
        });

        if (paranoid) return $card.find("[data-friends-sub]").text(RxFriendsUI.t("paranoid"));
        if (!logged) return $card.find("[data-friends-sub]").text(RxFriendsUI.t("text"));

        $card.find("[data-friends-me-nick]").text(RxAccount.user.nick);
        $card.find("[data-friends-me-group]").html(RxFriendsUI.groupBadge(RxAccount.user.group));
        $card.find("[data-friends-me-head]").attr("src", RxFriendsUI.head(RxAccount.user.nick, 30));
        const {friends, incoming, outgoing} = RxFriends.state;
        const online = friends.filter(friend => friend.online).length;
        $card.find("[data-friends-sub]").text(RxFriends.loaded
            ? RxFriendsUI.t("onlineCount").replace("{0}", online).replace("{1}", friends.length)
            : RxFriendsUI.t("loading"));
        const error = RxFriends.error;
        $card.find("[data-friends-error]").prop("hidden", !error).text(error ? RxAccount.errorText(error) : "");

        const requests = [
            ...(incoming.length ? [`<p class="fr-section">${RxFriendsUI.escape(RxFriendsUI.t("incoming"))}</p>`] : []),
            ...incoming.map(item => RxFriendsUI.row(item, "incoming")),
            ...outgoing.map(item => RxFriendsUI.row(item, "outgoing"))
        ];
        $card.find("[data-friends-requests]").html(requests.join(""));
        const sorted = [...friends].sort((a, b) => RxFriendsUI.rank(a) - RxFriendsUI.rank(b) || a.nick.localeCompare(b.nick));
        $card.find("[data-friends-list]").html(sorted.length
            ? sorted.map(friend => RxFriendsUI.row(friend, "friend")).join("")
            : (RxFriends.loaded ? `<p class="fr-empty">${RxFriendsUI.escape(RxFriendsUI.t("empty"))}</p>` : ""));
    };

    // ---------- действия ----------
    static busy = async ($element, action) => {
        $element.prop("disabled", true);
        try {
            return await action();
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
            return null;
        } finally {
            $element.prop("disabled", false);
        }
    };

    static addFriend = async () => {
        const $card = RxFriendsUI.$card();
        const $input = $card.find("[data-friends-nick]");
        const nick = String($input.val() || "").trim();
        if (!RxAccount.NICK_REGEX.test(nick)) return RxToasts.create(MESSAGES.friends.errors.badNick, "warning");
        const result = await RxFriendsUI.busy($card.find(".fr-add button"), () => RxFriends.request(nick));
        if (!result) return;
        $input.val("");
        // Ник так, как он записан у игрока (поиск без учёта регистра)
        const shown = [...RxFriends.state.friends, ...RxFriends.state.outgoing].find(item => item.nick.toLowerCase() === nick.toLowerCase())?.nick || nick;
        RxToasts.create(result.accepted ? RxFriendsUI.t("accepted") : RxFriendsUI.t("requestSent"), result.accepted ? "handshake" : "send", shown, "success");
    };

    static friendAction = async ($button, id, action) => {
        const person = [...RxFriends.state.friends, ...RxFriends.state.incoming, ...RxFriends.state.outgoing].find(item => item.id === id);
        if (!person) return;
        if (action === "accept") return RxFriendsUI.busy($button, () => RxFriends.accept(id));
        if (action === "decline") return RxFriendsUI.busy($button, () => RxFriends.decline(id));
        if (action === "cancel") return RxFriendsUI.busy($button, () => RxFriends.remove(id));
        if (action === "copy") {
            require("electron").clipboard.writeText(person.server);
            return RxToasts.create(RxFriendsUI.t("serverCopied"), "content_copy", person.server, "success");
        }
        if (action === "join") return RxFriendsUI.join(person);
        if (action === "pack") return RxFriendsUI.copyPack($button, person);
        if (action === "remove") {
            const confirmed = await RxDialog.confirm({icon: "person_remove", title: RxFriendsUI.t("removeTitle").replace("{0}", person.nick),
                text: RxFriendsUI.t("removeText"), confirmText: RxFriendsUI.t("remove"), danger: true});
            if (confirmed) return RxFriendsUI.busy($button, () => RxFriends.remove(id));
        }
    };

    // Сборка друга → превью в «Принять приглашение»: там видно, что внутри, и кнопки «Установить»
    static copyPack = async ($button, friend) => {
        const code = await RxFriendsUI.busy($button, () => RxFriends.copyPack(friend.id));
        if (!code) return;
        const $modal = RxTogetherUI.$modal();
        $modal.find("[data-join-code]").val(code);
        if (RxTogetherUI.check(code)) {
            RxUtils.scrollWithin($modal.find("[data-join-preview]")[0]);
            RxToasts.create(RxFriendsUI.t("packReady"), "file_copy", friend.nick, "success");
        }
    };

    static setCopyMode = async (mode) => {
        try {
            if (mode === "selected") return await RxFriendsUI.pickCopyFriends();
            await RxFriends.saveCopySettings(mode);
            RxToasts.create(RxFriendsUI.t("copySaved"), "file_copy", RxFriendsUI.t("copyModes")[mode], "success");
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
        RxFriendsUI.render();
    };

    // «Выбранные друзья»: галочки по списку друзей
    static pickCopyFriends = async () => {
        const settings = await RxFriends.copySettings();
        if (!settings.friends.length) {
            RxToasts.create(RxFriendsUI.t("empty"), "group", "", "warning");
            return RxFriendsUI.render();
        }
        const allowed = new Set(settings.copyMode === "selected" ? settings.allowed : []);
        const result = await RxDialog.open({
            icon: "file_copy", title: RxFriendsUI.t("copyPickTitle"), text: RxFriendsUI.t("copyPickText"),
            checks: settings.friends.map(friend => ({id: friend.id, icon: "person", title: friend.nick, checked: allowed.has(friend.id)})),
            buttons: [{id: "cancel", text: MESSAGES.dialog.cancel}, {id: "ok", text: MESSAGES.accounts.save, primary: true}]
        });
        if (result.button === "ok") {
            const chosen = Object.entries(result.checks).filter(([, on]) => on).map(([id]) => id);
            await RxFriends.saveCopySettings("selected", chosen);
            RxToasts.create(RxFriendsUI.t("copySaved"), "file_copy", RxFriendsUI.t("copySelectedCount").replace("{0}", chosen.length), "success");
        }
        RxFriendsUI.render();
    };

    // Зайти к другу на сервер своей выбранной версией (версию друга показываем, чтобы было видно, совпадает ли)
    static join = async (friend) => {
        const active = RxVersionsManager.getActiveVersion();
        const mine = (RxVersionsUI.allVersions || []).find(version => version.id === active)?.displayName || active || "—";
        const theirs = [RxFriendsUI.LOADERS[friend.loader] || "", friend.version].filter(Boolean).join(" ") || "—";
        const confirmed = await RxDialog.confirm({
            icon: "login", title: RxFriendsUI.t("joinTitle").replace("{0}", friend.nick),
            text: RxFriendsUI.t("joinText").replace("{0}", friend.server),
            items: [
                {icon: "person", title: RxFriendsUI.t("friendVersion"), text: theirs},
                {icon: "deployed_code", title: RxFriendsUI.t("yourVersion"), text: mine}
            ],
            confirmText: RxFriendsUI.t("joinPlay")
        });
        if (!confirmed) return;
        selectedServerFromList = friend.server;
        await RxModals.switchModal("content");
        RxFlyout.startSelectedVersion();
    };

    // ---------- меню аккаунта ----------
    static menu = async () => {
        const admin = RxAccount.user.group === "admin";
        const choice = await RxDialog.choose({
            icon: "manage_accounts", title: RxAccount.user.nick,
            text: `${RxFriendsUI.t("manageText")} · ${RxFriendsUI.groupName(RxAccount.user.group)}`,
            choices: [
                ...(admin ? [{value: "admin", icon: "shield_person", title: RxFriendsUI.t("admin").title, text: RxFriendsUI.t("admin").menuText}] : []),
                {value: "rename", icon: "edit", title: RxFriendsUI.t("rename"), text: RxFriendsUI.t("renameMenu")},
                {value: "password", icon: "key", title: RxFriendsUI.t("changePassword")},
                {value: "site", icon: "open_in_new", title: RxFriendsUI.t("onSite"), text: RxFriendsUI.t("onSiteText")},
                {value: "logout", icon: "logout", title: RxFriendsUI.t("logout")},
                {value: "delete", icon: "delete_forever", title: RxFriendsUI.t("deleteAccount"), text: RxFriendsUI.t("deleteText")}
            ]
        });
        if (choice === "admin") return RxAdminUI.open();
        if (choice === "rename") return RxFriendsUI.rename();
        if (choice === "site") return openExternal(`${SITE_URL}/account/`);
        if (choice === "password" || choice === "delete") return RxFriendsUI.openAccount(choice);
        if (choice === "logout") {
            await RxAccount.logout();
            RxToasts.create(RxFriendsUI.t("loggedOut"), "logout");
        }
    };

    static rename = async () => {
        const nick = await RxDialog.prompt({icon: "edit", title: RxFriendsUI.t("rename"), text: RxFriendsUI.t("renameText"),
            value: RxAccount.user.nick, placeholder: RxFriendsUI.t("account").nick, confirmText: MESSAGES.accounts.save});
        if (nick === null || nick === RxAccount.user.nick) return;
        if (!RxAccount.NICK_REGEX.test(nick)) return RxToasts.create(MESSAGES.friends.errors.badNick, "warning");
        try {
            await RxAccount.rename(nick);
            RxToasts.create(RxFriendsUI.t("renamed"), "edit", nick, "success");
            RxFriends.sync();
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    static openRegister = () => openExternal(`${SITE_URL}/account/#register`);

    static loginDiscord = async () => {
        const $modal = RxFriendsUI.$account();
        const $button = $modal.find("[data-account-discord]");
        if ($button.hasClass("waiting")) {
            RxAccount.cancelDiscord();
            return RxFriendsUI.discordWaiting(false);
        }
        RxFriendsUI.accountError("");
        RxFriendsUI.discordWaiting(true);
        try {
            const user = await RxAccount.loginDiscord();
            if (!user) return;
            RxToasts.create(RxFriendsUI.t("loggedIn"), "login", user.nick, "success");
            await RxModals.hideModal("rxAccount");
        } catch (error) {
            RxFriendsUI.accountError(RxAccount.errorText(error));
        } finally {
            RxFriendsUI.discordWaiting(false);
        }
    };

    static discordWaiting = (waiting) => {
        const $button = RxFriendsUI.$account().find("[data-account-discord]").toggleClass("waiting", waiting);
        $button.find("[data-discord-text]").text(waiting ? RxFriendsUI.t("account").discordWaiting : RxFriendsUI.t("account").discord);
    };

    // ---------- окно аккаунта: вход, смена пароля, удаление ----------
    static MODES = {
        login: {icon: "login", submitIcon: "arrow_forward"},
        password: {icon: "key", submitIcon: "check"},
        delete: {icon: "delete_forever", submitIcon: "delete_forever"}
    };

    static setMode = (mode) => {
        const $modal = RxFriendsUI.$account();
        const texts = RxFriendsUI.t("account")[mode];
        $modal.attr("data-mode", mode);
        $modal.find("[data-account-title]").text(texts.title);
        $modal.find("[data-account-hint]").text(texts.hint);
        $modal.find("[data-account-submit]").text(texts.submit);
        $modal.find("[data-account-icon]").text(RxFriendsUI.MODES[mode].icon);
        $modal.find("[data-account-submit-icon]").text(RxFriendsUI.MODES[mode].submitIcon).removeClass("spin");
        $modal.find("[data-account-foot], [data-account-discord-wrap]").prop("hidden", mode !== "login");
        $modal.find("[data-modes]").each(function () {
            this.hidden = !this.dataset.modes.split(" ").includes(mode);
        });
        $modal.find("input").val("").attr("type", function () { return this.dataset.field === "nick" ? "text" : "password"; });
        $modal.find("[data-account-eye]").removeClass("on").find(".material-symbols-outlined").text("visibility");
        RxFriendsUI.accountError("");
        $modal.find(".rxa-submit").prop("disabled", false);
    };

    static accountError = (text) => {
        const $error = RxFriendsUI.$account().find("[data-account-error]");
        $error.prop("hidden", !text).find("[data-account-error-text]").text(text || "");
        // Перезапуск анимации «встряски» при повторной ошибке
        if (text) { $error[0].style.animation = "none"; void $error[0].offsetWidth; $error[0].style.animation = ""; }
    };

    static openAccount = async (mode) => {
        RxFriendsUI.setMode(mode);
        if (mode === "login") {
            const $wrap = RxFriendsUI.$account().find("[data-account-discord-wrap]").prop("hidden", true);
            RxAccount.discordEnabled().then(on => $wrap.prop("hidden", !on || RxFriendsUI.$account().attr("data-mode") !== "login"));
        }
        await RxModals.showModal("rxAccount");
        setTimeout(() => RxFriendsUI.$account().find("[data-modes]:not([hidden]) input").first().trigger("focus"), 60);
    };

    static submitAccount = async () => {
        const $modal = RxFriendsUI.$account();
        const mode = $modal.attr("data-mode");
        const field = name => String($modal.find(`[data-field="${name}"]`).val() || "");
        const errors = MESSAGES.friends.errors;
        const nick = field("nick").trim();
        const password = field("password");
        const fresh = field("newPassword");

        if (mode === "login" && !RxAccount.NICK_REGEX.test(nick)) return RxFriendsUI.accountError(errors.badNick);
        if (!password) return RxFriendsUI.accountError(errors.badPassword);
        if (mode === "password" && (fresh.length < 6 || fresh.length > 128)) return RxFriendsUI.accountError(errors.badPassword);
        if (mode === "password" && fresh !== field("repeat")) return RxFriendsUI.accountError(errors.passwordsDiffer);

        RxFriendsUI.accountError("");
        const $submit = $modal.find(".rxa-submit").prop("disabled", true);
        const $icon = $modal.find("[data-account-submit-icon]").text("progress_activity").addClass("spin");
        try {
            if (mode === "login") {
                const user = await RxAccount.login(nick, password);
                RxToasts.create(RxFriendsUI.t("loggedIn"), "login", user.nick, "success");
            } else if (mode === "password") {
                await RxAccount.changePassword(password, fresh);
                RxToasts.create(RxFriendsUI.t("passwordChanged"), "key", "", "success");
            } else if (mode === "delete") {
                await RxAccount.deleteAccount(password);
                RxToasts.create(RxFriendsUI.t("deleted"), "delete_forever");
            }
            $modal.find("input").val("");
            await RxModals.hideModal("rxAccount");
        } catch (error) {
            RxFriendsUI.accountError(RxAccount.errorText(error));
        } finally {
            $submit.prop("disabled", false);
            $icon.text(RxFriendsUI.MODES[mode].submitIcon).removeClass("spin");
        }
    };

    static init = () => {
        const $card = RxFriendsUI.$card();
        if (!$card.length) return;
        const $account = RxFriendsUI.$account();

        document.addEventListener("rxFriendsChanged", RxFriendsUI.render);
        document.addEventListener("rxAccountChanged", RxFriendsUI.render);
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "together") return;
            RxFriendsUI.render();
            RxFriends.sync();
        });

        $card.on("click", '[data-friends-action="register"]', () => RxFriendsUI.openRegister());
        $card.on("click", '[data-friends-action="login"]', () => RxFriendsUI.openAccount("login"));
        $card.on("click", '[data-friends-action="menu"]', () => RxFriendsUI.menu());
        $card.on("submit", "[data-friends-add]", (event) => { event.preventDefault(); RxFriendsUI.addFriend(); });
        $card.on("click", "[data-friend-action]", function () {
            RxFriendsUI.friendAction($(this), $(this).closest("[data-friend-id]").attr("data-friend-id"), $(this).attr("data-friend-action"));
        });
        $card.on("change", "[data-friends-copy-mode]", function () { RxFriendsUI.setCopyMode(this.value); });
        $card.on("click", "[data-friends-copy-pick]", () => RxFriendsUI.pickCopyFriends().catch(error => RxToasts.create(RxAccount.errorText(error), "error", "", "error")));
        $card.on("change", "[data-friends-option]", function () {
            RxConfig.write(this.dataset.friendsOption, this.checked);
            RxFriends.sync();
        });

        $account.on("submit", "[data-account-form]", (event) => { event.preventDefault(); RxFriendsUI.submitAccount(); });
        $account.on("click", "[data-account-register]", () => RxFriendsUI.openRegister());
        $account.on("click", "[data-account-discord]", () => RxFriendsUI.loginDiscord());
        $(document).on("hideModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "rxAccount") return;
            RxAccount.cancelDiscord();
            RxFriendsUI.discordWaiting(false);
        });
        $account.on("click", "[data-account-eye]", function () {
            const $input = $(this).siblings("input");
            const show = $input.attr("type") === "password";
            $input.attr("type", show ? "text" : "password");
            $(this).toggleClass("on", show).find(".material-symbols-outlined").text(show ? "visibility_off" : "visibility");
        });
        RxFriendsUI.render();
    };
}

$(RxFriendsUI.init);
