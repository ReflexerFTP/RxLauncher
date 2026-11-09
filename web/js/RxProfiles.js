// Профили игроков RxLauncher: открыть чей угодно профиль (даже не друга, если он не скрыт), свой — редактировать:
// аватарка (у всех), баннер (Игрок+), описание, «профиль видят только друзья». Поиск людей — лупа в шапке.
// Админ видит скрытые профили, правит описание, убирает картинки и выдаёт награды
class RxProfiles {
    static AVATAR = {width: 128, height: 128, limit: 96 * 1024};
    static BANNER = {width: 720, height: 240, limit: 640 * 1024};
    static BANNER_GROUPS = ["admin", "player_plus"];
    static current = null;
    static editing = false;
    static people = {query: "", offset: 0, total: 0, items: [], timer: 0, token: 0};

    static t = (key, fallback = "") => MESSAGES.profiles?.[key] || fallback;
    static esc = (value) => RxDialog.escape(value);
    static url = (path) => path ? (/^https?:/.test(path) ? path : `${SITE_URL}${path}`) : "";

    // Аватарка игрока: своя загруженная или голова скина
    static avatar = (person, size = 64) => RxFriendsUI.avatar(person, size);

    static needAccount = () => {
        if (RxAccount.isLoggedIn()) return false;
        RxToasts.create(RxProfiles.t("needAccount", "Войдите в аккаунт RxLauncher"), "account_circle");
        RxFriendsUI.openAccount("login");
        return true;
    };

    // ---------- профиль ----------
    static open = async (who = {}) => {
        if (RxProfiles.needAccount()) return false;
        RxProfiles.editing = false;
        const $modal = $("#modal-profile");
        $modal.addClass("loading");
        $modal.find("[data-pf-body]").html('<div class="pf-loading"><span class="material-symbols-outlined spin">progress_activity</span></div>');
        $modal.find("[data-pf-actions], [data-pf-tags]").empty();
        $modal.find("[data-pf-nick]").text(who.nick || "");
        RxModals.showModal("profile");
        try {
            const data = await RxAccount.call("profile/get", who.id ? {id: who.id} : {nick: who.nick});
            RxProfiles.current = data.profile;
            RxProfiles.render();
        } catch (error) {
            $modal.find("[data-pf-body]").html(`<p class="pf-empty">${RxProfiles.esc(RxAccount.errorText(error))}</p>`);
        } finally {
            $modal.removeClass("loading");
        }
        return true;
    };

    static isAdmin = () => RxAccount.user?.group === "admin";
    static canEdit = () => Boolean(RxProfiles.current && (RxProfiles.current.self || RxProfiles.isAdmin()));

    static hours = (seconds) => {
        const hours = Math.floor((Number(seconds) || 0) / 3600);
        return RxProfiles.t("hours", "{0} ч").replace("{0}", hours.toLocaleString());
    };

