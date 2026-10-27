// Вкладка «Импорт» в настройках: найденные лаунчеры, окно с галочками, прогресс и откат по резервным копиям
class RxImportUI {
    static busy = false;

    static $ = (selector) => $(`#modal-settings ${selector}`);

    static render = () => {
        const esc = RxDialog.escape;
        RxImportUI.$("[data-import-target]").text(RxImport.text("target", "Куда: {0}", RxImport.targetDirectory()));

        const sources = RxImport.detectSources();
        RxImportUI.$("[data-import-sources]").html(sources.length ? sources.map((source, index) => `<div class="import-row">
            <span class="material-symbols-outlined">${source.kind === "legacy" || source.kind === "tlauncher" ? "rocket_launch" : "folder"}</span>
            <div class="import-row-copy"><b>${esc(source.name)}</b><span>${esc(source.path)}</span></div>
            <button type="button" data-import-source="${index}"${RxImportUI.busy ? " disabled" : ""}>
                <span class="material-symbols-outlined">download</span><span>${esc(RxImport.text("importButton", "Импортировать"))}</span>
            </button>
        </div>`).join("") : `<div class="import-empty">${esc(RxImport.text("noSources", "Другие лаунчеры не найдены — выберите папку вручную"))}</div>`);
        RxImportUI.sources = sources;

        const backups = RxImport.listBackups();
        RxImportUI.$("[data-import-backups]").html(backups.length ? backups.map(backup => {
            const left = RxImport.restorableParts(backup);
            const parts = RxImport.backupParts(backup).map(RxImport.partTitle).join(", ");
            const when = new Date(backup.createdAt).toLocaleString();
            return `<div class="import-row">
                <span class="material-symbols-outlined">${left.length ? "history" : "task_alt"}</span>
                <div class="import-row-copy"><b>${esc(backup.sourceName)} · ${esc(when)}</b>
                    <span>${esc(left.length ? parts : RxImport.text("restoredAll", "Уже возвращено"))}</span></div>
                ${left.length ? `<button type="button" data-import-restore="${esc(backup.id)}"${RxImportUI.busy ? " disabled" : ""}>
                    <span class="material-symbols-outlined">undo</span><span>${esc(RxImport.text("restoreButton", "Вернуть"))}</span></button>` : ""}
                <button type="button" class="transparent" data-import-delete="${esc(backup.id)}" title="${esc(RxImport.text("deleteBackup", "Удалить копию"))}"${RxImportUI.busy ? " disabled" : ""}>
                    <span class="material-symbols-outlined">delete</span></button>
            </div>`;
        }).join("") : `<div class="import-empty">${esc(RxImport.text("noBackups", "Копий пока нет"))}</div>`);
    };

    static gameRunning = () => {
        if (typeof gamePid !== "undefined" && gamePid !== false) {
            RxToasts.create(RxImport.text("closeGame", "Закройте игру перед импортом"), "warning");
            return true;
        }
        return false;
    };

    static setProgress = (copied, total, label) => {
        const percent = total > 0 ? Math.min(100, Math.round(copied * 100 / total)) : 100;
        RxImportUI.$("[data-import-progress]").prop("hidden", false);
        RxImportUI.$(".import-progress-bar div").css("width", `${percent}%`);
        RxImportUI.$("[data-import-progress-text]").text(`${label ? `${label} · ` : ""}${RxUtils.humanFileSize(copied)} / ${RxUtils.humanFileSize(total)} (${percent}%)`);
    };

    static setBusy = (busy) => {
        RxImportUI.busy = busy;
        RxImportUI.$(".import-panel button").prop("disabled", busy);
        if (!busy) setTimeout(() => RxImportUI.$("[data-import-progress]").prop("hidden", true), 1500);
    };

    // Окно выбора: что перенести + галочка резервной копии
    static start = async (source) => {
        if (RxImportUI.busy || RxImportUI.gameRunning()) return false;
        RxImportUI.setBusy(true);
        let scan;
        try {
            RxImportUI.$("[data-import-progress]").prop("hidden", false);
            RxImportUI.$(".import-progress-bar div").css("width", "0%");
            RxImportUI.$("[data-import-progress-text]").text(RxImport.text("scanning", "Смотрим, что есть в {0}…", source.name));
            scan = await RxImport.scan(source.path);
        } catch (error) {
            RxCollector.writeLog(`Import: scan failed [error=${error.message}]`);
            RxToasts.create(RxImport.text("failed", "Не удалось выполнить импорт"), "error");
            RxImportUI.setBusy(false);
            return false;
        }
        RxImportUI.setBusy(false);

        const checks = RxImport.PARTS.map(part => ({
            id: part.id, icon: part.icon, title: RxImport.partTitle(part.id),
            text: RxImport.describe(part.id, scan[part.id]),
            checked: !RxImport.DEFAULT_OFF.includes(part.id), disabled: !scan[part.id]?.count
        }));
        checks.push({id: "__backup", icon: "settings_backup_restore", separated: true, optional: true, checked: true,
            title: RxImport.text("backupCheck", "Сделать резервную копию"),
            text: RxImport.text("backupCheckText", "Если что-то пойдёт не так, всё можно будет вернуть в «Резервных копиях импорта»")});
        const result = await RxDialog.open({
            icon: "move_to_inbox",
            title: RxImport.text("dialogTitle", "Импорт из {0}", source.name),
            text: RxImport.text("dialogText", "Откуда: {0}\nКуда: {1}", source.path, RxImport.targetDirectory()),
            checks,
            buttons: [{id: "cancel", text: MESSAGES.dialog.cancel},
                {id: "ok", text: RxImport.text("importButton", "Импортировать"), icon: "download", primary: true, requiresCheck: true}]
        });
        if (result.button !== "ok") return false;
        const parts = RxImport.PARTS.map(part => part.id).filter(id => result.checks[id] && scan[id]?.count);
        if (!parts.length) return false;
        if (RxImportUI.gameRunning()) return false;

        RxImportUI.setBusy(true);
        try {
            const stats = await RxImport.run(source, parts, {backup: result.checks.__backup === true, onProgress: RxImportUI.setProgress});
            RxToasts.create(RxImport.text("done", "Импорт завершён: {0} файлов", String(stats.copied)), "task_alt",
                stats.failed ? RxImport.text("doneWithErrors", "Не скопировано: {0}", String(stats.failed)) : source.name);
            if (parts.includes("accounts") && typeof RxAccountsUI !== "undefined") RxAccountsUI.reloadAccountSelect?.();
            return true;
        } catch (error) {
            RxCollector.writeLog(`Import: failed [error=${error.message}]`);
            RxToasts.create(RxImport.text("failed", "Не удалось выполнить импорт"), "error", error.message);
            return false;
        } finally {
            RxImportUI.setBusy(false);
            RxImportUI.render();
        }
    };

