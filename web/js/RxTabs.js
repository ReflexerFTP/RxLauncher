// Какие вкладки показывать в боковом меню. Главная и Настройки есть всегда.
// По умолчанию включены Главная, Настройки, Статистика и Консоль; остальное пользователь включает сам
// (в настройках или прямо в установщике — тот оставляет installer-tabs.json рядом с config.json).
class RxTabs {
    static ALL = ["content", "settings", "catalog", "instances", "mods", "skins", "servers", "statistics", "together", "screenshots", "console"];
    static LOCKED = ["content", "settings"];
    static DEFAULT = ["content", "settings", "catalog", "statistics", "together", "console"];
    // Вкладки, о которых установщик не знает: его выбор их не выключает
    static INSTALLER_TABS = ["content", "settings", "instances", "mods", "skins", "servers", "statistics", "screenshots", "console"];
    // Новые разделы 3.0 один раз включаются и у тех, кто настроил меню раньше
    static ADDED_IN_3 = ["catalog", "together"];
    static CONFIG_KEY = "enabledTabs";

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

    // В рейле — главная, настройки и не больше MAX_RAIL вкладок по приоритету; остальные включённые — в панели «Ещё»,
    // чтобы меню не превращалось в длинный столбик одинаковых значков
    static MAX_RAIL = 4;
    static PRIORITY = ["catalog", "instances", "together", "mods", "servers", "statistics", "skins", "screenshots", "console"];

    static layout = (enabled = RxTabs.getEnabled()) => {
        const optional = RxTabs.PRIORITY.filter(tab => enabled.includes(tab));
        // Одну вкладку в «Ещё» прятать незачем — её значок займёт то же место, что и кнопка «Ещё»
        const railCount = optional.length <= RxTabs.MAX_RAIL + 1 ? optional.length : RxTabs.MAX_RAIL;
        return {rail: optional.slice(0, railCount), more: optional.slice(railCount)};
    };

    // Спрятать выключенные вкладки; если открыта выключенная — вернуться на главную
    static apply = () => {
        const enabled = RxTabs.getEnabled();
        const {more} = RxTabs.layout(enabled);
        RxTabs.moreTabs = more;
        document.querySelectorAll(".flymenu .item[data-modal]").forEach(item => {
            const tab = item.dataset.modal;
            // hidden не подходит: у пунктов меню в CSS свой display
            item.style.display = RxTabs.ALL.includes(tab) && (!enabled.includes(tab) || more.includes(tab)) ? "none" : "";
        });
        const moreButton = document.querySelector("[data-flymenu-more-button]");
        if (moreButton) moreButton.style.display = more.length ? "" : "none";
        RxTabs.closeMore();
        RxTabs.markMore();
        try {
            const current = RxModals.currentModalName();
            if (current && !RxTabs.isEnabled(current) && current !== "content") RxModals.switchModal("content");
        } catch (_) {}
        RxTabs.renderSettings();
    };

    // ---------- панель «Ещё» ----------
    static moreTabs = [];

    static markMore = (current = null) => {
        const button = document.querySelector("[data-flymenu-more-button]");
        if (!button) return;
        try { current = current || RxModals.currentModalName(); } catch (_) {}
        const inside = RxTabs.moreTabs.includes(current);
        button.classList.toggle("active", inside);
        // Открыта вкладка из «Ещё» — на кнопке её значок, чтобы было видно, где вы
        const icon = inside && document.querySelector(`.flymenu .item[data-modal="${current}"] .material-symbols-outlined`);
        button.querySelector(".material-symbols-outlined").textContent = icon ? icon.textContent : "apps";
    };

    static openMore = () => {
        const $panel = $("[data-flymenu-more]");
        const button = document.querySelector("[data-flymenu-more-button]");
        let current = "";
        try { current = RxModals.currentModalName(); } catch (_) {}
        $panel.find("[data-flymenu-more-grid]").html(RxTabs.moreTabs.map(tab => {
            const item = document.querySelector(`.flymenu .item[data-modal="${tab}"]`);
            const icon = item?.querySelector(".material-symbols-outlined")?.textContent || "tab";
            // В атрибуте data-text ключ перевода {{…}} — подставляем текст сами
            const name = String(item?.dataset.text || tab).replace(/\{\{([\w.-]+)\}\}/g, (match, key) => key.split(".").reduce((node, part) => node?.[part], MESSAGES) ?? match);
            return `<button type="button" class="${tab === current ? "active" : ""}" data-more-modal="${tab}">
                <span class="material-symbols-outlined">${icon}</span><span>${$("<i>").text(name).html()}</span>
            </button>`;
        }).join(""));
        const rect = button.getBoundingClientRect();
        $panel.prop("hidden", false);
        const height = $panel.outerHeight();
        $panel.css({left: rect.right + 12, top: Math.max(12, Math.min(rect.top - 10, window.innerHeight - height - 12))});
        button.classList.add("open");
        RxFlyout.hideTooltip();
    };

