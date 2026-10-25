let packs_downloadList = [];
let packs_promiseResolve;
let packs_promise;
let packs_currentDownloading = 0;

class RxPacks {
    // Создать пак
    static createPack = (baseVersion, displayName) => {
        displayName = RxUtils.translit(displayName);
        let modpackId = displayName.replace(/\W/g, '_');
        let modpackPath = path.join(GAME_DATA, "modpacks", modpackId);

        fs.mkdirSync(modpackPath, {recursive: true});
        fs.mkdirSync(path.join(modpackPath, "mods"), {recursive: true});
        let parsedVersion = RxVersionsManager.parseVersionID(baseVersion);
        let resultJson = {
            id: modpackId,
            uuid: crypto.randomUUID(),
            displayName: displayName,
            baseVersion: {
                full: baseVersion,
                type: parsedVersion.type,
                number: parsedVersion.name
            },
            files: []
        };
        RxPacks.writeModpackManifest(modpackId, resultJson);
        RxVersionsUI.loadVersions();
        return true;
    }

    // Получить манифест пака
    static getModpackManifest = (modpackId) => {
        if (RxPacks.isModpackExists(modpackId)) {
            return JSON.parse(fs.readFileSync(path.join(GAME_DATA, "modpacks", modpackId, "manifest.json")))
        }
        return false;
    }

    // Сохранить манифест пака
    static writeModpackManifest = (modpackId, manifestData) => {
        let modpackPath = path.join(GAME_DATA, "modpacks", modpackId);
        if (!fs.existsSync(modpackPath)) {
            fs.mkdirSync(modpackPath, {recursive: true});
        }
        return fs.writeFileSync(path.join(modpackPath, "manifest.json"), JSON.stringify(manifestData, null, 4));
    }

    // Существует ли такой пак
    static isModpackExists = (modpackId) => {
        if (typeof modpackId !== "string") return false;
        return fs.existsSync(path.join(GAME_DATA, "modpacks", modpackId, "manifest.json"));
    }

    // Удалить файл из модпака
    static deleteFileFromModpack = (filePath, fromModpack = false, modpackId = null) => {
        if (fromModpack === true && !RxPacks.isModpackExists(modpackId)) {
            return false;
        }

        // Удаляем файл
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Если это модпак - удаляем из конфига. Если нет - возвращаем true
        if (fromModpack === false) {
            // Перезагружаем список
            RxPacksUI.loadInstalledList();
            return true;
        }

        // Получаем манифест нужного пака
        let modpackData = RxPacks.getModpackManifest(modpackId);
        let modpackFiles = modpackData.files;
        let deletionIndex = -1;
        // Ищем deletion index
        modpackFiles.forEach((item, i) => {
            if (item.name === path.basename(filePath)) {
                deletionIndex = i;
            }
        })
        // Удаляем из конфига, если нашли
        if (deletionIndex !== -1) {
            modpackFiles.splice(deletionIndex, 1);
            modpackData.files = modpackFiles;
            RxPacks.writeModpackManifest(modpackId, modpackData);
        }
        // Перезагружаем список
        RxPacksUI.loadInstalledList();
        return true;
    }

    // Получить список модов из пака
    static getPackModlist = (modpackId) => {
        if (!RxPacks.isModpackExists(modpackId)) {
            return false;
        }
        return RxPacks.getModpackManifest(modpackId).files;
    }

    // Проверить и установить недостающие моды
    static verifyAndInstall = (modpackId) => {
        return packs_promise = new Promise((resolve) => {
            packs_promiseResolve = resolve;
            RxPacks.verifyFiles(modpackId).then(() => {
                if (packs_downloadList.length === 0) {
                    return resolve(true);
                }
                packs_currentDownloading = -1;
                RxPacks.downloadNext();
            })
        });
    }

