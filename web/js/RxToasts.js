// Уведомления: стопка в правом нижнем углу, тип по цвету, таймер с паузой при наведении.
// create(text, icon, description, options) — options: число (длительность), строка (тип)
// или объект {type, duration, onClick, action: {label, onClick}}.
class RxToasts {
    static MAX_VISIBLE = 4;
    static DEFAULT_DURATION = 5000;
    static counter = 0;

    static ICON_TYPES = {
        error: ["error", "report", "cancel", "dangerous", "block", "heart_broken"],
        warning: ["warning", "person_alert", "lock", "priority_high"],
        success: ["check", "check_circle", "done", "task_alt", "person", "extension", "archive", "content_copy", "edit"]
    };

    static detectType = (icon) => Object.entries(RxToasts.ICON_TYPES).find(([, icons]) => icons.includes(icon))?.[0] || "info";

    static normalizeOptions = (options) => {
        if (typeof options === "number") return {duration: options};
        if (typeof options === "string") return {type: options};
        return options && typeof options === "object" ? options : {};
    };

    static create(text, icon = "info", description = "", options = {}) {
        const opts = RxToasts.normalizeOptions(options);
        const type = opts.type || RxToasts.detectType(icon);
        const duration = Number.isFinite(opts.duration) ? opts.duration : RxToasts.DEFAULT_DURATION;
        const $pool = $("#toasts-pool");

        // Одинаковое уведомление подряд — не плодим копии, а показываем счётчик
        const key = `${text}|${description}`;
        const $same = $pool.children(".toast").filter((_, node) => node.dataset.key === key).last();
        if ($same.length) {
            const count = Number($same.attr("data-count") || 1) + 1;
            $same.attr("data-count", count).find(".toast-count").text(`×${count}`).prop("hidden", false);
            RxToasts.restartTimer($same, duration);
            return $same;
        }

        const id = `toast-${++RxToasts.counter}`;
        const $toast = $("<div>").addClass(`toast toast-${type}`).attr({id, role: "status", "data-key": key});
        $toast.append($("<div>").addClass("toast-icon").append($("<span>").addClass("material-symbols-outlined").text(icon || "info")));
        const $copy = $("<div>").addClass("toast-copy")
            .append($("<div>").addClass("toast-title")
                .append($("<span>").text(String(text ?? "")), $("<span>").addClass("toast-count").prop("hidden", true)));
        if (description !== "" && description !== null && description !== undefined) {
            $copy.append($("<div>").addClass("toast-description").text(String(description)));
        }
        if (opts.action?.label) {
            $copy.append($("<button>").addClass("toast-action").text(opts.action.label).on("click", (event) => {
                event.stopPropagation();
                opts.action.onClick?.();
                RxToasts.dismiss($toast);
            }));
        }
        $toast.append($copy);
        $toast.append($("<button>").addClass("toast-close").attr("title", MESSAGES?.commons?.close || "Close")
            .append($("<span>").addClass("material-symbols-outlined").text("close"))
            .on("click", (event) => {
                event.stopPropagation();
                RxToasts.dismiss($toast);
            }));
        if (duration > 0) $toast.append($("<div>").addClass("toast-progress"));

        $toast.on("click", () => {
            opts.onClick?.();
            RxToasts.dismiss($toast);
        });
        $toast.on("mouseenter", () => $toast.addClass("paused"));
        $toast.on("mouseleave", () => $toast.removeClass("paused"));

        $pool.append($toast);
        // Не больше MAX_VISIBLE: самые старые уходят первыми
        const $all = $pool.children(".toast:not(.leaving)");
        if ($all.length > RxToasts.MAX_VISIBLE) RxToasts.dismiss($all.first());
        RxToasts.restartTimer($toast, duration);
        return $toast;
    }

    // Таймер реализован через анимацию полоски: пауза при наведении останавливает и таймер
    static restartTimer = ($toast, duration) => {
        const $progress = $toast.find(".toast-progress");
        if (!$progress.length || duration <= 0) return;
        const bar = $progress[0];
        bar.style.setProperty("--toast-duration", `${duration}ms`);
        bar.style.animation = "none";
        void bar.offsetWidth;
        bar.style.animation = "";
        $progress.off("animationend").on("animationend", () => RxToasts.dismiss($toast));
    };

    static dismiss = ($toast) => {
        if (!$toast?.length || $toast.hasClass("leaving")) return;
        $toast.addClass("leaving");
        setTimeout(() => $toast.remove(), 220);
    };

    // Удалить все уведомления
    static removeAll() {
        $("#toasts-pool").empty();
    }
}