    static render = () => {
        const profile = RxProfiles.current;
        if (!profile) return;
        const esc = RxProfiles.esc;
        const $modal = $("#modal-profile");
        $modal.toggleClass("has-banner", Boolean(profile.banner));
        $modal.find("[data-pf-banner]").css("background-image", profile.banner ? `url("${RxProfiles.url(profile.banner)}")` : "")
            .attr("data-group", profile.group);
        $modal.find("[data-pf-avatar]").attr("src", RxProfiles.avatar(profile, 96));
        $modal.find("[data-pf-nick]").text(profile.nick);
        const tags = [RxFriendsUI.groupBadge(profile.group)];
        if (profile.online) tags.push(`<span class="pf-tag online"><i></i>${esc(RxProfiles.t("online", "В сети"))}</span>`);
        if (profile.friend) tags.push(`<span class="pf-tag"><span class="material-symbols-outlined">diversity_3</span>${esc(RxProfiles.t("friend", "Друг"))}</span>`);
        if (profile.private) tags.push(`<span class="pf-tag"><span class="material-symbols-outlined">lock</span>${esc(RxProfiles.t("private", "Только для друзей"))}</span>`);
        $modal.find("[data-pf-tags]").html(tags.join(""));

        // Кнопки: дружба, правка
        const actions = [];
        if (!profile.self && !profile.friend) {
            actions.push(profile.incoming
                ? `<button type="button" data-pf-action="accept"><span class="material-symbols-outlined">person_check</span><span>${esc(RxProfiles.t("accept", "Принять заявку"))}</span></button>`
                : `<button type="button"${profile.outgoing ? " disabled" : ""} data-pf-action="add"><span class="material-symbols-outlined">${profile.outgoing ? "schedule_send" : "person_add"}</span><span>${esc(profile.outgoing ? RxProfiles.t("requested", "Заявка отправлена") : RxProfiles.t("add", "Добавить в друзья"))}</span></button>`);
        }
        if (RxProfiles.canEdit() && !profile.hidden && !RxProfiles.editing) {
            actions.push(`<button type="button" class="transparent" data-pf-action="edit"><span class="material-symbols-outlined">edit</span><span>${esc(profile.self ? RxProfiles.t("edit", "Редактировать") : RxProfiles.t("adminEdit", "Править (админ)"))}</span></button>`);
        }
        $modal.find("[data-pf-actions]").html(actions.join(""));

        if (profile.hidden) {
            $modal.find("[data-pf-body]").html(`<div class="pf-hidden"><span class="material-symbols-outlined">lock</span>
                <b>${esc(RxProfiles.t("hiddenTitle", "Профиль скрыт"))}</b><span>${esc(RxProfiles.t("hiddenText", "Его видят только друзья этого игрока"))}</span></div>`);
            return;
        }
        if (RxProfiles.editing) return RxProfiles.renderEditor();

        const fact = (icon, label, value) => `<div class="pf-fact"><span class="material-symbols-outlined">${icon}</span><div><b>${esc(value)}</b><span>${esc(label)}</span></div></div>`;
        const got = (profile.achievements || []).filter(item => item.got);
        const game = profile.game?.version ? `<div class="pf-section">${esc(RxProfiles.t("playingNow", "Сейчас играет"))}</div>
            <div class="fr-status">${RxFriendsUI.gameChips(profile.game)}</div>` : "";
        $modal.find("[data-pf-body]").html(`
            ${profile.bio ? `<p class="pf-bio">${esc(profile.bio)}</p>` : profile.self ? `<p class="pf-bio empty">${esc(RxProfiles.t("noBio", "Расскажите о себе — нажмите «Редактировать»"))}</p>` : ""}
            <div class="pf-facts">
                ${fact("schedule", RxProfiles.t("playTime", "в игре"), RxProfiles.hours(profile.playSeconds))}
                ${fact("cake", RxProfiles.t("since", "аккаунт с"), new Date(profile.created).toLocaleDateString(RxTranslator.getCurrentLanguage() === "en" ? "en-GB" : "ru-RU"))}
                ${fact("diversity_3", RxProfiles.t("friends", "друзей"), String(profile.friendsCount || 0))}
                ${fact("emoji_events", RxProfiles.t("achievements", "достижений"), `${got.length} / ${(profile.achievements || []).length}`)}
            </div>
            ${game}
            <div class="pf-section">${esc(RxAchievements.t("title", "Достижения"))}</div>
            <div class="fx-ach-grid pf-ach">${(profile.achievements || []).map(item => RxAchievements.tile(item).replace("data-achievement=", "data-pf-achievement=")).join("")}</div>
        `);
    };

