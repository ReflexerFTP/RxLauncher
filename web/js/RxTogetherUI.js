// Раздел «Играть вместе»: код сборки, приглашение на сервер, принятие кода и история
class RxTogetherUI {
    static lastShared = null;
    static pending = null;

    static $modal = () => $("#modal-together");
    static t = (key) => MESSAGES.together[key];
    static escape = (value) => RxInstancesUI.escape(value);
    static clipboard = () => require("electron").clipboard;

    static loaderLabel = (loader) => RxVersionsUI.TYPE_LABELS[loader] || RxUtils.capitalizeWord(loader);

    static setBusy = ($button, busy, icon) => {
        $button.prop("disabled", busy).find(".material-symbols-outlined").first().text(busy ? "progress_activity" : icon).toggleClass("spin", busy);
    };

    // Сборки и установленные версии, которыми можно поделиться
    static fillSources = () => {
        const $select = RxTogetherUI.$modal().find("[data-share-source]");
        const current = $select.val() || RxVersionsManager.getActiveVersion();
        const options = RxInstancesUI.list().map(instance => ({id: `pack-${instance.id}`, label: `${instance.displayName} · ${RxTogetherUI.t("instance")}`}));
        (RxVersionsUI.allVersions || [])
            .filter(version => version.installed && RxShare.LOADERS.includes(version.type))
            .forEach(version => options.push({id: version.id, label: version.displayName}));
        $select.html(options.map(option => `<option value="${RxTogetherUI.escape(option.id)}">${RxTogetherUI.escape(option.label)}</option>`).join(""));
        $select.val(options.some(option => option.id === current) ? current : options[0]?.id || "");
        const servers = RxMinecraftServers.getSavedServers().slice(0, 6);
        RxTogetherUI.$modal().find("[data-share-servers]").html(servers.map(server =>
            `<button type="button" data-server-chip="${RxTogetherUI.escape(server.ip)}">${RxTogetherUI.escape(server.name)}</button>`).join(""));
    };

    static shareSource = () => {
        const versionId = String(RxTogetherUI.$modal().find("[data-share-source]").val() || "");
        if (!versionId) {
            RxToasts.create(RxTogetherUI.t("noSource"), "warning");
            return "";
        }
        return versionId;
    };

    static serverValue = () => {
        const value = String(RxTogetherUI.$modal().find("[data-share-server]").val() || "").trim();
        if (!value) return "";
        try {
            return RxMinecraftServers.normalizeAddress(value);
        } catch (_) {
            RxToasts.create(RxTogetherUI.t("badServer"), "warning", value);
            return null;
        }
    };

    static errorText = (error) => ({
        customVersion: RxTogetherUI.t("customVersion"),
        badCode: RxTogetherUI.t("badCode"),
        badServer: RxTogetherUI.t("badServer"),
        noSource: RxTogetherUI.t("noSource")
    })[error?.message] || RxTogetherUI.t("offline");

    static makeCode = async ($button) => {
        const versionId = RxTogetherUI.shareSource();
        const server = RxTogetherUI.serverValue();
        if (!versionId || server === null) return;
        RxTogetherUI.setBusy($button, true, "key");
        try {
            const result = await RxShare.createCode(versionId, server);
            RxTogetherUI.lastShared = result;
            const esc = RxTogetherUI.escape;
            const $result = RxTogetherUI.$modal().find("[data-share-result]").prop("hidden", false);
            $result.find("[data-share-code]").text(result.code);
            const total = result.data.m.length + result.data.r.length + result.data.s.length;
            const parts = [
                `<span><span class="material-symbols-outlined">deployed_code</span>${esc(`${RxTogetherUI.loaderLabel(result.data.l)} ${result.data.g}`)}</span>`,
                `<span><span class="material-symbols-outlined">extension</span>${esc(RxTogetherUI.t("filesInCode").replace("{0}", total))}</span>`
            ];
            if (result.data.sv) parts.push(`<span><span class="material-symbols-outlined">dns</span>${esc(result.data.sv)}</span>`);
            if (result.unknown.length) parts.push(`<span class="warn"><span class="material-symbols-outlined">warning</span>${esc(RxTogetherUI.t("notOnModrinth").replace("{0}", result.unknown.length))}</span>`);
            $result.find("[data-share-meta]").html(parts.join(""));
            RxTogetherUI.copy(RxTogetherUI.inviteText(result.data, result.code), RxTogetherUI.t("inviteCopied"));
            RxTogetherUI.renderHistory();
        } catch (error) {
            RxCollector.writeLog(`Share: Code failed [error=${error?.stack || error}]`);
            RxToasts.create(RxTogetherUI.t("codeFailed"), "error", RxTogetherUI.errorText(error), "error");
        } finally {
            RxTogetherUI.setBusy($button, false, "key");
        }
    };

