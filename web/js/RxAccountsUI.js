class RxAccountsUI {
    static editingUuid = "";
    static deleteTimer = null;

    static getAvatarURL = (account) => {
        const accountUuid = String(account?.uuid || "").toLowerCase();
        const launcherHeadPath = path.join(USERDATA_PATH, "skins", "heads", `${accountUuid}.png`);
        if (accountUuid && fs.existsSync(launcherHeadPath)) {
            return `${pathToFileURL(launcherHeadPath).href}?v=${fs.statSync(launcherHeadPath).mtimeMs}`;
        }
        if (account?.type === "elyby") {
            const localSkinPath = path.join(USERDATA_PATH, "elybySkins", `${account.nickname}.png`);
            return fs.existsSync(localSkinPath) ? pathToFileURL(localSkinPath).href : "assets/icon.png";
        }
        return RxPrivacy.remoteAvatar(`https://minotar.net/avatar/${encodeURIComponent(account?.nickname || "Steve")}/44`);
    };

    // Собрать строку профиля
    static buildRow = (acc, isActive) => {
        const $row = $(`<div class="acc-item"></div>`)
            .attr("data-uuid", acc.uuid)
            .attr("data-type", acc.type)
            .toggleClass("active", isActive);

        $row.append($(`<span class="acc-handle material-symbols-outlined">drag_indicator</span>`).attr("title", MESSAGES.accounts.reorderHint));

        const $avatar = $(`<div class="acc-avatar"><img class="avatar" alt="" loading="lazy"/></div>`);
        $avatar.find("img").attr("src", RxAccountsUI.getAvatarURL(acc)).on("error", function () {
            $(this).off("error").attr("src", "assets/icon.png");
        });
        if (acc.type === "elyby") $avatar.append(`<img class="type" src="assets/elyby.webp" alt=""/>`);
        $row.append($avatar);

        const $meta = $(`<div class="acc-meta"></div>`);
        $meta.append($(`<span class="acc-nick"></span>`).text(acc.nickname));
        $meta.append($(`<span class="acc-type"></span>`).text(RxAccountsUI.typeDisplayName(acc.type)));
        $meta.append($(`<input class="acc-rename" type="text" maxlength="16" spellcheck="false"/>`).val(acc.nickname));
        $row.append($meta);

        const $side = $(`<div class="acc-side"><span class="acc-check material-symbols-outlined">check_circle</span><div class="acc-actions"></div></div>`);
        const $actions = $side.find(".acc-actions");
        if (acc.type === "local") {
            $actions.append($(`<button class="edit"><span class="material-symbols-outlined">edit</span></button>`).attr("title", MESSAGES.accounts.edit));
        }
        $actions.append($(`<button class="delete"><span class="material-symbols-outlined">delete</span></button>`).attr("title", MESSAGES.accounts.deleteConfirm));
        $row.append($side);
        return $row;
    };

    // Перезагрузить список доступных аккаунтов
    static reloadAccountsManager = () => {
        const accountsList = Object.values(RxAccountsManager.getAccounts());
        const activeAccount = RxAccountsManager.getActiveAccount();
        const $list = $("#modal-accounts .accounts-list");
        RxAccountsUI.editingUuid = "";
        $list.empty();
        accountsList.forEach((acc) => $list.append(RxAccountsUI.buildRow(acc, acc.uuid === activeAccount)));
        $("#modal-accounts .accounts-empty").toggle(accountsList.length === 0);
        $("#modal-accounts .accounts-count").text(accountsList.length).toggle(accountsList.length > 0);
        RxAccountsUI.bindListEvents();
        return true;
    }

    static bindListEvents = () => {
        const $list = $("#modal-accounts .accounts-list");
        $list.off();

        $list.on("click", ".acc-actions .edit", function (e) {
            e.stopPropagation();
            RxAccountsUI.startEdit($(this).closest(".acc-item").data("uuid"));
        });

        // Удаление в два клика: первый — подтверждение
        $list.on("click", ".acc-actions .delete", function (e) {
            e.stopPropagation();
            const $row = $(this).closest(".acc-item");
            if ($row.hasClass("confirm-delete")) {
                clearTimeout(RxAccountsUI.deleteTimer);
                RxAccountsManager.deleteAccount($row.data("uuid"));
                return;
            }
            $list.find(".confirm-delete").removeClass("confirm-delete");
            $row.addClass("confirm-delete");
            clearTimeout(RxAccountsUI.deleteTimer);
            RxAccountsUI.deleteTimer = setTimeout(() => $row.removeClass("confirm-delete"), 2500);
        });

        $list.on("keydown", ".acc-rename", function (e) {
            if (e.key === "Enter") RxAccountsUI.saveEdit();
            if (e.key === "Escape") { e.stopPropagation(); RxAccountsUI.cancelEdit(); }
        });
        $list.on("blur", ".acc-rename", () => {
            // Клик мимо поля: сохраняем, если ник изменён и корректен
            setTimeout(() => { if (RxAccountsUI.editingUuid) RxAccountsUI.saveEdit(true); }, 0);
        });

        $list.on("pointerdown", ".acc-item", RxAccountsUI.onPointerDown);
    }

    // ---------- Выбор и перетаскивание (один жест: клик или drag) ----------
    static onPointerDown = (e) => {
        if (e.button !== 0) return;
        const row = e.currentTarget;
        if ($(e.target).closest(".acc-actions, .acc-rename").length > 0 || row.classList.contains("editing")) return;

        const list = row.parentElement;
        const startY = e.clientY;
        const grabOffset = startY - row.getBoundingClientRect().top;
        const initialOrder = [...list.children].map((r) => r.dataset.uuid).join();
        let dragging = false;

        const placeRow = (clientY) => {
            // Строка не выезжает за границы списка, иначе её обрезает прокрутка
            const bounds = list.getBoundingClientRect();
            const y = Math.min(Math.max(clientY, bounds.top + grabOffset), bounds.bottom - row.offsetHeight + grabOffset);
            row.style.transform = "none";
            const naturalTop = row.getBoundingClientRect().top;
            row.style.transform = `translateY(${y - grabOffset - naturalTop}px)`;
        };

        const onMove = (ev) => {
            if (!dragging) {
                if (Math.abs(ev.clientY - startY) < 5) return;
                dragging = true;
                row.setPointerCapture(e.pointerId);
                row.classList.add("dragging");
                list.classList.add("sorting");
            }
            const others = [...list.children].filter((r) => r !== row);
            const before = others.find((r) => ev.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
            if (row.nextElementSibling !== before) {
                // FLIP: соседи плавно разъезжаются на новые места
                const firstTops = new Map(others.map((r) => [r, r.getBoundingClientRect().top]));
                list.insertBefore(row, before);
                others.forEach((r) => {
                    const delta = firstTops.get(r) - r.getBoundingClientRect().top;
                    if (!delta) return;
                    r.style.transition = "none";
                    r.style.transform = `translateY(${delta}px)`;
                    requestAnimationFrame(() => {
                        r.style.transition = "transform .18s cubic-bezier(.22, 1, .36, 1)";
                        r.style.transform = "";
                    });
                });
            }
            placeRow(ev.clientY);
        };

        const onUp = (ev) => {
            row.removeEventListener("pointermove", onMove);
            row.removeEventListener("pointerup", onUp);
            row.removeEventListener("pointercancel", onUp);
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);

            if (!dragging) {
                if (ev.type === "pointerup") RxAccountsUI.selectAccount(row.dataset.uuid);
                return;
            }
            row.style.transition = "transform .16s ease";
            row.style.transform = "";
            setTimeout(() => {
                row.classList.remove("dragging");
                row.style.transition = "";
                list.classList.remove("sorting");
            }, 170);
            const newOrder = [...list.children].map((r) => r.dataset.uuid);
            if (newOrder.join() !== initialOrder) RxAccountsManager.reorderAccounts(newOrder);
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    }

    static selectAccount = (uuid) => {
        RxAccountsManager.setActiveAccount(uuid);
        RxModals.hideModal("accounts");
        return true;
    }

    // Перезагрузить кнопку для открытия менеджера аккаунтов
    static reloadAccountSelect = () => {
        const activeAccount = RxAccountsManager.getActiveAccount();
        const $select = $("#accountSelect");
        $(".title-wrapper .account-chip").toggleClass("no-account", activeAccount === "none");
        $select.empty();

        if (activeAccount === "none") {
            $select.append($(`<span class="title"></span>`).text(MESSAGES.commons.notSelected));
        } else {
            const acc = RxAccountsManager.getAccount(activeAccount);
            const $icon = $(`<div class="icon"><img class="avatar" alt=""/></div>`);
            $icon.find("img").attr("src", RxAccountsUI.getAvatarURL(acc)).on("error", function () {
                $(this).off("error").attr("src", "assets/icon.png");
            });
            $select.append($icon, $(`<span class="title"></span>`).text(acc.nickname));
        }
        $("#accountSelectPlaceholder").hide();
        $select.show();
        return true;
    }

    // Получить текст из типа аккаунта
    static typeDisplayName = (type) => {
        if (typeof MESSAGES.accounts[type] !== "undefined") {
            return MESSAGES.accounts[type];
        } else {
            return MESSAGES.accounts.unknown;
        }
    }

    // Поле добавления всегда на виду — просто фокусируем его
    static showAddLocalAccountUI = () => {
        $("#modal-accounts .add-local input").focus();
        return true;
    }

    // Добавить локальный аккаунт из UI
    static addLocalAccount = () => {
        const $input = $("#modal-accounts .add-local input");
        if (RxAccountsManager.addLocalAccount($input.val().trim()) === false) {
            RxToasts.create(MESSAGES.accounts.invalidNickname, "person_alert");
            $input.focus();
            return false;
        }
        $input.val("");
        return true;
    }

    // Переименование прямо в строке списка
    static startEdit = (uuid) => {
        const account = RxAccountsManager.getAccount(uuid);
        if (!account || account.type !== "local") {
            RxToasts.create(MESSAGES.accounts.editOnlyLocal, "lock");
            return false;
        }
        RxAccountsUI.cancelEdit();
        RxAccountsUI.editingUuid = uuid;
        const $row = $(`#modal-accounts .acc-item[data-uuid="${uuid}"]`);
        $row.addClass("editing");
        $row.find(".acc-rename").val(account.nickname).focus().select();
        return true;
    }

    static cancelEdit = () => {
        const uuid = RxAccountsUI.editingUuid;
        RxAccountsUI.editingUuid = "";
        if (uuid) {
            const $row = $(`#modal-accounts .acc-item[data-uuid="${uuid}"]`);
            $row.removeClass("editing").find(".acc-rename").val($row.find(".acc-nick").text());
        }
        return true;
    }

    static saveEdit = (quiet = false) => {
        const uuid = RxAccountsUI.editingUuid;
        if (!uuid) return false;
        const $row = $(`#modal-accounts .acc-item[data-uuid="${uuid}"]`);
        const nickname = $row.find(".acc-rename").val().trim();
        if (nickname === $row.find(".acc-nick").text()) return RxAccountsUI.cancelEdit();
        if (!RxAccountsManager.renameLocalAccount(uuid, nickname)) {
            if (quiet) return RxAccountsUI.cancelEdit() && false;
            RxToasts.create(MESSAGES.accounts.invalidNickname, "person_alert");
            $row.find(".acc-rename").focus();
            return false;
        }
        RxAccountsUI.editingUuid = "";
        return true;
    }

    // Открыть UI аккаунтов под чипом в шапке
    static open = () => {
        if (RxModals.isModalShown("accounts")) {
            return RxModals.hideModal("accounts");
        }
        const chip = document.querySelector(".title-wrapper .account-chip");
        if (chip) {
            const rect = chip.getBoundingClientRect();
            $("#modal-accounts").css({top: `${Math.round(rect.bottom + 8)}px`, right: `${Math.max(12, Math.round(window.innerWidth - rect.right))}px`});
        }
        return RxModals.showModal("accounts");
    }
}