    // ---------- редактирование ----------
    static renderEditor = () => {
        const profile = RxProfiles.current;
        const esc = RxProfiles.esc;
        const admin = !profile.self && RxProfiles.isAdmin();
        const bannerAllowed = RxProfiles.BANNER_GROUPS.includes(profile.group);
        $("#modal-profile [data-pf-body]").html(`
            <div class="pf-edit">
                ${admin ? `<p class="pf-admin-note"><span class="material-symbols-outlined">shield_person</span>${esc(RxProfiles.t("adminNote", "Вы правите чужой профиль как администратор"))}</p>` : ""}
                <div class="pf-edit-row">
                    <div class="pf-edit-label"><b>${esc(RxProfiles.t("avatar", "Аватарка"))}</b><span>${esc(RxProfiles.t("avatarHint", "Квадратная картинка, лишнее обрежется"))}</span></div>
                    ${admin ? "" : `<button type="button" data-pf-action="avatar"><span class="material-symbols-outlined">upload</span><span>${esc(RxProfiles.t("upload", "Загрузить"))}</span></button>`}
                    ${profile.avatar ? `<button type="button" class="transparent" data-pf-action="clear-avatar"><span class="material-symbols-outlined">delete</span><span>${esc(RxProfiles.t("remove", "Убрать"))}</span></button>` : ""}
                </div>
                <div class="pf-edit-row">
                    <div class="pf-edit-label"><b>${esc(RxProfiles.t("banner", "Баннер"))}</b><span>${esc(bannerAllowed ? RxProfiles.t("bannerHint", "Широкая картинка 3:1 над профилем") : RxProfiles.t("bannerPlus", "Баннер доступен группе Игрок+"))}</span></div>
                    ${!admin && bannerAllowed ? `<button type="button" data-pf-action="banner"><span class="material-symbols-outlined">wallpaper</span><span>${esc(RxProfiles.t("upload", "Загрузить"))}</span></button>` : ""}
                    ${profile.banner ? `<button type="button" class="transparent" data-pf-action="clear-banner"><span class="material-symbols-outlined">delete</span><span>${esc(RxProfiles.t("remove", "Убрать"))}</span></button>` : ""}
                </div>
                <label class="pf-edit-bio">
                    <b>${esc(RxProfiles.t("bio", "Описание"))}</b>
                    <textarea data-pf-bio maxlength="300" rows="4" spellcheck="true" placeholder="${esc(RxProfiles.t("bioPlaceholder", "Пару слов о себе: где играете, что любите…"))}">${esc(profile.bio || "")}</textarea>
                    <span class="pf-counter" data-pf-counter>${(profile.bio || "").length} / 300</span>
                </label>
                <label class="pf-edit-check">
                    <div><b>${esc(RxProfiles.t("privateTitle", "Профиль видят только друзья"))}</b><span>${esc(RxProfiles.t("privateText", "Остальные увидят только ник и аватарку, и вас не будет в поиске людей"))}</span></div>
                    <span class="switch"><input type="checkbox" data-pf-private${profile.private ? " checked" : ""}><span class="inner"></span></span>
                </label>
                ${admin ? `<div class="pf-section">${esc(RxProfiles.t("adminBadges", "Награды от админа"))}</div>${RxAchievements.adminHtml(profile.achievements || [])}` : ""}
                <div class="pf-edit-actions">
                    <button type="button" class="transparent" data-pf-action="cancel"><span>${esc(MESSAGES.commons?.cancel || "Отмена")}</span></button>
                    <button type="button" data-pf-action="save"><span class="material-symbols-outlined">check</span><span>${esc(RxProfiles.t("save", "Сохранить"))}</span></button>
                </div>
            </div>`);
        if (admin) RxAchievements.bindAdmin($("#modal-profile [data-pf-body]"), profile.id, () => RxProfiles.reload(true));
    };

    static reload = async (keepEditing = false) => {
        const data = await RxAccount.call("profile/get", {id: RxProfiles.current.id});
        RxProfiles.current = data.profile;
        RxProfiles.editing = keepEditing;
        RxProfiles.render();
    };

    static applied = (profile, toast) => {
        RxProfiles.current = profile;
        RxProfiles.editing = false;
        RxProfiles.render();
        if (profile.self) {
            RxAccount.user = {...RxAccount.user, avatar: profile.avatar, banner: profile.banner, bio: profile.bio, profilePrivate: profile.private};
            RxAccount.changed();
        }
        if (toast) RxToasts.create(toast, "check_circle");
    };