    // Откат: тоже галочками, по частям
    static restore = async (id) => {
        if (RxImportUI.busy || RxImportUI.gameRunning()) return false;
        const manifest = RxImport.readManifest(id);
        if (!manifest) return false;
        const left = RxImport.restorableParts(manifest);
        const count = (part) => (part.added?.length || 0) + (part.overwritten?.length || 0);
        const result = await RxDialog.open({
            icon: "settings_backup_restore",
            title: RxImport.text("restoreTitle", "Вернуть как было"),
            text: RxImport.text("restoreText", "Отмеченное вернётся к состоянию до импорта из {0}: добавленное удалится, заменённые файлы вернутся.", manifest.sourceName),
            checks: RxImport.backupParts(manifest).map(partId => {
                const part = RxImport.PARTS.find(item => item.id === partId);
                return {id: partId, icon: part?.icon || "check", title: RxImport.partTitle(partId), checked: left.includes(partId), disabled: !left.includes(partId),
                    text: left.includes(partId) ? RxImport.text("restoreCount", "Изменений: {0}", String(count(manifest.parts[partId]))) : RxImport.text("restoredAll", "Уже возвращено")};
            }),
            buttons: [{id: "cancel", text: MESSAGES.dialog.cancel},
                {id: "ok", text: RxImport.text("restoreButton", "Вернуть"), icon: "undo", primary: true, danger: true, requiresCheck: true}]
        });
        if (result.button !== "ok") return false;
        const parts = left.filter(partId => result.checks[partId]);
        if (!parts.length) return false;
        RxImportUI.setBusy(true);
        try {
            const stats = await RxImport.restore(id, parts);
            RxToasts.create(RxImport.text("restored", "Возвращено как было"), "undo",
                stats.failed ? RxImport.text("doneWithErrors", "Не скопировано: {0}", String(stats.failed)) : manifest.sourceName);
            if (parts.includes("accounts") && typeof RxAccountsUI !== "undefined") RxAccountsUI.reloadAccountSelect?.();
            return true;
        } catch (error) {
            RxCollector.writeLog(`Import: restore failed [error=${error.message}]`);
            RxToasts.create(RxImport.text("failed", "Не удалось выполнить импорт"), "error", error.message);
            return false;
        } finally {
            RxImportUI.setBusy(false);
            RxImportUI.render();
        }
    };

    static removeBackup = async (id) => {
        if (RxImportUI.busy) return false;
        const confirmed = await RxDialog.confirm({icon: "delete", title: RxImport.text("deleteBackup", "Удалить копию"),
            text: RxImport.text("deleteBackupText", "После удаления вернуть этот импорт будет нельзя."), danger: true});
        if (!confirmed) return false;
        await RxImport.deleteBackup(id);
        RxImportUI.render();
        return true;
    };

    static pickFolder = async () => {
        const result = await ipcRenderer.invoke("open-dialog", {properties: ["openDirectory"], title: RxImport.text("pickFolder", "Выбрать папку")});
        const dir = Array.isArray(result) ? result[0] : result;
        if (!dir) return false;
        if (!RxImport.looksLikeGameDir(dir)) {
            RxToasts.create(RxImport.text("notGameDir", "В этой папке нет файлов Minecraft"), "warning");
            return false;
        }
        if (RxImport.samePath(dir, RxImport.targetDirectory()) || RxImport.isInside(GAME_DATA, dir) || RxImport.isInside(dir, GAME_DATA) || RxImport.samePath(dir, GAME_DATA)) {
            RxToasts.create(RxImport.text("ownFolder", "Это папка самого RxLauncher"), "warning");
            return false;
        }
        return RxImportUI.start({name: path.basename(dir), path: path.resolve(dir), kind: "folder"});
    };
}

$(function () {
    $("#modal-settings")
        .on("click", ".tabs .tab[data-tab='import']", () => RxImportUI.render())
        .on("click", "[data-import-source]", function () {
            const source = RxImportUI.sources?.[Number($(this).attr("data-import-source"))];
            if (source) RxImportUI.start(source);
        })
        .on("click", "[data-import-restore]", function () { RxImportUI.restore($(this).attr("data-import-restore")); })
        .on("click", "[data-import-delete]", function () { RxImportUI.removeBackup($(this).attr("data-import-delete")); })
        .on("click", "[data-import-pick]", () => RxImportUI.pickFolder())
        .on("click", "[data-import-refresh]", () => RxImportUI.render());
});
