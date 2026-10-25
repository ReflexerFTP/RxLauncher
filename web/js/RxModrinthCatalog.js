// Каталог Modrinth внутри менеджера модов: поиск под выбранную версию, установка с зависимостями, обновления
class RxModrinthCatalog {
    static API = "https://api.modrinth.com/v2";
    static PAGE = 20;
    static LOADERS = ["fabric", "forge", "neoforge", "quilt"];

    static state = {query: "", sort: "relevance", category: "", offset: 0, total: 0, generation: 0, loading: false};
    static installed = new Map(); // projectId → {file, versionId, sha1}
    static installedKey = "";
    static installing = new Set();
    static updates = [];

    // ---------- запросы ----------
    static call = (method, apiPath, body = null) => new Promise((resolve, reject) => {
        request({
            method,
            url: `${RxModrinthCatalog.API}${apiPath}`,
            json: body || true,
            gzip: true,
            timeout: 20000,
            headers: {"User-Agent": `MaxRx/RxLauncher/${LAUNCHER_VERSION} (${SITE_URL})`}
        }, (error, response, data) => {
            if (error || !response || response.statusCode < 200 || response.statusCode >= 300) {
                reject(error || new Error(`Modrinth HTTP ${response?.statusCode}`));
                return;
            }
            resolve(data);
        });
    });

    // Загрузчик и версия игры для выбранной версии/сборки
    static target = () => {
        const base = typeof RxModMeta !== "undefined" ? RxModMeta.getTarget() : null;
        if (!base) return null;
        let loader = base.loader;
        let game = base.mcText;
        if (loader === "custom" && typeof RxCustomVersions !== "undefined") {
            const name = RxVersionsManager.parseVersionID(RxVersionsManager.getActiveVersion()).name;
            const info = RxCustomVersions.getInfo(name);
            game = info?.baseVersion || game;
            loader = /neoforge/i.test(name) ? "neoforge" : /fabric/i.test(name) ? "fabric" : /quilt/i.test(name) ? "quilt" : /forge/i.test(name) ? "forge" : "";
        }
        const match = String(game || "").match(/\d+\.\d+(?:\.\d+)?/);
        return {loader: RxModrinthCatalog.LOADERS.includes(loader) ? loader : "", game: match ? match[0] : ""};
    };

    // Quilt запускает и Fabric-моды
    static loadersFor = (loader) => loader === "quilt" ? ["quilt", "fabric"] : [loader];

    // ---------- что уже установлено (по SHA-1 файлов) ----------
    static sha1 = (file) => new Promise((resolve) => {
        const hash = crypto.createHash("sha1");
        fs.createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", () => resolve(""));
    });

    static jarFiles = (modsPath) => {
        try {
            return fs.readdirSync(modsPath).filter(name => /\.jar(\.disabled)?$/i.test(name)).map(name => path.join(modsPath, name));
        } catch (_) {
            return [];
        }
    };

    static loadInstalled = async (force = false) => {
        const context = RxModsManager.getContext();
        if (!context) return RxModrinthCatalog.installed;
        const files = RxModrinthCatalog.jarFiles(context.modsPath);
        const key = context.modsPath + "|" + files.map(file => {
            try { return `${path.basename(file)}:${fs.statSync(file).mtimeMs}`; } catch (_) { return file; }
        }).join(",");
        if (!force && key === RxModrinthCatalog.installedKey) return RxModrinthCatalog.installed;

        const hashes = {};
        for (const file of files) {
            const hash = await RxModrinthCatalog.sha1(file);
            if (hash) hashes[hash] = file;
        }
        const installed = new Map();
        if (Object.keys(hashes).length) {
            try {
                const versions = await RxModrinthCatalog.call("POST", "/version_files", {hashes: Object.keys(hashes), algorithm: "sha1"});
                Object.entries(versions || {}).forEach(([hash, version]) => {
                    installed.set(version.project_id, {file: hashes[hash], versionId: version.id, sha1: hash});
                });
            } catch (error) {
                RxCollector.writeLog(`Modrinth: Could not identify installed mods [error=${error}]`);
            }
        }
        RxModrinthCatalog.installed = installed;
        RxModrinthCatalog.installedKey = key;
        return installed;
    };

