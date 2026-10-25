// «Сборки»: отдельные экземпляры игры со своими модами, мирами и настройками.
// Хранятся как модпаки лаунчера (modpacks/<id>/manifest.json) и запускаются как версия pack-<id>.
class RxInstancesUI {
    static editingId = "";

    static root = () => path.join(GAME_DATA, "modpacks");
    static dirFor = (id) => path.join(RxInstancesUI.root(), id);

    static list = () => RxPacks.getPacksList()
        .map(id => {
            try {
                return {...RxPacks.getModpackManifest(id), id};
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => (b.lastPlayed || b.created || 0) - (a.lastPlayed || a.created || 0));

    static countMods = (id) => {
        try {
            return fs.readdirSync(path.join(RxInstancesUI.dirFor(id), "mods")).filter(name => /\.jar$/i.test(name)).length;
        } catch (_) {
            return 0;
        }
    };

    static uniqueId = (name) => {
        const base = RxPacks.modpackCleanID(RxUtils.translit(name)).slice(0, 40) || "instance";
        let id = base;
        for (let i = 2; fs.existsSync(RxInstancesUI.dirFor(id)); i++) id = `${base}_${i}`;
        return id;
    };

    static iconFor = (instance) => {
        if (instance.icon === "pack") return RxScreenshotsUI.fileUrl(path.join(RxInstancesUI.dirFor(instance.id), "icon.png"));
        if (typeof instance.icon === "string" && /^https:\/\//.test(instance.icon)) return instance.icon;
        return `assets/versions/${instance.baseVersion?.type === "custom" ? "3rdparty" : instance.baseVersion?.type || "vanilla"}.webp`;
    };

    static relative = (time) => {
        if (!time) return MESSAGES.instances.neverPlayed;
        const minutes = Math.round((Date.now() - time) / 60000);
        const rtf = new Intl.RelativeTimeFormat(RxTranslator.getCurrentLanguage() === "en" ? "en" : "ru", {numeric: "auto"});
        if (minutes < 60) return MESSAGES.instances.played.replace("{0}", rtf.format(-minutes, "minute"));
        if (minutes < 1440) return MESSAGES.instances.played.replace("{0}", rtf.format(-Math.round(minutes / 60), "hour"));
        return MESSAGES.instances.played.replace("{0}", rtf.format(-Math.round(minutes / 1440), "day"));
    };

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    // ---------- отрисовка ----------
    static render = () => {
        const $modal = $("#modal-instances");
        const instances = RxInstancesUI.list();
        const active = RxVersionsManager.getActiveVersion();
        const esc = RxInstancesUI.escape;
        $modal.find("[data-instances-count]").text(MESSAGES.instances.count.replace("{0}", instances.length));
        $modal.find("[data-instances-empty]").prop("hidden", instances.length > 0);
        $modal.find("[data-instances-grid]").html(instances.map(instance => {
            const isActive = active === `pack-${instance.id}`;
            let versionLabel = instance.baseVersion?.full || "—";
            try { versionLabel = RxVersionsManager.versionToDisplayName(instance.baseVersion.full); } catch (_) {}
            const memory = instance.memory?.mode === "manual"
                ? `${(instance.memory.mb / 1024).toFixed(1).replace(/\.0$/, "")} ${MESSAGES.units.gb}`
                : instance.memory?.mode === "auto" ? MESSAGES.instances.memoryAutoShort : MESSAGES.instances.memoryGlobalShort;
            return `<article class="inst-card${isActive ? " active" : ""}" data-instance="${esc(instance.id)}">
                <div class="inst-top">
                    <img class="inst-icon" src="${esc(RxInstancesUI.iconFor(instance))}" alt="" loading="lazy"/>
                    <div class="inst-copy">
                        <strong title="${esc(instance.displayName)}">${esc(instance.displayName)}</strong>
                        <span>${esc(versionLabel)}</span>
                    </div>
                    ${isActive ? `<span class="inst-active">${esc(MESSAGES.instances.active)}</span>` : ""}
                </div>
                <div class="inst-stats">
                    <span><span class="material-symbols-outlined">extension</span>${esc(MESSAGES.instances.mods.replace("{0}", RxInstancesUI.countMods(instance.id)))}</span>
                    <span><span class="material-symbols-outlined">memory_alt</span>${esc(memory)}</span>
                    <span><span class="material-symbols-outlined">schedule</span>${esc(RxInstancesUI.relative(instance.lastPlayed))}</span>
                </div>
                <div class="inst-actions">
                    <button class="inst-play" data-instance-action="play"><span class="material-symbols-outlined">play_arrow</span><span>${esc(MESSAGES.flyout.play)}</span></button>
                    <button class="transparent" data-instance-action="mods" title="${esc(MESSAGES.instances.openMods)}"><span class="material-symbols-outlined">extension</span></button>
                    <button class="transparent" data-instance-action="folder" title="${esc(MESSAGES.instances.openFolder)}"><span class="material-symbols-outlined">folder_open</span></button>
                    <button class="transparent" data-instance-action="edit" title="${esc(MESSAGES.instances.settings)}"><span class="material-symbols-outlined">tune</span></button>
                    <button class="transparent" data-instance-action="duplicate" title="${esc(MESSAGES.instances.duplicate)}"><span class="material-symbols-outlined">content_copy</span></button>
                    <button class="transparent inst-delete" data-instance-action="delete" title="${esc(MESSAGES.instances.delete)}"><span class="material-symbols-outlined">delete</span></button>
                </div>
            </article>`;
        }).join(""));
        RxInstancesUI.checkUpdates(instances);
    };

    // Сборки из каталога Modrinth: в фоне ищем новую версию и показываем кнопку обновления
    static checkUpdates = (instances) => {
        instances.filter(instance => instance.source?.provider === "modrinth").forEach(async (instance) => {
            const update = await RxCatalog.checkPackUpdate(instance);
            if (!update) return;
            const $card = $(`#modal-instances .inst-card[data-instance="${CSS.escape(instance.id)}"]`);
            if (!$card.length || $card.find(".inst-update").length) return;
            const text = MESSAGES.instances.updateAvailable.replace("{0}", update.version_number);
            $card.find(".inst-stats").append($("<span>").addClass("inst-update-note")
                .append($("<span>").addClass("material-symbols-outlined").text("new_releases"), document.createTextNode(text)));
            $card.find(".inst-play").after($("<button>").addClass("transparent inst-update").attr({"data-instance-action": "update", title: text})
                .append($("<span>").addClass("material-symbols-outlined").text("upgrade")));
        });
    };

    // ---------- диалог создания/настройки ----------
    static fillVersions = (selected) => {
        const versions = (RxVersionsUI.allVersions || []).filter(ver => ver.type !== "pack");
        // Сначала установленные, затем остальные; вверху — Fabric/Forge/…, т.к. сборки обычно с модами
        const sorted = [...versions].sort((a, b) => (b.installed - a.installed) || RxVersionsManager.compareGameVersions(b.version, a.version));
        const $select = $("#modal-instances [data-instance-version]");
        const options = sorted.map(ver => `<option value="${RxInstancesUI.escape(ver.id)}">${RxInstancesUI.escape(ver.displayName)}${ver.installed ? " ✓" : ""}</option>`);
        if (selected && !sorted.some(ver => ver.id === selected)) options.unshift(`<option value="${RxInstancesUI.escape(selected)}">${RxInstancesUI.escape(selected)}</option>`);
        $select.html(options.join(""));
        const fallback = sorted.find(ver => ver.installed && ver.type !== "vanilla") || sorted[0];
        $select.val(selected || fallback?.id || "");
    };

    static openDialog = (id = "") => {
        RxInstancesUI.editingId = id;
        const $dialog = $("#modal-instances [data-instance-dialog]");
        const instance = id ? RxPacks.getModpackManifest(id) : null;
        const active = RxVersionsManager.getActiveVersion();
        $dialog.find("[data-dialog-title]").text(id ? MESSAGES.instances.editTitle : MESSAGES.instances.createTitle);
        $dialog.find("[data-instance-save] span:last-child").text(id ? MESSAGES.instances.save : MESSAGES.instances.create);
        $dialog.find("[data-instance-name]").val(instance?.displayName || "");
        RxInstancesUI.fillVersions(instance?.baseVersion?.full || (active.startsWith("pack-") || active === "none" ? "" : active));
        $dialog.find("[data-instance-memory-mode]").val(instance?.memory?.mode || "global");
        $dialog.find("[data-instance-memory]").val(instance?.memory?.mb || RxMemoryAdvisor.forActiveVersion().mb);
        $dialog.find("[data-instance-java]").val(instance?.javaArgs || "");
        $dialog.find("[data-instance-icon-reset]").prop("hidden", !instance || instance.icon !== "pack");
        RxInstancesUI.syncMemoryField();
        $dialog.prop("hidden", false);
        setTimeout(() => $dialog.find("[data-instance-name]").trigger("focus"), 50);
    };

    static closeDialog = () => {
        RxInstancesUI.editingId = "";
        $("#modal-instances [data-instance-dialog]").prop("hidden", true);
    };

    static syncMemoryField = () => {
        const manual = $("#modal-instances [data-instance-memory-mode]").val() === "manual";
        $("#modal-instances [data-instance-memory-row]").toggleClass("disabled", !manual).find("input").prop("disabled", !manual);
    };

    static save = () => {
        const $dialog = $("#modal-instances [data-instance-dialog]");
        const name = String($dialog.find("[data-instance-name]").val() || "").trim().slice(0, 48);
        const versionId = String($dialog.find("[data-instance-version]").val() || "");
        if (!name) return RxToasts.create(MESSAGES.instances.needName, "edit", "", "warning");
        if (!versionId.includes("-")) return RxToasts.create(MESSAGES.instances.needVersion, "deployed_code", "", "warning");
        const parsed = RxVersionsManager.parseVersionID(versionId);
        const memoryMode = $dialog.find("[data-instance-memory-mode]").val();
        const memoryMb = Math.max(1024, Math.min(65536, Math.round(Number($dialog.find("[data-instance-memory]").val()) / 256) * 256 || 4096));
        const fields = {
            displayName: name,
            baseVersion: {full: versionId, type: parsed.type, number: parsed.name},
            memory: {mode: memoryMode, mb: memoryMb},
            javaArgs: String($dialog.find("[data-instance-java]").val() || "").trim().slice(0, 1000)
        };

        if (RxInstancesUI.editingId) {
            const id = RxInstancesUI.editingId;
            RxPacks.writeModpackManifest(id, {...RxPacks.getModpackManifest(id), ...fields});
            RxToasts.create(MESSAGES.instances.saved, "check", name, "success");
        } else {
            const id = RxInstancesUI.uniqueId(name);
            ["mods", "config", "resourcepacks", "shaderpacks", "saves"].forEach(dir => fs.mkdirSync(path.join(RxInstancesUI.dirFor(id), dir), {recursive: true}));
            RxPacks.writeModpackManifest(id, {id, uuid: crypto.randomUUID(), created: Date.now(), files: [], icon: false, ...fields});
            RxVersionsManager.setActiveVersion(`pack-${id}`);
            RxToasts.create(MESSAGES.instances.created, "add_circle", name, "success");
        }
        RxInstancesUI.closeDialog();
        RxInstancesUI.render();
        RxVersionsUI.loadVersions();
    };

    static changeIcon = async () => {
        const id = RxInstancesUI.editingId;
        if (!id) return;
        const result = await ipcRenderer.invoke("open-dialog", {properties: ["openFile"], filters: [{name: "PNG", extensions: ["png"]}]});
        if (!Array.isArray(result) || !result[0]) return;
        fs.copyFileSync(result[0], path.join(RxInstancesUI.dirFor(id), "icon.png"));
        RxPacks.writeModpackManifest(id, {...RxPacks.getModpackManifest(id), icon: "pack"});
        $("#modal-instances [data-instance-icon-reset]").prop("hidden", false);
        RxInstancesUI.render();
    };

    static resetIcon = () => {
        const id = RxInstancesUI.editingId;
        if (!id) return;
        RxPacks.writeModpackManifest(id, {...RxPacks.getModpackManifest(id), icon: false});
        $("#modal-instances [data-instance-icon-reset]").prop("hidden", true);
        RxInstancesUI.render();
    };

    // ---------- действия с карточкой ----------
    static action = async (id, action, $button) => {
        const instance = RxPacks.getModpackManifest(id);
        if (!instance) return RxInstancesUI.render();
        switch (action) {
            case "play":
                RxVersionsManager.setActiveVersion(`pack-${id}`);
                await RxModals.switchModal("content");
                return RxFlyout.startSelectedVersion();
            case "mods":
                RxVersionsManager.setActiveVersion(`pack-${id}`);
                return RxModals.switchModal("mods");
            case "folder":
                return openExternal(RxInstancesUI.dirFor(id));
            case "edit":
                return RxInstancesUI.openDialog(id);
            case "update":
                $button.prop("disabled", true);
                return RxCatalog.updatePack(id);
            case "duplicate": {
                const name = `${instance.displayName} (${MESSAGES.instances.copySuffix})`.slice(0, 48);
                const newId = RxInstancesUI.uniqueId(name);
                await fsPromises.cp(RxInstancesUI.dirFor(id), RxInstancesUI.dirFor(newId), {recursive: true});
                RxPacks.writeModpackManifest(newId, {...instance, id: newId, uuid: crypto.randomUUID(), displayName: name, created: Date.now(), lastPlayed: 0});
                RxToasts.create(MESSAGES.instances.duplicated, "content_copy", name, "success");
                RxVersionsUI.loadVersions();
                return RxInstancesUI.render();
            }
            case "delete": {
                // Второе нажатие подтверждает
                if (!$button.hasClass("confirm")) {
                    $button.addClass("confirm").attr("title", MESSAGES.instances.deleteConfirm);
                    setTimeout(() => $button.removeClass("confirm"), 3000);
                    return;
                }
                const ok = await ipcRenderer.invoke("trash-instance-folder", {root: GAME_DATA, id}).catch(() => false);
                if (!ok) return RxToasts.create(MESSAGES.instances.deleteFailed, "error", instance.displayName, "error");
                if (RxVersionsManager.getActiveVersion() === `pack-${id}`) RxConfig.write("activeVersion", "none");
                RxToasts.create(MESSAGES.instances.deleted, "delete", instance.displayName);
                RxVersionsUI.loadVersions();
                return RxInstancesUI.render();
            }
        }
    };

    static importMrpack = async () => {
        const imported = await RxPacks.importModrinthPackDialog();
        if (imported) {
            RxVersionsUI.loadVersions();
            RxInstancesUI.render();
        }
    };

    // Запомнить запуск сборки — для сортировки и «играли N дней назад»
    static markPlayed = (id) => {
        try {
            const manifest = RxPacks.getModpackManifest(id);
            if (manifest) RxPacks.writeModpackManifest(id, {...manifest, lastPlayed: Date.now()});
        } catch (_) {}
    };

    static activeManifest = () => {
        const active = RxVersionsManager.getActiveVersion();
        if (!active.startsWith("pack-")) return null;
        try {
            return RxPacks.getModpackManifest(active.slice(5)) || null;
        } catch (_) {
            return null;
        }
    };

    static init = () => {
        const $modal = $("#modal-instances");
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "instances" && RxWorldsUI.view === "instances") RxInstancesUI.render();
        });
        $modal.on("click", "[data-instances-create]", () => RxInstancesUI.openDialog());
        $modal.on("click", "[data-instances-import]", () => RxInstancesUI.importMrpack());
        $modal.on("click", "[data-instances-catalog]", async () => {
            RxCatalog.state.type = "modpack";
            RxCatalog.state.category = "";
            await RxModals.switchModal("catalog");
        });
        $modal.on("click", "[data-instance-action]", function () {
            RxInstancesUI.action($(this).closest("[data-instance]").attr("data-instance"), $(this).attr("data-instance-action"), $(this));
        });
        $modal.on("click", "[data-instance-save]", () => RxInstancesUI.save());
        $modal.on("click", "[data-instance-cancel]", () => RxInstancesUI.closeDialog());
        $modal.on("click", "[data-instance-icon]", () => RxInstancesUI.changeIcon());
        $modal.on("click", "[data-instance-icon-reset]", () => RxInstancesUI.resetIcon());
        $modal.on("change", "[data-instance-memory-mode]", () => RxInstancesUI.syncMemoryField());
        $modal.on("keydown", "[data-instance-name]", (e) => { if (e.key === "Enter") RxInstancesUI.save(); });
        $modal.find("[data-instance-dialog]").on("click", (e) => { if (e.target === e.currentTarget) RxInstancesUI.closeDialog(); });
        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || $modal.find("[data-instance-dialog]").prop("hidden") || !RxModals.isModalShown("instances")) return;
            e.stopPropagation();
            RxInstancesUI.closeDialog();
        }, true);
    };
}

$(RxInstancesUI.init);
