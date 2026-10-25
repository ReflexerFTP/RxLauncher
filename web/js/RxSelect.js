// Красивый выпадающий список поверх системного <select>.
// Сам <select> остаётся в DOM (скрытым): .val(), событие change и опции работают как раньше.
class RxSelect {
    static current = null;

    // Свойства, которые кнопка перенимает у <select>, чтобы окно выглядело как прежде
    static BOX_STYLES = ["backgroundColor", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
        "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
        "borderRadius", "paddingLeft", "paddingRight"];
    static TEXT_STYLES = ["fontSize", "fontWeight", "color"];
    static WRAPPER_STYLES = ["flexGrow", "flexShrink", "flexBasis", "maxWidth", "minWidth"];

    static init = () => {
        document.querySelectorAll("select:not([multiple]):not([data-native])").forEach(RxSelect.enhance);
        // Код ставит значение через $(select).val(x) без события change — обновляем подпись и тогда
        const originalSet = $.valHooks.select.set;
        $.valHooks.select.set = function (element, value) {
            const result = originalSet.call(this, element, value);
            RxSelect.refresh(element);
            return result;
        };
        window.addEventListener("resize", () => RxSelect.close());
    };

    static enhance = (select) => {
        if (select.rxSelect) return;
        const computed = getComputedStyle(select);
        const boxed = !/rgba\(0, 0, 0, 0\)|transparent/.test(computed.backgroundColor);

        const wrapper = document.createElement("div");
        wrapper.className = "rx-select";
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "rx-select-trigger";
        trigger.setAttribute("aria-haspopup", "listbox");
        if (select.getAttribute("aria-label")) trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
        trigger.innerHTML = `<span class="rx-select-label"></span><span class="material-symbols-outlined rx-select-chevron">expand_more</span>`;
        wrapper.appendChild(trigger);

        RxSelect.WRAPPER_STYLES.forEach(prop => {
            if (computed[prop] && computed[prop] !== "none" && computed[prop] !== "auto") wrapper.style[prop] = computed[prop];
        });
        if (/px$/.test(computed.width) && select.style.width) wrapper.style.width = computed.width;
        RxSelect.TEXT_STYLES.forEach(prop => trigger.style[prop] = computed[prop]);
        if (boxed) {
            RxSelect.BOX_STYLES.forEach(prop => trigger.style[prop] = computed[prop]);
            if (/px$/.test(computed.height)) wrapper.style.height = computed.height;
            wrapper.classList.add("boxed");
        }
        if (select.classList.contains("flex-grow")) wrapper.style.flexGrow = "1";

        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        select.classList.add("rx-select-native");
        select.rxSelect = {wrapper, trigger};

        trigger.addEventListener("click", (e) => {
            e.stopPropagation();
            RxSelect.current?.select === select ? RxSelect.close() : RxSelect.open(select);
        });
        trigger.addEventListener("keydown", (e) => {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && RxSelect.current?.select !== select) {
                e.preventDefault();
                RxSelect.open(select);
            }
        });
        select.addEventListener("change", () => RxSelect.refresh(select));
        // Опции часто заполняются кодом позже и переводятся — следим за ними
        new MutationObserver(() => RxSelect.refresh(select)).observe(select, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"]});
        RxSelect.refresh(select);
    };

    static refresh = (select) => {
        if (!select?.rxSelect) return;
        const option = select.options[select.selectedIndex];
        select.rxSelect.trigger.querySelector(".rx-select-label").textContent = option ? option.textContent.trim() : "";
        select.rxSelect.trigger.disabled = select.disabled;
    };

