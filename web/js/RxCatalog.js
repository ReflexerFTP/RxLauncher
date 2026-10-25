// Каталог Modrinth: сборки, моды, ресурспаки, шейдеры и датапаки в одном разделе.
// Сборка ставится одной кнопкой (версия игры, загрузчик и Java подтянутся при первом запуске),
// остальное — в выбранную версию или сборку.
class RxCatalog {
    static API = "https://api.modrinth.com/v2";
    static PAGE = 20;

    static TYPES = {
        modpack: {icon: "stacks", categories: ["optimization", "adventure", "lightweight", "multiplayer", "technology", "magic", "quests", "combat", "kitchen-sink", "challenging"]},
        mod: {icon: "extension", dir: "mods", categories: ["optimization", "utility", "decoration", "adventure", "technology", "magic", "storage", "mobs", "worldgen", "equipment", "food", "library"]},
        resourcepack: {icon: "texture", dir: "resourcepacks", categories: ["vanilla-like", "simplistic", "realistic", "themed", "tweaks", "utility", "decoration", "combat", "modded"]},
        shader: {icon: "wb_sunny", dir: "shaderpacks", categories: ["vanilla-like", "semi-realistic", "realistic", "fantasy", "cartoon"]},
        datapack: {icon: "data_object", categories: ["adventure", "utility", "worldgen", "game-mechanics", "decoration", "equipment", "mobs"]}
    };

