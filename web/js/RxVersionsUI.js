class RxVersionsUI {
    static offlineNoticeShown = false;
    static allVersions = [];
    static loaderTab = "all";
    static sortMode = "newest";

    static LOADER_TABS = [
        {id: "all", label: () => MESSAGES.versions.all},
        {id: "vanilla", label: () => "Vanilla"},
        {id: "fabric", label: () => "Fabric"},
        {id: "forge", label: () => "Forge"},
        {id: "neoforge", label: () => "NeoForge"},
        {id: "quilt", label: () => "Quilt"},
        {id: "forgeOptiFine", label: () => "OptiFine"},
        {id: "custom", label: () => MESSAGES.versions.custom},
        {id: "pack", label: () => MESSAGES.versions.pack}
    ];

    static TYPE_LABELS = {
        vanilla: "Vanilla", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge",
        quilt: "Quilt", forgeOptiFine: "Forge + OptiFine"
    };

    static init = () => {
        const $modal = $("#modal-versions");
        RxVersionsUI.sortMode = RxConfig.read("versionsSort", "newest");
        RxVersionsUI.loaderTab = RxConfig.read("versionsLoaderTab", "all");
        $modal.find("[data-versions-sort]").val(RxVersionsUI.sortMode).on("change", function () {
            RxVersionsUI.sortMode = $(this).val();
            RxConfig.write("versionsSort", RxVersionsUI.sortMode);
            RxVersionsUI.render();
        });

        $modal.find("input.search").on("input", () => RxVersionsUI.render()).on("keydown", (e) => {
            if (e.key === "Enter") $modal.find(".versions-list .item").first().trigger("click");
        });

        // Типы vanilla меняют загружаемый список, избранные/установленные — только фильтр
        $modal.find("#versionTypeSelect .chip").on("click", function () {
            $(this).toggleClass("active");
            if (["favorite", "installed"].includes($(this).data("type"))) RxVersionsUI.render();
            else RxVersionsUI.loadVersions();
        });

        $modal.find("[data-versions-tabs]").on("click", ".vp-tab", function () {
            RxVersionsUI.loaderTab = $(this).attr("data-tab");
            RxConfig.write("versionsLoaderTab", RxVersionsUI.loaderTab);
            RxVersionsUI.render();
        });

        const $list = $modal.find(".versions-list");
        $list.on("click", ".item", function () {
            const versionId = $(this).attr("data-version");
            $list.find(".item.active").removeClass("active");
            $(this).addClass("active");
            RxVersionsManager.setActiveVersion(versionId);
            RxVersionsUI.clearSearch();
            RxModals.hideModal("versions");
        });
        $list.on("click", ".favorite", function (e) {
            e.stopPropagation();
            const versionId = $(this).closest(".item").attr("data-version");
            RxVersionsManager.addOrRemoveFavorite(versionId);
            $(this).toggleClass("active");
            if (RxVersionsUI.sortMode === "favorites" || RxVersionsUI.isChipActive("favorite")) RxVersionsUI.render();
        });
        $list.on("click", ".vp-delete", async function (e) {
            e.stopPropagation();
            const $button = $(this);
            // Двойное нажатие: первое — подтверждение
            if (!$button.hasClass("confirm")) {
                $button.addClass("confirm").attr("title", MESSAGES.versions.deleteConfirm);
                setTimeout(() => $button.removeClass("confirm"), 3000);
                return;
            }
            const versionId = $button.closest(".item").attr("data-version");
            const name = RxVersionsManager.parseVersionID(versionId).name;
            if (await RxCustomVersions.remove(name)) {
                if (RxVersionsManager.getActiveVersion() === versionId) RxConfig.write("activeVersion", "none");
                RxToasts.create(MESSAGES.versions.deleted, "delete", name);
                RxVersionsUI.loadVersions();
            } else {
                RxToasts.create(MESSAGES.versions.errDelete, "error", name, "error");
            }
        });

        // Своя версия: меню «папка / файл»
        const $menu = $modal.find(".vp-add-menu");
        $modal.find("[data-versions-add]").on("click", (e) => {
            e.stopPropagation();
            $menu.prop("hidden", !$menu.prop("hidden"));
        });
        $modal.on("click", (e) => {
            if (!$(e.target).closest(".vp-add").length) $menu.prop("hidden", true);
        });
        $modal.find("[data-versions-import]").on("click", async function () {
            $menu.prop("hidden", true);
            const folder = $(this).attr("data-versions-import") === "folder";
            const result = await ipcRenderer.invoke("open-dialog", folder
                ? {properties: ["openDirectory"]}
                : {properties: ["openFile"], filters: [{name: "Minecraft version", extensions: ["json", "zip"]}]});
            if (Array.isArray(result) && result[0]) RxVersionsUI.importCustom([result[0]]);
        });

        // Закрыть: крестик или Esc (Esc сначала закрывает меню «Своя версия»)
        $modal.find("[data-versions-close]").on("click", () => RxModals.hideModal("versions"));
        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !RxModals.isModalShown("versions") || $menu.prop("hidden")) return;
            e.stopPropagation(); // на фазе захвата: общий обработчик Esc не закроет всё окно
            $menu.prop("hidden", true);
        }, true);

        RxVersionsUI.bindDragAndDrop($modal);
    };

    static bindDragAndDrop = ($modal) => {
        const $drop = $modal.find(".vp-drop");
        const hasFiles = (e) => [...(e.originalEvent?.dataTransfer?.types || [])].includes("Files");
        let depth = 0;
        $modal.on("dragenter", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth++;
            $drop.prop("hidden", false);
        }).on("dragover", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.originalEvent.dataTransfer.dropEffect = "copy";
        }).on("dragleave", (e) => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) $drop.prop("hidden", true);
        }).on("drop", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            $drop.prop("hidden", true);
            const {webUtils} = require("electron");
            const paths = [...e.originalEvent.dataTransfer.files].map(file => {
                try { return webUtils.getPathForFile(file); } catch (_) { return ""; }
            }).filter(Boolean);
            if (paths.length) RxVersionsUI.importCustom(paths);
        });
    };

    static importCustom = async (paths) => {
        let lastImported = "";
        for (const sourcePath of paths) {
            const result = await RxCustomVersions.importFrom(sourcePath);
            if (result.ok) {
                lastImported = result.name;
                RxToasts.create(MESSAGES.versions.imported, "add_circle", result.name, "success");
            } else {
                const messages = {
                    noManifest: MESSAGES.versions.errNoManifest,
                    exists: MESSAGES.versions.errExists.replace("{0}", result.name || ""),
                    unsupported: MESSAGES.versions.errUnsupported
                };
                RxToasts.create(messages[result.error] || MESSAGES.versions.errFailed, "error", path.basename(sourcePath), "error");
            }
        }
        if (lastImported) {
            RxVersionsUI.loaderTab = "custom";
            RxConfig.write("activeVersion", `custom-${lastImported}`);
            await RxVersionsUI.loadVersions();
        }
    };

    // Открыть UI версий
    static open = () => {
        if (RxModals.isModalShown("versions")) {
            return RxModals.hideModal("versions");
        }
        RxVersionsUI.position();
        return RxModals.showModal("versions");
    }

    // Окно появляется над кнопкой выбора версии
    static position = () => {
        const anchor = document.querySelector("#versionSelect:not([style*='display: none'])") || document.querySelector("#versionSelectPlaceholder");
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        if (!rect.width) return;
        const width = Math.min(780, window.innerWidth - rect.left - 24);
        $("#modal-versions").css({
            left: `${Math.max(12, rect.left)}px`,
            bottom: `${Math.max(12, window.innerHeight - rect.top + 10)}px`,
            width: `${Math.max(520, width)}px`
        });
    };

    // Загрузить список версий в UI
    static loadVersions = async () => {
        $(".flyout #versionSelectPlaceholder").show();
        $(".flyout #versionSelect, .flyout #playButton").hide();
        $("#modal-versions .preloader").show();
        $("#modal-versions .versions-list").hide();
        $("#modal-versions .vp-empty").prop("hidden", true);

        try {
            RxVersionsUI.allVersions = await RxVersionsManager.getPreparedVersions();
            RxVersionsUI.render();

            // Без сети — один раз за запуск объясняем, почему в списке только установленные
            if (RxVersionsManager.lastListOffline && !RxVersionsUI.offlineNoticeShown) {
                RxVersionsUI.offlineNoticeShown = true;
                RxToasts.create(MESSAGES.versions.offlineTitle, "wifi_off", MESSAGES.versions.offlineText, "warning");
            }

            $("#modal-versions .preloader").hide();
            RxVersionsUI.reloadButtonUI();
            if (typeof RxVersionArtwork !== "undefined") RxVersionArtwork.update(RxVersionsManager.getActiveVersion());
            return true;
        } catch (error) {
            console.error("Error loading versions:", error);
            RxAlerts.create("Ошибка!", "Не удалось загрузить список версий", "Понятно", "error");
            return false;
        }
    };

    static isChipActive = (type) => $(`#modal-versions #versionTypeSelect .chip[data-type="${type}"]`).hasClass("active");

    static iconFor = (ver) => {
        if (ver.type === "custom") return "assets/versions/3rdparty.webp";
        if (ver.type !== "pack") return `assets/versions/${ver.type}.webp`;
        try {
            const modpackData = RxPacks.getModpackManifest(ver.id.replace("pack-", ""));
            if (modpackData.icon === "pack") return path.join(GAME_DATA, "modpacks", modpackData.id, "icon.png");
            if (modpackData.icon) return modpackData.icon;
        } catch (_) {}
        return "assets/icon.png";
    };

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    static sortVersions = (list, favorites) => {
        const byNewest = (a, b) => RxVersionsManager.compareGameVersions(b.version, a.version) || a.order - b.order;
        const sorters = {
            newest: byNewest,
            oldest: (a, b) => -byNewest(a, b),
            name: (a, b) => a.displayName.localeCompare(b.displayName, undefined, {numeric: true, sensitivity: "base"}),
            installed: (a, b) => (b.installed - a.installed) || byNewest(a, b),
            favorites: (a, b) => (favorites.includes(b.id) - favorites.includes(a.id)) || byNewest(a, b)
        };
        return list.sort(sorters[RxVersionsUI.sortMode] || byNewest);
    };

    // Нарисовать список с учётом поиска, вкладки, фильтров и сортировки
    static render = () => {
        const $modal = $("#modal-versions");
        const $list = $modal.find(".versions-list");
        const activeVersion = RxVersionsManager.getActiveVersion();
        const favorites = RxVersionsManager.getFavoriteVersions();
        const query = String($modal.find("input.search").val() || "").trim().toLowerCase();
        const onlyFavorites = RxVersionsUI.isChipActive("favorite");
        const onlyInstalled = RxVersionsUI.isChipActive("installed");

        const filtered = RxVersionsUI.allVersions
            .map((ver, order) => ({...ver, order}))
            .filter(ver => (!onlyFavorites || favorites.includes(ver.id))
                && (!onlyInstalled || ver.installed)
                && (!query || `${ver.displayName} ${ver.version}`.toLowerCase().includes(query)));

        // Вкладки загрузчиков с количеством; пустые прячем, кроме «Все» и активной
        const counts = filtered.reduce((acc, ver) => ({...acc, [ver.type]: (acc[ver.type] || 0) + 1}), {});
        if (RxVersionsUI.loaderTab !== "all" && !counts[RxVersionsUI.loaderTab] && !query && !onlyFavorites && !onlyInstalled) {
            RxVersionsUI.loaderTab = "all";
        }
        $modal.find("[data-versions-tabs]").html(RxVersionsUI.LOADER_TABS
            .filter(tab => tab.id === "all" || counts[tab.id] || tab.id === RxVersionsUI.loaderTab)
            .map(tab => `<button type="button" class="vp-tab${tab.id === RxVersionsUI.loaderTab ? " active" : ""}" data-tab="${tab.id}">
                <span>${RxVersionsUI.escape(tab.label())}</span><small>${tab.id === "all" ? filtered.length : (counts[tab.id] || 0)}</small></button>`)
            .join(""));

        const visible = RxVersionsUI.sortVersions(
            filtered.filter(ver => RxVersionsUI.loaderTab === "all" || ver.type === RxVersionsUI.loaderTab),
            favorites
        );

        $list.html(visible.map(ver => {
            const isCustom = ver.type === "custom";
            const title = isCustom || ver.type === "pack" ? ver.displayName : ver.version;
            const subtitle = isCustom
                ? MESSAGES.versions.baseVersion.replace("{0}", ver.version)
                : ver.type === "pack" ? MESSAGES.versions.pack : (RxVersionsUI.TYPE_LABELS[ver.type] || ver.type);
            const badges = [
                ver.installed ? `<span class="vp-badge installed"><span class="material-symbols-outlined">download_done</span>${RxVersionsUI.escape(MESSAGES.versions.installedBadge)}</span>` : "",
                isCustom ? `<span class="vp-badge custom">${RxVersionsUI.escape(MESSAGES.versions.customBadge)}</span>` : ""
            ].join("");
            return `<div class="item${ver.id === activeVersion ? " active" : ""}" data-version="${RxVersionsUI.escape(ver.id)}"
                    data-display="${RxVersionsUI.escape(ver.displayName)}" data-installed="${ver.installed}">
                <img class="icon" src="${RxVersionsUI.escape(RxVersionsUI.iconFor(ver))}" loading="lazy" alt=""/>
                <div class="vp-item-copy">
                    <span class="title">${RxVersionsUI.escape(title)}</span>
                    <span class="vp-item-sub">${RxVersionsUI.escape(subtitle)}</span>
                </div>
                <div class="vp-badges">${badges}</div>
                ${isCustom ? `<span class="vp-delete material-symbols-outlined" title="${RxVersionsUI.escape(MESSAGES.versions.delete)}">delete</span>` : ""}
                <span class="favorite material-symbols-outlined${favorites.includes(ver.id) ? " active" : ""}">star</span>
                <span class="vp-check material-symbols-outlined">check_circle</span>
            </div>`;
        }).join(""));

        $list.toggle(visible.length > 0);
        $modal.find(".vp-empty").prop("hidden", visible.length > 0);
        $modal.find("[data-versions-count]").text(MESSAGES.versions.shown
            .replace("{0}", visible.length)
            .replace("{1}", RxVersionsUI.allVersions.length));
        return visible.length;
    };

    // Перезагрузить кнопку в Flyout (при смене активной версии)
    static reloadButtonUI = () => {
        let $activeVersionItem = $("#modal-versions .versions-list .item.active");
        const activeVersion = RxVersionsManager.getActiveVersion();
        // Активная версия может быть скрыта фильтром — берём её данные из полного списка
        const activeData = RxVersionsUI.allVersions.find(ver => ver.id === activeVersion);
        if ($activeVersionItem.length === 0 && !activeData) {
            $("#versionSelect .title").text(MESSAGES.commons.notSelected);
            $("#versionSelect .icon").hide();
        } else {
            // Проверяем на модпак и на его существование
            if (RxVersionsManager.parseVersionID(activeVersion).type === "pack") {
                if (!RxPacks.isModpackExists(activeVersion.replace("pack-", ""))) {
                    return RxVersionsManager.setActiveVersion("none");
                }
            }
            const displayName = activeData ? activeData.displayName : $activeVersionItem.first().attr("data-display");
            const icon = activeData ? RxVersionsUI.iconFor(activeData) : $activeVersionItem.first().find("img.icon").attr("src");
            $("#versionSelect .title").text(displayName);
            $("#versionSelect .icon").show().attr("src", icon);
        }
        $(".flyout #versionSelectPlaceholder").hide();
        $(".flyout #versionSelect").show();
        $(".flyout #playButton").show();
        return true;
    }

    // Искать по версиям
    static searchByInput = () => RxVersionsUI.render();

    // Сбросить поиск
    static clearSearch = () => {
        $("#modal-versions input.search").val("");
        RxVersionsUI.render();
    }

    // Получить выбранные типы версий
    static getVersionsTypeSelected = () => {
        let selectedList = [];
        $("#modal-versions #versionTypeSelect .chip.active").each(function () {
            selectedList.push($(this).data("type"));
        })
        return selectedList;
    }
}
