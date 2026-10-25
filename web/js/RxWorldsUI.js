// Вкладка «Миры и копии» в разделе «Сборки»: все миры, ручная копия и восстановление из копий
class RxWorldsUI {
    static view = "instances";
    static busy = new Set();

    static escape = (value) => RxInstancesUI.escape(value);

    // Где лежит мир: основная папка, сборка или отдельная папка версии
    static locationLabel = (savesDir) => {
        const relative = path.relative(GAME_DATA, savesDir).split(path.sep);
        if (relative[0] === "modpacks" && relative[1]) {
            try {
                return RxPacks.getModpackManifest(relative[1])?.displayName || relative[1];
            } catch (_) {
                return relative[1];
            }
        }
        if (relative[0] === "home" && relative[1]) {
            try {
                return RxVersionsManager.versionToDisplayName(relative[1]);
            } catch (_) {
                return relative[1];
            }
        }
        return MESSAGES.worlds.mainFolder;
    };

    static relativeTime = (time) => {
        const minutes = Math.round((Date.now() - time) / 60000);
        const rtf = new Intl.RelativeTimeFormat(RxTranslator.getCurrentLanguage() === "en" ? "en" : "ru", {numeric: "auto"});
        if (minutes < 60) return rtf.format(-minutes, "minute");
        if (minutes < 1440) return rtf.format(-Math.round(minutes / 60), "hour");
        return rtf.format(-Math.round(minutes / 1440), "day");
    };

    static setView = (view) => {
        RxWorldsUI.view = view;
        const $modal = $("#modal-instances");
        $modal.find("[data-inst-view-tab]").removeClass("active").filter(`[data-inst-view-tab="${view}"]`).addClass("active");
        $modal.find("[data-inst-view]").each(function () { this.hidden = this.dataset.instView !== view; });
        $modal.find("[data-inst-only]").each(function () { this.hidden = this.dataset.instOnly !== view; });
        if (view === "worlds") RxWorldsUI.render();
        else RxInstancesUI.render();
    };

    static render = async () => {
        const $modal = $("#modal-instances");
        const groups = await RxWorldsManager.getAllWorlds();
        const worlds = groups.flatMap(group => group.worlds.map(world => {
            let played = 0;
            try { played = fs.statSync(path.join(world.path, "level.dat")).mtimeMs; } catch (_) {}
            return {...world, location: RxWorldsUI.locationLabel(group.path), played, backups: RxWorldBackups.list(world.path)};
        })).sort((a, b) => b.played - a.played);
        const esc = RxWorldsUI.escape;
        $modal.find("[data-worlds-empty]").prop("hidden", worlds.length > 0);
        $modal.find("[data-worlds-list]").html(worlds.map(world => {
            const icon = world.icon && world.icon !== "assets/world.webp" ? RxScreenshotsUI.fileUrl(world.icon) : "assets/world.webp";
            const last = world.backups[0];
            const busy = RxWorldsUI.busy.has(world.path);
            return `<article class="world-row" data-world="${esc(world.path)}">
                <img class="world-icon" src="${esc(icon)}" alt="" loading="lazy"/>
                <div class="world-copy">
                    <strong title="${esc(world.name)}">${esc(world.name || path.basename(world.path))}</strong>
                    <div class="world-meta">
                        <span><span class="material-symbols-outlined">folder</span>${esc(world.location)}</span>
                        ${world.version ? `<span><span class="material-symbols-outlined">deployed_code</span>${esc(world.version)}</span>` : ""}
                        ${world.played ? `<span><span class="material-symbols-outlined">schedule</span>${esc(RxWorldsUI.relativeTime(world.played))}</span>` : ""}
                        <span class="${last ? "world-has-backup" : ""}"><span class="material-symbols-outlined">${last ? "cloud_done" : "cloud_off"}</span>${esc(last
                            ? MESSAGES.worlds.backupsCount.replace("{0}", world.backups.length).replace("{1}", RxWorldsUI.relativeTime(last.time))
                            : MESSAGES.worlds.noBackups)}</span>
                    </div>
                </div>
                <div class="world-actions">
                    <button data-world-action="backup"${busy ? " disabled" : ""}><span class="material-symbols-outlined${busy ? " spin" : ""}">${busy ? "progress_activity" : "backup"}</span><span>${esc(busy ? MESSAGES.worlds.saving : MESSAGES.worlds.backup)}</span></button>
                    <button class="transparent" data-world-action="restore"${world.backups.length ? "" : " disabled"}><span class="material-symbols-outlined">settings_backup_restore</span><span>${esc(MESSAGES.worlds.restore)}</span></button>
                    <button class="transparent icon-only" data-world-action="folder" title="${esc(MESSAGES.instances.openFolder)}"><span class="material-symbols-outlined">folder_open</span></button>
                </div>
            </article>`;
        }).join(""));
    };