    static state = {type: "modpack", query: "", sort: "relevance", category: "", game: "", offset: 0, total: 0, generation: 0, loading: false, failed: false};
    static hits = new Map();
    static installed = new Set();
    static busy = new Set();
    static hashCache = new Map(); // путь файла → {stamp, projectId}
    static gameVersions = null;

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);
    static t = (key, fallback = key) => MESSAGES.catalog?.[key] ?? fallback;
    static call = (method, apiPath, body = null) => RxHttp.json(`${RxCatalog.API}${apiPath}`, {method, body, timeout: 20000});
    static $modal = () => $("#modal-catalog");

    // ---------- цель установки ----------
    static target = () => RxModrinthCatalog.target();

    static context = () => RxModsManager.getContext();

    // Загрузчики, с которыми работают шейдеры выбранной версии
    static shaderLoaders = (loader) => {
        const type = RxVersionsManager.parseVersionID(RxVersionsManager.getActiveVersion()).type;
        if (type === "forgeOptiFine") return ["optifine"];
        return ["fabric", "quilt", "neoforge"].includes(loader) ? ["iris", "optifine"] : [];
    };

    static installDir = (type) => {
        const context = RxCatalog.context();
        const dir = RxCatalog.TYPES[type]?.dir;
        return context && dir ? path.join(context.gameRoot, dir) : "";
    };

    // ---------- поиск ----------
    static facets = (type, target) => {
        const facets = [[`project_type:${type}`]];
        if (type === "modpack") {
            if (RxCatalog.state.game) facets.push([`versions:${RxCatalog.state.game}`]);
        } else if (type === "mod") {
            facets.push(RxModrinthCatalog.loadersFor(target.loader).map(loader => `categories:${loader}`), [`versions:${target.game}`]);
        } else if (type === "shader") {
            const loaders = RxCatalog.shaderLoaders(target?.loader);
            if (loaders.length) facets.push(loaders.map(loader => `categories:${loader}`));
        } else if (target?.game) {
            facets.push([`versions:${target.game}`]);
        }
        if (RxCatalog.state.category) facets.push([`categories:${RxCatalog.state.category}`]);
        return facets;
    };

    // Чего не хватает для выбранного раздела: null — можно искать
    static blocker = (type, target) => {
        if (type === "modpack") return null;
        if (!RxCatalog.context() || !target?.game) return {icon: "deployed_code_alert", title: RxCatalog.t("noVersion"), text: RxCatalog.t("noVersionText")};
        if (type === "mod" && !target.loader) return {icon: "block", title: MESSAGES.mods.catalogNoLoader, text: MESSAGES.mods.catalogNoLoaderText};
        return null;
    };

    static search = async (append = false) => {
        const state = RxCatalog.state;
        const $modal = RxCatalog.$modal();
        const target = RxCatalog.target();
        RxCatalog.renderHeader();
        const blocked = RxCatalog.blocker(state.type, target);
        if (blocked) {
            $modal.find("[data-catalog-list]").empty();
            $modal.find("[data-catalog-more]").prop("hidden", true);
            return RxCatalog.setStatus(blocked.icon, blocked.title, blocked.text);
        }
        if (append && (state.loading || state.failed || state.offset >= state.total)) return;
        if (!append) {
            state.offset = 0;
            state.failed = false;
            RxCatalog.hits.clear();
        }
        const generation = ++state.generation;
        state.loading = true;
        if (!append) {
            RxCatalog.setStatus("progress_activity", RxCatalog.t("loading"), "");
            $modal.find("[data-catalog-list]").empty();
            $modal.find("[data-catalog-more]").prop("hidden", true);
        }

        const query = new URLSearchParams({
            query: state.query,
            facets: JSON.stringify(RxCatalog.facets(state.type, target)),
            index: state.sort,
            limit: String(RxCatalog.PAGE),
            offset: String(state.offset)
        });
        try {
            const [result] = await Promise.all([RxCatalog.call("GET", `/search?${query}`), RxCatalog.loadInstalled(state.type)]);
            if (generation !== state.generation) return;
            state.total = result.total_hits || 0;
            state.offset += (result.hits || []).length;
            (result.hits || []).forEach(hit => RxCatalog.hits.set(hit.project_id, hit));
            $modal.find("[data-catalog-list]").append((result.hits || []).map(RxCatalog.cardHtml).join(""));
            if (!append) $modal.find("[data-catalog-scroll]").scrollTop(0);
            if (state.total === 0) RxCatalog.setStatus("search_off", MESSAGES.mods.catalogEmpty, MESSAGES.mods.catalogEmptyText);
            else RxCatalog.setStatus(null);
            $modal.find("[data-catalog-more]").prop("hidden", state.offset >= state.total);
        } catch (error) {
            if (generation !== state.generation) return;
            RxCollector.writeLog(`Catalog: Search failed [type=${state.type}] [error=${error}]`);
            state.failed = true;
            RxCatalog.setStatus("wifi_off", MESSAGES.mods.catalogOffline, MESSAGES.mods.catalogOfflineText);
            $modal.find("[data-catalog-more]").prop("hidden", true);
        } finally {
            if (generation === state.generation) {
                state.loading = false;
                RxCatalog.loadMoreIfNeeded();
            }
        }
    };

    static loadMoreIfNeeded = () => {
        const scroll = document.querySelector("#modal-catalog [data-catalog-scroll]");
        const state = RxCatalog.state;
        if (!scroll || state.loading || state.failed || state.offset === 0 || state.offset >= state.total || !scroll.clientHeight) return;
        if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < scroll.clientHeight * 1.5) RxCatalog.search(true);
    };

    static setStatus = (icon, title = "", text = "") => {
        const $status = RxCatalog.$modal().find("[data-catalog-status]");
        $status.prop("hidden", !icon).toggleClass("spinning", icon === "progress_activity");
        $status.find(".material-symbols-outlined").text(icon || "");
        $status.find("strong").text(title);
        $status.find("span:last-child").text(text);
    };

    // ---------- что уже установлено ----------
    static loadInstalled = async (type) => {
        const installed = new Set();
        try {
            if (type === "modpack") {
                RxInstancesUI.list().forEach(instance => {
                    if (instance.source?.projectId) installed.add(instance.source.projectId);
                });
            } else if (type === "mod") {
                (await RxModrinthCatalog.loadInstalled()).forEach((_, projectId) => installed.add(projectId));
            } else if (RxCatalog.TYPES[type]?.dir) {
                (await RxCatalog.projectsInDir(RxCatalog.installDir(type))).forEach(projectId => installed.add(projectId));
            }
        } catch (error) {
            RxCollector.writeLog(`Catalog: Could not read installed content [type=${type}] [error=${error}]`);
        }
        RxCatalog.installed = installed;
        return installed;
    };

    // Проекты Modrinth, файлы которых лежат в папке (по SHA-1, с кешем по дате изменения)
    static projectsInDir = async (dir) => {
        let files = [];
        try {
            files = fs.readdirSync(dir).filter(name => /\.(zip|jar)$/i.test(name)).map(name => path.join(dir, name));
        } catch (_) {
            return [];
        }
        const unknown = {};
        const result = [];
        for (const file of files) {
            const stamp = (() => { try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; } })();
            const cached = RxCatalog.hashCache.get(file);
            if (cached && cached.stamp === stamp) {
                if (cached.projectId) result.push(cached.projectId);
                continue;
            }
            const hash = await RxHttp.hashFile(file, "sha1");
            if (hash) unknown[hash] = {file, stamp};
        }
        if (Object.keys(unknown).length) {
            const versions = await RxCatalog.call("POST", "/version_files", {hashes: Object.keys(unknown), algorithm: "sha1"});
            Object.entries(unknown).forEach(([hash, {file, stamp}]) => {
                const projectId = versions?.[hash]?.project_id || "";
                RxCatalog.hashCache.set(file, {stamp, projectId});
                if (projectId) result.push(projectId);
            });
        }
        return result;
    };

    // ---------- отрисовка ----------
    static compact = (number) => RxModrinthCatalog.compact(number);

    static categoryName = (slug) => MESSAGES.catalog?.categories?.[slug] || slug.replace(/-/g, " ").replace(/^\w/, char => char.toUpperCase());

    static latestGameVersion = (hit) => {
        const releases = (hit.versions || []).filter(version => /^\d+(\.\d+)+$/.test(version));
        return releases.sort((a, b) => RxVersionsManager.compareGameVersions(b, a))[0] || "";
    };

    static buttonHtml = (projectId) => {
        const esc = RxCatalog.escape;
        if (RxCatalog.busy.has(projectId)) {
            return `<button disabled data-catalog-install="${esc(projectId)}"><span class="material-symbols-outlined spin">progress_activity</span><span>${esc(MESSAGES.mods.catalogInstalling)}</span></button>`;
        }
        if (RxCatalog.installed.has(projectId) && RxCatalog.state.type !== "modpack") {
            return `<button class="transparent mc-installed" disabled><span class="material-symbols-outlined">check</span><span>${esc(MESSAGES.mods.catalogInstalled)}</span></button>`;
        }
        const label = RxCatalog.installed.has(projectId) ? RxCatalog.t("installAgain") : MESSAGES.mods.catalogInstall;
        return `<button data-catalog-install="${esc(projectId)}"><span class="material-symbols-outlined">download</span><span>${esc(label)}</span></button>`;
    };

    static cardHtml = (hit) => {
        const esc = RxCatalog.escape;
        const type = RxCatalog.state.type;
        const icon = hit.icon_url
            ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy"/>`
            : `<span class="material-symbols-outlined">${esc(RxCatalog.TYPES[type].icon)}</span>`;
        const game = type === "modpack" ? RxCatalog.latestGameVersion(hit) : "";
        const installedBadge = type === "modpack" && RxCatalog.installed.has(hit.project_id)
            ? `<span class="cat-badge"><span class="material-symbols-outlined">check</span>${esc(RxCatalog.t("inInstances"))}</span>` : "";
        return `<article class="mc-card cat-card" data-project="${esc(hit.project_id)}" title="${esc(RxCatalog.t("details"))}">
            <div class="mc-icon">${icon}</div>
            <div class="mc-copy">
                <div class="mc-title-row"><strong>${esc(hit.title)}</strong><span>${esc(MESSAGES.mods.catalogBy.replace("{0}", hit.author || "—"))}</span>${installedBadge}</div>
                <p>${esc(hit.description)}</p>
                <div class="mc-meta">
                    <span><span class="material-symbols-outlined">download</span>${RxCatalog.compact(hit.downloads)}</span>
                    <span><span class="material-symbols-outlined">favorite</span>${RxCatalog.compact(hit.follows)}</span>
                    <span><span class="material-symbols-outlined">update</span>${esc(RxModsManager.formatDate(Date.parse(hit.date_modified) || Date.now()))}</span>
                    ${game ? `<span><span class="material-symbols-outlined">deployed_code</span>Minecraft ${esc(game)}</span>` : ""}
                </div>
            </div>
            <div class="mc-actions">
                ${RxCatalog.buttonHtml(hit.project_id)}
                <button class="transparent mc-open" data-catalog-open="${esc(hit.project_id)}" title="Modrinth"><span class="material-symbols-outlined">open_in_new</span></button>
            </div>
        </article>`;
    };

    static refreshCard = (projectId) => {
        RxCatalog.$modal().find(`.cat-card[data-project="${CSS.escape(projectId)}"] .mc-actions > button:first-child`).replaceWith(RxCatalog.buttonHtml(projectId));
        RxCatalog.$modal().find(`[data-details-install="${CSS.escape(projectId)}"]`).prop("disabled", RxCatalog.busy.has(projectId));
    };

    static renderHeader = () => {
        const $modal = RxCatalog.$modal();
        const state = RxCatalog.state;
        const target = RxCatalog.target();
        const context = RxCatalog.context();
        $modal.find("[data-catalog-type]").removeClass("active").filter(`[data-catalog-type="${state.type}"]`).addClass("active");
        $modal.find("[data-catalog-version]").text(context ? context.displayName : MESSAGES.commons.notSelected);
        $modal.find("[data-catalog-target-card]").prop("hidden", state.type === "modpack");
        $modal.find("[data-catalog-game-wrap]").prop("hidden", state.type !== "modpack");
        $modal.find("[data-catalog-search]").attr("placeholder", RxCatalog.t(`search_${state.type}`));
        $modal.find("[data-catalog-categories]").html(
            [`<button type="button" class="${state.category ? "" : "active"}" data-catalog-category="">${RxCatalog.escape(MESSAGES.mods.catAll)}</button>`]
                .concat(RxCatalog.TYPES[state.type].categories.map(slug => `<button type="button" class="${state.category === slug ? "active" : ""}" data-catalog-category="${slug}">${RxCatalog.escape(RxCatalog.categoryName(slug))}</button>`))
                .join(""));
        RxCatalog.renderNotice(target);
    };

    // Подсказка над списком: куда ставится контент и чего не хватает
    static renderNotice = (target) => {
        const $notice = RxCatalog.$modal().find("[data-catalog-notice]");
        const type = RxCatalog.state.type;
        let notice = null;
        if (type === "modpack") {
            notice = {icon: "bolt", text: RxCatalog.t("modpackHint")};
        } else if (type === "shader" && target?.game) {
            const loaders = RxCatalog.shaderLoaders(target.loader);
            if (!loaders.length) {
                notice = {icon: "warning", text: RxCatalog.t("shaderNeedsLoader"), level: "warn"};
            } else if (loaders.includes("iris") && !RxCatalog.hasIris()) {
                notice = {icon: "wb_sunny", text: RxCatalog.t("shaderNeedsIris"), action: {id: "iris", text: RxCatalog.t("installIris")}, level: "warn"};
            }
        } else if (type === "datapack" && target?.game) {
            notice = {icon: "public", text: RxCatalog.t("datapackHint")};
        } else if (type === "resourcepack" && target?.game) {
            notice = {icon: "info", text: RxCatalog.t("resourcepackHint")};
        }
        $notice.prop("hidden", !notice).toggleClass("warn", notice?.level === "warn");
        if (!notice) return;
        $notice.find(".material-symbols-outlined").first().text(notice.icon);
        $notice.find("[data-notice-text]").text(notice.text);
        $notice.find("[data-notice-action]").prop("hidden", !notice.action).attr("data-notice-action", notice.action?.id || "").find("span:last-child").text(notice.action?.text || "");
    };

    static hasIris = () => {
        const context = RxCatalog.context();
        if (!context) return false;
        try {
            return fs.readdirSync(context.modsPath).some(name => /^iris[-_.]/i.test(name) && /\.jar$/i.test(name));
        } catch (_) {
            return false;
        }
    };

    // ---------- выбор версии проекта ----------
    static versionFilter = (type, target) => {
        const params = {};
        if (type === "mod") {
            params.loaders = RxModrinthCatalog.loadersFor(target.loader);
            params.game_versions = [target.game];
        } else if (type === "shader") {
            const loaders = RxCatalog.shaderLoaders(target?.loader);
            if (loaders.length) params.loaders = loaders;
        } else if (type === "datapack") {
            params.loaders = ["datapack"];
            params.game_versions = [target.game];
        } else if (type === "resourcepack") {
            params.game_versions = [target.game];
        } else if (type === "modpack" && RxCatalog.state.game) {
            params.game_versions = [RxCatalog.state.game];
        }
        return params;
    };

    static projectVersions = async (projectId, params = {}) => {
        const query = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, JSON.stringify(value)])));
        const versions = await RxCatalog.call("GET", `/project/${encodeURIComponent(projectId)}/version${query.toString() ? `?${query}` : ""}`);
        return Array.isArray(versions) ? versions : [];
    };

    static pickVersion = async (type, projectId, target) => {
        let versions = await RxCatalog.projectVersions(projectId, RxCatalog.versionFilter(type, target));
        // Ресурспаки и шейдеры часто не отмечают новые версии игры, хотя работают на них
        if (!versions.length && (type === "resourcepack" || type === "shader")) versions = await RxCatalog.projectVersions(projectId);
        return versions.find(version => version.version_type === "release") || versions[0] || null;
    };

    // ---------- установка ----------
    static install = async (projectId, versionId = "") => {
        const type = RxCatalog.state.type;
        const target = RxCatalog.target();
        if (RxCatalog.busy.has(projectId)) return false;
        const hit = RxCatalog.hits.get(projectId) || RxCatalog.details?.project && {title: RxCatalog.details.project.title, icon_url: RxCatalog.details.project.icon_url} || {};
        RxCatalog.busy.add(projectId);
        RxCatalog.refreshCard(projectId);
        try {
            const version = versionId
                ? await RxCatalog.call("GET", `/version/${encodeURIComponent(versionId)}`)
                : await RxCatalog.pickVersion(type, projectId, target);
            if (!version) throw new Error("noVersion");
            let installed;
            if (type === "modpack") installed = await RxCatalog.installModpack(projectId, version, hit);
            else if (type === "mod") installed = await RxCatalog.installMod(projectId, version, target);
            else if (type === "datapack") installed = await RxCatalog.installDatapack(version);
            else installed = await RxCatalog.installFile(version, RxCatalog.installDir(type));
            if (installed && type !== "datapack") RxCatalog.installed.add(projectId);
            return installed;
        } catch (error) {
            RxCollector.writeLog(`Catalog: Install failed [type=${type}] [project=${projectId}] [error=${error?.stack || error}]`);
            RxToasts.create(error?.message === "noVersion" ? RxCatalog.t("noCompatible") : MESSAGES.mods.catalogFailed, "error", hit.title || "", "error");
            return false;
        } finally {
            RxCatalog.busy.delete(projectId);
            RxCatalog.refreshCard(projectId);
        }
    };

    static primaryFile = (version) => (version.files || []).find(file => file.primary) || (version.files || [])[0];

    static safeFileName = (file, pattern) => {
        const name = path.basename(String(file?.filename || ""));
        if (!name || name !== file.filename || !pattern.test(name)) throw new Error(`Unexpected file ${file?.filename}`);
        if (new URL(file.url).protocol !== "https:") throw new Error("Insecure download URL");
        return name;
    };

    // Мод нужной версии вместе с обязательными зависимостями
    static installMod = async (projectId, version, target) => {
        const context = RxCatalog.context();
        RxModsManager.ensureDirectory(context.modsPath);
        await RxModrinthCatalog.loadInstalled();
        const files = [];
        const visited = new Set([projectId]);
        for (const dependency of (version.dependencies || []).filter(dep => dep.dependency_type === "required")) {
            const depProject = dependency.project_id || (dependency.version_id
                ? (await RxCatalog.call("GET", `/version/${encodeURIComponent(dependency.version_id)}`)).project_id : null);
            if (depProject) files.push(...await RxModrinthCatalog.installProject(depProject, target, context.modsPath, visited));
        }
        const file = RxCatalog.primaryFile(version);
        files.push(await RxModrinthCatalog.download(file, context.modsPath));
        RxModrinthCatalog.installed.set(projectId, {file: path.join(context.modsPath, file.filename), versionId: version.id, sha1: file.hashes?.sha1});
        RxModrinthCatalog.installedKey = "";
        const [main, ...deps] = files.reverse();
        RxToasts.create(MESSAGES.mods.catalogDone, "download_done", deps.length ? `${main} + ${MESSAGES.mods.catalogDeps.replace("{0}", deps.length)}` : main, "success");
        return true;
    };

    static installFile = async (version, dir) => {
        if (!dir) throw new Error("No install directory");
        const file = RxCatalog.primaryFile(version);
        const name = RxCatalog.safeFileName(file, /\.zip$/i);
        await RxHttp.download(file.url, path.join(dir, name), {hashes: file.hashes});
        RxToasts.create(RxCatalog.t(`installed_${RxCatalog.state.type}`), "download_done", name, "success");
        RxCollector.writeLog(`Catalog: Installed ${name} into ${dir}`);
        return true;
    };

    // Датапак кладётся в папку datapacks выбранного мира
    static installDatapack = async (version) => {
        const context = RxCatalog.context();
        const savesDir = path.join(context.gameRoot, "saves");
        const worlds = (await RxWorldsManager.savesFromDirectory(savesDir)) || [];
        if (!worlds.length) {
            RxToasts.create(RxCatalog.t("noWorlds"), "public_off", RxCatalog.t("noWorldsText"), "warning");
            return false;
        }
        const worldPath = await RxDialog.choose({
            icon: "public",
            title: RxCatalog.t("chooseWorld"),
            text: RxCatalog.t("chooseWorldText"),
            choices: worlds.map(world => ({
                value: world.path,
                title: world.name || path.basename(world.path),
                text: `${path.basename(world.path)} · ${world.version || ""}`,
                image: world.icon && world.icon !== "assets/world.webp" ? RxScreenshotsUI.fileUrl(world.icon) : "assets/world.webp"
            }))
        });
        if (!worldPath) return false;
        const file = RxCatalog.primaryFile(version);
        const name = RxCatalog.safeFileName(file, /\.zip$/i);
        await RxHttp.download(file.url, path.join(worldPath, "datapacks", name), {hashes: file.hashes});
        RxToasts.create(RxCatalog.t("installed_datapack"), "download_done", `${name} → ${path.basename(worldPath)}`, "success");
        return true;
    };

    // Сборка в один клик: скачать .mrpack, создать сборку, сразу докачать её файлы и выбрать её
    static installModpack = async (projectId, version, hit = {}) => {
        const file = RxCatalog.primaryFile(version);
        const name = RxCatalog.safeFileName(file, /\.mrpack$/i);
        const archive = path.join(GAME_DATA, "cache", "modrinth", name);
        try {
            await RxDownloader.downloadFile(file.url, archive, hit.title || name, true, file.hashes || {});
            const modpackId = await RxPacks.importModrinthPack(archive, hit.icon_url || false, {
                displayName: hit.title ? `${hit.title} ${version.version_number}`.slice(0, 64) : undefined,
                source: {provider: "modrinth", projectId, versionId: version.id, versionNumber: version.version_number, title: hit.title || ""}
            });
            if (!modpackId) return false;
            RxVersionsManager.setActiveVersion(`pack-${modpackId}`);
            await RxVersionsUI.loadVersions();
            const ready = await RxPacks.verifyAndInstall(modpackId);
            const title = RxPacks.getModpackManifest(modpackId)?.displayName || hit.title;
            RxToasts.create(ready ? RxCatalog.t("modpackReady") : RxCatalog.t("modpackPartly"), ready ? "task_alt" : "warning", title, {
                type: ready ? "success" : "warning",
                duration: 9000,
                action: {label: MESSAGES.flyout.play, onClick: () => RxModals.switchModal("content").then(() => RxFlyout.startSelectedVersion())}
            });
            RxCollector.writeLog(`Catalog: Modpack installed [project=${projectId}] [id=${modpackId}] [filesReady=${ready}]`);
            return true;
        } finally {
            try { fs.unlinkSync(archive); } catch (_) {}
            await RxFlyout.changeMode("idle");
        }
    };

    // ---------- обновления сборок с Modrinth ----------
    static updateCache = new Map(); // modpackId → {checkedAt, version}

    // Новая версия сборки для той же версии Minecraft и того же загрузчика или null.
    // У многих сборок отдельные версии под Fabric и NeoForge — их нельзя считать обновлением друг друга
    static checkPackUpdate = async (manifest, force = false) => {
        const source = manifest?.source;
        if (source?.provider !== "modrinth" || !source.projectId) return null;
        const cached = RxCatalog.updateCache.get(manifest.id);
        if (!force && cached && Date.now() - cached.checkedAt < 30 * 60 * 1000) return cached.version;
        let update = null;
        try {
            // Modrinth отдаёт версии от новых к старым. Фильтр loaders для сборок API не применяет — отбираем сами
            const loader = manifest.baseVersion?.type;
            const versions = (await RxCatalog.projectVersions(source.projectId, {game_versions: [manifest.baseVersion?.number]}))
                .filter(version => !loader || loader === "vanilla" || !(version.loaders || []).length || version.loaders.includes(loader));
            const latest = versions.find(version => version.version_type === "release") || versions[0] || null;
            const currentIndex = versions.findIndex(version => version.id === source.versionId);
            if (latest && latest.id !== source.versionId && (currentIndex === -1 || versions.indexOf(latest) < currentIndex)) update = latest;
        } catch (error) {
            RxCollector.writeLog(`Catalog: Pack update check failed [pack=${manifest.id}] [error=${error}]`);
            return cached?.version || null;
        }
        RxCatalog.updateCache.set(manifest.id, {checkedAt: Date.now(), version: update});
        return update;
    };

    static updatePack = async (modpackId) => {
        const manifest = RxPacks.getModpackManifest(modpackId);
        const version = await RxCatalog.checkPackUpdate(manifest, true);
        if (!version) {
            RxToasts.create(RxCatalog.t("packUpToDate"), "check_circle", manifest?.displayName || "", "success");
            return false;
        }
        const confirmed = await RxDialog.confirm({
            icon: "upgrade",
            title: RxCatalog.t("packUpdateTitle"),
            text: RxCatalog.t("packUpdateText").replace("{0}", manifest.displayName).replace("{1}", version.version_number),
            confirmText: RxCatalog.t("packUpdateConfirm")
        });
        if (!confirmed) return false;
        const file = RxCatalog.primaryFile(version);
        const name = RxCatalog.safeFileName(file, /\.mrpack$/i);
        const archive = path.join(GAME_DATA, "cache", "modrinth", name);
        try {
            await RxDownloader.downloadFile(file.url, archive, manifest.displayName, true, file.hashes || {});
            const updated = await RxPacks.updateModrinthPack(modpackId, archive, {versionId: version.id, versionNumber: version.version_number});
            if (!updated) throw new Error("update failed");
            RxCatalog.updateCache.delete(modpackId);
            const ready = await RxPacks.verifyAndInstall(modpackId);
            RxToasts.create(RxCatalog.t("packUpdated"), "upgrade", `${manifest.displayName} → ${version.version_number}`, ready ? "success" : "warning");
            return true;
        } catch (error) {
            RxCollector.writeLog(`Catalog: Pack update failed [pack=${modpackId}] [error=${error}]`);
            RxToasts.create(RxCatalog.t("packUpdateFailed"), "error", manifest.displayName, "error");
            return false;
        } finally {
            try { fs.unlinkSync(archive); } catch (_) {}
            await RxFlyout.changeMode("idle");
            RxVersionsUI.loadVersions();
            if (RxModals.isModalShown("instances")) RxInstancesUI.render();
        }
    };

    // ---------- подробности о проекте ----------
    static details = null;

    // Описание Modrinth (Markdown + HTML) → простые абзацы текста
    static plainText = (markdown) => String(markdown || "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/!\[[^\]]*]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/^\s*\[[^\]]+]:\s*\S+.*$/gm, "")
        .replace(/\[([^\]]+)]\[[^\]]*]/g, "$1")
        .replace(/^\s{0,3}#{1,6}\s*(.+)$/gm, "\n\n$1\n\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
        .replace(/^\s{0,3}#{1,6}\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/[*_`~]{1,3}/g, "")
        .replace(/^\s*\|.*\|\s*$/gm, "")
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.replace(/\s*\n\s*/g, " ").trim())
        .filter(paragraph => paragraph.length > 1)
        .slice(0, 30);

    static openDetails = async (projectId) => {
        const $panel = RxCatalog.$modal().find("[data-catalog-details]");
        const esc = RxCatalog.escape;
        const type = RxCatalog.state.type;
        const target = RxCatalog.target();
        const hit = RxCatalog.hits.get(projectId) || {};
        RxCatalog.details = {projectId};
        $panel.prop("hidden", false).find("[data-details-body]").html(`<div class="mc-status spinning"><span class="material-symbols-outlined">progress_activity</span><strong>${esc(RxCatalog.t("loading"))}</strong><span></span></div>`);
        try {
            const [project, versions] = await Promise.all([
                RxCatalog.call("GET", `/project/${encodeURIComponent(projectId)}`),
                type === "modpack" || !target?.game
                    ? RxCatalog.projectVersions(projectId)
                    : RxCatalog.projectVersions(projectId, RxCatalog.versionFilter(type, target)).then(list => list.length ? list : RxCatalog.projectVersions(projectId))
            ]);
            if (RxCatalog.details?.projectId !== projectId) return;
            RxCatalog.details.project = project;
            const paragraphs = RxCatalog.plainText(project.body).map(text => `<p>${esc(text)}</p>`).join("") || `<p>${esc(project.description)}</p>`;
            const gallery = (project.gallery || []).slice(0, 8).map(image => `<img src="${esc(image.url)}" alt="${esc(image.title || "")}" loading="lazy"/>`).join("");
            const links = [["source_url", "code", "source"], ["issues_url", "bug_report", "issues"], ["wiki_url", "menu_book", "wiki"], ["discord_url", "forum", "discord"]]
                .filter(([key]) => /^https:\/\//.test(project[key] || ""))
                .map(([key, icon, label]) => `<button class="transparent" data-details-link="${esc(project[key])}"><span class="material-symbols-outlined">${icon}</span><span>${esc(RxCatalog.t(`link_${label}`))}</span></button>`).join("");
            const versionRows = versions.slice(0, 40).map(version => {
                const loaders = (version.loaders || []).filter(loader => !["minecraft"].includes(loader)).map(loader => RxVersionsUI.TYPE_LABELS[loader] || RxUtils.capitalizeWord(loader)).join(", ");
                const games = (version.game_versions || []).slice(-3).join(", ");
                return `<div class="cat-version">
                    <div class="cat-version-copy">
                        <strong>${esc(version.name || version.version_number)}</strong>
                        <span>${esc([version.version_number, loaders, games].filter(Boolean).join(" · "))}</span>
                    </div>
                    <span class="cat-version-type ${esc(version.version_type)}">${esc(RxCatalog.t(`type_${version.version_type}`, version.version_type))}</span>
                    <button class="transparent" data-details-version="${esc(version.id)}" title="${esc(MESSAGES.mods.catalogInstall)}"><span class="material-symbols-outlined">download</span></button>
                </div>`;
            }).join("");
            $panel.find("[data-details-body]").html(`
                <div class="cat-details-head">
                    <div class="mc-icon">${project.icon_url ? `<img src="${esc(project.icon_url)}" alt=""/>` : `<span class="material-symbols-outlined">${esc(RxCatalog.TYPES[type].icon)}</span>`}</div>
                    <div class="cat-details-title">
                        <h2>${esc(project.title)}</h2>
                        <span>${esc(MESSAGES.mods.catalogBy.replace("{0}", hit.author || "—"))}</span>
                    </div>
                </div>
                <div class="mc-meta cat-details-meta">
                    <span><span class="material-symbols-outlined">download</span>${RxCatalog.compact(project.downloads)}</span>
                    <span><span class="material-symbols-outlined">favorite</span>${RxCatalog.compact(project.followers)}</span>
                    <span><span class="material-symbols-outlined">update</span>${esc(RxModsManager.formatDate(Date.parse(project.updated) || Date.now()))}</span>
                    ${project.license?.id ? `<span><span class="material-symbols-outlined">gavel</span>${esc(project.license.id)}</span>` : ""}
                </div>
                <div class="cat-details-actions">
                    <button data-details-install="${esc(projectId)}"${RxCatalog.busy.has(projectId) ? " disabled" : ""}><span class="material-symbols-outlined">download</span><span>${esc(MESSAGES.mods.catalogInstall)}</span></button>
                    <button class="transparent" data-details-link="https://modrinth.com/${esc(project.project_type)}/${esc(project.slug)}"><span class="material-symbols-outlined">open_in_new</span><span>Modrinth</span></button>
                    ${links}
                </div>
                ${gallery ? `<div class="cat-gallery">${gallery}</div>` : ""}
                <div class="cat-details-text">${paragraphs}</div>
                <h3 class="cat-details-subtitle">${esc(RxCatalog.t("versions"))}</h3>
                <div class="cat-versions">${versionRows || `<p class="cat-muted">${esc(RxCatalog.t("noCompatible"))}</p>`}</div>`);
        } catch (error) {
            RxCollector.writeLog(`Catalog: Details failed [project=${projectId}] [error=${error}]`);
            $panel.find("[data-details-body]").html(`<div class="mc-status"><span class="material-symbols-outlined">wifi_off</span><strong>${esc(MESSAGES.mods.catalogOffline)}</strong><span>${esc(MESSAGES.mods.catalogOfflineText)}</span></div>`);
        }
    };

    static closeDetails = () => {
        RxCatalog.details = null;
        RxCatalog.$modal().find("[data-catalog-details]").prop("hidden", true);
    };

    // ---------- переключение и события ----------
    static switchType = (type) => {
        if (!RxCatalog.TYPES[type]) return;
        RxCatalog.state.type = type;
        RxCatalog.state.category = "";
        RxConfig.write("catalogType", type);
        RxCatalog.closeDetails();
        RxCatalog.search();
    };

    static loadGameVersions = async () => {
        if (RxCatalog.gameVersions) return;
        try {
            const tags = await RxCatalog.call("GET", "/tag/game_version");
            RxCatalog.gameVersions = tags.filter(tag => tag.version_type === "release").map(tag => tag.version).slice(0, 40);
        } catch (_) {
            RxCatalog.gameVersions = [];
            return;
        }
        RxCatalog.$modal().find("[data-catalog-game]").append(RxCatalog.gameVersions.map(version => `<option value="${RxCatalog.escape(version)}">${RxCatalog.escape(version)}</option>`).join(""));
    };

    static bind = () => {
        const $modal = RxCatalog.$modal();
        if (!$modal.length) return;
        const saved = RxConfig.read("catalogType", "modpack");
        RxCatalog.state.type = RxCatalog.TYPES[saved] ? saved : "modpack";
        let searchTimer = null;
        $modal.on("click", "[data-catalog-type]", function () { RxCatalog.switchType($(this).attr("data-catalog-type")); });
        $modal.on("input", "[data-catalog-search]", function () {
            clearTimeout(searchTimer);
            RxCatalog.state.query = String($(this).val() || "").trim();
            searchTimer = setTimeout(() => RxCatalog.search(), 350);
        });
        $modal.on("change", "[data-catalog-sort]", function () {
            RxCatalog.state.sort = $(this).val();
            RxCatalog.search();
        });
        $modal.on("change", "[data-catalog-game]", function () {
            RxCatalog.state.game = $(this).val();
            RxCatalog.search();
        });
        $modal.on("click", "[data-catalog-category]", function () {
            RxCatalog.state.category = $(this).attr("data-catalog-category");
            RxCatalog.search();
        });
        $modal.find("[data-catalog-scroll]").on("scroll", () => RxCatalog.loadMoreIfNeeded());
        $modal.on("click", "[data-catalog-install]", function (event) {
            event.stopPropagation();
            RxCatalog.install($(this).attr("data-catalog-install"));
        });
        $modal.on("click", "[data-catalog-open]", function (event) {
            event.stopPropagation();
            const hit = RxCatalog.hits.get($(this).attr("data-catalog-open"));
            openExternal(`https://modrinth.com/${hit?.project_type || "project"}/${encodeURIComponent(hit?.slug || $(this).attr("data-catalog-open"))}`);
        });
        $modal.on("click", ".cat-card", function () { RxCatalog.openDetails($(this).attr("data-project")); });
        $modal.on("click", "[data-details-close]", () => RxCatalog.closeDetails());
        $modal.find("[data-catalog-details]").on("click", (event) => { if (event.target === event.currentTarget) RxCatalog.closeDetails(); });
        $modal.on("click", "[data-details-install]", function () { RxCatalog.install($(this).attr("data-details-install")); });
        $modal.on("click", "[data-details-version]", function () {
            if (RxCatalog.details?.projectId) RxCatalog.install(RxCatalog.details.projectId, $(this).attr("data-details-version"));
        });
        $modal.on("click", "[data-details-link]", function () { openExternal($(this).attr("data-details-link")); });
        $modal.on("click", "[data-catalog-change-version]", () => RxVersionsUI.open());
        $modal.on("click", '[data-notice-action="iris"]', async function () {
            const $button = $(this).prop("disabled", true);
            try {
                await RxModrinthCatalog.installByName("iris", RxCatalog.context().modsPath);
                RxToasts.create(MESSAGES.mods.catalogDone, "download_done", "Iris", "success");
            } catch (error) {
                RxToasts.create(MESSAGES.mods.catalogFailed, "error", "Iris", "error");
            } finally {
                $button.prop("disabled", false);
                RxCatalog.renderNotice(RxCatalog.target());
            }
        });
        window.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || !RxCatalog.details || !RxModals.isModalShown("catalog") || RxDialog.current) return;
            event.stopPropagation();
            RxCatalog.closeDetails();
        }, true);
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "catalog") return;
            RxCatalog.loadGameVersions();
            RxCatalog.search();
        });
        // Сменили версию в окне выбора — каталог показывает контент уже для неё
        $(document).on("hideModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "versions" && RxModals.isModalShown("catalog")) setTimeout(() => RxCatalog.search(), 50);
        });
    };
}

$(RxCatalog.bind);
