const CURSEFORGE_GAME_ID = 432;
const CURSEFORGE_CLASS_IDS = {
    mods: 6,
    modpacks: 4471,
    resourcepacks: 12,
    shaders: 6552
};
const CURSEFORGE_LOADER_TYPES = {
    forge: 1,
    fabric: 4,
    quilt: 5,
    neoforge: 6
};

class RxCurseForge {
    // Папка overrides из manifest.json CurseForge: относительный путь строго внутри распакованного архива, не ссылка
    static safeOverridesDir = (root, value) => {
        const name = value === undefined || value === null || value === "" ? "overrides" : value;
        let relative;
        try {
            relative = RxPacks.safety().safePackPath(name);
        } catch (_) {
            throw new Error("Unsafe overrides folder in CurseForge manifest");
        }
        const base = fs.realpathSync(root);
        const target = path.resolve(base, relative);
        if (!target.startsWith(base + path.sep)) throw new Error("Unsafe overrides folder in CurseForge manifest");
        if (!fs.existsSync(target)) return null;
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe overrides folder in CurseForge manifest");
        const real = fs.realpathSync(target);
        if (!real.startsWith(base + path.sep)) throw new Error("Unsafe overrides folder in CurseForge manifest");
        return real;
    };

    // forge-47.2.0 / neoforge-21.1.77 / fabric-0.16.9 → номер версии загрузчика (или "", если его нет)
    static loaderVersion = (loaderId, loaderType) => {
        if (loaderType === "vanilla") return "";
        const match = /^[a-z-]*?-(\d[0-9A-Za-z._+-]*)$/i.exec(String(loaderId || ""));
        if (!match) return "";
        try {
            return RxPacks.safety().safePackVersion(match[1]);
        } catch (_) {
            return "";
        }
    };

    static apiKeyConfigured = false;

    static request = async (endpoint, query = {}, method = "GET", body = null) => {
        const response = await ipcRenderer.invoke("curseforge-request", {endpoint, query, method, body});
        return [response?.success === true, response?.data || false, response || {}];
    }

    static refreshAuthPanel = async () => {
        const status = await ipcRenderer.invoke("curseforge-key-status");
        RxCurseForge.apiKeyConfigured = status?.configured === true;
        const $panel = $("#modal-installMods .curseforge-auth");
        $panel.toggle(packs_currentProvider === "curseforge");
        $panel.toggleClass("configured", RxCurseForge.apiKeyConfigured);
        $panel.find(".curseforge-auth__setup").toggle(!RxCurseForge.apiKeyConfigured);
        $panel.find(".curseforge-auth__ready").toggle(RxCurseForge.apiKeyConfigured);
        $panel.find(".curseforge-auth__clear").prop("disabled", status?.managedByEnvironment === true);
        $panel.find(".curseforge-auth__error").text("").hide();
        if (status?.secureStorageAvailable === false && !RxCurseForge.apiKeyConfigured) {
            $panel.find(".curseforge-auth__error").text(MESSAGES.packs.curseforge.secureStorageUnavailable).show();
            $panel.find(".curseforge-auth__save").prop("disabled", true);
        } else {
            $panel.find(".curseforge-auth__save").prop("disabled", false);
        }
        return status;
    }

    static saveApiKey = async () => {
        const $input = $("#modal-installMods .curseforge-api-key");
        const $button = $("#modal-installMods .curseforge-auth__save");
        const $error = $("#modal-installMods .curseforge-auth__error");
        const apiKey = $input.val().toString().trim();
        $error.hide().text("");
        $button.prop("disabled", true);
        const result = await ipcRenderer.invoke("set-curseforge-api-key", apiKey);
        $button.prop("disabled", false);
        if (!result?.success) {
            const message = {
                invalid_key_format: MESSAGES.packs.curseforge.invalidKey,
                invalid_key: MESSAGES.packs.curseforge.invalidKey,
                secure_storage_unavailable: MESSAGES.packs.curseforge.secureStorageUnavailable
            }[result?.error] || `${MESSAGES.packs.curseforge.keySaveError}: ${result?.error || "unknown"}`;
            $error.text(message).show();
            return false;
        }
        $input.val("");
        await RxCurseForge.refreshAuthPanel();
        await RxPacksUI.reloadAll(true, true, true);
        return true;
    }

