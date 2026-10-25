class RxModsManager {
    static files = [];
    static expanded = new Set();
    static metaGeneration = 0;
    static index = null;
    static SORT_KEY = "modsSort";

    static message = (key, fallback) => MESSAGES.mods?.[key] || fallback;

    static getContext = () => {
        const versionId = RxVersionsManager.getActiveVersion();
        if (!versionId || versionId === "none" || !versionId.includes("-")) return false;
        const gameRoot = path.resolve(RxUtils.getGameRoot(versionId));
        return {
            versionId,
            displayName: RxVersionsManager.versionToDisplayName(versionId),
            gameRoot,
            modsPath: path.join(gameRoot, "mods"),
            loader: RxVersionsManager.parseVersionID(versionId).type
        };
    };

    static ensureDirectory = (modsPath) => {
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, {recursive: true});
        return modsPath;
    };

    static isJarFileName = fileName => /\.jar(?:\.disabled)?$/i.test(String(fileName || ""));

    static hasJarSignature = filePath => {
        try {
            if (!fs.statSync(filePath).isFile()) return false;
            const handle = fs.openSync(filePath, "r");
            const signature = Buffer.alloc(4);
            fs.readSync(handle, signature, 0, 4, 0);
            fs.closeSync(handle);
            return signature[0] === 0x50 && signature[1] === 0x4b && [0x03, 0x05, 0x07].includes(signature[2]);
        } catch (_) {
            return false;
        }
    };

    static isValidJar = filePath => /\.jar$/i.test(filePath) && RxModsManager.hasJarSignature(filePath);

    static readableSize = bytes => {
        const value = Number(bytes) || 0;
        if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
        return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB`;
    };

    static displayName = fileName => String(fileName || "")
        .replace(/\.jar(?:\.disabled)?$/i, "")
        .replace(/[-_](?:fabric|forge|neoforge|quilt)?[-_]?\d+(?:\.\d+){1,3}.*$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, character => character.toUpperCase())
        .trim() || fileName;

    static scan = () => {
        const context = RxModsManager.getContext();
        if (!context) return [];
        RxModsManager.ensureDirectory(context.modsPath);
        const resolvedRoot = path.resolve(context.modsPath);
        return fs.readdirSync(resolvedRoot, {withFileTypes: true})
            .filter(entry => entry.isFile() && RxModsManager.isJarFileName(entry.name))
            .map(entry => {
                const fullPath = path.resolve(resolvedRoot, entry.name);
                if (path.dirname(fullPath) !== resolvedRoot) return false;
                const stat = fs.statSync(fullPath);
                return {
                    fileName: entry.name,
                    fullPath,
                    title: RxModsManager.displayName(entry.name),
                    enabled: /\.jar$/i.test(entry.name),
                    valid: RxModsManager.hasJarSignature(fullPath),
                    bytes: stat.size,
                    modified: stat.mtimeMs,
                    meta: null,
                    compat: null
                };
            })
            .filter(Boolean)
            .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title));
    };

    static formatDate = timestamp => new Intl.DateTimeFormat(
        RxTranslator.getCurrentLanguage() === "ru" ? "ru-RU" : "en-US",
        {day: "2-digit", month: "short", year: "numeric"}
    ).format(new Date(timestamp));

    // ---------- сортировка ----------
    static getSort = () => typeof RxConfig !== "undefined" ? RxConfig.read(RxModsManager.SORT_KEY, "enabled") : "enabled";

    static sortFiles = (files, mode) => {
        const name = file => String(file.meta?.name || file.title).toLocaleLowerCase();
        const severity = file => !file.valid ? 3 : ({error: 2, warn: 1})[file.compat?.verdict] || 0;
        const comparators = {
            name: (a, b) => name(a).localeCompare(name(b)),
            newest: (a, b) => b.modified - a.modified,
            oldest: (a, b) => a.modified - b.modified,
            size: (a, b) => b.bytes - a.bytes,
            problems: (a, b) => severity(b) - severity(a) || name(a).localeCompare(name(b)),
            enabled: (a, b) => Number(b.enabled) - Number(a.enabled) || name(a).localeCompare(name(b))
        };
        return [...files].sort(comparators[mode] || comparators.enabled);
    };

    static refresh = () => {
        const context = RxModsManager.getContext();
        const $modal = $("#modal-mods");
        const hasVersion = Boolean(context);
        $modal.toggleClass("mods-no-context", !hasVersion);
        $modal.find("[data-mods-no-version]").prop("hidden", hasVersion);
        $modal.find(".mods-toolbar, .mods-overview, .mods-list-head, [data-mods-list], [data-mods-empty]").toggle(hasVersion);
        if (!context) {
            $modal.find("[data-mods-version]").text(MESSAGES.commons.notSelected);
            return false;
        }

        RxModsManager.files = RxModsManager.scan();
        $modal.find("[data-mods-version]").text(context.displayName);
        $modal.find("[data-mods-path]").text(context.modsPath).attr("title", context.modsPath);
        $modal.find("[data-mods-count]").text(RxModsManager.files.length);
        $modal.find("[data-mods-enabled]").text(RxModsManager.files.filter(file => file.enabled).length);
        $modal.find("[data-mods-disabled]").text(RxModsManager.files.filter(file => !file.enabled).length);
        $modal.find("[data-mods-empty]").toggle(RxModsManager.files.length === 0);
        $modal.find(".mods-list-head, [data-mods-list]").toggle(RxModsManager.files.length > 0);
        $modal.find("[data-mods-sort]").val(RxModsManager.getSort());
        $modal.find('[data-mods-action="last-crash"]').prop("hidden", typeof RxCrashAnalyzer === "undefined" || !RxCrashAnalyzer.loadLastReport());
        RxModsManager.render();
        RxModsManager.loadMeta();
        return true;
    };

    // ---------- метаданные и совместимость (в фоне, строки обновляются по мере готовности) ----------
    static loadMeta = async () => {
        if (typeof RxModMeta === "undefined") return false;
        const generation = ++RxModsManager.metaGeneration;
        const files = RxModsManager.files;
        let next = 0;
        const worker = async () => {
            while (next < files.length) {
                const file = files[next++];
                if (!file.valid) continue;
                file.meta = await RxModMeta.read(file.fullPath);
                if (generation !== RxModsManager.metaGeneration) return;
                RxModsManager.updateRow(file);
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (generation !== RxModsManager.metaGeneration) return false;
        // Совместимость считается, когда известны все моды (нужен полный индекс)
        const target = RxModMeta.getTarget();
        RxModsManager.index = RxModMeta.buildIndex(files);
        files.forEach(file => {
            file.compat = file.valid && file.meta ? RxModMeta.evaluate(file, RxModsManager.index, target) : null;
        });
        if (RxModsManager.getSort() === "problems") RxModsManager.render();
        else files.forEach(file => RxModsManager.updateRow(file));
        return true;
    };

    static statusFor = (file) => {
        if (!file.valid) return {cls: "invalid", icon: "error", text: RxModsManager.message("invalidFile", "Повреждён")};
        if (!file.enabled) return {cls: "off", icon: "pause_circle", text: RxModsManager.message("disabled", "Отключён")};
        if (!file.compat) return {cls: "checking", icon: "hourglass_empty", text: RxModsManager.message("checking", "Проверка…")};
        return {
            ok: {cls: "ok", icon: "check_circle", text: RxModsManager.message("compatOk", "Совместим")},
            warn: {cls: "warn", icon: "help", text: RxModsManager.message("compatWarn", "Проверьте")},
            error: {cls: "error", icon: "report", text: RxModsManager.message("compatError", "Проблема")},
            unknown: {cls: "unknown", icon: "help", text: RxModsManager.message("compatUnknown", "Неизвестно")}
        }[file.compat.verdict];
    };

    static buildRow = (file) => {
        const enabledText = RxModsManager.message("enabled", "Включён");
        const disabledText = RxModsManager.message("disabled", "Отключён");
        const meta = file.meta;
        const status = RxModsManager.statusFor(file);
        const expanded = RxModsManager.expanded.has(file.fileName);
        const $row = $("<article>")
            .addClass(`mods-row${file.enabled ? "" : " disabled"}${file.valid ? "" : " invalid"}${expanded ? " expanded" : ""}`)
            .attr("data-mod-file", file.fileName);

        const $icon = $("<div>").addClass("mods-row-icon");
        if (meta?.iconData) $icon.append($("<img>").attr({src: meta.iconData, alt: ""}));
        else $icon.append($("<span>").addClass("material-symbols-outlined").text("extension"));
        const $main = $("<div>").addClass("mods-row-main").append($icon, $("<div>").addClass("mods-row-copy")
            .append($("<span>").addClass("mods-row-title").text(meta?.name || file.title))
            .append($("<span>").addClass("mods-row-file").text(file.fileName).attr("title", file.fileName)));

        const $details = $("<div>").addClass("mods-row-details");
        if (meta?.version) $details.append($("<span>").text(`v${meta.version}`).attr("title", meta.version));
        $details.append($("<span>").text(RxModsManager.readableSize(file.bytes)))
            .append($("<span>").text(RxModsManager.formatDate(file.modified)));

        const $status = $("<span>").addClass(`mods-row-status ${status.cls}`)
            .append($("<span>").addClass("material-symbols-outlined").text(status.icon))
            .append($("<span>").text(status.text));

        const $actions = $("<div>").addClass("mods-row-actions");
        $actions.append($("<button>").addClass("mods-row-info").attr("title", RxModsManager.message("info", "Подробнее"))
            .append($("<span>").addClass("material-symbols-outlined").text(expanded ? "expand_less" : "info"))
            .on("click", () => RxModsManager.toggleInfo(file.fileName)));
        $actions.append($("<button>").attr("title", file.enabled ? disabledText : enabledText)
            .append($("<span>").addClass("material-symbols-outlined").text(file.enabled ? "pause" : "play_arrow"))
            .prop("disabled", !file.valid)
            .on("click", () => RxModsManager.toggle(file.fileName)));
        $actions.append($("<button>").addClass("mods-row-delete").attr("title", RxModsManager.message("delete", "Удалить"))
            .append($("<span>").addClass("material-symbols-outlined").text("delete"))
            .on("click", () => RxModsManager.remove(file.fileName)));

        $row.append($main, $details, $status, $actions);
        if (expanded) $row.append(RxModsManager.buildInfo(file));
        return $row;
    };

    // Панель «Подробнее»: описание, поля из метаданных и проверки совместимости
    static buildInfo = (file) => {
        const meta = file.meta;
        const unknown = RxModsManager.message("infoUnknownField", "не указано");
        const $info = $("<div>").addClass("mods-info");
        $info.append($("<p>").addClass("mods-info-description").text(meta?.description || RxModsManager.message("infoNoDescription", "Описание не указано")));

        const field = (label, value) => $("<div>").addClass("mods-info-field")
            .append($("<span>").text(label), $("<b>").text(value || unknown).attr("title", value || ""));
        const $fields = $("<div>").addClass("mods-info-fields").append(
            field(RxModsManager.message("infoVersion", "Версия"), meta?.version),
            field(RxModsManager.message("infoId", "ID мода"), meta?.id),
            field(RxModsManager.message("infoLoader", "Загрузчик"), (meta?.loaders || []).map(RxModMeta.loaderLabel).join(", ")),
            field(RxModsManager.message("infoMinecraft", "Minecraft"), meta?.mcRange !== null && meta?.mcRange !== undefined ? RxModMeta.rangeToText(meta.mcRange) : ""),
            field(RxModsManager.message("infoAuthors", "Авторы"), (meta?.authors || []).slice(0, 4).join(", "))
        );
        $info.append($fields);

        const $compat = $("<div>").addClass("mods-info-compat");
        $compat.append($("<div>").addClass("mods-info-compat-head")
            .append($("<b>").text(RxModsManager.message("infoCompat", "Примерная совместимость")),
                $("<span>").text(RxModsManager.message("infoCompatHint", ""))));
        const checks = file.compat?.checks || [];
        if (checks.length === 0) {
            $compat.append($("<div>").addClass("mods-check warn").append(
                $("<span>").addClass("material-symbols-outlined").text("hourglass_empty"),
                $("<span>").text(file.enabled ? RxModsManager.message("checking", "Проверка…") : RxModsManager.message("disabled", "Отключён"))));
        }
        const icons = {ok: "check_circle", warn: "help", error: "cancel"};
        checks.forEach(check => $compat.append($("<div>").addClass(`mods-check ${check.level}`).append(
            $("<span>").addClass("material-symbols-outlined").text(icons[check.level]),
            $("<span>").text(check.text))));
        $info.append($compat);
        return $info;
    };

    static updateRow = (file) => {
        const $old = $(`#modal-mods [data-mods-list] [data-mod-file="${CSS.escape(file.fileName)}"]`);
        if ($old.length) $old.replaceWith(RxModsManager.buildRow(file));
    };

    static toggleInfo = (fileName) => {
        if (RxModsManager.expanded.has(fileName)) RxModsManager.expanded.delete(fileName);
        else RxModsManager.expanded.add(fileName);
        const file = RxModsManager.files.find(item => item.fileName === fileName);
        if (file) RxModsManager.updateRow(file);
    };

    static render = () => {
        const context = RxModsManager.getContext();
        if (!context) return false;
        const query = String($("#modal-mods [data-mods-search]").val() || "").trim().toLowerCase();
        const $list = $("#modal-mods [data-mods-list]").empty();
        RxModsManager.sortFiles(RxModsManager.files, RxModsManager.getSort())
            .filter(file => !query || `${file.title} ${file.fileName} ${file.meta?.name || ""} ${file.meta?.id || ""}`.toLowerCase().includes(query))
            .forEach(file => $list.append(RxModsManager.buildRow(file)));
        return true;
    };

    static resolveManagedPath = fileName => {
        const context = RxModsManager.getContext();
        if (!context || path.basename(fileName) !== fileName || !RxModsManager.isJarFileName(fileName)) return false;
        const root = path.resolve(context.modsPath);
        const target = path.resolve(root, fileName);
        return path.dirname(target) === root ? target : false;
    };

    // Скопировать JAR-файлы в папку модов (общая логика для кнопки и перетаскивания)
    static installFiles = (sources) => {
        const context = RxModsManager.getContext();
        if (!context) return {added: 0, skipped: 0, rejected: 0};
        RxModsManager.ensureDirectory(context.modsPath);
        let added = 0;
        let skipped = 0;
        let rejected = 0;
        for (const source of sources) {
            if (!RxModsManager.isValidJar(source)) {
                rejected++;
                continue;
            }
            const destination = path.join(context.modsPath, path.basename(source));
            if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination) || fs.existsSync(`${destination}.disabled`)) {
                skipped++;
                continue;
            }
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            added++;
        }
        RxCollector.writeLog(`Mods: Added ${added}, skipped ${skipped}, rejected ${rejected} [version=${context.versionId}]`);
        if (added > 0 || skipped > 0) {
            const details = [String(added)];
            if (skipped + rejected) details.push(`${RxModsManager.message("skipped", "пропущено")}: ${skipped + rejected}`);
            RxToasts.create(RxModsManager.message("added", "Моды добавлены"), "extension", details.join(" · "));
        } else if (rejected > 0) {
            RxToasts.create(RxModsManager.message("notJar", "Это не JAR-моды"), "error", String(rejected));
        }
        RxModsManager.refresh();
        return {added, skipped, rejected};
    };

    static add = async () => {
        const context = RxModsManager.getContext();
        if (!context) return false;
        const selected = await ipcRenderer.invoke("open-dialog", {
            title: RxModsManager.message("add", "Добавить моды"),
            defaultPath: context.modsPath,
            properties: ["openFile", "multiSelections", "dontAddToRecent"],
            filters: [{name: "Minecraft JAR", extensions: ["jar"]}]
        });
        if (!selected) return false;
        return RxModsManager.installFiles(selected).added > 0;
    };

    static toggle = fileName => {
        const source = RxModsManager.resolveManagedPath(fileName);
        if (!source || !fs.existsSync(source)) return false;
        if (!RxModsManager.hasJarSignature(source)) {
            RxToasts.create(RxModsManager.message("invalidFile", "Повреждённый JAR"), "error", fileName);
            return false;
        }
        const enabled = /\.jar$/i.test(fileName);
        const target = enabled ? `${source}.disabled` : source.replace(/\.disabled$/i, "");
        if (fs.existsSync(target)) {
            RxToasts.create(RxModsManager.message("duplicate", "Файл с таким именем уже существует"), "warning");
            return false;
        }
        fs.renameSync(source, target);
        if (RxModsManager.expanded.delete(fileName)) RxModsManager.expanded.add(path.basename(target));
        RxCollector.writeLog(`Mods: ${enabled ? "Disabled" : "Enabled"} ${fileName}`);
        RxModsManager.refresh();
        return true;
    };

    static remove = fileName => {
        const target = RxModsManager.resolveManagedPath(fileName);
        if (!target || !fs.existsSync(target)) return false;
        fs.unlinkSync(target);
        RxModsManager.expanded.delete(fileName);
        RxCollector.writeLog(`Mods: Deleted ${fileName}`);
        RxToasts.create(RxModsManager.message("deleted", "Мод удалён"), "delete", fileName);
        RxModsManager.refresh();
        return true;
    };

    static removeAll = () => {
        if (RxModsManager.files.length === 0) return false;
        if (!window.confirm(RxModsManager.message("confirmDeleteAll", "Удалить все моды выбранной версии?"))) return false;
        let removed = 0;
        for (const file of RxModsManager.files) {
            const target = RxModsManager.resolveManagedPath(file.fileName);
            if (target && fs.existsSync(target)) {
                fs.unlinkSync(target);
                removed++;
            }
        }
        RxCollector.writeLog(`Mods: Deleted all [count=${removed}]`);
        RxToasts.create(RxModsManager.message("allDeleted", "Все моды удалены"), "delete_sweep", String(removed));
        RxModsManager.refresh();
        return true;
    };

    static backup = async () => {
        const context = RxModsManager.getContext();
        if (!context) return false;
        RxModsManager.ensureDirectory(context.modsPath);
        const safeVersion = context.versionId.replace(/[^a-z0-9._-]/gi, "_");
        const date = new Date().toISOString().slice(0, 10);
        const output = await ipcRenderer.invoke("save-dialog", {
            title: RxModsManager.message("backup", "Сохранить моды"),
            defaultPath: `mods-${safeVersion}-${date}.zip`,
            properties: ["dontAddToRecent"],
            filters: [{name: "ZIP", extensions: ["zip"]}]
        });
        if (!output) return false;
        await RxUtils.compressDirectory(output, context.modsPath);
        RxCollector.writeLog(`Mods: Backup saved [path=${output}]`);
        RxToasts.create(RxModsManager.message("backupReady", "Копия модов сохранена"), "archive", path.basename(output));
        return true;
    };

    static openFolder = () => {
        const context = RxModsManager.getContext();
        if (!context) return false;
        RxModsManager.ensureDirectory(context.modsPath);
        openExternal(context.modsPath);
        return true;
    };

    // ---------- перетаскивание файлов ----------
    static droppedPaths = (event) => {
        const files = [...(event.originalEvent?.dataTransfer?.files || [])];
        const {webUtils} = require("electron");
        return files.map(file => {
            try { return webUtils.getPathForFile(file); } catch (_) { return ""; }
        }).filter(Boolean);
    };

    static bindDragAndDrop = () => {
        const $modal = $("#modal-mods");
        const $overlay = $modal.find("[data-mods-drop]");
        const hasFiles = event => [...(event.originalEvent?.dataTransfer?.types || [])].includes("Files");
        let depth = 0;
        $modal.on("dragenter", (event) => {
            if (!hasFiles(event) || !RxModsManager.getContext()) return;
            event.preventDefault();
            depth++;
            $overlay.prop("hidden", false);
        });
        $modal.on("dragover", (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.originalEvent.dataTransfer.dropEffect = RxModsManager.getContext() ? "copy" : "none";
        });
        $modal.on("dragleave", (event) => {
            if (!hasFiles(event)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) $overlay.prop("hidden", true);
        });
        $modal.on("drop", (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            depth = 0;
            $overlay.prop("hidden", true);
            const paths = RxModsManager.droppedPaths(event);
            if (paths.length) RxModsManager.installFiles(paths);
        });
    };

    static bind = () => {
        $(document).on("showModalEvent", event => {
            if (event.originalEvent.detail.modal === "mods") RxModsManager.refresh();
        });
        $("#modal-mods").on("input", "[data-mods-search]", RxModsManager.render);
        $("#modal-mods").on("change", "[data-mods-sort]", function () {
            RxConfig.write(RxModsManager.SORT_KEY, String($(this).val() || "enabled"));
            RxModsManager.render();
        });
        $("#modal-mods").on("click", "[data-mods-action]", function () {
            const action = $(this).data("mods-action");
            if (action === "add") RxModsManager.add();
            if (action === "backup") RxModsManager.backup();
            if (action === "folder") RxModsManager.openFolder();
            if (action === "delete-all") RxModsManager.removeAll();
            if (action === "last-crash") RxCrashUI.show(RxCrashAnalyzer.loadLastReport());
        });
        RxModsManager.bindDragAndDrop();
    };
}

$(RxModsManager.bind);
