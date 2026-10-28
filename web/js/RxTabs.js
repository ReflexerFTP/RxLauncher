// Какие вкладки показывать в боковом меню. Главная и Настройки есть всегда.
// По умолчанию включены Главная, Настройки, Каталог, Друзья, Статистика и Консоль; остальное пользователь включает сам
// (в настройках или прямо в установщике — тот оставляет installer-tabs.json рядом с config.json).
// Меню сгруппировано и разворачивается: свёрнуто — значки, развёрнуто — значки с подписями (sidebarExpanded).
class RxTabs {
    static ALL = ["content", "settings", "catalog", "instances", "mods", "friends", "skins", "servers", "statistics", "together", "screenshots", "console"];
    static LOCKED = ["content", "settings"];
    static DEFAULT = ["content", "settings", "catalog", "friends", "statistics", "together", "console"];
    // Вкладки, о которых установщик не знает: его выбор их не выключает
    static INSTALLER_TABS = ["content", "settings", "instances", "mods", "skins", "servers", "statistics", "screenshots", "console"];
    // Новые разделы один раз включаются и у тех, кто настроил меню раньше
    static ADDED_IN_3 = ["catalog", "together"];
    static ADDED_IN_3_9 = ["friends"];
    static CONFIG_KEY = "enabledTabs";
    static EXPANDED_KEY = "sidebarExpanded";
    static ICONS = {
        content: "home", settings: "settings", catalog: "travel_explore", instances: "stacks", mods: "extension", friends: "diversity_3",
        skins: "accessibility_new", servers: "dns", statistics: "monitoring", together: "group", screenshots: "photo_library", console: "terminal"
    };

    static normalize = (list) => {
        const valid = Array.isArray(list) ? list.filter(tab => RxTabs.ALL.includes(tab)) : RxTabs.DEFAULT;
        return RxTabs.ALL.filter(tab => RxTabs.LOCKED.includes(tab) || valid.includes(tab));
    };

    static getEnabled = () => RxTabs.normalize(RxConfig.read(RxTabs.CONFIG_KEY, RxTabs.DEFAULT));

    static isEnabled = (tab) => !RxTabs.ALL.includes(tab) || RxTabs.getEnabled().includes(tab);

    static setEnabled = (tab, enabled) => {
        if (RxTabs.LOCKED.includes(tab) || !RxTabs.ALL.includes(tab)) return false;
        const current = new Set(RxTabs.getEnabled());
        enabled ? current.add(tab) : current.delete(tab);
        RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize([...current]));
        RxTabs.apply();
        return true;
    };

    // Выбор из установщика переносим в настройки один раз и удаляем файл
    static applyInstallerChoice = () => {
        const file = path.join(path.dirname(CONFIG_PATH), "installer-tabs.json");
        try {
            if (!fs.existsSync(file)) return false;
            const choice = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
            if (Array.isArray(choice?.enabledTabs)) {
                const keep = RxTabs.getEnabled().filter(tab => !RxTabs.INSTALLER_TABS.includes(tab));
                RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize([...choice.enabledTabs, ...keep]));
            }
            return true;
        } catch (_) {
            return false;
        } finally {
            try { fs.unlinkSync(file); } catch (_) {}
        }
    };

    // Спрятать выключенные вкладки и пустые группы; если открыта выключенная — вернуться на главную
    static apply = () => {
        const enabled = RxTabs.getEnabled();
        document.querySelectorAll(".flymenu .item[data-modal]").forEach(item => {
            // hidden не подходит: у пунктов меню в CSS свой display
            item.style.display = RxTabs.ALL.includes(item.dataset.modal) && !enabled.includes(item.dataset.modal) ? "none" : "";
        });
        document.querySelectorAll(".flymenu [data-flymenu-group]").forEach(group => {
            let next = group.nextElementSibling;
            let visible = false;
            while (next && !next.matches("[data-flymenu-group]")) {
                if (next.matches(".item") && next.style.display !== "none") visible = true;
                next = next.nextElementSibling;
            }
            group.hidden = !visible;
        });
        try {
            const current = RxModals.currentModalName();
            if (current && !RxTabs.isEnabled(current) && current !== "content") RxModals.switchModal("content");
        } catch (_) {}
        RxTabs.renderSettings();
    };

    // ---------- развёрнутое меню ----------
    static isExpanded = () => RxConfig.read(RxTabs.EXPANDED_KEY, false) === true;

    static setExpanded = (expanded) => {
        RxConfig.write(RxTabs.EXPANDED_KEY, expanded);
        RxTabs.applyExpanded();
    };

    static applyExpanded = () => {
        const expanded = RxTabs.isExpanded();
        $(".flymenu").toggleClass("expanded", expanded);
        const $toggle = $("[data-flymenu-toggle]");
        $toggle.attr("data-text", expanded ? MESSAGES.flymenu.collapse : MESSAGES.flymenu.expand);
        RxFlyout.hideTooltip();
    };

    // Плитки в настройках «Оформление»
    static renderSettings = () => {
        const $grid = $("#tabs-toggle-grid");
        if (!$grid.length) return;
        const enabled = RxTabs.getEnabled();
        $grid.html(RxTabs.ALL.map(tab => {
            const locked = RxTabs.LOCKED.includes(tab);
            const on = enabled.includes(tab);
            const title = MESSAGES?.settings?.personalization?.tabs?.names?.[tab] || tab;
            return `<button type="button" class="tab-toggle${on ? " on" : ""}${locked ? " locked" : ""}" data-tab-toggle="${tab}"${locked ? " disabled" : ""}>
                <span class="material-symbols-outlined">${RxTabs.ICONS[tab]}</span>
                <span class="tab-toggle-name">${title}</span>
                <span class="material-symbols-outlined tab-toggle-state">${locked ? "lock" : (on ? "check_circle" : "radio_button_unchecked")}</span>
            </button>`;
        }).join(""));
    };

    static migrate = () => {
        if (RxConfig.read("tabsMigrated3", false) !== true) {
            if (RxConfig.isKeyExists(RxTabs.CONFIG_KEY)) {
                RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize([...RxTabs.getEnabled(), ...RxTabs.ADDED_IN_3]));
            }
            RxConfig.write("tabsMigrated3", true);
        }
        if (RxConfig.read("tabsMigrated39", false) !== true) {
            if (RxConfig.isKeyExists(RxTabs.CONFIG_KEY)) {
                RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize([...RxTabs.getEnabled(), ...RxTabs.ADDED_IN_3_9]));
            }
            RxConfig.write("tabsMigrated39", true);
        }
    };

    static init = () => {
        RxTabs.migrate();
        RxTabs.applyInstallerChoice();
        $(document).on("click", "[data-tab-toggle]", function () {
            const tab = $(this).attr("data-tab-toggle");
            RxTabs.setEnabled(tab, !RxTabs.getEnabled().includes(tab));
        });
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "settings") RxTabs.renderSettings();
        });
        $(document).on("click", "[data-flymenu-toggle]", () => RxTabs.setExpanded(!RxTabs.isExpanded()));
        RxTabs.apply();
        RxTabs.applyExpanded();
    };
}

$(RxTabs.init);