    static clearApiKey = async () => {
        const result = await ipcRenderer.invoke("clear-curseforge-api-key");
        if (!result?.success) {
            RxToasts.create(MESSAGES.packs.curseforge.keyDeleteError, "error", result?.error || "unknown");
            return false;
        }
        await RxCurseForge.refreshAuthPanel();
        await RxPacksUI.reloadAll(true, true, true);
        return true;
    }

    static loadFilters = async () => {
        const [versionsSuccess, versions] = await RxRequests.get(MODRINTH_GAME_VERSIONS_URL);
        if (!versionsSuccess || !Array.isArray(versions)) return false;

        const selectedCheckboxes = [];
        $("#modal-installMods .filters__scroll-wrapper input[type=checkbox]:checked").each(function () {
            selectedCheckboxes.push($(this).val());
        });
        $("#filtersLoaders").empty();
        $("#filtersVersions").empty();

        versions.filter((item) => item.version_type === "release").forEach((item, index) => {
            const $input = $("<input>").attr({type: "checkbox", class: "checkbox", id: `cf-ver-${index}`, value: item.version});
            const $label = $("<label>").attr("for", `cf-ver-${index}`).text(item.version);
            $("#filtersVersions").append($input, $label);
        });

        if (["mods", "modpacks"].includes(packs_currentMode)) {
            Object.keys(CURSEFORGE_LOADER_TYPES).forEach((loader, index) => {
                const $input = $("<input>").attr({type: "checkbox", class: "checkbox", id: `cf-loader-${index}`, value: loader});
                const $label = $("<label>").attr("for", `cf-loader-${index}`).text(RxUtils.capitalizeWord(loader));
                $("#filtersLoaders").append($input, $label);
            });
        }

        $("#modal-installMods .filters__scroll-wrapper input[type=checkbox]").each(function () {
            if (selectedCheckboxes.includes($(this).val())) $(this).prop("checked", true);
        });
        RxPacksUI.loadFiltersByModpackID();
        $("#modal-installMods .filters__scroll-wrapper input[type=checkbox]").off("change.curseforge").on("change.curseforge", function () {
            if ($(this).is(":checked")) {
                $(this).siblings("input[type=checkbox]").prop("checked", false);
            }
            RxPacksUI.reloadAll(true, false, true);
        });
        return true;
    }

    static selectedGameVersion = () => $("#filtersVersions input:checked").first().val() || "";

    static selectedLoaderName = () => $("#filtersLoaders input:checked").first().val() || "";

    static selectedLoaderType = () => CURSEFORGE_LOADER_TYPES[RxCurseForge.selectedLoaderName()] || 0;

    static modeFromClassId = (classId) => ({
        6: "mods",
        4471: "modpacks",
        12: "resourcepacks",
        6552: "shaders"
    })[classId] || "mods";