    static save = async () => {
        const profile = RxProfiles.current;
        const bio = String($("#modal-profile [data-pf-bio]").val() || "");
        const isPrivate = $("#modal-profile [data-pf-private]").is(":checked");
        try {
            const data = profile.self
                ? await RxAccount.call("profile/save", {bio, private: isPrivate})
                : await RxAccount.call("admin/profile", {id: profile.id, bio, private: isPrivate});
            RxProfiles.applied(data.profile, RxProfiles.t("saved", "Профиль сохранён"));
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    static clearImage = async (kind) => {
        const profile = RxProfiles.current;
        try {
            const data = profile.self
                ? await RxAccount.call("profile/image", {kind, png: null})
                : await RxAccount.call("admin/profile", {id: profile.id, [kind === "avatar" ? "clearAvatar" : "clearBanner"]: true});
            RxProfiles.current = data.profile;
            RxProfiles.renderEditor();
            if (profile.self) RxProfiles.applied(data.profile);
            RxProfiles.editing = true;
            RxProfiles.render();
        } catch (error) {
            RxToasts.create(RxAccount.errorText(error), "error", "", "error");
        }
    };

    // Картинка с компьютера → обрезка по центру под нужные пропорции → PNG нужного размера
    static pickImage = () => new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp,image/gif";
        input.onchange = () => resolve(input.files?.[0] || null);
        input.click();
    });