    // Скачать следующий мод из списка
    static downloadNext = () => {
        packs_currentDownloading++;
        if (typeof packs_downloadList[packs_currentDownloading] === "undefined") {
            return packs_promiseResolve(true);
        }
        let filePath = packs_downloadList[packs_currentDownloading].path;
        let url = packs_downloadList[packs_currentDownloading].url;
        let displayName = packs_downloadList[packs_currentDownloading].displayName;
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        RxDownloader.downloadFile(url, filePath, displayName).then(() => {
            RxPacks.downloadNext();
        })
    }

    // Проверить моды и составить список для скачивания
    static verifyFiles = (modpackId) => {
        packs_downloadList = [];
        return new Promise(resolve => {
            let filesList = RxPacks.getPackModlist(modpackId);
            if (filesList === false || filesList.length === 0) {
                return resolve(true, "emptyList");
            }

            filesList.forEach((item) => {
                let filePath = path.join(GAME_DATA, "modpacks", modpackId, item.path);
                if (!RxPacks.verifyPackFile(filePath, item.hashes || {})) {
                    packs_downloadList.push({
                        path: filePath,
                        url: item.url,
                        displayName: item.displayName
                    })
                }
            });
            return resolve(true);
        })
    }

    static verifyPackFile = (filePath, hashes = {}) => {
        if (!fs.existsSync(filePath)) return false;
        const algorithm = hashes.sha512 ? "sha512" : (hashes.sha1 ? "sha1" : (hashes.md5 ? "md5" : false));
        if (!algorithm) return fs.statSync(filePath).size > 0;
        const actual = crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
        return actual.toLowerCase() === hashes[algorithm].toLowerCase();
    }

    // Получить список паков
    static getPacksList = () => {
        let packsPath = path.join(GAME_DATA, "modpacks");
        if (!fs.existsSync(packsPath)) {
            return [];
        }

        let rdPacks = fs.readdirSync(packsPath);
        if (rdPacks.length === 0) {
            return [];
        }

        let validItems = [];
        rdPacks.forEach((item) => {
            if (RxPacks.isModpackExists(item)) {
                validItems.push(item);
            }
        })
        return validItems;
    }

    // Очистить ID модпака от лишних символов
    static modpackCleanID = (id) => {
        return id.toString().replace(/\W/g, '_').trim();
    }

    // Получить безопасную директорию установки для типа проекта Modrinth
    static getInstallDirectory = (mode, modpackId = "default", customPath = "") => {
        if (customPath) {
            return path.resolve(customPath);
        }

        const modeDirectories = {
            mods: "mods",
            resourcepacks: "resourcepacks",
            shaders: "shaderpacks",
            modpacks: path.join("cache", "modrinth")
        };
        const modeDirectory = modeDirectories[mode] || "mods";
        if (mode === "modpacks") {
            return path.join(GAME_DATA, modeDirectory);
        }
        if (RxPacks.isModpackExists(modpackId)) {
            return path.join(GAME_DATA, "modpacks", modpackId, modeDirectory);
        }
        return path.join(GAME_DATA, modeDirectory);
    }

    static getPrimaryModrinthFile = (versionData) => {
        if (!versionData || !Array.isArray(versionData.files) || versionData.files.length === 0) {
            return false;
        }
        return versionData.files.find((file) => file.primary === true) || versionData.files[0];
    }

    static verifyModrinthFile = (filePath, hashes = {}) => {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        const hashType = hashes.sha512 ? "sha512" : (hashes.sha1 ? "sha1" : false);
        if (!hashType) {
            return fs.statSync(filePath).size > 0;
        }
        const actualHash = crypto.createHash(hashType).update(fs.readFileSync(filePath)).digest("hex");
        return actualHash.toLowerCase() === hashes[hashType].toLowerCase();
    }