    static open = (select) => {
        RxSelect.close();
        const {wrapper, trigger} = select.rxSelect;
        const menu = document.createElement("div");
        menu.className = "rx-select-menu";
        menu.setAttribute("role", "listbox");

        [...select.children].forEach(child => {
            const options = child.tagName === "OPTGROUP" ? [...child.children] : [child];
            if (child.tagName === "OPTGROUP") {
                const group = document.createElement("div");
                group.className = "rx-select-group";
                group.textContent = child.label;
                menu.appendChild(group);
            }
            options.filter(option => option.tagName === "OPTION" && !option.hidden).forEach(option => {
                const item = document.createElement("div");
                item.className = "rx-select-option";
                item.setAttribute("role", "option");
                item.dataset.index = String(option.index);
                item.classList.toggle("selected", option.index === select.selectedIndex);
                item.classList.toggle("disabled", option.disabled);
                item.innerHTML = `<span></span><span class="material-symbols-outlined">check</span>`;
                item.firstChild.textContent = option.textContent.trim();
                menu.appendChild(item);
            });
        });

        menu.addEventListener("mousedown", (e) => e.preventDefault());
        menu.addEventListener("click", (e) => {
            e.stopPropagation();
            const item = e.target.closest(".rx-select-option");
            if (item && !item.classList.contains("disabled")) RxSelect.choose(select, Number(item.dataset.index));
        });

        document.body.appendChild(menu);
        wrapper.classList.add("open");
        RxSelect.current = {select, menu, focused: select.selectedIndex};
        RxSelect.position();
        menu.querySelector(".selected")?.scrollIntoView({block: "nearest"});

        RxSelect.onOutside = (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) RxSelect.close(); };
        RxSelect.onKey = (e) => RxSelect.handleKey(e);
        RxSelect.onScroll = (e) => { if (!menu.contains(e.target)) RxSelect.position(); };
        document.addEventListener("mousedown", RxSelect.onOutside, true);
        window.addEventListener("keydown", RxSelect.onKey, true);
        document.addEventListener("scroll", RxSelect.onScroll, true);
    };

    static position = () => {
        const state = RxSelect.current;
        if (!state) return;
        const rect = state.select.rxSelect.trigger.getBoundingClientRect();
        // Кнопка уехала из вида (окно закрыли или прокрутили) — закрываем меню
        if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) return RxSelect.close();
        const menu = state.menu;
        const width = Math.max(rect.width, 180);
        menu.style.minWidth = `${width}px`;
        menu.style.maxHeight = "";
        const height = Math.min(menu.scrollHeight, 320);
        const below = window.innerHeight - rect.bottom - 10;
        const openUp = below < height && rect.top > below;
        menu.style.maxHeight = `${Math.max(120, Math.min(320, (openUp ? rect.top : below) - 6))}px`;
        menu.style.top = openUp ? "" : `${rect.bottom + 6}px`;
        menu.style.bottom = openUp ? `${window.innerHeight - rect.top + 6}px` : "";
        const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 10);
        menu.style.left = `${Math.max(10, left)}px`;
    };

    static handleKey = (e) => {
        const state = RxSelect.current;
        if (!state) return;
        const items = [...state.menu.querySelectorAll(".rx-select-option:not(.disabled)")];
        let position = items.findIndex(item => Number(item.dataset.index) === state.focused);
        if (e.key === "Escape" || e.key === "Tab") {
            e.stopPropagation(); // Esc закрывает только список, а не окно под ним
            if (e.key === "Escape") e.preventDefault();
            return RxSelect.close(true);
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            position = Math.max(0, Math.min(items.length - 1, position + (e.key === "ArrowDown" ? 1 : -1)));
            state.focused = Number(items[position]?.dataset.index);
            items.forEach(item => item.classList.toggle("focused", Number(item.dataset.index) === state.focused));
            items[position]?.scrollIntoView({block: "nearest"});
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            if (state.focused >= 0) RxSelect.choose(state.select, state.focused);
        }
    };

    static choose = (select, index) => {
        const changed = select.selectedIndex !== index;
        select.selectedIndex = index;
        RxSelect.close(true);
        RxSelect.refresh(select);
        if (changed) select.dispatchEvent(new Event("change", {bubbles: true}));
    };

    static close = (focusTrigger = false) => {
        const state = RxSelect.current;
        if (!state) return;
        state.menu.remove();
        state.select.rxSelect.wrapper.classList.remove("open");
        RxSelect.current = null;
        document.removeEventListener("mousedown", RxSelect.onOutside, true);
        window.removeEventListener("keydown", RxSelect.onKey, true);
        document.removeEventListener("scroll", RxSelect.onScroll, true);
        if (focusTrigger) state.select.rxSelect.trigger.focus({preventScroll: true});
    };
}

// После загрузки стилей: кнопка перенимает уже применённое оформление <select>
$(window).on("load", RxSelect.init);