    static backup = async (worldPath) => {
        if (RxWorldsUI.busy.has(worldPath)) return;
        RxWorldsUI.busy.add(worldPath);
        RxWorldsUI.render();
        try {
            await RxWorldBackups.backup(worldPath, "manual");
            RxToasts.create(MESSAGES.worlds.saved, "backup", path.basename(worldPath), "success");
        } catch (error) {
            RxCollector.writeLog(`WorldBackups: Manual backup failed [world=${worldPath}] [error=${error}]`);
            RxToasts.create(MESSAGES.worlds.saveFailed, "error", path.basename(worldPath), "error");
        } finally {
            RxWorldsUI.busy.delete(worldPath);
            RxWorldsUI.render();
        }
    };

    static restore = async (worldPath) => {
        const backups = RxWorldBackups.list(worldPath);
        if (!backups.length) return;
        const format = new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"});
        const file = await RxDialog.choose({
            icon: "settings_backup_restore",
            title: MESSAGES.worlds.chooseBackup,
            text: path.basename(worldPath),
            choices: backups.map(item => ({
                value: item.file,
                icon: {auto: "schedule", manual: "backup", restore: "history"}[item.reason] || "backup",
                title: format.format(new Date(item.time)),
                text: `${MESSAGES.worlds.reasons[item.reason] || item.reason} · ${RxUtils.humanFileSize(item.size)}`
            }))
        });
        if (!file) return;
        const confirmed = await RxDialog.confirm({
            icon: "warning",
            title: MESSAGES.worlds.restoreTitle,
            text: MESSAGES.worlds.restoreText,
            confirmText: MESSAGES.worlds.restore,
            danger: true
        });
        if (!confirmed) return;
        RxWorldsUI.busy.add(worldPath);
        RxWorldsUI.render();
        try {
            await RxWorldBackups.restore(worldPath, file);
            RxToasts.create(MESSAGES.worlds.restored, "settings_backup_restore", path.basename(worldPath), "success");
        } catch (error) {
            RxCollector.writeLog(`WorldBackups: Restore failed [world=${worldPath}] [error=${error}]`);
            RxToasts.create(/running/i.test(error.message) ? MESSAGES.worlds.closeGame : MESSAGES.worlds.restoreFailed, "error", path.basename(worldPath), "error");
        } finally {
            RxWorldsUI.busy.delete(worldPath);
            RxWorldsUI.render();
        }
    };

    static init = () => {
        const $modal = $("#modal-instances");
        $modal.on("click", "[data-inst-view-tab]", function () { RxWorldsUI.setView($(this).attr("data-inst-view-tab")); });
        $modal.on("click", "[data-worlds-folder]", () => {
            fs.mkdirSync(RxWorldBackups.root(), {recursive: true});
            openExternal(RxWorldBackups.root());
        });
        $modal.on("click", "[data-world-action]", function () {
            const worldPath = $(this).closest("[data-world]").attr("data-world");
            const action = $(this).attr("data-world-action");
            if (action === "backup") RxWorldsUI.backup(worldPath);
            if (action === "restore") RxWorldsUI.restore(worldPath);
            if (action === "folder") openExternal(worldPath);
        });
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "instances" && RxWorldsUI.view === "worlds") RxWorldsUI.render();
        });
    };
}

$(RxWorldsUI.init);