    static downloadModrinthVersionFile = async (versionData, downloadDirectory) => {
        const fileItem = RxPacks.getPrimaryModrinthFile(versionData);
        if (!fileItem || typeof fileItem.filename !== "string" || path.basename(fileItem.filename) !== fileItem.filename) {
            throw new Error("Modrinth returned invalid file metadata");
        }
        const downloadUrl = new URL(fileItem.url);
        if (downloadUrl.protocol !== "https:") {
            throw new Error("Modrinth returned an insecure download URL");
        }

        fs.mkdirSync(downloadDirectory, {recursive: true});
        const fullDownloadPath = path.join(downloadDirectory, fileItem.filename);
        if (RxPacks.verifyModrinthFile(fullDownloadPath, fileItem.hashes || {})) {
            return fullDownloadPath;
        }

        await RxDownloader.downloadFile(fileItem.url, fullDownloadPath, fileItem.filename);
        if (!RxPacks.verifyModrinthFile(fullDownloadPath, fileItem.hashes || {})) {
            if (fs.existsSync(fullDownloadPath)) {
                fs.unlinkSync(fullDownloadPath);
            }
            throw new Error(`Hash verification failed for ${fileItem.filename}`);
        }
        return fullDownloadPath;
    }

    // Импортировать пак с Modrinth (.mrpack)
    static importModrinthPack = async (archivePath, iconUrl = false) => {
        RxToasts.create(MESSAGES.packs.importing, "publish", path.parse(archivePath).name, 2500);

        const modpacksPath = path.join(GAME_DATA, "modpacks");
        const decompPath = path.join(modpacksPath, `.rx-modrinth-${crypto.randomUUID()}`);
        let createdModpackPath = false;

        try {
            fs.mkdirSync(decompPath, {recursive: true});
            await RxUtils.unpackArchive(archivePath, decompPath);

            const indexPath = path.join(decompPath, "modrinth.index.json");
            if (!fs.existsSync(indexPath)) {
                throw new Error("modrinth.index.json is missing");
            }
            const modrinthIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
            if (!modrinthIndex.name || !modrinthIndex.versionId || !modrinthIndex.dependencies?.minecraft || !Array.isArray(modrinthIndex.files)) {
                throw new Error("Invalid Modrinth pack index");
            }

            const displayName = `${modrinthIndex.name} ${modrinthIndex.versionId}`;
            const modpackId = RxPacks.modpackCleanID(displayName) || `modrinth_${Date.now()}`;
            const modpackPath = path.join(modpacksPath, modpackId);
            if (fs.existsSync(modpackPath)) {
                RxToasts.create(MESSAGES.packs.importFailed, "error", MESSAGES.packs.alreadyExists);
                return false;
            }

            const dependencyKeys = Object.keys(modrinthIndex.dependencies || {});
            let baseVersionType = "vanilla";
            if (dependencyKeys.includes("fabric-loader") || dependencyKeys.includes("fabric-api")) baseVersionType = "fabric";
            if (dependencyKeys.includes("forge")) baseVersionType = "forge";
            if (dependencyKeys.includes("neoforge")) baseVersionType = "neoforge";
            if (dependencyKeys.includes("quilt") || dependencyKeys.includes("quilt-loader")) baseVersionType = "quilt";

            const preparedFilesList = [];
            modrinthIndex.files.forEach((item) => {
                if (item?.env?.client && item.env.client !== "required") return;
                const normalizedPath = path.normalize(item.path || "");
                if (!normalizedPath || path.isAbsolute(normalizedPath) || normalizedPath === ".." || normalizedPath.startsWith(`..${path.sep}`)) {
                    throw new Error("Modrinth pack contains an unsafe file path");
                }
                if (!Array.isArray(item.downloads) || !item.downloads[0] || new URL(item.downloads[0]).protocol !== "https:") {
                    throw new Error("Modrinth pack contains an invalid download URL");
                }
                preparedFilesList.push({
                    hashes: item.hashes || {},
                    path: normalizedPath,
                    name: path.basename(normalizedPath),
                    url: item.downloads[0],
                    size: item.fileSize,
                    displayName: path.parse(normalizedPath).name
                });
            });

            fs.mkdirSync(modpackPath, {recursive: true});
            createdModpackPath = modpackPath;
            for (const overridesDirectory of ["overrides", "client-overrides"]) {
                const sourcePath = path.join(decompPath, overridesDirectory);
                if (fs.existsSync(sourcePath)) {
                    await fsExtra.copy(sourcePath, modpackPath, {overwrite: true});
                }
            }

            const manifestJson = {
                id: modpackId,
                uuid: crypto.randomUUID(),
                displayName,
                baseVersion: {
                    full: `${baseVersionType}-${modrinthIndex.dependencies.minecraft}`,
                    type: baseVersionType,
                    number: modrinthIndex.dependencies.minecraft
                },
                files: preparedFilesList,
                icon: iconUrl
            };
            RxPacks.writeModpackManifest(modpackId, manifestJson);
            await fsPromises.copyFile(indexPath, path.join(modpackPath, "modrinth.index.json"));
            RxToasts.create(MESSAGES.packs.imported, "check", displayName);
            return true;
        } catch (error) {
            console.error(error);
            RxCollector.writeLog(`Modrinth pack import failed [archive=${archivePath}] [error=${error}]`);
            if (createdModpackPath && fs.existsSync(createdModpackPath)) {
                await fsPromises.rm(createdModpackPath, {recursive: true, force: true});
            }
            RxToasts.create(MESSAGES.packs.importFailed, "error", error.message);
            return false;
        } finally {
            await fsPromises.rm(decompPath, {recursive: true, force: true});
        }
    }

