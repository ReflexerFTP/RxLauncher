// Галерея скриншотов Minecraft из всех папок лаунчера
class RxScreenshotsUI {
    static items = [];
    static visible = [];
    static viewerIndex = -1;
    static observer = null;

    static init = () => {
        const $modal = $("#modal-screenshots");
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "screenshots") RxScreenshotsUI.refresh();
        });
        // Ушли со страницы — отпускаем миниатюры, чтобы не держать память
        $(document).on("hideModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "screenshots") {
                RxScreenshotsUI.closeViewer();
                $modal.find("[data-shots-groups]").empty();
            }
        });
        $modal.find("[data-shots-source]").on("change", () => RxScreenshotsUI.render());
        $modal.find("[data-shots-open]").on("click", () => {
            const source = $modal.find("[data-shots-source]").val();
            const dir = source !== "all" ? source : path.join(GAME_DATA, "screenshots");
            fs.mkdirSync(dir, {recursive: true});
            openExternal(dir);
        });
        $modal.find("[data-shots-groups]").on("click", ".shots-tile", function () {
            RxScreenshotsUI.openViewer(Number($(this).attr("data-index")));
        });
        $modal.find("[data-shots-step]").on("click", function () {
            RxScreenshotsUI.step(Number($(this).attr("data-shots-step")));
        });
        $modal.find("[data-shots-close]").on("click", () => RxScreenshotsUI.closeViewer());
        $modal.find("[data-shots-viewer]").on("click", (e) => {
            if (e.target === e.currentTarget) RxScreenshotsUI.closeViewer();
        });
        $modal.find("[data-shots-action]").on("click", function () {
            RxScreenshotsUI.action($(this).attr("data-shots-action"), $(this));
        });
        window.addEventListener("keydown", (e) => {
            if (RxScreenshotsUI.viewerIndex < 0 || !RxModals.isModalShown("screenshots")) return;
            if (e.key === "ArrowLeft") RxScreenshotsUI.step(-1);
            else if (e.key === "ArrowRight") RxScreenshotsUI.step(1);
            else if (e.key === "Escape") {
                e.stopPropagation();
                RxScreenshotsUI.closeViewer();
            } else return;
            e.preventDefault();
        }, true);
    };

    // Папки со скриншотами: общая, раздельные хранилища версий, сборки, свои сборки лаунчера
    static getSources = () => {
        const sources = [{dir: path.join(GAME_DATA, "screenshots"), label: MESSAGES.screenshots.mainFolder}];
        const scan = (root, labelFor) => {
            try {
                fs.readdirSync(root, {withFileTypes: true}).filter(entry => entry.isDirectory()).forEach(entry => {
                    const dir = path.join(root, entry.name, "screenshots");
                    if (fs.existsSync(dir)) sources.push({dir, label: labelFor(entry.name)});
                });
            } catch (_) {}
        };
        scan(path.join(GAME_DATA, "home"), (name) => {
            try { return RxVersionsManager.versionToDisplayName(name); } catch (_) { return name; }
        });
        // Сборки — под их названиями
        scan(path.join(GAME_DATA, "modpacks"), (name) => {
            try { return RxPacks.getModpackManifest(name)?.displayName || name; } catch (_) { return name; }
        });
        return sources;
    };

    static refresh = () => {
        const sources = RxScreenshotsUI.getSources();
        const items = [];
        sources.forEach(source => {
            let files = [];
            try { files = fs.readdirSync(source.dir); } catch (_) {}
            files.filter(name => /\.(png|jpe?g)$/i.test(name)).forEach(name => {
                const file = path.join(source.dir, name);
                try {
                    const stat = fs.statSync(file);
                    items.push({file, name, dir: source.dir, label: source.label, time: stat.mtimeMs, size: stat.size});
                } catch (_) {}
            });
        });
        RxScreenshotsUI.items = items.sort((a, b) => b.time - a.time);

        // Источники в списке: только те, где есть скриншоты (+ «Все»)
        const $select = $("#modal-screenshots [data-shots-source]");
        const previous = $select.val();
        const used = sources.filter(source => items.some(item => item.dir === source.dir));
        $select.html(`<option value="all">${RxScreenshotsUI.escape(MESSAGES.screenshots.allSources)}</option>`
            + used.map(source => `<option value="${RxScreenshotsUI.escape(source.dir)}">${RxScreenshotsUI.escape(source.label)}</option>`).join(""));
        $select.val(used.some(source => source.dir === previous) ? previous : "all");
        RxScreenshotsUI.render();
    };

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    static dayLabel = (time) => {
        const day = new Date(time);
        const today = new Date();
        const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const diff = Math.round((startOf(today) - startOf(day)) / 86400000);
        if (diff === 0) return MESSAGES.screenshots.today;
        if (diff === 1) return MESSAGES.screenshots.yesterday;
        return new Intl.DateTimeFormat(RxTranslator.getCurrentLanguage() === "en" ? "en-US" : "ru-RU",
            {day: "numeric", month: "long", year: day.getFullYear() === today.getFullYear() ? undefined : "numeric"}).format(day);
    };

    static render = () => {
        const $modal = $("#modal-screenshots");
        const source = $modal.find("[data-shots-source]").val() || "all";
        RxScreenshotsUI.visible = RxScreenshotsUI.items.filter(item => source === "all" || item.dir === source);
        const visible = RxScreenshotsUI.visible;

        $modal.find("[data-shots-count]").text(MESSAGES.screenshots.count.replace("{0}", visible.length));
        $modal.find("[data-shots-empty]").prop("hidden", visible.length > 0);

        // Группы по дням
        let html = "";
        let currentDay = "";
        visible.forEach((item, index) => {
            const day = RxScreenshotsUI.dayLabel(item.time);
            if (day !== currentDay) {
                if (currentDay) html += "</div></section>";
                html += `<section class="shots-group"><h3>${RxScreenshotsUI.escape(day)}</h3><div class="shots-grid">`;
                currentDay = day;
            }
            const time = new Date(item.time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
            html += `<button type="button" class="shots-tile" data-index="${index}" title="${RxScreenshotsUI.escape(item.name)}">
                <img alt="" data-file="${RxScreenshotsUI.escape(item.file)}"/>
                <span class="shots-tile-meta"><span>${time}</span><span>${RxScreenshotsUI.escape(item.label)}</span></span>
            </button>`;
        });
        if (currentDay) html += "</div></section>";
        $modal.find("[data-shots-groups]").html(html);
        RxScreenshotsUI.observeThumbnails();
    };

    // Миниатюры грузим только для плиток, которые видны на экране
    static observeThumbnails = () => {
        RxScreenshotsUI.observer?.disconnect();
        RxScreenshotsUI.observer = new IntersectionObserver((entries) => {
            entries.filter(entry => entry.isIntersecting).forEach(async entry => {
                const img = entry.target;
                RxScreenshotsUI.observer.unobserve(img);
                const thumb = await ipcRenderer.invoke("screenshot-thumbnail", img.dataset.file);
                if (thumb) img.src = thumb;
                img.closest(".shots-tile")?.classList.add(thumb ? "loaded" : "broken");
            });
        }, {root: document.querySelector("#modal-screenshots [data-shots-scroll]"), rootMargin: "300px"});
        document.querySelectorAll("#modal-screenshots .shots-tile img").forEach(img => RxScreenshotsUI.observer.observe(img));
    };

    static fileUrl = (file) => "file:///" + file.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");

    static openViewer = (index) => {
        const item = RxScreenshotsUI.visible[index];
        if (!item) return;
        RxScreenshotsUI.viewerIndex = index;
        const $viewer = $("#modal-screenshots [data-shots-viewer]");
        $viewer.find("[data-shots-image]").attr("src", RxScreenshotsUI.fileUrl(item.file));
        $viewer.find("[data-shots-name]").text(item.name);
        $viewer.find("[data-shots-meta]").text([
            new Date(item.time).toLocaleString(RxTranslator.getCurrentLanguage() === "en" ? "en-US" : "ru-RU"),
            RxUtils.humanFileSize(item.size),
            item.label
        ].join(" · "));
        $viewer.find(".prev").prop("disabled", index <= 0);
        $viewer.find(".next").prop("disabled", index >= RxScreenshotsUI.visible.length - 1);
        $viewer.find(".shots-delete").removeClass("confirm");
        $viewer.prop("hidden", false);
    };

    static step = (delta) => {
        const next = RxScreenshotsUI.viewerIndex + delta;
        if (next >= 0 && next < RxScreenshotsUI.visible.length) RxScreenshotsUI.openViewer(next);
    };

    static closeViewer = () => {
        RxScreenshotsUI.viewerIndex = -1;
        const $viewer = $("#modal-screenshots [data-shots-viewer]");
        $viewer.prop("hidden", true);
        $viewer.find("[data-shots-image]").removeAttr("src");
    };

    static action = async (action, $button) => {
        const item = RxScreenshotsUI.visible[RxScreenshotsUI.viewerIndex];
        if (!item) return;
        // Удаление — по второму нажатию
        if (action === "delete" && !$button.hasClass("confirm")) {
            $button.addClass("confirm").find("span:last-child").text(MESSAGES.screenshots.deleteConfirm);
            return;
        }
        const ok = await ipcRenderer.invoke("screenshot-action", {action, file: item.file});
        if (action === "copy" && ok) RxToasts.create(MESSAGES.screenshots.copied, "content_copy", item.name, "success");
        if (action === "delete") {
            $button.removeClass("confirm").find("span:last-child").text(MESSAGES.screenshots.delete);
            if (!ok) return RxToasts.create(MESSAGES.screenshots.deleteFailed, "error", item.name, "error");
            RxToasts.create(MESSAGES.screenshots.deleted, "delete", item.name);
            const index = RxScreenshotsUI.viewerIndex;
            RxScreenshotsUI.refresh();
            if (RxScreenshotsUI.visible.length) RxScreenshotsUI.openViewer(Math.min(index, RxScreenshotsUI.visible.length - 1));
            else RxScreenshotsUI.closeViewer();
        }
    };
}

$(RxScreenshotsUI.init);
