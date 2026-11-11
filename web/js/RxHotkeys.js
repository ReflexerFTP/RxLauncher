// Горячие клавиши лаунчера:
//   Ctrl+1…9 — разделы бокового меню по порядку, Ctrl+, — настройки,
//   Ctrl+F — поиск в открытом окне (если поиска нет — каталог), Ctrl+Enter — «Играть»
class RxHotkeys {
    static SEARCH = "[data-catalog-search], [data-mods-search], [data-console-search], input.search, .pp-search input, .rxad-search input";

    static visible = (element) => Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";

    // Пока открыт диалог или меню занято переключением раздела, клавиши не срабатывают
    static blocked = () => Boolean(RxDialog.current) || $(".flymenu").css("pointer-events") === "none" || $(".loading-screen").is(":visible");

    static openSection = (modalName) => {
        const item = [...document.querySelectorAll(`.flymenu .item[data-modal="${modalName}"]`)].find(RxHotkeys.visible);
        if (!item) return false;
        if (RxModals.shownOverlays().length) RxModals.hideCurrentOverlay();
        item.click();
        return true;
    };

    static sectionByNumber = (number) => {
        const items = [...document.querySelectorAll(".flymenu .item[data-modal]")]
            .filter(item => RxHotkeys.visible(item) && item.dataset.modal !== "settings");
        return items[number - 1] ? RxHotkeys.openSection(items[number - 1].dataset.modal) : false;
    };

    // Поле поиска: сначала в окне поверх остальных, затем в открытом разделе
    static focusSearch = async () => {
        const find = () => {
            const scopes = [...RxModals.shownOverlays().toArray().reverse(), ...document.querySelectorAll(".modal:not(.overlay)")];
            for (const scope of scopes) {
                const input = [...scope.querySelectorAll(RxHotkeys.SEARCH)].find(RxHotkeys.visible);
                if (input) return input;
            }
            return null;
        };
        let input = find();
        if (!input && RxHotkeys.openSection("catalog")) {
            await new Promise(resolve => setTimeout(resolve, 450));
            input = find();
        }
        if (!input) return false;
        input.focus();
        input.select();
        return true;
    };

    static play = () => {
        const button = document.getElementById("playButton");
        if (!RxHotkeys.visible(button) || button.disabled) return false;
        button.click();
        return true;
    };

    static onKey = (event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat || RxHotkeys.blocked()) return;
        let handled = false;
        if (/^Digit[1-9]$/.test(event.code)) handled = RxHotkeys.sectionByNumber(Number(event.code.slice(5)));
        else if (event.code === "Comma") handled = RxHotkeys.openSection("settings");
        else if (event.code === "KeyF") handled = Boolean(RxHotkeys.focusSearch());
        else if (event.code === "Enter" || event.code === "NumpadEnter") handled = RxHotkeys.play();
        if (handled) event.preventDefault();
    };

    static init = () => window.addEventListener("keydown", RxHotkeys.onKey);
}