    static inviteText = (data, code) => RxTogetherUI.t("inviteText")
        .replace("{name}", data.n)
        .replace("{version}", `${RxTogetherUI.loaderLabel(data.l)} ${data.g}`)
        .replace("{server}", data.sv ? RxTogetherUI.t("inviteServer").replace("{0}", data.sv) : "")
        .replace("{code}", code);

    static copy = (text, toast) => {
        RxTogetherUI.clipboard().writeText(text);
        RxToasts.create(toast, "content_copy", "", "success");
    };

    static exportMrpack = async ($button) => {
        const versionId = RxTogetherUI.shareSource();
        if (!versionId) return;
        let source;
        try {
            source = RxShare.describe(versionId);
        } catch (error) {
            return RxToasts.create(RxTogetherUI.errorText(error), "warning");
        }
        const target = await ipcRenderer.invoke("save-dialog", {
            title: RxTogetherUI.t("exportMrpack"),
            defaultPath: `${source.name.replace(/[<>:"/\\|?*]+/g, "_")}.mrpack`,
            properties: ["dontAddToRecent"],
            filters: [{name: "Modrinth", extensions: ["mrpack"]}]
        });
        if (!target) return;
        RxTogetherUI.setBusy($button, true, "archive");
        try {
            const result = await RxShare.exportMrpack(versionId, target);
            RxToasts.create(RxTogetherUI.t("exported"), "archive", RxTogetherUI.t("exportedText").replace("{0}", result.files).replace("{1}", result.embedded), "success");
        } catch (error) {
            RxCollector.writeLog(`Share: Export failed [error=${error?.stack || error}]`);
            RxToasts.create(RxTogetherUI.t("exportFailed"), "error", RxTogetherUI.errorText(error), "error");
        } finally {
            RxTogetherUI.setBusy($button, false, "archive");
        }
    };

    // ---------- принять код ----------
    static check = (text = null) => {
        const $modal = RxTogetherUI.$modal();
        const value = text ?? String($modal.find("[data-join-code]").val() || "");
        try {
            const data = RxShare.decode(value);
            RxTogetherUI.pending = data;
            const esc = RxTogetherUI.escape;
            $modal.find("[data-join-name]").text(data.n);
            $modal.find("[data-join-sub]").text(data.by ? RxTogetherUI.t("fromPlayer").replace("{0}", data.by) : RxTogetherUI.t("fromFriend"));
            const stats = [
                `<span><span class="material-symbols-outlined">deployed_code</span>${esc(`${RxTogetherUI.loaderLabel(data.l)} ${data.g}`)}</span>`,
                `<span><span class="material-symbols-outlined">extension</span>${esc(RxTogetherUI.t("modsCount").replace("{0}", data.m.length))}</span>`
            ];
            if (data.r.length) stats.push(`<span><span class="material-symbols-outlined">texture</span>${esc(RxTogetherUI.t("rpCount").replace("{0}", data.r.length))}</span>`);
            if (data.s.length) stats.push(`<span><span class="material-symbols-outlined">wb_sunny</span>${esc(RxTogetherUI.t("shaderCount").replace("{0}", data.s.length))}</span>`);
            if (data.sv) stats.push(`<span><span class="material-symbols-outlined">dns</span>${esc(data.sv)}</span>`);
            $modal.find("[data-join-stats]").html(stats.join(""));
            $modal.find('[data-join-action="install-play"] span:last-child').text(data.sv ? RxTogetherUI.t("installJoin") : RxTogetherUI.t("installPlay"));
            $modal.find("[data-join-preview]").prop("hidden", false);
            return true;
        } catch (error) {
            RxTogetherUI.pending = null;
            $modal.find("[data-join-preview]").prop("hidden", true);
            RxToasts.create(RxTogetherUI.errorText(error), "error", "", "error");
            return false;
        }
    };

    static install = async (play, $button) => {
        const data = RxTogetherUI.pending;
        if (!data) return;
        const $buttons = RxTogetherUI.$modal().find("[data-join-action^='install']").prop("disabled", true);
        RxTogetherUI.setBusy($button, true, play ? "play_arrow" : "download");
        try {
            const {id, missing} = await RxShare.install(data);
            const name = RxPacks.getModpackManifest(id)?.displayName || data.n;
            RxToasts.create(RxTogetherUI.t("installed"), "task_alt", missing.length ? RxTogetherUI.t("missingFiles").replace("{0}", missing.length) : name, missing.length ? "warning" : "success");
            RxTogetherUI.renderHistory();
            if (play) {
                if (data.sv) selectedServerFromList = data.sv;
                await RxModals.switchModal("content");
                RxFlyout.startSelectedVersion();
            }
        } catch (error) {
            RxCollector.writeLog(`Share: Install from code failed [error=${error?.stack || error}]`);
            RxToasts.create(RxTogetherUI.t("installFailed"), "error", RxTogetherUI.errorText(error), "error");
        } finally {
            $buttons.prop("disabled", false);
            RxTogetherUI.setBusy($button, false, play ? "play_arrow" : "download");
        }
    };

