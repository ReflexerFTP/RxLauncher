// Небольшие диалоги поверх лаунчера: подтверждение, выбор из списка, ввод текста.
// Возвращают Promise, поэтому ими удобно пользоваться внутри async-кода
class RxDialog {
    static current = null;

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    // options: {icon, title, text, items: [{icon, title, text, level}], choices: [{value, icon, image, title, text}],
    //           checks: [{id, icon, title, text, checked, disabled, separated}],
    //           input: {placeholder, multiline, value}, buttons: [{id, text, icon, primary, danger}]}
    // Результат: {button, value, input, checks: {id: true/false}}; button === null — окно закрыли
    static open = (options = {}) => new Promise((resolve) => {
        RxDialog.close(null);
        const esc = RxDialog.escape;
        const items = (options.items || []).map(item => `<li class="rx-dialog-item ${esc(item.level || "")}">
            <span class="material-symbols-outlined">${esc(item.icon || "info")}</span>
            <div><b>${esc(item.title)}</b>${item.text ? `<span>${esc(item.text)}</span>` : ""}</div>
        </li>`).join("");
        const choices = (options.choices || []).map((choice, index) => `<button type="button" class="rx-dialog-choice" data-choice="${index}">
            ${choice.image ? `<img src="${esc(choice.image)}" alt=""/>` : `<span class="material-symbols-outlined">${esc(choice.icon || "radio_button_unchecked")}</span>`}
            <div><b>${esc(choice.title)}</b>${choice.text ? `<span>${esc(choice.text)}</span>` : ""}</div>
        </button>`).join("");
        // separated — отдельные галочки под списком, они не уезжают при прокрутке
        const checkHtml = check => `<label class="rx-dialog-check${check.disabled ? " disabled" : ""}">
            <span class="material-symbols-outlined">${esc(check.icon || "check_box")}</span>
            <div><b>${esc(check.title)}</b>${check.text ? `<span>${esc(check.text)}</span>` : ""}</div>
            <span class="switch"><input type="checkbox" data-check="${esc(check.id)}"${check.checked && !check.disabled ? " checked" : ""}${check.disabled ? " disabled" : ""}><span class="inner"></span></span>
        </label>`;
        const checks = (options.checks || []).filter(check => !check.separated).map(checkHtml).join("");
        const pinnedChecks = (options.checks || []).filter(check => check.separated).map(checkHtml).join("");
        const input = options.input
            ? (options.input.multiline
                ? `<textarea class="rx-dialog-input" rows="4" spellcheck="false" placeholder="${esc(options.input.placeholder || "")}">${esc(options.input.value || "")}</textarea>`
                : `<input class="rx-dialog-input" type="text" spellcheck="false" placeholder="${esc(options.input.placeholder || "")}" value="${esc(options.input.value || "")}"/>`)
            : "";
        const buttons = (options.buttons || [{id: "ok", text: MESSAGES.commons?.close || "OK", primary: true}]).map(button => `<button type="button"
            class="${button.primary ? "" : "transparent"}${button.danger ? " rx-dialog-danger" : ""}" data-dialog-button="${esc(button.id)}"${button.requiresCheck ? " data-requires-check" : ""}>
            ${button.icon ? `<span class="material-symbols-outlined">${esc(button.icon)}</span>` : ""}<span>${esc(button.text)}</span>
        </button>`).join("");

        const $root = $(`<div class="rx-dialog-backdrop">
            <div class="rx-dialog" role="dialog" aria-modal="true">
                <div class="rx-dialog-head">
                    ${options.icon ? `<span class="rx-dialog-icon material-symbols-outlined">${esc(options.icon)}</span>` : ""}
                    <div class="rx-dialog-copy">
                        <h2>${esc(options.title)}</h2>
                        ${options.text ? `<p>${esc(options.text)}</p>` : ""}
                    </div>
                </div>
                ${items ? `<ul class="rx-dialog-items">${items}</ul>` : ""}
                ${choices ? `<div class="rx-dialog-choices">${choices}</div>` : ""}
                ${checks ? `<div class="rx-dialog-checks">${checks}</div>` : ""}
                ${pinnedChecks ? `<div class="rx-dialog-checks pinned">${pinnedChecks}</div>` : ""}
                ${input}
                <div class="rx-dialog-actions">${buttons}</div>
            </div>
        </div>`);

        const finish = (button, value = null) => {
            if (RxDialog.current?.root !== $root) return;
            window.removeEventListener("keydown", onKey, true);
            RxDialog.current = null;
            const text = String($root.find(".rx-dialog-input").val() ?? "");
            const checked = {};
            $root.find("[data-check]").each(function () { checked[$(this).attr("data-check")] = $(this).is(":checked"); });
            $root.addClass("leaving");
            setTimeout(() => $root.remove(), 160);
            resolve({button, value, input: text, checks: checked});
        };
        const onKey = (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                finish(null);
            } else if (event.key === "Enter" && !event.shiftKey && !$(event.target).is("textarea")) {
                const primary = (options.buttons || []).find(button => button.primary);
                if (primary && !choices) {
                    event.preventDefault();
                    finish(primary.id);
                }
            }
        };

        $root.on("click", (event) => { if (event.target === event.currentTarget) finish(null); });
        // Кнопку «готово» можно выключить, пока ни одна галочка не выбрана
        const syncRequired = () => $root.find("[data-dialog-button][data-requires-check]")
            .prop("disabled", !$root.find("[data-check]:checked:not([data-check-optional])").length);
        $root.on("change", "[data-check]", syncRequired);
        $root.on("click", "[data-dialog-button]", function () { finish($(this).attr("data-dialog-button")); });
        $root.on("click", "[data-choice]", function () {
            const choice = options.choices[Number($(this).attr("data-choice"))];
            finish("choice", choice?.value ?? null);
        });
        window.addEventListener("keydown", onKey, true);
        RxDialog.current = {root: $root, finish};
        $("body").append($root);
        (options.checks || []).filter(check => check.optional).forEach(check => $root.find(`[data-check="${CSS.escape(String(check.id))}"]`).attr("data-check-optional", ""));
        syncRequired();
        setTimeout(() => ($root.find(".rx-dialog-input")[0] || $root.find("[data-dialog-button]").last()[0])?.focus(), 30);
    });

    static close = (button = null) => RxDialog.current?.finish(button);

    // true — пользователь согласился
    static confirm = async ({icon = "help", title, text = "", items = [], confirmText, cancelText, danger = false, extraButton = null}) => {
        const buttons = [{id: "cancel", text: cancelText || MESSAGES.dialog.cancel}];
        if (extraButton) buttons.push({...extraButton, id: "extra"});
        buttons.push({id: "ok", text: confirmText || MESSAGES.dialog.ok, primary: true, danger});
        const result = await RxDialog.open({icon, title, text, items, buttons});
        return result.button === "extra" ? "extra" : result.button === "ok";
    };

    // Значение выбранного варианта или null
    static choose = async ({icon = "list", title, text = "", choices = []}) => {
        const result = await RxDialog.open({icon, title, text, choices, buttons: [{id: "cancel", text: MESSAGES.dialog.cancel}]});
        return result.button === "choice" ? result.value : null;
    };

    // Введённый текст или null
    static prompt = async ({icon = "edit", title, text = "", placeholder = "", value = "", multiline = false, confirmText}) => {
        const result = await RxDialog.open({
            icon, title, text, input: {placeholder, value, multiline},
            buttons: [{id: "cancel", text: MESSAGES.dialog.cancel}, {id: "ok", text: confirmText || MESSAGES.dialog.ok, primary: true}]
        });
        return result.button === "ok" ? result.input.trim() : null;
    };
}