    // Установить обязательные зависимости для мода (включая вложенные)
    static installDependenciesList = async (deps, gameVersions, loaders, modpackId = "default", visited = new Set()) => {
        if (!Array.isArray(deps) || deps.length === 0) {
            return true;
        }

        const requiredDeps = deps.filter((dep) => !dep.dependency_type || dep.dependency_type === "required");
        for (const dep of requiredDeps) {
            let depVersion = false;
            if (dep.version_id) {
                const [success, response] = await RxRequests.get(`https://api.modrinth.com/v2/version/${encodeURIComponent(dep.version_id)}`);
                if (success) depVersion = response;
            } else if (dep.project_id) {
                const queryParams = {};
                if (Array.isArray(gameVersions) && gameVersions.length > 0) {
                    queryParams.game_versions = JSON.stringify(gameVersions);
                }
                if (Array.isArray(loaders) && loaders.length > 0) {
                    queryParams.loaders = JSON.stringify(loaders);
                }
                const query = encodeGetParams(queryParams);
                const [success, versions] = await RxRequests.get(`https://api.modrinth.com/v2/project/${encodeURIComponent(dep.project_id)}/version?${query}`);
                if (success && Array.isArray(versions) && versions.length > 0) {
                    depVersion = versions[0];
                }
            }

            if (!depVersion) {
                throw new Error(`Required dependency could not be resolved: ${dep.project_id || dep.version_id || dep.file_name || "unknown"}`);
            }
            if (visited.has(depVersion.id)) {
                continue;
            }
            visited.add(depVersion.id);

            const projectId = depVersion.project_id || dep.project_id;
            let dependencyMode = "mods";
            if (projectId) {
                const [projectSuccess, projectData] = await RxRequests.get(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
                if (projectSuccess) {
                    dependencyMode = {
                        mod: "mods",
                        resourcepack: "resourcepacks",
                        shader: "shaders"
                    }[projectData.project_type] || "mods";
                }
            }

            await RxPacks.downloadModrinthVersionFile(depVersion, RxPacks.getInstallDirectory(dependencyMode, modpackId));
            await RxPacks.installDependenciesList(
                depVersion.dependencies,
                depVersion.game_versions || gameVersions,
                depVersion.loaders || loaders,
                modpackId,
                visited
            );
        }
        return true;
    }

    // Скачать ресурс по ID версии
    static downloadByVersionID = async (versionId, buttonElement = false, installPath = "") => {
        const iconUrl = buttonElement !== false
            ? $(buttonElement).closest(".packs-list > .item").find("img.icon").attr("src") || false
            : false;
        const selectedModpackId = $("#modal-installMods #packs_dirList").val() || "default";

        try {
            const [isSuccess, response] = await RxRequests.get(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
            if (!isSuccess) {
                throw new Error("Failed to load Modrinth version metadata");
            }

            const downloadDirectory = RxPacks.getInstallDirectory(packs_currentMode, selectedModpackId, installPath);
            const downloadedFile = await RxPacks.downloadModrinthVersionFile(response, downloadDirectory);

            if (packs_currentMode === "modpacks") {
                RxFlyout.setText(MESSAGES.commons.installing);
                await RxFlyout.changeMode("spinner");
                const imported = await RxPacks.importModrinthPack(downloadedFile, iconUrl);
                if (fs.existsSync(downloadedFile)) {
                    fs.unlinkSync(downloadedFile);
                }
                if (!imported) {
                    throw new Error("Failed to import Modrinth modpack");
                }
                RxVersionsUI.loadVersions();
            } else if (!installPath && RxConfig.read("autoInstallDeps", false) === true) {
                await RxPacks.installDependenciesList(
                    response.dependencies,
                    response.game_versions,
                    response.loaders,
                    selectedModpackId,
                    new Set([response.id])
                );
            }

            RxToasts.create(response.name, "download_done", MESSAGES.packs.catalog.installed);
            await RxPacksUI.reloadAll(true, false, true);
            return true;
        } catch (error) {
            console.error(error);
            RxCollector.writeLog(`Modrinth install failed [version=${versionId}] [error=${error}]`);
            RxToasts.create(MESSAGES.packs.catalog.installFailed, "error", error.message);
            return false;
        } finally {
            await RxFlyout.changeMode("idle");
        }
    }

    // Импортировать пак с Modrinth (.mrpack) через диалог выбора
    static importModrinthPackDialog = async () => {
        let result = await ipcRenderer.invoke("open-dialog", {
            properties: ["dontAddToRecent"],
            filters: [{name: ".mrpack", extensions: ["mrpack"]}],
        });
        if (result === false) {
            return false;
        }
        return await RxPacks.importModrinthPack(result[0]);
    }

    // Экспортировать пак в zip-файл
    static exportModpack = async (modpackId) => {
        let result = await ipcRenderer.invoke("save-dialog", {
            properties: ["dontAddToRecent"],
            filters: [{name: ".zip", extensions: ["zip"]}],
        });
        if (result === false) {
            return false;
        }
        let modpackPath = path.join(GAME_DATA, "modpacks", modpackId);
        RxToasts.create(MESSAGES.packManager.exportStarted, "upgrade", path.basename(result));
        await RxUtils.compressDirectory(result, modpackPath);
        RxToasts.create(MESSAGES.packManager.exportCompleted, "upgrade", path.basename(result));
        return true;
    }

    // Импортировать пак из файла
    static importModpack = async () => {
        let result = await ipcRenderer.invoke("open-dialog", {
            properties: ["dontAddToRecent"],
            filters: [{name: ".zip", extensions: ["zip"]}],
        });
        if (result === false) {
            return false;
        }
        let unpackPath = path.join(GAME_DATA, "modpacks");
        RxToasts.create(MESSAGES.packManager.importStarted, "download", path.basename(result[0]));
        await RxUtils.unpackArchive(result[0], unpackPath);
        RxToasts.create(MESSAGES.packManager.importCompleted, "download", path.basename(result[0]));
        await RxPacksUI.reloadAll(true, true, true);
        return true;
    }

    // Сменить иконку пака
    static changePackIcon = async (modpackId) => {
        if (!RxPacks.isModpackExists(modpackId)) {
            return resolve(false);
        }

        let result = await ipcRenderer.invoke("open-dialog", {
            properties: ["dontAddToRecent"],
            filters: [{name: ".png", extensions: ["png"]}],
        });

        if (result === false) {
            return false;
        }

        let modpackData = RxPacks.getModpackManifest(modpackId);
        modpackData.icon = "pack";
        RxPacks.writeModpackManifest(modpackId, modpackData);

        let iconPath = path.join(GAME_DATA, "modpacks", modpackId, "icon.png");

        await fs.copyFile(result[0], iconPath);
        RxPackManagerUI.loadModpackIcon(modpackData);
        RxPacksUI.refreshDirectorySelect();
        return true;
    }
}
