class RxPacks {
    static safety = () => require("../modrinthPackSafety");
    static isSafePackId = id => typeof id === "string" && id.length > 0 && id.length <= 128
        && /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(id) && !id.endsWith(".")
        && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id);
    static assertSafePackTarget = (root, target) => {
        const realRoot = fs.realpathSync(root);
        const realParent = fs.realpathSync(path.dirname(root));
        if (path.dirname(realRoot).toLowerCase() !== realParent.toLowerCase()) throw new Error("Linked modpack directory");
        let existing = target;
        while (!fs.existsSync(existing) && existing !== root) existing = path.dirname(existing);
        const realExisting = fs.realpathSync(existing);
        if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
            throw new Error("Modpack file path leaves the pack directory");
        }
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Linked modpack file");
    };

    // Создать пак
    static createPack = (baseVersion, displayName) => {
        displayName = RxUtils.translit(displayName);
        let modpackId = displayName.replace(/\W/g, '_').slice(0, 100);
        if (!RxPacks.isSafePackId(modpackId)) modpackId = `pack_${crypto.randomUUID().slice(0, 8)}`;
        if (fs.existsSync(path.join(GAME_DATA, "modpacks", modpackId))) modpackId += `_${crypto.randomUUID().slice(0, 8)}`;
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
            try { return JSON.parse(fs.readFileSync(path.join(GAME_DATA, "modpacks", modpackId, "manifest.json"))); }
            catch (error) { RxCollector.writeLog(`Packs: Invalid manifest [pack=${modpackId}] [error=${error.message}]`); }
        }
        return false;
    }

    // Сохранить манифест пака
    static writeModpackManifest = (modpackId, manifestData) => {
        if (!RxPacks.isSafePackId(modpackId)) throw new Error("Invalid modpack ID");
        let modpackPath = path.join(GAME_DATA, "modpacks", modpackId);
        if (!fs.existsSync(modpackPath)) {
            fs.mkdirSync(modpackPath, {recursive: true});
        }
        const target = path.join(modpackPath, "manifest.json");
        const temporary = path.join(modpackPath, `.manifest-${crypto.randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, JSON.stringify(manifestData, null, 4));
            fs.renameSync(temporary, target);
            return true;
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }

    // Существует ли такой пак
    static isModpackExists = (modpackId) => {
        if (!RxPacks.isSafePackId(modpackId)) return false;
        return fs.existsSync(path.join(GAME_DATA, "modpacks", modpackId, "manifest.json"));
    }

    // Удалить файл из модпака
    static deleteFileFromModpack = async (filePath, fromModpack = false, modpackId = null) => {
        if (fromModpack === true && !RxPacks.isModpackExists(modpackId)) {
            return false;
        }
        const modpackData = fromModpack ? RxPacks.getModpackManifest(modpackId) : null;
        if (fromModpack && (!modpackData || !Array.isArray(modpackData.files))) return false;
        const root = path.resolve(GAME_DATA, ...(fromModpack ? ["modpacks", modpackId] : []));
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return false;
        const resolved = path.resolve(filePath);
        const relative = path.relative(root, resolved);
        try {
            RxPacks.safety().safePackPath(relative, {allowBackslashes: true});
            const parts = relative.split(path.sep);
            if (parts.length < 2 || !["mods", "resourcepacks", "shaderpacks"].includes(parts[0])) return false;
            if (!resolved.startsWith(root + path.sep)) return false;
            if (fs.existsSync(resolved)) {
                if ((!fs.statSync(resolved).isFile() && !fs.statSync(resolved).isDirectory())
                    || fs.lstatSync(resolved).isSymbolicLink()
                    || !fs.realpathSync(resolved).startsWith(fs.realpathSync(root) + path.sep)) return false;
            }
        } catch (_) { return false; }
        // Files and folder-based resource packs go to the recycle bin.
        try { if (fs.existsSync(resolved)) await require("electron").shell.trashItem(resolved); }
        catch (error) { RxCollector.writeLog(`Packs: Could not trash file [error=${error.message}]`); return false; }

        // Если это модпак - удаляем из конфига. Если нет - возвращаем true
        if (fromModpack === false) {
            // Перезагружаем список
            RxPacksUI.loadInstalledList();
            return true;
        }

        // Получаем манифест нужного пака
        let modpackFiles = modpackData.files;
        const remaining = modpackFiles.filter(item => {
            const itemPath = path.normalize(item.path || item.name || "");
            return itemPath !== relative && !itemPath.startsWith(relative + path.sep);
        });
        if (remaining.length !== modpackFiles.length) {
            modpackData.files = remaining;
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
        try {
            const missing = await RxPacks.verifyFiles(modpackId);
            if (missing.length === 0) return true;
            RxCollector.writeLog(`Packs: Downloading ${missing.length} file(s) [pack=${modpackId}]`);
            await RxDownloader.downloadMany(missing, RxPacks.getModpackManifest(modpackId)?.displayName || modpackId);
            return true;
        } catch (error) {
            RxCollector.writeLog(`Packs: Download failed [pack=${modpackId}] [file=${error.file}] [error=${error.message}]`);
            if (!/aborted|cancelled/i.test(error.message || "")) RxToasts.create(MESSAGES.packs.filesFailed, "error", error.file || error.message, "error");
            return false;
        }
    }

    // Файлы сборки, которых нет или которые не совпадают по хешу. Проверяем по 4 файла сразу, не блокируя окно
    static verifyFiles = async (modpackId) => {
        if (!RxPacks.isSafePackId(modpackId)) throw new Error("Invalid modpack ID");
        const filesList = RxPacks.getPackModlist(modpackId);
        if (!Array.isArray(filesList) || filesList.length === 0) return [];
        const root = path.resolve(GAME_DATA, "modpacks", modpackId);
        const missing = [];
        const queue = [...filesList];
        const worker = async () => {
            while (queue.length) {
                const item = queue.shift();
                const relative = RxPacks.safety().safePackPath(item.path || item.name || "", {allowBackslashes: true});
                const filePath = path.resolve(root, relative);
                // Путь из манифеста не должен выходить за папку сборки
                if (!filePath.startsWith(root + path.sep)) throw new Error("Unsafe modpack file entry");
                RxPacks.assertSafePackTarget(root, filePath);
                const url = RxPacks.safety().safePackUrl(item.url);
                if (!(await RxHttp.isFileValid(filePath, item.hashes || {}))) {
                    missing.push({path: filePath, url, hashes: item.hashes || {}, size: item.size,
                        displayName: item.displayName, urlPolicy: RxPacks.safety().safePackUrl});
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
            if (RxPacks.getModpackManifest(item)) {
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
        try {
            await RxUtils.unpackArchive(archivePath, decompPath);
            const indexPath = path.join(decompPath, "modrinth.index.json");
            if (!fs.existsSync(indexPath) || fs.statSync(indexPath).size > 16 * 1024 * 1024) {
                throw new Error("modrinth.index.json is missing or too large");
            }
            const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
            return {decompPath, indexPath, index, ...RxPacks.parseModrinthIndex(index)};
        } catch (error) {
            error.decompPath = decompPath;
            throw error;
        }
    }

    // Базовая версия игры и список клиентских файлов из modrinth.index.json
    static parseModrinthIndex = (modrinthIndex) => {
        if (!modrinthIndex || typeof modrinthIndex !== "object" || typeof modrinthIndex.name !== "string"
            || !modrinthIndex.name.trim() || typeof modrinthIndex.versionId !== "string"
            || !modrinthIndex.versionId.trim() || !modrinthIndex.dependencies?.minecraft
            || !Array.isArray(modrinthIndex.files) || modrinthIndex.files.length > 20000) {
            throw new Error("Invalid Modrinth pack index");
        }
        const safe = RxPacks.safety();
        const minecraftVersion = safe.safePackVersion(modrinthIndex.dependencies.minecraft);

        const dependencyKeys = Object.keys(modrinthIndex.dependencies || {});
        let baseVersionType = "vanilla";
        if (dependencyKeys.includes("fabric-loader") || dependencyKeys.includes("fabric-api")) baseVersionType = "fabric";
        if (dependencyKeys.includes("forge")) baseVersionType = "forge";
        if (dependencyKeys.includes("neoforge")) baseVersionType = "neoforge";
        if (dependencyKeys.includes("quilt") || dependencyKeys.includes("quilt-loader")) baseVersionType = "quilt";

        const files = [];
        const seenPaths = new Set();
        modrinthIndex.files.forEach((item) => {
            if (item?.env?.client && item.env.client !== "required") return;
            const normalizedPath = safe.safePackPath(item.path);
            if (seenPaths.has(normalizedPath.toLowerCase())) throw new Error("Duplicate Modrinth pack file path");
            seenPaths.add(normalizedPath.toLowerCase());
            if (!Array.isArray(item.downloads) || !item.downloads[0]) {
                throw new Error("Modrinth pack contains an invalid download URL");
            }
            const url = safe.safePackUrl(item.downloads[0]);
            const hashes = safe.safePackHashes(item.hashes);
            if (!Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > 4 * 1024 ** 3) {
                throw new Error("Modrinth pack file size is invalid");
            }
            files.push({
                hashes,
                path: normalizedPath,
                name: path.basename(normalizedPath),
                url,
                size: item.fileSize,
                displayName: path.parse(normalizedPath).name
            });
        });

        return {
            files,
            baseVersion: {
                full: `${baseVersionType}-${minecraftVersion}`,
                type: baseVersionType,
                number: minecraftVersion,
                loaderVersion: (modrinthIndex.dependencies[{fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", neoforge: "neoforge"}[baseVersionType]] || modrinthIndex.dependencies.quilt)
                    ? safe.safePackVersion(modrinthIndex.dependencies[{fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", neoforge: "neoforge"}[baseVersionType]] || modrinthIndex.dependencies.quilt) : ""
            }
        };
    }

    static copyModrinthOverrides = async (decompPath, modpackPath) => {
        for (const overridesDirectory of ["overrides", "client-overrides"]) {
            const sourcePath = path.join(decompPath, overridesDirectory);
            if (fs.existsSync(sourcePath)) {
                const realSourceRoot = fs.realpathSync(sourcePath);
                await fsExtra.copy(sourcePath, modpackPath, {overwrite: true, filter: (source, destination) => {
                    if (source === sourcePath) return true;
                    const relative = path.relative(sourcePath, source);
                    RxPacks.safety().safePackPath(relative, {allowBackslashes: true});
                    if (fs.lstatSync(source).isSymbolicLink()) throw new Error("Pack override contains a link");
                    const realSource = fs.realpathSync(source);
                    if (!realSource.startsWith(realSourceRoot + path.sep)) throw new Error("Pack override escapes archive");
                    let current = destination;
                    while (current !== modpackPath && current.startsWith(modpackPath + path.sep)) {
                        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
                            throw new Error("Pack override targets a linked folder");
                        }
                        current = path.dirname(current);
                    }
                    return true;
                }});
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
            const modpackId = RxPacks.modpackCleanID(RxUtils.translit(displayName)).slice(0, 100) || `modrinth_${Date.now()}`;
            const modpackPath = path.join(modpacksPath, modpackId);
            if (fs.existsSync(modpackPath)) {
                RxToasts.create(MESSAGES.packs.importFailed, "error", MESSAGES.packs.alreadyExists);
                return false;
            }

            fs.mkdirSync(modpackPath, {recursive: true});
            createdModpackPath = modpackPath;
            await RxPacks.copyModrinthOverrides(decompPath, modpackPath);

            const manifestJson = {
                id: modpackId,
                uuid: crypto.randomUUID(),
                displayName,
                baseVersion: unpacked.baseVersion,
                files: unpacked.files,
                icon: iconUrl,
                created: Date.now(),
                ...(extra.source && typeof extra.source === "object" ? {source: extra.source} : {})
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
            if (decompPath) await fsPromises.rm(decompPath, {recursive: true, force: true}).catch(error => {
                RxCollector.writeLog(`Packs: Temporary cleanup failed [error=${error}]`);
            });
        }
    }

    // Обновить сборку из нового .mrpack: файлы, которых больше нет в сборке, уходят в rx-mod-backups,
    // моды, добавленные вручную, и миры не трогаются. Название меняется, только если пользователь его не переименовывал
    static updateModrinthPack = async (modpackId, archivePath, source = {}) => {
        const manifest = RxPacks.getModpackManifest(modpackId);
        if (!manifest) return false;
        const modpackPath = path.resolve(GAME_DATA, "modpacks", modpackId);
        let decompPath = false;
        const movedFiles = [];
        const changedFiles = new Map();
        let rollbackRoot = false;
        let rollbackFailed = false;
        try {
            const realModpacksRoot = fs.realpathSync(path.join(GAME_DATA, "modpacks"));
            if (path.dirname(fs.realpathSync(modpackPath)).toLowerCase() !== realModpacksRoot.toLowerCase()) {
                throw new Error("Pack directory is linked outside the game data");
            }
            const unpacked = await RxPacks.unpackModrinthPack(archivePath).catch(error => {
                decompPath = error.decompPath || false;
                throw error;
            });
            decompPath = unpacked.decompPath;
            // Validate and merge both override trees before changing the installed pack.
            const stagePath = path.join(decompPath, ".rx-staged-overrides");
            fs.mkdirSync(stagePath, {recursive: true});
            await RxPacks.copyModrinthOverrides(decompPath, stagePath);
            rollbackRoot = path.join(decompPath, ".rx-rollback");
            fs.mkdirSync(rollbackRoot, {recursive: true});
            fs.copyFileSync(path.join(modpackPath, "manifest.json"), path.join(rollbackRoot, "manifest.json"));
            const oldIndexPath = path.join(modpackPath, "modrinth.index.json");
            if (fs.existsSync(oldIndexPath)) fs.copyFileSync(oldIndexPath, path.join(rollbackRoot, "modrinth.index.json"));
            const keep = new Set(unpacked.files.map(file => path.normalize(file.path).toLowerCase()));
            const backupDir = path.join(modpackPath, "rx-mod-backups",
                `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
            let removed = 0;
            for (const oldFile of manifest.files || []) {
                const relative = RxPacks.safety().safePackPath(oldFile.path || oldFile.name || "", {allowBackslashes: true});
                if (keep.has(relative.toLowerCase())) continue;
                const fullPath = path.resolve(modpackPath, relative);
                if (!fullPath.startsWith(modpackPath + path.sep)) throw new Error("Unsafe installed pack file path");
                for (const candidate of [fullPath, `${fullPath}.disabled`]) {
                    if (!fs.existsSync(candidate)) continue;
                    if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error("Pack contains a linked file");
                    RxPacks.assertSafePackTarget(modpackPath, candidate);
                    const target = path.join(backupDir, path.relative(modpackPath, candidate));
                    fs.mkdirSync(path.dirname(target), {recursive: true});
                    fs.renameSync(candidate, target);
                    movedFiles.push({from: candidate, to: target});
                    removed++;
                }
            }
            await fsExtra.copy(stagePath, modpackPath, {overwrite: true, filter: (from, to) => {
                if (from === stagePath) return true;
                const relative = RxPacks.safety().safePackPath(path.relative(stagePath, from), {allowBackslashes: true});
                let current = to;
                while (current !== modpackPath && current.startsWith(modpackPath + path.sep)) {
                    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
                        throw new Error("Pack override targets a linked folder");
                    }
                    current = path.dirname(current);
                }
                if (fs.lstatSync(from).isFile() && !changedFiles.has(to)) {
                    const original = fs.existsSync(to) ? path.join(rollbackRoot, "overrides", relative) : null;
                    if (original) {
                        fs.mkdirSync(path.dirname(original), {recursive: true});
                        fs.copyFileSync(to, original);
                    }
                    changedFiles.set(to, original);
                }
                return true;
            }});

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
            if (rollbackRoot) {
                try {
                    for (const [target, original] of changedFiles) {
                        if (original) fs.copyFileSync(original, target);
                        else if (fs.existsSync(target)) fs.unlinkSync(target);
                    }
                    for (const name of ["manifest.json", "modrinth.index.json"]) {
                        const original = path.join(rollbackRoot, name);
                        const target = path.join(modpackPath, name);
                        if (fs.existsSync(original)) fs.copyFileSync(original, target);
                        else if (name === "modrinth.index.json" && fs.existsSync(target)) fs.unlinkSync(target);
                    }
                    for (const item of movedFiles.reverse()) {
                        fs.mkdirSync(path.dirname(item.from), {recursive: true});
                        fs.renameSync(item.to, item.from);
                    }
                } catch (rollbackError) {
                    rollbackFailed = true;
                    RxCollector.writeLog(`Packs: Rollback failed [pack=${modpackId}] [recovery=${rollbackRoot}] [error=${rollbackError}]`);
                }
            }
            RxCollector.writeLog(`Packs: Update failed [pack=${modpackId}] [error=${error}]`);
            return false;
        } finally {
            if (decompPath && !rollbackFailed) await fsPromises.rm(decompPath, {recursive: true, force: true}).catch(error => {
                RxCollector.writeLog(`Packs: Temporary cleanup failed [error=${error}]`);
            });
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