    static prepareImage = (file, spec) => new Promise((resolve, reject) => {
        if (!file || file.size > 15 * 1024 * 1024) return reject(new Error("size"));
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            const ratio = spec.width / spec.height;
            let sw = image.naturalWidth, sh = image.naturalHeight;
            if (sw / sh > ratio) sw = sh * ratio; else sh = sw / ratio;
            const sx = (image.naturalWidth - sw) / 2, sy = (image.naturalHeight - sh) / 2;
            const canvas = document.createElement("canvas");
            canvas.width = spec.width;
            canvas.height = spec.height;
            const context = canvas.getContext("2d");
            context.imageSmoothingQuality = "high";
            context.drawImage(image, sx, sy, sw, sh, 0, 0, spec.width, spec.height);
            let data = canvas.toDataURL("image/png").split(",")[1];
            // Фото в PNG бывает тяжёлым — тогда чуть огрубляем цвета (на глаз почти незаметно), пока не влезет
            for (let step = 8; data.length * 3 / 4 > spec.limit && step <= 64; step *= 2) {
                const pixels = context.getImageData(0, 0, spec.width, spec.height);
                for (let i = 0; i < pixels.data.length; i++) if (i % 4 !== 3) pixels.data[i] = Math.min(255, Math.round(pixels.data[i] / step) * step);
                context.putImageData(pixels, 0, 0);
                data = canvas.toDataURL("image/png").split(",")[1];
            }
            if (data.length * 3 / 4 > spec.limit) return reject(new Error("size"));
            resolve(data);
        };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
        image.src = url;
    });

    static uploadImage = async (kind) => {
        const file = await RxProfiles.pickImage();
        if (!file) return;
        try {
            const png = await RxProfiles.prepareImage(file, kind === "avatar" ? RxProfiles.AVATAR : RxProfiles.BANNER);
            const data = await RxAccount.call("profile/image", {kind, png});
            RxProfiles.applied(data.profile, kind === "avatar" ? RxProfiles.t("avatarSaved", "Аватарка обновлена") : RxProfiles.t("bannerSaved", "Баннер обновлён"));
            RxProfiles.editing = true;
            RxProfiles.render();
        } catch (error) {
            RxToasts.create(error?.code ? RxAccount.errorText(error) : RxProfiles.t("badImage", "Не получилось открыть картинку"), "error", "", "error");
        }
    };

    static action = async (action) => {
        const profile = RxProfiles.current;
        if (!profile) return;
        if (action === "edit") { RxProfiles.editing = true; return RxProfiles.render(); }
        if (action === "cancel") { RxProfiles.editing = false; return RxProfiles.render(); }
        if (action === "save") return RxProfiles.save();
        if (action === "avatar" || action === "banner") return RxProfiles.uploadImage(action);
        if (action === "clear-avatar") return RxProfiles.clearImage("avatar");
        if (action === "clear-banner") return RxProfiles.clearImage("banner");
        if (action === "add" || action === "accept") {
            try {
                if (action === "add") await RxAccount.call("friends/request", {nick: profile.nick});
                else await RxAccount.call("friends/accept", {id: profile.id});
                RxToasts.create(action === "add" ? RxProfiles.t("requestSent", "Заявка в друзья отправлена") : RxProfiles.t("nowFriends", "Теперь вы друзья"), "person_add");
                await RxProfiles.reload();
                RxFriends.sync?.();
            } catch (error) {
                RxToasts.create(RxAccount.errorText(error), "error", "", "error");
            }
        }
    };

    // ---------- люди ----------
    static openPeople = async () => {
        if (RxProfiles.needAccount()) return false;
        RxModals.showModal("people");
        RxProfiles.searchPeople("");
        setTimeout(() => $("#modal-people [data-people-query]").trigger("focus"), 250);
        return true;
    };

    static searchPeople = async (query, more = false) => {
        const state = RxProfiles.people;
        const token = ++state.token;
        if (!more) {
            state.query = query;
            state.offset = 0;
            state.items = [];
            $("#modal-people [data-people-list]").html('<div class="pf-loading"><span class="material-symbols-outlined spin">progress_activity</span></div>');
        }
        try {
            const data = await RxAccount.call("people", {query: state.query, offset: state.offset});
            if (token !== state.token) return;
            state.items = more ? [...state.items, ...data.people] : data.people;
            state.total = data.total;
            state.offset = state.items.length;
            RxProfiles.renderPeople();
        } catch (error) {
            if (token === state.token) $("#modal-people [data-people-list]").html(`<p class="pf-empty">${RxProfiles.esc(RxAccount.errorText(error))}</p>`);
        }
    };

    static renderPeople = () => {
        const esc = RxProfiles.esc;
        const state = RxProfiles.people;
        $("#modal-people [data-people-count]").text(RxProfiles.t("peopleCount", "Игроков: {0}").replace("{0}", state.total));
        $("#modal-people [data-people-list]").html(state.items.length ? state.items.map(person => `
            <button type="button" class="pp-card" data-person-id="${esc(person.id)}">
                <span class="pp-avatar"><img alt="" loading="lazy" src="${esc(RxProfiles.avatar(person, 64))}"/>${person.online ? "<i></i>" : ""}</span>
                <span class="pp-name"><b>${esc(person.nick)}</b>${RxFriendsUI.groupBadge(person.group)}</span>
                <span class="pp-meta">${esc(person.self ? RxProfiles.t("you", "Это вы") : person.friend ? RxProfiles.t("friend", "Друг") : person.online ? RxProfiles.t("online", "В сети") : "")}</span>
            </button>`).join("") : `<p class="pf-empty">${esc(RxProfiles.t("nobody", "Никого не нашли"))}</p>`);
        $("#modal-people [data-people-more]").css("display", state.items.length >= state.total ? "none" : "");
    };

    static init = () => {
        const $profile = $("#modal-profile");
        $profile.on("click", "[data-pf-action]", function () { RxProfiles.action(this.dataset.pfAction); });
        $profile.on("input", "[data-pf-bio]", function () { $profile.find("[data-pf-counter]").text(`${this.value.length} / 300`); });
        $profile.on("click", "[data-pf-achievement]", function () {
            const item = (RxProfiles.current?.achievements || []).find(entry => entry.id === this.dataset.pfAchievement);
            if (item) RxDialog.open({icon: RxAchievements.icon(item), title: RxAchievements.name(item),
                text: `${item.got ? RxAchievements.t("got", "Получено") : RxAchievements.t("locked", "Ещё не получено")} · ${RxAchievements.text(item)}`});
        });
        const $people = $("#modal-people");
        $people.on("input", "[data-people-query]", function () {
            clearTimeout(RxProfiles.people.timer);
            const value = this.value.trim();
            RxProfiles.people.timer = setTimeout(() => RxProfiles.searchPeople(value), 250);
        });
        $people.on("click", "[data-people-more]", () => RxProfiles.searchPeople(RxProfiles.people.query, true));
        $people.on("click", "[data-person-id]", async function () {
            const id = this.dataset.personId;
            await RxModals.hideModal("people");
            RxProfiles.open({id});
        });
        // Друзья: клик по аватарке или нику — профиль
        $(document).on("click", ".fx-friend .fx-avatar, .fx-friend .fx-name span", function () {
            const id = $(this).closest("[data-friend-id]").attr("data-friend-id");
            if (id) RxProfiles.open({id});
        });
    };
}

$(RxProfiles.init);
