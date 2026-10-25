// Какие вкладки показывать в боковом меню. Главная и Настройки есть всегда.
// По умолчанию включены Главная, Настройки, Статистика и Консоль; остальное пользователь включает сам
// (в настройках или прямо в установщике — тот оставляет installer-tabs.json рядом с config.json).
class RxTabs {
    static ALL = ["content", "settings", "instances", "mods", "skins", "servers", "statistics", "screenshots", "console"];
    static LOCKED = ["content", "settings"];
    static DEFAULT = ["content", "settings", "statistics", "console"];
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
            if (Array.isArray(choice?.enabledTabs)) RxConfig.write(RxTabs.CONFIG_KEY, RxTabs.normalize(choice.enabledTabs));
            return true;
        } catch (_) {
            return false;
        } finally {
            try { fs.unlinkSync(file); } catch (_) {}
        }
    };

    // Спрятать выключенные вкладки; если открыта выключенная — вернуться на главную
    static apply = () => {
        const enabled = RxTabs.getEnabled();
        document.querySelectorAll(".flymenu .item[data-modal]").forEach(item => {
            // hidden не подходит: у пунктов меню в CSS свой display
            item.style.display = !enabled.includes(item.dataset.modal) && RxTabs.ALL.includes(item.dataset.modal) ? "none" : "";
        });
        try {
            const current = RxModals.currentModalName();
            if (current && !RxTabs.isEnabled(current) && current !== "content") RxModals.switchModal("content");
        } catch (_) {}
        RxTabs.renderSettings();
    };

    // Плитки в настройках «Оформление»
    static renderSettings = () => {
        const $grid = $("#tabs-toggle-grid");
        if (!$grid.length) return;
        const enabled = RxTabs.getEnabled();
        const icons = {
            content: "home", settings: "settings", instances: "stacks", mods: "extension", skins: "accessibility_new",
            servers: "dns", statistics: "monitoring", screenshots: "photo_library", console: "terminal"
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

    static init = () => {
        RxTabs.applyInstallerChoice();
        $(document).on("click", "[data-tab-toggle]", function () {
            const tab = $(this).attr("data-tab-toggle");
            RxTabs.setEnabled(tab, !RxTabs.getEnabled().includes(tab));
        });
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "settings") RxTabs.renderSettings();
        });
        RxTabs.apply();
    };
}

$(RxTabs.init);