    // ---------- поиск ----------
    static search = async (append = false) => {
        const $view = $("#modal-mods [data-view='catalog']");
        const target = RxModrinthCatalog.target();
        $view.find("[data-catalog-target]").text(target?.loader
            ? `${RxVersionsUI.TYPE_LABELS[target.loader] || target.loader} · ${target.game}`
            : "");
        if (!target?.loader || !target.game) {
            $view.find("[data-catalog-list]").empty();
            $view.find("[data-catalog-more]").prop("hidden", true);
            return RxModrinthCatalog.setStatus("block", MESSAGES.mods.catalogNoLoader, MESSAGES.mods.catalogNoLoaderText);
        }

        const state = RxModrinthCatalog.state;
        if (append && (state.loading || state.failed || state.offset >= state.total)) return;
        if (!append) {
            state.offset = 0;
            state.failed = false;
        }
        const generation = ++state.generation;
        state.loading = true;
        if (!append) {
            RxModrinthCatalog.setStatus("progress_activity", MESSAGES.mods.catalogLoading, "");
            $view.find("[data-catalog-more]").prop("hidden", true);
        }

        const facets = [["project_type:mod"], RxModrinthCatalog.loadersFor(target.loader).map(loader => `categories:${loader}`), [`versions:${target.game}`]];
        if (state.category) facets.push([`categories:${state.category}`]);
        const query = new URLSearchParams({
            query: state.query,
            facets: JSON.stringify(facets),
            index: state.sort,
            limit: String(RxModrinthCatalog.PAGE),
            offset: String(state.offset)
        });

        try {
            const [result] = await Promise.all([RxModrinthCatalog.call("GET", `/search?${query}`), RxModrinthCatalog.loadInstalled()]);
            if (generation !== state.generation) return;
            state.total = result.total_hits || 0;
            state.offset += (result.hits || []).length;
            const html = (result.hits || []).map(RxModrinthCatalog.cardHtml).join("");
            const $list = $view.find("[data-catalog-list]");
            append ? $list.append(html) : $list.html(html);
            if (!append) $view.find("[data-catalog-scroll]").scrollTop(0);
            if (state.total === 0) RxModrinthCatalog.setStatus("search_off", MESSAGES.mods.catalogEmpty, MESSAGES.mods.catalogEmptyText);
            else RxModrinthCatalog.setStatus(null);
            // Индикатор внизу виден, пока есть что подгружать
            $view.find("[data-catalog-more]").prop("hidden", state.offset >= state.total);
        } catch (error) {
            if (generation !== state.generation) return;
            RxCollector.writeLog(`Modrinth: Search failed [error=${error}]`);
            state.failed = true; // не повторяем догрузку при каждой прокрутке
            RxModrinthCatalog.setStatus("wifi_off", MESSAGES.mods.catalogOffline, MESSAGES.mods.catalogOfflineText);
            $view.find("[data-catalog-more]").prop("hidden", true);
        } finally {
            if (generation === state.generation) {
                state.loading = false;
                // Карточек мало и прокрутки ещё нет (большое окно) — догружаем сразу
                RxModrinthCatalog.loadMoreIfNeeded();
            }
        }
    };

