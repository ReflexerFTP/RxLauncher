class RxSkinBrowserUI {
    static viewerScriptPromise = null;

    static ensureViewerScript = async () => {
        if (typeof skinview3d !== "undefined") return true;
        try { loadRxLibrary("skinview3d"); return typeof skinview3d !== "undefined"; }
        catch (_) { return false; }
    };
    static CONFIG_KEY = "skinSearchHistory";
    static MAX_RECENT = 8;
    static DEFAULT_SKIN_PATH = "assets/skins/default-steve.png";
    static NICKNAME_PATTERN = /^[A-Za-z0-9_]{2,16}$/;

    static bound = false;
    static visible = false;
    static viewer = null;
    static resizeObserver = null;
    static viewerToken = 0;
    static lookupToken = 0;
    static actionTokens = {download: 0, apply: 0};
    static actionBusy = {download: false, apply: false};
    static currentProfile = null;

    static message = (key, fallback = "") => {
        let value = typeof MESSAGES !== "undefined" ? MESSAGES?.skins : null;
        for (const part of String(key || "").split(".")) {
            if (!part || !value || typeof value !== "object") return fallback;
            value = value[part];
        }
        return typeof value === "string" && value.trim() ? value : fallback;
    };

    static createDefaultProfile = () => ({
        name: RxSkinBrowserUI.message("defaultName", "Steve"),
        id: "",
        model: "default",
        skinPath: RxSkinBrowserUI.DEFAULT_SKIN_PATH,
        fromCache: false,
        updatedAt: null,
        isDefault: true
    });

    static normalizeModel = (model) => String(model || "").toLowerCase() === "slim" ? "slim" : "default";

    static normalizeProfile = (profile) => {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
        const name = String(profile.name || "").trim();
        const id = String(profile.id || "").replace(/-/g, "").toLowerCase();
        const skinPath = String(profile.skinPath || "").trim();
        if (!RxSkinBrowserUI.NICKNAME_PATTERN.test(name)
            || !/^[0-9a-f]{32}$/.test(id)
            || !skinPath
            || skinPath.length > 32768) {
            return null;
        }

        const updatedAt = Number(profile.updatedAt);
        return {
            name,
            id,
            model: RxSkinBrowserUI.normalizeModel(profile.model),
            skinPath,
            fromCache: profile.fromCache === true,
            updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
            isDefault: false
        };
    };

    static bind = () => {
        if (RxSkinBrowserUI.bound) return true;
        const $modal = $("#modal-skins");
        if ($modal.length === 0) return false;
        RxSkinBrowserUI.bound = true;

        $modal.on("submit", "[data-skin-search-form]", async (event) => {
            event.preventDefault();
            await RxSkinBrowserUI.search();
        });

        $modal.on("click", "[data-skin-action]", async function (event) {
            event.preventDefault();
            const action = String($(this).data("skin-action") || "");
            switch (action) {
                case "search":
                    await RxSkinBrowserUI.search();
                    break;
                case "download":
                    await RxSkinBrowserUI.download();
                    break;
                case "apply":
                    await RxSkinBrowserUI.apply();
                    break;
                case "reset":
                    RxSkinBrowserUI.reset();
                    break;
                case "clear-recent":
                    RxSkinBrowserUI.clearRecent();
                    break;
            }
        });

        $modal.on("click", "[data-skin-recent-nickname]", async function () {
            const nickname = String($(this).data("skin-recent-nickname") || "");
            if (!RxSkinBrowserUI.NICKNAME_PATTERN.test(nickname)) return;
            $modal.find("[data-skin-search-input]").val(nickname);
            await RxSkinBrowserUI.search(nickname);
        });

        $modal.on("keydown", "[data-skin-recent-nickname]", async function (event) {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            $(this).trigger("click");
        });

        RxSkinBrowserUI.currentProfile = RxSkinBrowserUI.createDefaultProfile();
        RxSkinBrowserUI.renderProfile(RxSkinBrowserUI.currentProfile);
        RxSkinBrowserUI.renderRecent();
        RxSkinBrowserUI.setStatus(
            "ready",
            RxSkinBrowserUI.message("readyTitle", "Поиск скинов готов"),
            RxSkinBrowserUI.message("readyHint", "Введите ник игрока Minecraft Java Edition."),
            "verified"
        );
        return true;
    };

    static onShow = () => {
        RxSkinBrowserUI.visible = true;
        if (!RxSkinBrowserUI.bound) RxSkinBrowserUI.bind();
        RxSkinBrowserUI.renderRecent();
        window.requestAnimationFrame(() => {
            if (!RxSkinBrowserUI.visible) return;
            RxSkinBrowserUI.mountViewer(RxSkinBrowserUI.currentProfile || RxSkinBrowserUI.createDefaultProfile());
            window.setTimeout(() => {
                if (RxSkinBrowserUI.visible) $("#modal-skins [data-skin-search-input]").trigger("focus");
            }, 180);
        });
    };

    static onHide = () => {
        RxSkinBrowserUI.visible = false;
        RxSkinBrowserUI.lookupToken += 1;
        RxSkinBrowserUI.actionTokens.download += 1;
        RxSkinBrowserUI.actionTokens.apply += 1;
        RxSkinBrowserUI.setSearchBusy(false);
        RxSkinBrowserUI.setPreviewLoading(false);
        RxSkinBrowserUI.disposeViewer();
    };

    static locale = () => {
        const language = typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru";
        return language === "ru" ? "ru-RU" : "en-US";
    };

    static formatDate = (timestamp, includeTime = true) => {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return "—";
        try {
            return new Intl.DateTimeFormat(RxSkinBrowserUI.locale(), includeTime
                ? {day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"}
                : {day: "2-digit", month: "short"}
            ).format(new Date(value));
        } catch (_) {
            return new Date(value).toLocaleString();
        }
    };

    static formatUuid = (uuid) => {
        const clean = String(uuid || "").replace(/-/g, "").toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(clean)) return "—";
        return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    };

    static modelLabel = (model) => RxSkinBrowserUI.normalizeModel(model) === "slim"
        ? RxSkinBrowserUI.message("models.slim", "Slim")
        : RxSkinBrowserUI.message("models.classic", "Classic");

    static renderProfile = (profile) => {
        const normalized = profile?.isDefault === true ? {...RxSkinBrowserUI.createDefaultProfile(), ...profile} : profile;
        RxSkinBrowserUI.currentProfile = normalized || RxSkinBrowserUI.createDefaultProfile();
        RxSkinBrowserUI.actionTokens.download += 1;
        RxSkinBrowserUI.actionTokens.apply += 1;
        const current = RxSkinBrowserUI.currentProfile;
        const $modal = $("#modal-skins");
        const hasRemoteProfile = current.isDefault !== true && Boolean(current.id);
        const modelLabel = RxSkinBrowserUI.modelLabel(current.model);

        $modal.find("[data-skin-profile-name]").text(current.name);
        $modal.find("[data-skin-profile-id]")
            .text(hasRemoteProfile ? RxSkinBrowserUI.formatUuid(current.id) : "—")
            .attr("title", hasRemoteProfile ? RxSkinBrowserUI.formatUuid(current.id) : "");
        $modal.find("[data-skin-profile-model]").text(modelLabel);
        $modal.find("[data-skin-profile-updated]").text(RxSkinBrowserUI.formatDate(current.updatedAt));
        $modal.find("[data-skin-model-label]").text(modelLabel);
        $modal.find("[data-skin-source-pill]").prop("hidden", current.fromCache !== true);
        $modal.find('[data-skin-action="download"]')
            .prop("disabled", !hasRemoteProfile || RxSkinBrowserUI.actionBusy.download);
        $modal.find('[data-skin-action="apply"]')
            .prop("disabled", !hasRemoteProfile || RxSkinBrowserUI.actionBusy.apply);

        const source = RxSkinBrowserUI.toRenderableSource(current.skinPath || RxSkinBrowserUI.DEFAULT_SKIN_PATH);
        const $image = $modal.find("[data-skin-fallback-image]");
        $modal.find("[data-skin-preview-unavailable]").prop("hidden", true);
        $image
            .off(".rxSkinBrowser")
            .removeClass("is-hidden")
            .attr("alt", current.name)
            .on("load.rxSkinBrowser", () => {
                $modal.find("[data-skin-preview-unavailable]").prop("hidden", true);
            })
            .on("error.rxSkinBrowser", () => {
                if (!$modal.find("[data-skin-viewer-canvas]").hasClass("is-visible")) {
                    $image.addClass("is-hidden");
                    $modal.find("[data-skin-preview-unavailable]").prop("hidden", false);
                }
            });
        $image.attr("src", source);

        RxSkinBrowserUI.disposeViewer();
        if (RxSkinBrowserUI.visible) {
            window.requestAnimationFrame(() => RxSkinBrowserUI.mountViewer(current));
        }
    };

    static toRenderableSource = (skinPath) => {
        const value = String(skinPath || "").trim();
        if (!value) return RxSkinBrowserUI.DEFAULT_SKIN_PATH;
        if (/^(?:data:image\/png;base64,|https:\/\/|file:\/\/)/i.test(value)) return value;
        try {
            if (typeof path !== "undefined" && typeof pathToFileURL === "function" && path.isAbsolute(value)) {
                return pathToFileURL(path.normalize(value)).href;
            }
        } catch (_) {
            // Relative packaged assets are intentionally left as relative URLs.
        }
        return value.replace(/\\/g, "/");
    };

    static mountViewer = async (profile) => {
        if (!RxSkinBrowserUI.visible || !profile) return false;
        RxSkinBrowserUI.disposeViewer();
        const token = RxSkinBrowserUI.viewerToken;
        if (!(await RxSkinBrowserUI.ensureViewerScript()) || token !== RxSkinBrowserUI.viewerToken || !RxSkinBrowserUI.visible) return false;
        const $modal = $("#modal-skins");
        $modal.find("[data-skin-fallback-image]").removeClass("is-hidden");
        const canvas = $modal.find("[data-skin-viewer-canvas]")[0];
        const stage = $modal.find("[data-skin-preview-stage]")[0];
        if (!canvas || !stage || typeof skinview3d === "undefined" || typeof skinview3d.SkinViewer !== "function") {
            return false;
        }

        const bounds = stage.getBoundingClientRect();
        const width = Math.max(260, Math.round(bounds.width || 360));
        const height = Math.max(260, Math.round(bounds.height || 420));
        const source = RxSkinBrowserUI.toRenderableSource(profile.skinPath || RxSkinBrowserUI.DEFAULT_SKIN_PATH);
        let viewer = null;

        try {
            viewer = new skinview3d.SkinViewer({
                canvas,
                width,
                height,
                model: RxSkinBrowserUI.normalizeModel(profile.model),
                zoom: 0.86,
                fov: 50,
                pixelRatio: "match-device"
            });
            viewer.background = null;
            viewer.autoRotate = typeof RxConfig === "undefined"
                || RxConfig.read("disableAnimations", false) !== true;
            viewer.autoRotateSpeed = 0.55;
            if (viewer.controls) {
                viewer.controls.enablePan = false;
                viewer.controls.enableZoom = true;
                viewer.controls.enableRotate = true;
            }

            // Publish the viewer before the asynchronous texture load so closing
            // the modal can immediately stop its render loop and release WebGL.
            RxSkinBrowserUI.viewer = viewer;
            await viewer.loadSkin(source, {model: RxSkinBrowserUI.normalizeModel(profile.model)});
            if (token !== RxSkinBrowserUI.viewerToken || !RxSkinBrowserUI.visible) {
                try { viewer.dispose(); } catch (_) { /* already released */ }
                if (RxSkinBrowserUI.viewer === viewer) RxSkinBrowserUI.viewer = null;
                return false;
            }

            if (typeof skinview3d.IdleAnimation === "function"
                && (typeof RxConfig === "undefined" || RxConfig.read("disableAnimations", false) !== true)) {
                viewer.animation = new skinview3d.IdleAnimation();
            }
            $modal.find("[data-skin-viewer-canvas]").addClass("is-visible");
            $modal.find("[data-skin-fallback-image]").addClass("is-hidden");
            $modal.find("[data-skin-preview-unavailable]").prop("hidden", true);

            if (typeof ResizeObserver === "function") {
                RxSkinBrowserUI.resizeObserver = new ResizeObserver((entries) => {
                    if (!RxSkinBrowserUI.viewer || RxSkinBrowserUI.viewer.disposed) return;
                    const rect = entries[0]?.contentRect;
                    if (!rect || rect.width < 1 || rect.height < 1) return;
                    RxSkinBrowserUI.viewer.setSize(Math.round(rect.width), Math.round(rect.height));
                });
                RxSkinBrowserUI.resizeObserver.observe(stage);
            } else {
                $(window).off("resize.rxSkinBrowser").on("resize.rxSkinBrowser", () => {
                    if (!RxSkinBrowserUI.viewer || RxSkinBrowserUI.viewer.disposed) return;
                    const rect = stage.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        RxSkinBrowserUI.viewer.setSize(Math.round(rect.width), Math.round(rect.height));
                    }
                });
            }
            return true;
        } catch (error) {
            if (viewer) {
                try { viewer.dispose(); } catch (_) { /* already released */ }
            }
            if (RxSkinBrowserUI.viewer === viewer) RxSkinBrowserUI.viewer = null;
            if (token !== RxSkinBrowserUI.viewerToken) return false;
            if (token === RxSkinBrowserUI.viewerToken) {
                $modal.find("[data-skin-viewer-canvas]").removeClass("is-visible");
                $modal.find("[data-skin-fallback-image]").removeClass("is-hidden");
            }
            RxSkinBrowserUI.log(`Skins: 3D preview unavailable [error=${error?.message || error}]`);
            return false;
        }
    };

    static disposeViewer = () => {
        RxSkinBrowserUI.viewerToken += 1;
        if (RxSkinBrowserUI.resizeObserver) {
            RxSkinBrowserUI.resizeObserver.disconnect();
            RxSkinBrowserUI.resizeObserver = null;
        }
        $(window).off("resize.rxSkinBrowser");
        if (RxSkinBrowserUI.viewer) {
            try {
                // Сразу отдаём WebGL-контекст: иначе Chromium держит видеопамять до следующей сборки
                RxSkinBrowserUI.viewer.renderer?.forceContextLoss?.();
                RxSkinBrowserUI.viewer.dispose();
            } catch (error) {
                RxSkinBrowserUI.log(`Skins: Failed to dispose 3D preview [error=${error?.message || error}]`);
            }
            RxSkinBrowserUI.viewer = null;
        }
        const canvas = $("#modal-skins [data-skin-viewer-canvas]").removeClass("is-visible")[0];
        if (canvas && canvas.parentNode) {
            // A canvas is permanently bound to its first context type. Replacing
            // the released node guarantees that the next SkinViewer can request
            // WebGL and also drops any listeners left by the old controls.
            const replacement = canvas.cloneNode(false);
            replacement.classList.remove("is-visible");
            canvas.replaceWith(replacement);
        }
    };

    static search = async (requestedNickname = "") => {
        const $modal = $("#modal-skins");
        const $input = $modal.find("[data-skin-search-input]");
        const nickname = String(requestedNickname || $input.val() || "").trim();
        if (!RxSkinBrowserUI.NICKNAME_PATTERN.test(nickname)) {
            RxSkinBrowserUI.setStatus(
                "error",
                RxSkinBrowserUI.message("invalidNicknameTitle", "Некорректный ник"),
                RxSkinBrowserUI.message("invalidNickname", "Используйте 1–16 латинских букв, цифр или знак подчёркивания."),
                "person_alert"
            );
            $input.trigger("focus").trigger("select");
            return false;
        }

        const token = ++RxSkinBrowserUI.lookupToken;
        RxSkinBrowserUI.setSearchBusy(true);
        RxSkinBrowserUI.setPreviewLoading(true);
        RxSkinBrowserUI.setStatus(
            "loading",
            RxSkinBrowserUI.message("loading", "Ищем скин"),
            RxSkinBrowserUI.message("loadingHint", "Проверяем профиль Minecraft и загружаем текстуру."),
            "progress_activity"
        );

        try {
            const response = await ipcRenderer.invoke("minecraft-skin-lookup", nickname);
            if (token !== RxSkinBrowserUI.lookupToken) return false;

            if (!response || response.success !== true) {
                RxSkinBrowserUI.showLookupError(response?.error);
                return false;
            }
            if (response.found !== true) {
                RxSkinBrowserUI.renderProfile(RxSkinBrowserUI.createDefaultProfile());
                RxSkinBrowserUI.setStatus(
                    "warning",
                    RxSkinBrowserUI.message("notFoundTitle", "Скин не найден"),
                    RxSkinBrowserUI.message("notFoundHint", "Проверьте ник — показан стандартный Steve."),
                    "person_off"
                );
                return false;
            }

            const profile = RxSkinBrowserUI.normalizeProfile(response.profile);
            if (!profile) {
                RxSkinBrowserUI.showLookupError("invalid_response");
                return false;
            }

            $input.val(profile.name);
            RxSkinBrowserUI.renderProfile(profile);
            RxSkinBrowserUI.addRecent(profile);
            RxSkinBrowserUI.setStatus(
                "success",
                RxSkinBrowserUI.message("foundTitle", "Скин найден"),
                profile.fromCache
                    ? RxSkinBrowserUI.message("foundCacheHint", "Показана проверенная локальная копия.")
                    : RxSkinBrowserUI.message("foundHint", "Текстура готова к скачиванию или применению."),
                profile.fromCache ? "offline_bolt" : "check_circle"
            );
            return true;
        } catch (error) {
            if (token === RxSkinBrowserUI.lookupToken) RxSkinBrowserUI.showLookupError(error?.message || "network_error");
            return false;
        } finally {
            if (token === RxSkinBrowserUI.lookupToken) {
                RxSkinBrowserUI.setSearchBusy(false);
                RxSkinBrowserUI.setPreviewLoading(false);
            }
        }
    };

    static showLookupError = (error) => {
        const errorCode = RxSkinBrowserUI.normalizeErrorCode(error);
        const hint = RxSkinBrowserUI.message(
            `errors.${errorCode}`,
            RxSkinBrowserUI.message("lookupError", "Не удалось загрузить скин. Проверьте интернет и попробуйте снова.")
        );
        RxSkinBrowserUI.setStatus(
            errorCode === "rate_limited" ? "warning" : "error",
            RxSkinBrowserUI.message("errorTitle", "Ошибка поиска"),
            hint,
            errorCode === "rate_limited" ? "timer" : "cloud_off"
        );
        RxSkinBrowserUI.log(`Skins: Lookup failed [error=${errorCode}]`);
    };

    static normalizeErrorCode = (error) => {
        const code = typeof error === "string"
            ? error
            : String(error?.code || error?.message || "unknown");
        const normalized = code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
        const known = [
            "invalid_nickname", "not_found", "offline", "network_error", "rate_limited",
            "service_unavailable", "invalid_response", "invalid_signature", "invalid_texture",
            "timeout", "no_active_account", "unsupported_account", "cache_miss",
            "apply_failed", "export_failed", "untrusted_sender"
        ];
        return known.includes(normalized) ? normalized : "unknown";
    };

    static download = async () => {
        if (RxSkinBrowserUI.actionBusy.download) return false;
        const profile = RxSkinBrowserUI.currentProfile;
        if (!profile || profile.isDefault || !profile.id) return false;
        const actionToken = ++RxSkinBrowserUI.actionTokens.download;
        RxSkinBrowserUI.setActionBusy("download", true);
        try {
            const response = await ipcRenderer.invoke("minecraft-skin-export", {
                profileId: profile.id,
                nickname: profile.name,
                language: typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru"
            });
            if (actionToken !== RxSkinBrowserUI.actionTokens.download) return false;
            if (response?.canceled === true) return false;
            if (response?.success !== true) {
                RxSkinBrowserUI.showActionError("export", response?.error);
                return false;
            }
            RxSkinBrowserUI.setStatus(
                "success",
                RxSkinBrowserUI.message("downloadedTitle", "Текстура сохранена"),
                RxSkinBrowserUI.message("downloadedHint", "PNG сохранён в выбранную папку."),
                "download_done"
            );
            RxSkinBrowserUI.notify(
                RxSkinBrowserUI.message("downloadedTitle", "Текстура сохранена"),
                "download_done",
                String(response.path || profile.name)
            );
            return true;
        } catch (error) {
            if (actionToken === RxSkinBrowserUI.actionTokens.download) {
                RxSkinBrowserUI.showActionError("export", error?.message);
            }
            return false;
        } finally {
            RxSkinBrowserUI.setActionBusy("download", false);
        }
    };

    static apply = async () => {
        if (RxSkinBrowserUI.actionBusy.apply) return false;
        const profile = RxSkinBrowserUI.currentProfile;
        if (!profile || profile.isDefault || !profile.id) return false;
        const accountUuid = typeof RxAccountsManager !== "undefined"
            ? RxAccountsManager.getActiveAccount()
            : "none";
        if (!accountUuid || accountUuid === "none") {
            RxSkinBrowserUI.setStatus(
                "warning",
                RxSkinBrowserUI.message("noAccountTitle", "Аккаунт не выбран"),
                RxSkinBrowserUI.message("noAccountHint", "Сначала выберите аккаунт на главной странице."),
                "manage_accounts"
            );
            return false;
        }

        const actionToken = ++RxSkinBrowserUI.actionTokens.apply;
        RxSkinBrowserUI.setActionBusy("apply", true);
        try {
            const response = await ipcRenderer.invoke("minecraft-skin-apply", {
                profileId: profile.id,
                accountUuid
            });
            if (actionToken !== RxSkinBrowserUI.actionTokens.apply) return false;
            if (response?.success !== true) {
                RxSkinBrowserUI.showActionError("apply", response?.error);
                return false;
            }
            RxSkinBrowserUI.setStatus(
                "success",
                RxSkinBrowserUI.message("appliedTitle", "Скин применён"),
                RxSkinBrowserUI.message("appliedHint", "Аватар выбранного профиля обновлён в лаунчере."),
                "checkroom"
            );
            if (typeof RxAccountsUI !== "undefined") {
                RxAccountsUI.reloadAccountsManager();
                RxAccountsUI.reloadAccountSelect();
            }
            RxSkinBrowserUI.notify(
                RxSkinBrowserUI.message("appliedTitle", "Скин применён"),
                "checkroom",
                profile.name
            );
            return true;
        } catch (error) {
            if (actionToken === RxSkinBrowserUI.actionTokens.apply) {
                RxSkinBrowserUI.showActionError("apply", error?.message);
            }
            return false;
        } finally {
            RxSkinBrowserUI.setActionBusy("apply", false);
        }
    };

    static showActionError = (action, error) => {
        const code = RxSkinBrowserUI.normalizeErrorCode(error);
        const fallback = action === "apply"
            ? RxSkinBrowserUI.message("applyError", "Не удалось применить скин к выбранному аккаунту.")
            : RxSkinBrowserUI.message("exportError", "Не удалось сохранить PNG-текстуру.");
        RxSkinBrowserUI.setStatus(
            "error",
            RxSkinBrowserUI.message("actionErrorTitle", "Действие не выполнено"),
            RxSkinBrowserUI.message(`errors.${code}`, fallback),
            "error"
        );
        RxSkinBrowserUI.log(`Skins: ${action} failed [error=${code}]`);
    };

    static reset = () => {
        RxSkinBrowserUI.lookupToken += 1;
        RxSkinBrowserUI.setSearchBusy(false);
        RxSkinBrowserUI.setPreviewLoading(false);
        $("#modal-skins [data-skin-search-input]").val("");
        RxSkinBrowserUI.renderProfile(RxSkinBrowserUI.createDefaultProfile());
        RxSkinBrowserUI.setStatus(
            "ready",
            RxSkinBrowserUI.message("readyTitle", "Поиск скинов готов"),
            RxSkinBrowserUI.message("readyHint", "Введите ник игрока Minecraft Java Edition."),
            "verified"
        );
    };

    static setSearchBusy = (busy) => {
        const $modal = $("#modal-skins");
        const $button = $modal.find('[data-skin-action="search"]');
        const $icon = $button.find(".material-symbols-outlined").first();
        if (!$button.data("skin-original-icon")) $button.data("skin-original-icon", $icon.text());
        $button.prop("disabled", busy === true).toggleClass("is-loading", busy === true);
        $icon.text(busy ? "progress_activity" : String($button.data("skin-original-icon") || "manage_search"));
        $modal.find("[data-skin-search-input]").attr("aria-busy", busy ? "true" : "false");
    };

    static setActionBusy = (action, busy) => {
        if (!Object.prototype.hasOwnProperty.call(RxSkinBrowserUI.actionBusy, action)) return;
        RxSkinBrowserUI.actionBusy[action] = busy === true;
        const $button = $(`#modal-skins [data-skin-action="${action}"]`);
        const $icon = $button.find(".material-symbols-outlined").first();
        if (!$button.data("skin-original-icon")) $button.data("skin-original-icon", $icon.text());
        const hasRemoteProfile = RxSkinBrowserUI.currentProfile
            && RxSkinBrowserUI.currentProfile.isDefault !== true
            && Boolean(RxSkinBrowserUI.currentProfile.id);
        $button.prop("disabled", busy === true || !hasRemoteProfile).toggleClass("is-loading", busy === true);
        $icon.text(busy ? "progress_activity" : String($button.data("skin-original-icon") || "check_circle"));
    };

    static setPreviewLoading = (loading) => {
        $("#modal-skins [data-skin-preview-loader]").prop("hidden", loading !== true);
    };

    static setStatus = (kind, title, hint, icon) => {
        const state = ["ready", "loading", "success", "warning", "error"].includes(kind) ? kind : "ready";
        const $status = $("#modal-skins [data-skin-status]");
        $status
            .removeClass("is-ready is-loading is-success is-warning is-error")
            .addClass(`is-${state}`);
        $status.find("[data-skin-status-icon]").text(icon || "info");
        $status.find("[data-skin-status-title]").text(title || "");
        $status.find("[data-skin-status-hint]").text(hint || "");
    };

    static getRecent = () => {
        let raw = [];
        try {
            raw = typeof RxConfig !== "undefined" ? RxConfig.read(RxSkinBrowserUI.CONFIG_KEY, []) : [];
        } catch (_) {
            raw = [];
        }
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        return raw.map((item) => {
            const nickname = String(item?.nickname || "").trim();
            const profileId = String(item?.profileId || "").replace(/-/g, "").toLowerCase();
            const searchedAt = Number(item?.searchedAt);
            if (!RxSkinBrowserUI.NICKNAME_PATTERN.test(nickname)
                || !/^[0-9a-f]{32}$/.test(profileId)
                || seen.has(nickname.toLowerCase())) return null;
            seen.add(nickname.toLowerCase());
            return {
                nickname,
                profileId,
                model: RxSkinBrowserUI.normalizeModel(item?.model),
                searchedAt: Number.isFinite(searchedAt) && searchedAt > 0 ? searchedAt : 0
            };
        }).filter(Boolean).slice(0, RxSkinBrowserUI.MAX_RECENT);
    };

    static addRecent = (profile) => {
        if (!profile || profile.isDefault || !profile.id) return;
        const recent = RxSkinBrowserUI.getRecent()
            .filter((item) => item.nickname.toLowerCase() !== profile.name.toLowerCase());
        recent.unshift({
            nickname: profile.name,
            profileId: profile.id,
            model: RxSkinBrowserUI.normalizeModel(profile.model),
            searchedAt: Date.now()
        });
        try {
            RxConfig.write(RxSkinBrowserUI.CONFIG_KEY, recent.slice(0, RxSkinBrowserUI.MAX_RECENT));
        } catch (error) {
            RxSkinBrowserUI.log(`Skins: Failed to save recent searches [error=${error?.message || error}]`);
        }
        RxSkinBrowserUI.renderRecent();
    };

    static clearRecent = () => {
        try {
            if (typeof RxConfig !== "undefined") RxConfig.write(RxSkinBrowserUI.CONFIG_KEY, []);
        } catch (error) {
            RxSkinBrowserUI.log(`Skins: Failed to clear recent searches [error=${error?.message || error}]`);
        }
        RxSkinBrowserUI.renderRecent();
    };

    static renderRecent = () => {
        const recent = RxSkinBrowserUI.getRecent();
        const $modal = $("#modal-skins");
        const $list = $modal.find("[data-skin-recent-list]").empty();
        $modal.find("[data-skin-recent-empty]").prop("hidden", recent.length > 0);
        $modal.find('[data-skin-action="clear-recent"]').prop("hidden", recent.length === 0);

        recent.forEach((item) => {
            const $button = $("<button>", {
                type: "button",
                class: "skin-recent-item",
                title: item.nickname
            }).attr("data-skin-recent-nickname", item.nickname).data("skin-recent-nickname", item.nickname);
            // Голова скина; без сети — запасная иконка
            const $icon = $("<span>", {class: "skin-recent-item-icon"})
                .append($("<img>", {alt: "", loading: "lazy", src: RxPrivacy.remoteAvatar(`https://minotar.net/helm/${encodeURIComponent(item.nickname)}/28`)})
                    .on("error", function () {
                        $(this).replaceWith($("<span>", {class: "material-symbols-outlined", text: "person"}));
                    }));
            const $copy = $("<span>", {class: "skin-recent-item-copy"})
                .append($("<strong>").text(item.nickname))
                .append($("<small>").text(`${RxSkinBrowserUI.modelLabel(item.model)} · ${RxSkinBrowserUI.formatDate(item.searchedAt, false)}`));
            $button
                .append($icon)
                .append($copy)
                .append($("<span>", {class: "material-symbols-outlined", text: "arrow_forward"}));
            $list.append($button);
        });
    };

    static notify = (title, icon, description = "") => {
        if (typeof RxToasts !== "undefined") RxToasts.create(title, icon, description);
    };

    static log = (message) => {
        if (typeof RxCollector !== "undefined" && typeof RxCollector.writeLog === "function") {
            RxCollector.writeLog(String(message));
        } else {
            console.warn(message);
        }
    };
}
