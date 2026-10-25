// Небольшие диалоги поверх лаунчера: подтверждение, выбор из списка, ввод текста.
// Возвращают Promise, поэтому ими удобно пользоваться внутри async-кода
class RxDialog {
    static current = null;

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    // options: {icon, title, text, items: [{icon, title, text, level}], choices: [{value, icon, image, title, text}],
    //           input: {placeholder, multiline, value}, buttons: [{id, text, icon, primary, danger}]}
    // Результат: {button, value, input}; button === null — окно закрыли
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
        const input = options.input
            ? (options.input.multiline
                ? `<textarea class="rx-dialog-input" rows="4" spellcheck="false" placeholder="${esc(options.input.placeholder || "")}">${esc(options.input.value || "")}</textarea>`
                : `<input class="rx-dialog-input" type="text" spellcheck="false" placeholder="${esc(options.input.placeholder || "")}" value="${esc(options.input.value || "")}"/>`)
            : "";
        const buttons = (options.buttons || [{id: "ok", text: MESSAGES.commons?.close || "OK", primary: true}]).map(button => `<button type="button"
            class="${button.primary ? "" : "transparent"}${button.danger ? " rx-dialog-danger" : ""}" data-dialog-button="${esc(button.id)}">
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
                ${input}
                <div class="rx-dialog-actions">${buttons}</div>
            </div>
        </div>`);

        const finish = (button, value = null) => {
            if (RxDialog.current?.root !== $root) return;
            window.removeEventListener("keydown", onKey, true);
            RxDialog.current = null;
            const text = String($root.find(".rx-dialog-input").val() ?? "");
            $root.addClass("leaving");
            setTimeout(() => $root.remove(), 160);
            resolve({button, value, input: text});
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
        $root.on("click", "[data-dialog-button]", function () { finish($(this).attr("data-dialog-button")); });
        $root.on("click", "[data-choice]", function () {
            const choice = options.choices[Number($(this).attr("data-choice"))];
            finish("choice", choice?.value ?? null);
        });
        window.addEventListener("keydown", onKey, true);
        RxDialog.current = {root: $root, finish};
        $("body").append($root);
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