    static openProjectURL = (url, projectId = "") => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol === "https:" && (parsed.hostname === "www.curseforge.com" || parsed.hostname === "legacy.curseforge.com")) {
                return openExternal(parsed.toString());
            }
        } catch (_) {}
        return openExternal(`https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(projectId)}`);
    }

    static loadModsList = async (clearBefore = true) => {
        const requestId = ++packs_loadRequestId;
        const $packsList = $("#modal-installMods .packs-list");
        const $preloader = $("#modal-installMods .preloader");

        if (clearBefore) {
            RxPacksUI.clearListAnimations();
            $packsList.find(".item:not(.placeholder)").remove();
            packs_hasMore = true;
        }
        const keyStatus = await RxCurseForge.refreshAuthPanel();
        if (!keyStatus?.configured) {
            $packsList.show();
            $preloader.hide();
            packs_hasMore = false;
            RxPacksUI.setCatalogStatus("empty", MESSAGES.packs.curseforge.apiKeyRequired);
            return false;
        }

        if (clearBefore) $packsList.hide();
        $preloader.show();
        RxPacksUI.setCatalogStatus("loading", MESSAGES.packs.curseforge.loading);

        const sortField = {
            downloads: 6,
            follows: 12,
            updated: 3,
            newest: 11,
            relevance: 2
        }[packs_currentSort] || 6;
        const query = {
            gameId: CURSEFORGE_GAME_ID,
            classId: CURSEFORGE_CLASS_IDS[packs_currentMode],
            index: packs_currentOffset,
            pageSize: 20,
            sortField,
            sortOrder: "desc"
        };
        const searchText = $("#modal-installMods input.search").val().toString().trim();
        if (searchText) query.searchFilter = searchText;
        const gameVersion = RxCurseForge.selectedGameVersion();
        if (gameVersion) query.gameVersion = gameVersion;
        const loaderType = RxCurseForge.selectedLoaderType();
        if (loaderType && ["mods", "modpacks"].includes(packs_currentMode)) query.modLoaderType = loaderType;

        const [success, responseBody, response] = await RxCurseForge.request("/v1/mods/search", query);
        if (!success) {
            if (requestId === packs_loadRequestId) {
                $packsList.show();
                $preloader.hide();
                RxPacksUI.setCatalogStatus("error", response.status === 401 || response.status === 403
                    ? MESSAGES.packs.curseforge.invalidKey
                    : MESSAGES.packs.curseforge.loadError);
            }
            packs_scrollIsLoading = false;
            return false;
        }
        if (requestId !== packs_loadRequestId) return false;

        const projects = Array.isArray(responseBody.data) ? responseBody.data : [];
        const pagination = responseBody.pagination || {};
        packs_hasMore = Number(pagination.index || 0) + projects.length < Number(pagination.totalCount || 0);
        const $newItems = RxCurseForge.renderProjects(projects);
        RxPacksUI.animateLoadedItems($newItems);
        $packsList.show();
        $preloader.hide();
        if (clearBefore && projects.length === 0) {
            RxPacksUI.setCatalogStatus("empty", MESSAGES.packs.catalog.empty);
        } else {
            RxPacksUI.setCatalogStatus("", "");
        }
        return true;
    }

    static renderProjects = (projects) => {
        const $packsList = $("#modal-installMods .packs-list");
        let $newItems = $();
        projects.forEach((item) => {
            const $card = $("#modal-installMods .item.placeholder").first().clone();
            $card.removeClass("placeholder").attr({"data-id": item.id, "data-provider": "curseforge"}).removeAttr("style");
            $card.find("img.icon").attr("src", item.logo?.thumbnailUrl || "assets/modIcon.webp").on("error", function () {
                $(this).attr("src", "assets/modIcon.webp");
            });
            $card.find(".title").first().text(item.name);
            $card.find(".description").text(item.summary || MESSAGES.packs.catalog.noDescription);
            $card.find(".downloads").text(kFormatter(item.downloadCount || 0));
            $card.find(".favorite-icon").text("person");
            $card.find(".favorite").text((item.authors || []).map((author) => author.name).slice(0, 2).join(", ") || "CurseForge");
            $card.find(".catalog-install").on("click", () => RxCurseForge.loadVersionsList(item.id));
            $card.find(".catalog-open").on("click", (event) => {
                event.preventDefault();
                RxCurseForge.openProjectURL(item.links?.websiteUrl, item.slug || item.id);
            });
            $packsList.append($card);
            $newItems = $newItems.add($card);
        });
        return $newItems;
    }

    static getFileLoaders = (fileData) => {
        const knownLoaders = ["Forge", "Fabric", "Quilt", "NeoForge", "LiteLoader", "Cauldron"];
        return (fileData.gameVersions || []).filter((value) => knownLoaders.some((loader) => loader.toLowerCase() === value.toLowerCase()));
    }

    static getFileGameVersions = (fileData) => {
        const loaders = RxCurseForge.getFileLoaders(fileData).map((loader) => loader.toLowerCase());
        return (fileData.gameVersions || []).filter((value) => !loaders.includes(value.toLowerCase()) && /^\d+(?:\.\d+){1,2}(?:[-.][0-9A-Za-z]+)?$/.test(value));
    }

    static isModpackInstalled = (projectId, fileId) => RxPacks.getPacksList().some((packId) => {
        const manifest = RxPacks.getModpackManifest(packId);
        return manifest?.source?.provider === "curseforge"
            && Number(manifest.source.projectId) === Number(projectId)
            && Number(manifest.source.fileId) === Number(fileId);
    });

    static loadVersionsList = async (modId) => {
        const $itemElem = $(`#modal-installMods .packs-list > .item[data-provider="curseforge"][data-id="${modId}"]`);
        const $versionList = $itemElem.find(".versions-list");
        if ($itemElem.hasClass("opened") && $itemElem.data("versions-loaded") === true) {
            $itemElem.removeClass("opened");
            $itemElem.find(".button button.pill").show();
            return true;
        }

        $itemElem.addClass("opened");
        $itemElem.find(".button button.pill").hide();
        $itemElem.find(".versions-list-preloader").show();
        $versionList.empty();
        const query = {pageSize: 50};
        const gameVersion = RxCurseForge.selectedGameVersion();
        const loaderType = RxCurseForge.selectedLoaderType();
        if (gameVersion) query.gameVersion = gameVersion;
        if (loaderType && ["mods", "modpacks"].includes(packs_currentMode)) query.modLoaderType = loaderType;
        const [success, body] = await RxCurseForge.request(`/v1/mods/${modId}/files`, query);
        if (!success) {
            $itemElem.find(".versions-list-preloader").hide();
            $itemElem.find(".button button.pill").show();
            $versionList.append($("<div>").addClass("version-message error").text(MESSAGES.packs.catalog.versionsError));
            return false;
        }

        const files = Array.isArray(body.data) ? body.data : [];
        files.forEach((fileData) => {
            const $versionItem = $("<div>").addClass("item");
            $versionItem.append($("<span>").addClass("title").text(fileData.displayName || fileData.fileName));
            const loaderText = RxCurseForge.getFileLoaders(fileData).join(", ");
            const versionText = RxCurseForge.getFileGameVersions(fileData).join(", ");
            $versionItem.append($("<div>").addClass("flex flex-align-center flex-gap-4 versions").text([loaderText, versionText].filter(Boolean).join(" • ")));
            const alreadyInstalled = packs_currentMode === "modpacks"
                ? RxCurseForge.isModpackInstalled(modId, fileData.id)
                : RxPacksUI.isFileInstalled(fileData.fileName);
            if (alreadyInstalled) {
                $versionItem.append($("<span>").addClass("material-symbols-outlined").attr("title", MESSAGES.packs.catalog.installed).text("download_done"));
            } else {
                const $installButton = $("<button>").addClass("small pill").text(MESSAGES.commons.install);
                $installButton.on("click", () => RxCurseForge.downloadFile(modId, fileData.id, $installButton[0]));
                $versionItem.append($installButton);
            }
            $versionList.append($versionItem);
        });
        if (files.length === 0) {
            $versionList.append($("<div>").addClass("version-message").text(MESSAGES.packs.catalog.noCompatibleVersions));
        }
        $itemElem.data("versions-loaded", true);
        $itemElem.find(".versions-list-preloader").hide();
        return true;
    }

    static hashesToObject = (hashes = []) => {
        const result = {};
        hashes.forEach((hash) => {
            if (hash.algo === 1) result.sha1 = hash.value;
            if (hash.algo === 2) result.md5 = hash.value;
        });
        return result;
    }

    static verifyFile = (filePath, hashes = {}) => {
        if (!fs.existsSync(filePath)) return false;
        const algorithm = hashes.sha1 ? "sha1" : (hashes.md5 ? "md5" : false);
        if (!algorithm) return fs.statSync(filePath).size > 0;
        const actual = crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
        return actual.toLowerCase() === hashes[algorithm].toLowerCase();
    }

    static resolveDownloadUrl = async (fileData) => {
        if (fileData.downloadUrl) return fileData.downloadUrl;
        const [success, body] = await RxCurseForge.request(`/v1/mods/${fileData.modId}/files/${fileData.id}/download-url`);
        if (success && typeof body.data === "string") return body.data;
        return false;
    }

    static downloadFileData = async (fileData, mode, modpackId) => {
        const downloadUrl = await RxCurseForge.resolveDownloadUrl(fileData);
        if (!downloadUrl) {
            const error = new Error(MESSAGES.packs.curseforge.manualDownloadRequired);
            error.code = "manual_download_required";
            error.modId = fileData.modId;
            error.fileId = fileData.id;
            throw error;
        }
        const parsedUrl = new URL(downloadUrl);
        if (parsedUrl.protocol !== "https:" || path.basename(fileData.fileName) !== fileData.fileName) {
            throw new Error(MESSAGES.packs.curseforge.invalidDownload);
        }
        const downloadDirectory = RxPacks.getInstallDirectory(mode, modpackId);
        fs.mkdirSync(downloadDirectory, {recursive: true});
        const destination = path.join(downloadDirectory, fileData.fileName);
        const hashes = RxCurseForge.hashesToObject(fileData.hashes);
        if (!RxCurseForge.verifyFile(destination, hashes)) {
            await RxDownloader.downloadFile(downloadUrl, destination, fileData.fileName);
            if (!RxCurseForge.verifyFile(destination, hashes)) {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
                throw new Error(`${MESSAGES.packs.curseforge.hashError}: ${fileData.fileName}`);
            }
        }
        return destination;
    }

    static getCompatibleFile = async (modId, gameVersion, loaderType) => {
        const query = {pageSize: 50};
        if (gameVersion) query.gameVersion = gameVersion;
        if (loaderType) query.modLoaderType = loaderType;
        const [success, body] = await RxCurseForge.request(`/v1/mods/${modId}/files`, query);
        if (!success || !Array.isArray(body.data) || body.data.length === 0) return false;
        return body.data.find((file) => file.isAvailable !== false) || false;
    }

    static installDependencies = async (dependencies, gameVersion, loaderType, modpackId, visited) => {
        const required = (dependencies || []).filter((dependency) => dependency.relationType === 3);
        for (const dependency of required) {
            const depFile = await RxCurseForge.getCompatibleFile(dependency.modId, gameVersion, loaderType);
            if (!depFile) throw new Error(`${MESSAGES.packs.curseforge.dependencyMissing}: ${dependency.modId}`);
            const visitKey = `${depFile.modId}:${depFile.id}`;
            if (visited.has(visitKey)) continue;
            visited.add(visitKey);
            const [projectSuccess, projectBody] = await RxCurseForge.request(`/v1/mods/${dependency.modId}`);
            const dependencyMode = projectSuccess ? RxCurseForge.modeFromClassId(projectBody.data?.classId) : "mods";
            await RxCurseForge.installDependencies(depFile.dependencies, gameVersion, loaderType, modpackId, visited);
            await RxCurseForge.downloadFileData(depFile, dependencyMode, modpackId);
        }
        return true;
    }

    static importModpack = async (archivePath, projectData, fileData) => {
        const modpacksPath = path.join(GAME_DATA, "modpacks");
        const tempPath = path.join(modpacksPath, `.rx-curseforge-${crypto.randomUUID()}`);
        let createdPackPath = false;
        try {
            fs.mkdirSync(tempPath, {recursive: true});
            await RxUtils.unpackArchive(archivePath, tempPath);
            const manifestPath = path.join(tempPath, "manifest.json");
            if (!fs.existsSync(manifestPath)) throw new Error(MESSAGES.packs.curseforge.invalidManifest);
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            if (!manifest.minecraft?.version || !Array.isArray(manifest.files)) throw new Error(MESSAGES.packs.curseforge.invalidManifest);

            const displayName = `${manifest.name || projectData.name} ${manifest.version || fileData.displayName}`;
            const packId = RxPacks.modpackCleanID(displayName) || `curseforge_${Date.now()}`;
            const packPath = path.join(modpacksPath, packId);
            if (fs.existsSync(packPath)) throw new Error(MESSAGES.packs.alreadyExists);

            const requestedFileIds = manifest.files.filter((file) => file.required !== false).map((file) => Number(file.fileID)).filter(Number.isInteger);
            const fileMetadata = [];
            for (let index = 0; index < requestedFileIds.length; index += 50) {
                const [success, body] = await RxCurseForge.request("/v1/mods/files", {}, "POST", {fileIds: requestedFileIds.slice(index, index + 50)});
                if (!success || !Array.isArray(body.data)) throw new Error(MESSAGES.packs.curseforge.packFilesError);
                fileMetadata.push(...body.data);
            }

            const preparedFiles = [];
            for (const dependencyFile of fileMetadata) {
                const downloadUrl = await RxCurseForge.resolveDownloadUrl(dependencyFile);
                if (!downloadUrl) throw new Error(`${MESSAGES.packs.curseforge.manualDownloadRequired}: ${dependencyFile.fileName}`);
                preparedFiles.push({
                    hashes: RxCurseForge.hashesToObject(dependencyFile.hashes),
                    path: path.join("mods", dependencyFile.fileName),
                    name: dependencyFile.fileName,
                    url: downloadUrl,
                    size: dependencyFile.fileLength,
                    displayName: path.parse(dependencyFile.fileName).name
                });
            }

            fs.mkdirSync(packPath, {recursive: true});
            createdPackPath = packPath;
            // Папка overrides из manifest.json — чужие данные: только относительный путь внутри распакованного архива,
            // без ссылок (иначе можно скопировать в сборку файлы снаружи архива)
            const overridesDirectory = RxCurseForge.safeOverridesDir(tempPath, manifest.overrides);
            if (overridesDirectory) {
                await fsExtra.copy(overridesDirectory, packPath, {
                    overwrite: true, dereference: false,
                    filter: (source) => !fs.lstatSync(source).isSymbolicLink()
                });
            }

            const loaderId = String(manifest.minecraft.modLoaders?.find((loader) => loader.primary)?.id || manifest.minecraft.modLoaders?.[0]?.id || "vanilla");
            const loaderType = loaderId.startsWith("neoforge") ? "neoforge"
                : loaderId.startsWith("forge") ? "forge"
                    : loaderId.includes("fabric") ? "fabric"
                        : loaderId.includes("quilt") ? "quilt" : "vanilla";
            // Точная версия загрузчика (forge-47.2.0 → 47.2.0), как при импорте Modrinth: сборка ставится воспроизводимо
            const loaderVersion = RxCurseForge.loaderVersion(loaderId, loaderType);
            RxPacks.writeModpackManifest(packId, {
                id: packId,
                uuid: crypto.randomUUID(),
                displayName,
                baseVersion: {
                    full: `${loaderType}-${manifest.minecraft.version}`,
                    type: loaderType,
                    number: manifest.minecraft.version,
                    ...(loaderVersion ? {loaderVersion} : {})
                },
                files: preparedFiles,
                icon: projectData.logo?.thumbnailUrl || false,
                source: {provider: "curseforge", projectId: projectData.id, fileId: fileData.id}
            });
            await fsPromises.copyFile(manifestPath, path.join(packPath, "curseforge-manifest.json"));
            return true;
        } catch (error) {
            if (createdPackPath && fs.existsSync(createdPackPath)) await fsPromises.rm(createdPackPath, {recursive: true, force: true});
            throw error;
        } finally {
            await fsPromises.rm(tempPath, {recursive: true, force: true});
        }
    }

    static downloadFile = async (modId, fileId, buttonElement = false) => {
        const selectedModpackId = $("#modal-installMods #packs_dirList").val() || "default";
        let projectData = false;
        let temporaryArchivePath = false;
        try {
            const [[fileSuccess, fileBody], [projectSuccess, projectBody]] = await Promise.all([
                RxCurseForge.request(`/v1/mods/${modId}/files/${fileId}`),
                RxCurseForge.request(`/v1/mods/${modId}`)
            ]);
            if (!fileSuccess || !projectSuccess) throw new Error(MESSAGES.packs.curseforge.fileMetadataError);
            const fileData = fileBody.data;
            projectData = projectBody.data;
            const visited = new Set([`${modId}:${fileId}`]);

            if (packs_currentMode === "modpacks") {
                temporaryArchivePath = await RxCurseForge.downloadFileData(fileData, "modpacks", selectedModpackId);
                const imported = await RxCurseForge.importModpack(temporaryArchivePath, projectData, fileData);
                if (!imported) throw new Error(MESSAGES.packs.importFailed);
                RxVersionsUI.loadVersions();
            } else {
                const gameVersion = RxCurseForge.getFileGameVersions(fileData)[0] || RxCurseForge.selectedGameVersion();
                const loaderName = RxCurseForge.getFileLoaders(fileData)[0]?.toLowerCase() || RxCurseForge.selectedLoaderName();
                const loaderType = CURSEFORGE_LOADER_TYPES[loaderName] || 0;
                if (RxConfig.read("autoInstallDeps", true) === true) {
                    await RxCurseForge.installDependencies(fileData.dependencies, gameVersion, loaderType, selectedModpackId, visited);
                }
                await RxCurseForge.downloadFileData(fileData, packs_currentMode, selectedModpackId);
            }

            RxToasts.create(projectData.name, "download_done", MESSAGES.packs.curseforge.installed);
            await RxPacksUI.reloadAll(true, false, true);
            return true;
        } catch (error) {
            console.error(error);
            RxCollector.writeLog(`CurseForge install failed [mod=${modId}] [file=${fileId}] [error=${error}]`);
            if (error.code === "manual_download_required") {
                const websiteUrl = projectData?.links?.websiteUrl;
                RxCurseForge.openProjectURL(websiteUrl ? `${websiteUrl.replace(/\/$/, "")}/files/${error.fileId}` : "", modId);
            }
            RxToasts.create(MESSAGES.packs.curseforge.installFailed, "error", error.message);
            return false;
        } finally {
            if (temporaryArchivePath && fs.existsSync(temporaryArchivePath)) {
                try { fs.unlinkSync(temporaryArchivePath); } catch (_) {}
            }
            await RxFlyout.changeMode("idle");
        }
    }
}
