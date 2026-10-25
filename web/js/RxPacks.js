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

    // Проверить и докачать недостающие файлы сборки (параллельно, с проверкой хешей).
    // false — что-то не скачалось: запуск с неполной сборкой всё равно бы упал
    static verifyAndInstall = async (modpackId) => {
        const missing = await RxPacks.verifyFiles(modpackId);
        if (missing.length === 0) return true;
        RxCollector.writeLog(`Packs: Downloading ${missing.length} file(s) [pack=${modpackId}]`);
        try {
            await RxDownloader.downloadMany(missing, RxPacks.getModpackManifest(modpackId)?.displayName || modpackId);
            return true;
        } catch (error) {
            RxCollector.writeLog(`Packs: Download failed [pack=${modpackId}] [file=${error.file}] [error=${error.message}]`);
            if (!/aborted|cancelled/i.test(error.message)) RxToasts.create(MESSAGES.packs.filesFailed, "error", error.file || error.message, "error");
            return false;
        }
    }

    // Файлы сборки, которых нет или которые не совпадают по хешу. Проверяем по 4 файла сразу, не блокируя окно
    static verifyFiles = async (modpackId) => {
        const filesList = RxPacks.getPackModlist(modpackId);
        if (!Array.isArray(filesList) || filesList.length === 0) return [];
        const root = path.resolve(GAME_DATA, "modpacks", modpackId);
        const missing = [];
        const queue = [...filesList];
        const worker = async () => {
            while (queue.length) {
                const item = queue.shift();
                const filePath = path.resolve(root, item.path || item.name || "");
                // Путь из манифеста не должен выходить за папку сборки
                if (!filePath.startsWith(root + path.sep) || !item.url) continue;
                if (!(await RxHttp.isFileValid(filePath, item.hashes || {}))) {
                    missing.push({path: filePath, url: item.url, hashes: item.hashes || {}, size: item.size, displayName: item.displayName});
                }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return missing;
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
        if (await RxHttp.isFileValid(fullDownloadPath, fileItem.hashes || {})) {
            return fullDownloadPath;
        }

        // Хеш проверяется до того, как файл окажется на месте
        await RxDownloader.downloadFile(fileItem.url, fullDownloadPath, fileItem.filename, true, fileItem.hashes || {});
        return fullDownloadPath;
    }

    // Распаковать .mrpack во временную папку и прочитать modrinth.index.json
    static unpackModrinthPack = async (archivePath) => {
        const decompPath = path.join(GAME_DATA, "modpacks", `.rx-modrinth-${crypto.randomUUID()}`);
        fs.mkdirSync(decompPath, {recursive: true});
        await RxUtils.unpackArchive(archivePath, decompPath);
        const indexPath = path.join(decompPath, "modrinth.index.json");
        if (!fs.existsSync(indexPath)) {
            throw Object.assign(new Error("modrinth.index.json is missing"), {decompPath});
        }
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        return {decompPath, indexPath, index, ...RxPacks.parseModrinthIndex(index)};
    }

    // Базовая версия игры и список клиентских файлов из modrinth.index.json
    static parseModrinthIndex = (modrinthIndex) => {
        if (!modrinthIndex.name || !modrinthIndex.versionId || !modrinthIndex.dependencies?.minecraft || !Array.isArray(modrinthIndex.files)) {
            throw new Error("Invalid Modrinth pack index");
        }

        const dependencyKeys = Object.keys(modrinthIndex.dependencies || {});
        let baseVersionType = "vanilla";
        if (dependencyKeys.includes("fabric-loader") || dependencyKeys.includes("fabric-api")) baseVersionType = "fabric";
        if (dependencyKeys.includes("forge")) baseVersionType = "forge";
        if (dependencyKeys.includes("neoforge")) baseVersionType = "neoforge";
        if (dependencyKeys.includes("quilt") || dependencyKeys.includes("quilt-loader")) baseVersionType = "quilt";

        const files = [];
        modrinthIndex.files.forEach((item) => {
            if (item?.env?.client && item.env.client !== "required") return;
            const normalizedPath = path.normalize(item.path || "");
            if (!normalizedPath || path.isAbsolute(normalizedPath) || normalizedPath === ".." || normalizedPath.startsWith(`..${path.sep}`)) {
                throw new Error("Modrinth pack contains an unsafe file path");
            }
            if (!Array.isArray(item.downloads) || !item.downloads[0] || new URL(item.downloads[0]).protocol !== "https:") {
                throw new Error("Modrinth pack contains an invalid download URL");
            }
            files.push({
                hashes: item.hashes || {},
                path: normalizedPath,
                name: path.basename(normalizedPath),
                url: item.downloads[0],
                size: item.fileSize,
                displayName: path.parse(normalizedPath).name
            });
        });

        return {
            files,
            baseVersion: {
                full: `${baseVersionType}-${modrinthIndex.dependencies.minecraft}`,
                type: baseVersionType,
                number: modrinthIndex.dependencies.minecraft
            }
        };
    }

    static copyModrinthOverrides = async (decompPath, modpackPath) => {
        for (const overridesDirectory of ["overrides", "client-overrides"]) {
            const sourcePath = path.join(decompPath, overridesDirectory);
            if (fs.existsSync(sourcePath)) {
                await fsExtra.copy(sourcePath, modpackPath, {overwrite: true});
            }
        }
    }

    // Импортировать пак с Modrinth (.mrpack). extra — дополнительные поля манифеста (например, source из каталога).
    // Возвращает ID созданной сборки или false
    static importModrinthPack = async (archivePath, iconUrl = false, extra = {}) => {
        RxToasts.create(MESSAGES.packs.importing, "publish", path.parse(archivePath).name, 2500);

        const modpacksPath = path.join(GAME_DATA, "modpacks");
        let decompPath = false;
        let createdModpackPath = false;

        try {
            const unpacked = await RxPacks.unpackModrinthPack(archivePath).catch(error => {
                decompPath = error.decompPath || false;
                throw error;
            });
            decompPath = unpacked.decompPath;
            const modrinthIndex = unpacked.index;

            // Из каталога приходит название со страницы Modrinth: в самом .mrpack оно бывает техническим
            const displayName = extra.displayName || `${modrinthIndex.name} ${modrinthIndex.versionId}`;
            const modpackId = RxPacks.modpackCleanID(RxUtils.translit(displayName)) || `modrinth_${Date.now()}`;
            const modpackPath = path.join(modpacksPath, modpackId);
            if (fs.existsSync(modpackPath)) {
                RxToasts.create(MESSAGES.packs.importFailed, "error", MESSAGES.packs.alreadyExists);
                return false;
            }

            fs.mkdirSync(modpackPath, {recursive: true});
            createdModpackPath = modpackPath;
            await RxPacks.copyModrinthOverrides(decompPath, modpackPath);

            const {displayName: _customName, ...extraFields} = extra;
            const manifestJson = {
                id: modpackId,
                uuid: crypto.randomUUID(),
                displayName,
                baseVersion: unpacked.baseVersion,
                files: unpacked.files,
                icon: iconUrl,
                created: Date.now(),
                ...extraFields
            };
            // Откуда сборка: по этим данным потом ищутся её обновления
            if (manifestJson.source) {
                manifestJson.source = {...manifestJson.source, packName: modrinthIndex.name, packVersion: modrinthIndex.versionId, defaultName: displayName};
            }
            RxPacks.writeModpackManifest(modpackId, manifestJson);
            await fsPromises.copyFile(unpacked.indexPath, path.join(modpackPath, "modrinth.index.json"));
            RxToasts.create(MESSAGES.packs.imported, "check", displayName);
            return modpackId;
        } catch (error) {
            console.error(error);
            RxCollector.writeLog(`Modrinth pack import failed [archive=${archivePath}] [error=${error}]`);
            if (createdModpackPath && fs.existsSync(createdModpackPath)) {
                await fsPromises.rm(createdModpackPath, {recursive: true, force: true});
            }
            RxToasts.create(MESSAGES.packs.importFailed, "error", error.message);
            return false;
        } finally {
            if (decompPath) await fsPromises.rm(decompPath, {recursive: true, force: true});
        }
    }

    // Обновить сборку из нового .mrpack: файлы, которых больше нет в сборке, уходят в rx-mod-backups,
    // моды, добавленные вручную, и миры не трогаются. Название меняется, только если пользователь его не переименовывал
    static updateModrinthPack = async (modpackId, archivePath, source = {}) => {
        const manifest = RxPacks.getModpackManifest(modpackId);
        if (!manifest) return false;
        const modpackPath = path.resolve(GAME_DATA, "modpacks", modpackId);
        let decompPath = false;
        try {
            const unpacked = await RxPacks.unpackModrinthPack(archivePath).catch(error => {
                decompPath = error.decompPath || false;
                throw error;
            });
            decompPath = unpacked.decompPath;

            const keep = new Set(unpacked.files.map(file => path.normalize(file.path).toLowerCase()));
            const backupDir = path.join(modpackPath, "rx-mod-backups", new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
            let removed = 0;
            for (const oldFile of manifest.files || []) {
                const relative = path.normalize(oldFile.path || "");
                if (!relative || relative === "." || keep.has(relative.toLowerCase())) continue;
                const fullPath = path.resolve(modpackPath, relative);
                if (!fullPath.startsWith(modpackPath + path.sep)) continue;
                for (const candidate of [fullPath, `${fullPath}.disabled`]) {
                    if (!fs.existsSync(candidate)) continue;
                    const target = path.join(backupDir, path.relative(modpackPath, candidate));
                    fs.mkdirSync(path.dirname(target), {recursive: true});
                    fs.renameSync(candidate, target);
                    removed++;
                }
            }
            await RxPacks.copyModrinthOverrides(decompPath, modpackPath);

            const oldSource = manifest.source || {};
            const newSource = {...oldSource, ...source, packName: unpacked.index.name, packVersion: unpacked.index.versionId};
            const renamed = manifest.displayName !== (oldSource.defaultName || `${oldSource.packName} ${oldSource.packVersion}`);
            const displayName = renamed ? manifest.displayName
                : (newSource.title ? `${newSource.title} ${newSource.versionNumber || unpacked.index.versionId}` : `${unpacked.index.name} ${unpacked.index.versionId}`);
            RxPacks.writeModpackManifest(modpackId, {
                ...manifest,
                displayName,
                baseVersion: unpacked.baseVersion,
                files: unpacked.files,
                source: {...newSource, defaultName: renamed ? oldSource.defaultName : displayName}
            });
            await fsPromises.copyFile(unpacked.indexPath, path.join(modpackPath, "modrinth.index.json"));
            RxCollector.writeLog(`Packs: Updated ${modpackId} to ${unpacked.index.versionId} [movedToBackup=${removed}]`);
            return true;
        } catch (error) {
            RxCollector.writeLog(`Packs: Update failed [pack=${modpackId}] [error=${error}]`);
            return false;
        } finally {
            if (decompPath) await fsPromises.rm(decompPath, {recursive: true, force: true});
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