    // ---------- история ----------
    static renderHistory = () => {
        const history = RxShare.history();
        const esc = RxTogetherUI.escape;
        const format = new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"});
        RxTogetherUI.$modal().find("[data-history-wrap]").prop("hidden", history.length === 0);
        RxTogetherUI.$modal().find("[data-history]").html(history.map((item, index) => {
            const instanceReady = item.instance && RxPacks.isModpackExists(item.instance);
            const detail = [item.direction === "sent" ? RxTogetherUI.t("sent") : (item.from ? RxTogetherUI.t("fromPlayer").replace("{0}", item.from) : RxTogetherUI.t("received")),
                item.server, format.format(new Date(item.time))].filter(Boolean).join(" · ");
            return `<div class="tg-history-row" data-history-index="${index}">
                <span class="material-symbols-outlined">${item.direction === "sent" ? "north_east" : "south_west"}</span>
                <div class="tg-history-copy"><strong>${esc(item.name)}</strong><span>${esc(detail)}</span></div>
                ${instanceReady ? `<button data-history-action="play" title="${esc(MESSAGES.flyout.play)}"><span class="material-symbols-outlined">play_arrow</span></button>` : ""}
                <button class="transparent" data-history-action="copy" title="${esc(RxTogetherUI.t("copyCode"))}"><span class="material-symbols-outlined">content_copy</span></button>
            </div>`;
        }).join(""));
    };

    static historyAction = async (index, action) => {
        const item = RxShare.history()[index];
        if (!item) return;
        if (action === "copy") return RxTogetherUI.copy(item.code, RxTogetherUI.t("codeCopied"));
        if (action === "play" && item.instance) {
            RxVersionsManager.setActiveVersion(`pack-${item.instance}`);
            if (item.server) selectedServerFromList = item.server;
            await RxModals.switchModal("content");
            RxFlyout.startSelectedVersion();
        }
    };

    // Открыть раздел с уже выбранной сборкой (кнопка «Поделиться» на карточке сборки)
    static openFor = async (versionId) => {
        await RxModals.switchModal("together");
        RxTogetherUI.$modal().find("[data-share-source]").val(versionId);
        RxTogetherUI.$modal().find("[data-share-result]").prop("hidden", true);
    };

    static init = () => {
        const $modal = RxTogetherUI.$modal();
        if (!$modal.length) return;
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "together") return;
            RxTogetherUI.fillSources();
            RxTogetherUI.renderHistory();
        });
        $modal.on("click", "[data-server-chip]", function () { $modal.find("[data-share-server]").val($(this).attr("data-server-chip")); });
        $modal.on("click", '[data-share-action="code"]', function () { RxTogetherUI.makeCode($(this)); });
        $modal.on("click", '[data-share-action="mrpack"]', function () { RxTogetherUI.exportMrpack($(this)); });
        $modal.on("click", '[data-share-action="copy-invite"]', () => {
            const shared = RxTogetherUI.lastShared;
            if (shared) RxTogetherUI.copy(RxTogetherUI.inviteText(shared.data, shared.code), RxTogetherUI.t("inviteCopied"));
        });
        $modal.on("click", '[data-share-action="copy-code"]', () => {
            if (RxTogetherUI.lastShared) RxTogetherUI.copy(RxTogetherUI.lastShared.code, RxTogetherUI.t("codeCopied"));
        });
        $modal.on("click", '[data-join-action="paste"]', () => {
            const text = RxTogetherUI.clipboard().readText();
            $modal.find("[data-join-code]").val(text);
            if (/RX1-/.test(text)) RxTogetherUI.check(text);
        });
        $modal.on("click", '[data-join-action="check"]', () => RxTogetherUI.check());
        $modal.on("input", "[data-join-code]", () => $modal.find("[data-join-preview]").prop("hidden", true));
        $modal.on("click", '[data-join-action="install-play"]', function () { RxTogetherUI.install(true, $(this)); });
        $modal.on("click", '[data-join-action="install"]', function () { RxTogetherUI.install(false, $(this)); });
        $modal.on("click", "[data-history-action]", function () {
            RxTogetherUI.historyAction(Number($(this).closest("[data-history-index]").attr("data-history-index")), $(this).attr("data-history-action"));
        });
    };
}

$(RxTogetherUI.init);