    static closeMore = () => {
        $("[data-flymenu-more]").prop("hidden", true);
        document.querySelector("[data-flymenu-more-button]")?.classList.remove("open");
    };

    // Плитки в настройках «Оформление»
    static renderSettings = () => {
        const $grid = $("#tabs-toggle-grid");
        if (!$grid.length) return;
        const enabled = RxTabs.getEnabled();
        const icons = {
            content: "home", settings: "settings", catalog: "travel_explore", instances: "stacks", mods: "extension", skins: "accessibility_new",
            servers: "dns", statistics: "monitoring", together: "group", screenshots: "photo_library", console: "terminal"
        };
        $grid.html(RxTabs.ALL.map(tab => {
            const locked = RxTabs.LOCKED.includes(tab);
            const on = enabled.includes(tab);
            const title = MESSAGES?.settings?.personalization?.tabs?.names?.[tab] || tab;
            return `<button type="button" class="tab-toggle${on ? " on" : ""}${locked ? " locked" : ""}" data-tab-toggle="${tab}"${locked ? " disabled" : ""}>
                <span class="material-symbols-outlined">${icons[tab]}</span>
                <span class="tab-toggle-name">${title}</span>
                <span class="material-symbols-outlined tab-toggle-state">${locked ? "lock" : (on ? "check_circle" : "radio_button_unchecked")}</span>
            </button>`;
        }).join(""));
    };

    static migrate = () => {
        if (RxConfig.read("tabsMigrated3", false) === true) return;
        if (RxConfig.isKeyExists(RxTabs.CONFIG_KEY)) {
            RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize([...RxTabs.getEnabled(), ...RxTabs.ADDED_IN_3]));
        }
        RxConfig.write("tabsMigrated3", true);
    };

    static init = () => {
        RxTabs.migrate();
        RxTabs.applyInstallerChoice();
        $(document).on("click", "[data-tab-toggle]", function () {
            const tab = $(this).attr("data-tab-toggle");
            RxTabs.setEnabled(tab, !RxTabs.getEnabled().includes(tab));
        });
        $(document).on("showModalEvent", (event) => {
            const modal = event.originalEvent?.detail?.modal;
            if (modal === "settings") RxTabs.renderSettings();
            if (RxTabs.ALL.includes(modal)) RxTabs.markMore(modal);
        });
        $(document).on("click", "[data-flymenu-more-button]", (event) => {
            event.stopPropagation();
            $("[data-flymenu-more]").prop("hidden") ? RxTabs.openMore() : RxTabs.closeMore();
        });
        $(document).on("keydown", "[data-flymenu-more-button]", (event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); RxTabs.openMore(); }
        });
        $(document).on("click", "[data-more-modal]", async function () {
            const tab = $(this).attr("data-more-modal");
            RxTabs.closeMore();
            if (RxModals.currentModalName() !== tab) await RxModals.switchModal(tab);
        });
        $(document).on("click", "[data-flymenu-customize]", async () => {
            RxTabs.closeMore();
            await RxModals.switchModal("settings");
            $('#modal-settings .tabs [data-tab="personalization"]').trigger("click");
            setTimeout(() => RxUtils.scrollWithin(document.getElementById("tabs-toggle-grid")), 250);
        });
        $(document).on("mousedown", (event) => {
            if (!$(event.target).closest("[data-flymenu-more], [data-flymenu-more-button]").length) RxTabs.closeMore();
        });
        $(document).on("keydown", (event) => { if (event.key === "Escape") RxTabs.closeMore(); });
        $(window).on("resize blur", RxTabs.closeMore);
        RxTabs.apply();
    };
}

$(RxTabs.init);