    // Бесконечная прокрутка: до конца списка осталось меньше ~1.5 экрана — грузим следующую страницу
    static loadMoreIfNeeded = () => {
        const scroll = document.querySelector("#modal-mods [data-catalog-scroll]");
        const state = RxModrinthCatalog.state;
        if (!scroll || state.loading || state.failed || state.offset === 0 || state.offset >= state.total) return;
        if (scroll.closest("[hidden]") || !scroll.clientHeight) return;
        if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < scroll.clientHeight * 1.5) RxModrinthCatalog.search(true);
    };

    static setStatus = (icon, title = "", text = "") => {
        const $status = $("#modal-mods [data-catalog-status]");
        $status.prop("hidden", !icon).toggleClass("spinning", icon === "progress_activity");
        $status.find(".material-symbols-outlined").text(icon || "");
        $status.find("strong").text(title);
        $status.find("span:last-child").text(text);
    };

    static escape = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]);

    static compact = (number) => new Intl.NumberFormat(RxTranslator.getCurrentLanguage() === "en" ? "en-US" : "ru-RU", {notation: "compact", maximumFractionDigits: 1}).format(number || 0);

    static cardHtml = (hit) => {
        const esc = RxModrinthCatalog.escape;
        const installed = RxModrinthCatalog.installed.has(hit.project_id);
        const busy = RxModrinthCatalog.installing.has(hit.project_id);
        const icon = hit.icon_url
            ? `<img src="${esc(hit.icon_url)}" alt="" loading="lazy"/>`
            : `<span class="material-symbols-outlined">extension</span>`;
        const button = installed
            ? `<button class="transparent mc-installed" disabled><span class="material-symbols-outlined">check</span><span>${esc(MESSAGES.mods.catalogInstalled)}</span></button>`
            : `<button data-catalog-install="${esc(hit.project_id)}"${busy ? " disabled" : ""}><span class="material-symbols-outlined">download</span><span>${esc(busy ? MESSAGES.mods.catalogInstalling : MESSAGES.mods.catalogInstall)}</span></button>`;
        return `<article class="mc-card" data-project="${esc(hit.project_id)}">
            <div class="mc-icon">${icon}</div>
            <div class="mc-copy">
                <div class="mc-title-row"><strong>${esc(hit.title)}</strong><span>${esc(MESSAGES.mods.catalogBy.replace("{0}", hit.author || "—"))}</span></div>
                <p>${esc(hit.description)}</p>
                <div class="mc-meta">
                    <span><span class="material-symbols-outlined">download</span>${RxModrinthCatalog.compact(hit.downloads)}</span>
                    <span><span class="material-symbols-outlined">favorite</span>${RxModrinthCatalog.compact(hit.follows)}</span>
                    <span><span class="material-symbols-outlined">update</span>${esc(RxModsManager.formatDate(Date.parse(hit.date_modified) || Date.now()))}</span>
                </div>
            </div>
            <div class="mc-actions">
                ${button}
                <button class="transparent mc-open" data-catalog-open="${esc(hit.slug || hit.project_id)}" title="Modrinth"><span class="material-symbols-outlined">open_in_new</span></button>
            </div>
        </article>`;
    };

    // ---------- установка ----------
    static pickVersion = async (projectId, target) => {
        const params = new URLSearchParams({
            loaders: JSON.stringify(RxModrinthCatalog.loadersFor(target.loader)),
            game_versions: JSON.stringify([target.game])
        });
        const versions = await RxModrinthCatalog.call("GET", `/project/${encodeURIComponent(projectId)}/version?${params}`);
        if (!Array.isArray(versions) || versions.length === 0) return null;
        return versions.find(version => version.version_type === "release") || versions[0];
    };

    static primaryFile = (version) => (version.files || []).find(file => file.primary) || (version.files || [])[0];

    static download = (file, modsPath) => new Promise((resolve, reject) => {
        const fileName = path.basename(String(file.filename || ""));
        if (!/\.jar$/i.test(fileName)) return reject(new Error("Not a jar file"));
        const target = path.join(modsPath, fileName);
        const temp = `${target}.rxdownload`;
        const hash = crypto.createHash("sha1");
        const stream = fs.createWriteStream(temp);
        request.get({url: file.url, headers: {"User-Agent": `MaxRx/RxLauncher/${LAUNCHER_VERSION} (${SITE_URL})`}, timeout: 30000})
            .on("response", (response) => {
                if (response.statusCode !== 200) stream.destroy(new Error(`HTTP ${response.statusCode}`));
            })
            .on("data", chunk => hash.update(chunk))
            .on("error", (error) => stream.destroy(error))
            .pipe(stream);
        stream.on("error", (error) => {
            try { fs.unlinkSync(temp); } catch (_) {}
            reject(error);
        });
        stream.on("finish", () => {
            // Файл проверяем по хешу из Modrinth, прежде чем положить в моды
            if (file.hashes?.sha1 && hash.digest("hex") !== file.hashes.sha1) {
                try { fs.unlinkSync(temp); } catch (_) {}
                return reject(new Error("Checksum mismatch"));
            }
            fs.renameSync(temp, target);
            resolve(fileName);
        });
    });

    // Мод + обязательные зависимости (рекурсивно), без повторов и уже установленного
    static installProject = async (projectId, target, modsPath, visited = new Set()) => {
        if (visited.has(projectId) || RxModrinthCatalog.installed.has(projectId)) return [];
        visited.add(projectId);
        const version = await RxModrinthCatalog.pickVersion(projectId, target);
        if (!version) {
            if (visited.size === 1) throw new Error("noVersion");
            return [];
        }
        const files = [];
        for (const dependency of (version.dependencies || []).filter(dep => dep.dependency_type === "required")) {
            const depProject = dependency.project_id || (dependency.version_id
                ? (await RxModrinthCatalog.call("GET", `/version/${encodeURIComponent(dependency.version_id)}`)).project_id
                : null);
            if (depProject) files.push(...await RxModrinthCatalog.installProject(depProject, target, modsPath, visited));
        }
        const file = RxModrinthCatalog.primaryFile(version);
        if (file) {
            files.push(await RxModrinthCatalog.download(file, modsPath));
            RxModrinthCatalog.installed.set(projectId, {file: path.join(modsPath, file.filename), versionId: version.id, sha1: file.hashes?.sha1});
        }
        return files;
    };

    static install = async (projectId) => {
        const context = RxModsManager.getContext();
        const target = RxModrinthCatalog.target();
        if (!context || !target?.loader || RxModrinthCatalog.installing.has(projectId)) return;
        RxModsManager.ensureDirectory(context.modsPath);
        RxModrinthCatalog.installing.add(projectId);
        RxModrinthCatalog.refreshCard(projectId);
        try {
            const files = await RxModrinthCatalog.installProject(projectId, target, context.modsPath);
            if (!files.length) return RxToasts.create(MESSAGES.mods.catalogInstalled, "check_circle");
            const [main, ...deps] = files.reverse();
            RxToasts.create(MESSAGES.mods.catalogDone, "download_done",
                deps.length ? `${main} + ${MESSAGES.mods.catalogDeps.replace("{0}", deps.length)}` : main, "success");
            RxCollector.writeLog(`Modrinth: Installed [project=${projectId}] [files=${files.join(", ")}]`);
            RxModrinthCatalog.installedKey = "";
        } catch (error) {
            RxCollector.writeLog(`Modrinth: Install failed [project=${projectId}] [error=${error}]`);
            RxToasts.create(error?.message === "noVersion" ? MESSAGES.mods.catalogNoVersion : MESSAGES.mods.catalogFailed, "error", "", "error");
        } finally {
            RxModrinthCatalog.installing.delete(projectId);
            RxModrinthCatalog.refreshCard(projectId);
        }
    };

    static refreshCard = (projectId) => {
        const $card = $(`#modal-mods .mc-card[data-project="${projectId}"]`);
        if (!$card.length) return;
        const installed = RxModrinthCatalog.installed.has(projectId);
        const busy = RxModrinthCatalog.installing.has(projectId);
        const $button = $card.find(".mc-actions > button:first-child");
        if (installed) {
            $button.replaceWith(`<button class="transparent mc-installed" disabled><span class="material-symbols-outlined">check</span><span>${RxModrinthCatalog.escape(MESSAGES.mods.catalogInstalled)}</span></button>`);
        } else {
            $button.prop("disabled", busy).find("span:last-child").text(busy ? MESSAGES.mods.catalogInstalling : MESSAGES.mods.catalogInstall);
            $button.find(".material-symbols-outlined").text(busy ? "progress_activity" : "download").toggleClass("spin", busy);
        }
    };

    // ---------- обновления установленных модов ----------
    static checkUpdates = async () => {
        const context = RxModsManager.getContext();
        const target = RxModrinthCatalog.target();
        if (!context || !target?.loader) return RxToasts.create(MESSAGES.mods.catalogNoLoader, "info");
        const $button = $('#modal-mods [data-mods-action="updates"]');
        $button.prop("disabled", true);
        try {
            const installed = await RxModrinthCatalog.loadInstalled(true);
            const byHash = new Map([...installed.values()].map(item => [item.sha1, item]));
            if (!byHash.size) {
                RxModrinthCatalog.showUpdates([]);
                return RxToasts.create(MESSAGES.mods.updatesNone, "check_circle", MESSAGES.mods.updatesUnknown);
            }
            const latest = await RxModrinthCatalog.call("POST", "/version_files/update", {
                hashes: [...byHash.keys()],
                algorithm: "sha1",
                loaders: RxModrinthCatalog.loadersFor(target.loader),
                game_versions: [target.game]
            });
            const updates = Object.entries(latest || {})
                .map(([hash, version]) => ({current: byHash.get(hash), version, file: RxModrinthCatalog.primaryFile(version)}))
                .filter(item => item.current && item.file && item.version.id !== item.current.versionId);
            RxModrinthCatalog.showUpdates(updates);
            if (!updates.length) RxToasts.create(MESSAGES.mods.updatesNone, "check_circle", "", "success");
        } catch (error) {
            RxCollector.writeLog(`Modrinth: Update check failed [error=${error}]`);
            RxToasts.create(MESSAGES.mods.catalogOffline, "wifi_off", "", "error");
        } finally {
            $button.prop("disabled", false);
        }
    };

    static showUpdates = (updates) => {
        RxModrinthCatalog.updates = updates;
        const $bar = $("#modal-mods [data-mods-updates]");
        $bar.prop("hidden", updates.length === 0);
        $bar.find("[data-mods-updates-title]").text(MESSAGES.mods.updatesFound.replace("{0}", updates.length));
        $bar.find("[data-mods-updates-list]").text(updates.map(item => `${path.basename(item.current.file)} → ${item.version.version_number}`).join(" · "));
    };

    static applyUpdates = async () => {
        const context = RxModsManager.getContext();
        if (!context || !RxModrinthCatalog.updates.length) return;
        const $button = $('#modal-mods [data-mods-action="apply-updates"]').prop("disabled", true);
        // Старые файлы не удаляем сразу, а переносим в папку бэкапа
        const backupDir = path.join(context.gameRoot, "rx-mod-backups", new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
        let done = 0;
        for (const item of RxModrinthCatalog.updates) {
            try {
                const fileName = await RxModrinthCatalog.download(item.file, context.modsPath);
                const oldFile = item.current.file;
                if (path.basename(oldFile) !== fileName && fs.existsSync(oldFile)) {
                    fs.mkdirSync(backupDir, {recursive: true});
                    fs.renameSync(oldFile, path.join(backupDir, path.basename(oldFile)));
                    // Отключённый мод остаётся отключённым
                    if (/\.disabled$/i.test(oldFile)) fs.renameSync(path.join(context.modsPath, fileName), path.join(context.modsPath, `${fileName}.disabled`));
                }
                done++;
            } catch (error) {
                RxCollector.writeLog(`Modrinth: Update failed [file=${item.current.file}] [error=${error}]`);
            }
        }
        $button.prop("disabled", false);
        RxModrinthCatalog.showUpdates([]);
        RxModrinthCatalog.installedKey = "";
        RxToasts.create(MESSAGES.mods.updatesDone.replace("{0}", done), "upgrade", done ? MESSAGES.mods.updatesBackup : "", done ? "success" : "error");
        RxModsManager.refresh();
    };

    // ---------- вкладки и события ----------
    static switchView = (view) => {
        const $modal = $("#modal-mods");
        $modal.find(".mods-tab").removeClass("active").filter(`[data-mods-view="${view}"]`).addClass("active");
        $modal.find(".mods-view").each(function () { this.hidden = this.dataset.view !== view; });
        if (view === "catalog") RxModrinthCatalog.search();
        else RxModsManager.refresh();
    };

    static bind = () => {
        const $modal = $("#modal-mods");
        let searchTimer = null;
        $modal.on("click", "[data-mods-view]", function () { RxModrinthCatalog.switchView($(this).attr("data-mods-view")); });
        $modal.on("input", "[data-catalog-search]", function () {
            clearTimeout(searchTimer);
            RxModrinthCatalog.state.query = String($(this).val() || "").trim();
            searchTimer = setTimeout(() => RxModrinthCatalog.search(), 350);
        });
        $modal.on("change", "[data-catalog-sort]", function () {
            RxModrinthCatalog.state.sort = $(this).val();
            RxModrinthCatalog.search();
        });
        $modal.on("click", "[data-category]", function () {
            $modal.find("[data-category]").removeClass("active");
            $(this).addClass("active");
            RxModrinthCatalog.state.category = $(this).attr("data-category");
            RxModrinthCatalog.search();
        });
        $modal.find("[data-catalog-scroll]").on("scroll", () => RxModrinthCatalog.loadMoreIfNeeded());
        $modal.on("click", "[data-catalog-install]", function () { RxModrinthCatalog.install($(this).attr("data-catalog-install")); });
        $modal.on("click", "[data-catalog-open]", function () { openExternal(`https://modrinth.com/mod/${encodeURIComponent($(this).attr("data-catalog-open"))}`); });
        $modal.on("click", '[data-mods-action="updates"]', () => RxModrinthCatalog.checkUpdates());
        $modal.on("click", '[data-mods-action="apply-updates"]', () => RxModrinthCatalog.applyUpdates());
        $modal.on("click", '[data-mods-action="hide-updates"]', () => RxModrinthCatalog.showUpdates([]));
        // Сменили версию — каталог и обновления относятся уже к другой
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal !== "mods") return;
            RxModrinthCatalog.showUpdates([]);
            if (!$modal.find('[data-view="catalog"]').prop("hidden")) RxModrinthCatalog.search();
        });
    };
}

$(RxModrinthCatalog.bind);
