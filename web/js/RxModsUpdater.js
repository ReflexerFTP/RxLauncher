let mods__resultList = [];
let mods__currentModpackId = null;

class RxModsUpdater {
    static checkPackUpdatesAvailable = async modpackId => {
        mods__currentModpackId = modpackId;
        mods__resultList = [];
        const $tab = $("#modal-packManager .updateTab");
        $tab.find(".selectMode").hide();
        $tab.find(".updateMode").show();
        const manifest = RxPacks.getModpackManifest(modpackId);
        if (!manifest || !Array.isArray(manifest.files)) return [];
        const files = manifest.files.filter(item => typeof item?.path === "string"
            && item.path.replaceAll("\\", "/").startsWith("mods/"));
        for (let index = 0; index < files.length; index++) {
            const item = files[index];
            $tab.find(".updateMode .text").text(`${MESSAGES.packs.updatePackM.checking} (${index + 1}/${files.length})`);
            try {
                const relative = RxPacks.safety().safePackPath(item.path, {allowBackslashes: true});
                const localPath = path.resolve(GAME_DATA, "modpacks", modpackId, relative);
                if (!fs.existsSync(localPath)) continue;
                const url = new URL(RxPacks.safety().safePackUrl(item.url));
                const parts = url.pathname.split("/");
                if (url.hostname !== "cdn.modrinth.com" || parts[1] !== "data" || !/^[A-Za-z0-9]+$/.test(parts[2] || "")) continue;
                const local = await RxAssetsParsers.readModInfo(localPath);
                if (!local || !local.version) continue;
                $tab.find(".updateMode .mod").text(local.name || item.name);
                const gameVersions = encodeURIComponent(JSON.stringify([manifest.baseVersion.number]));
                const loaders = encodeURIComponent(JSON.stringify([manifest.baseVersion.type]));
                const [ok, response] = await RxRequests.get(`https://api.modrinth.com/v2/project/${parts[2]}/version?game_versions=${gameVersions}&loaders=${loaders}`);
                if (!ok || !Array.isArray(response)) continue;
                const release = response.find(version => version.version_type === "release" && Array.isArray(version.files) && version.files.length);
                if (!release || local.version === release.version_number) continue;
                const file = release.files.find(candidate => candidate.primary) || release.files[0];
                if (!file || typeof file.filename !== "string" || path.basename(file.filename) !== file.filename) continue;
                RxPacks.safety().safePackPath(`mods/${file.filename}`);
                RxPacks.safety().safePackUrl(file.url);
                RxPacks.safety().safePackHashes(file.hashes);
                mods__resultList.push({
                    projectId: parts[2], projectName: local.name || item.name,
                    current: local.version, currentFileName: item.name,
                    currentPath: relative, latest: {version: release.version_number, file, name: release.name},
                    icon: local.icon
                });
            } catch (error) {
                RxCollector.writeLog(`Mods: Update check skipped [file=${item.name}] [error=${error.message}]`);
            }
        }
        return mods__resultList;
    }

    static updateAllFromList = async () => {
        const $tab = $("#modal-packManager .updateTab");
        $tab.find(".foundUpdateMode").hide();
        $tab.find(".updateMode .mod").text("");
        $tab.find(".updateMode .text").text(MESSAGES.packs.updatePackM.installing);
        $tab.find(".updateMode").show();
        const packId = mods__currentModpackId;
        const manifest = RxPacks.getModpackManifest(packId);
        const stageRoot = path.join(GAME_DATA, "cache", "mod-updates", crypto.randomUUID());
        const oldFiles = [];
        const copiedFiles = [];
        let manifestBackup = null;
        let rollbackFailed = false;
        try {
            if (!manifest || !Array.isArray(manifest.files) || !RxPacks.isSafePackId(packId)) throw new Error("Invalid modpack");
            const packRoot = path.resolve(GAME_DATA, "modpacks", packId);
            const realPackRoot = fs.realpathSync(packRoot);
            if (path.dirname(realPackRoot).toLowerCase() !== fs.realpathSync(path.join(GAME_DATA, "modpacks")).toLowerCase()) {
                throw new Error("Pack directory is linked outside the game data");
            }
            const safe = RxPacks.safety();
            const updates = mods__resultList.map((item, index) => {
                const relativeOld = safe.safePackPath(item.currentPath, {allowBackslashes: true});
                const relativeNew = safe.safePackPath(`mods/${item.latest.file.filename}`);
                const oldPath = path.resolve(packRoot, relativeOld);
                const newPath = path.resolve(packRoot, relativeNew);
                if (!oldPath.startsWith(packRoot + path.sep) || !newPath.startsWith(packRoot + path.sep)
                    || !fs.statSync(oldPath).isFile() || fs.lstatSync(oldPath).isSymbolicLink()
                    || !fs.realpathSync(oldPath).startsWith(realPackRoot + path.sep)
                    || !fs.realpathSync(path.dirname(newPath)).startsWith(realPackRoot + path.sep)
                    || (newPath !== oldPath && fs.existsSync(newPath))) {
                    throw new Error("Mod update conflicts with an existing file");
                }
                return {
                    item, oldPath, newPath, relativeNew,
                    stagePath: path.join(stageRoot, `${index}-${crypto.randomUUID()}.jar`),
                    url: safe.safePackUrl(item.latest.file.url),
                    hashes: safe.safePackHashes(item.latest.file.hashes)
                };
            });
            if (!updates.length) return false;
            if (new Set(updates.map(item => item.newPath.toLowerCase())).size !== updates.length) {
                throw new Error("Two mods have the same update filename");
            }
            fs.mkdirSync(stageRoot, {recursive: true});
            await RxDownloader.downloadMany(updates.map(update => ({
                url: update.url, path: update.stagePath, hashes: update.hashes,
                size: update.item.latest.file.size, displayName: update.item.latest.file.filename,
                urlPolicy: safe.safePackUrl
            })), MESSAGES.packs.updatePackM.installing, 3);
            manifestBackup = path.join(stageRoot, "manifest.backup.json");
            fs.copyFileSync(path.join(packRoot, "manifest.json"), manifestBackup);
            const backupDir = path.join(packRoot, "rx-mod-backups", `mod-update-${crypto.randomUUID()}`);
            const nextManifest = JSON.parse(JSON.stringify(manifest));
            for (const update of updates) {
                const backup = path.join(backupDir, path.relative(packRoot, update.oldPath));
                fs.mkdirSync(path.dirname(backup), {recursive: true});
                fs.renameSync(update.oldPath, backup);
                oldFiles.push({from: update.oldPath, backup});
                fs.mkdirSync(path.dirname(update.newPath), {recursive: true});
                copiedFiles.push(update.newPath);
                fs.copyFileSync(update.stagePath, update.newPath);
                const entry = nextManifest.files.find(file => {
                    try { return safe.safePackPath(file.path, {allowBackslashes: true}) === update.item.currentPath; }
                    catch (_) { return false; }
                });
                if (!entry) throw new Error("Mod manifest changed during update");
                Object.assign(entry, {
                    hashes: update.hashes, url: update.url, name: update.item.latest.file.filename,
                    size: update.item.latest.file.size, path: update.relativeNew,
                    displayName: path.parse(update.item.latest.file.filename).name
                });
            }
            RxPacks.writeModpackManifest(packId, nextManifest);
            mods__resultList = [];
            return true;
        } catch (error) {
            try {
                for (const file of copiedFiles.reverse()) if (fs.existsSync(file)) fs.unlinkSync(file);
                for (const file of oldFiles.reverse()) fs.renameSync(file.backup, file.from);
                if (manifestBackup) fs.copyFileSync(manifestBackup, path.join(GAME_DATA, "modpacks", packId, "manifest.json"));
            } catch (rollbackError) {
                rollbackFailed = true;
                RxCollector.writeLog(`Mods: Update rollback failed [pack=${packId}] [recovery=${stageRoot}] [error=${rollbackError.message}]`);
            }
            RxCollector.writeLog(`Mods: Update failed [pack=${packId}] [error=${error.message}]`);
            RxToasts.create(MESSAGES.packs.filesFailed, "error", error.message, "error");
            return false;
        } finally {
            if (!rollbackFailed) await fsPromises.rm(stageRoot, {recursive: true, force: true}).catch(() => {});
            $tab.find(".updateMode").hide();
            $tab.find(".selectMode").show();
            await RxFlyout.changeMode("idle");
            RxFlyout.setUIStartMode(false);
        }
    }

    static checkUpdates = async () => {
        const updates = await RxModsUpdater.checkPackUpdatesAvailable(packman__currentModpack.id);
        const $tab = $("#modal-packManager .updateTab");
        const $list = $tab.find(".updates-list").empty();
        $tab.find(".foundUpdateMode").show();
        $tab.find(".updateMode").hide();
        updates.forEach(item => {
            const $row = $("<div>").addClass("item custom-select icon-and-description");
            const $icon = $("<img>").addClass("icon");
            if (typeof item.icon === "string" && /^[A-Za-z0-9+/=]{1,100000}$/.test(item.icon)) {
                $icon.attr("src", `data:image/png;base64,${item.icon}`);
            }
            $row.append($icon, $("<span>").addClass("title").text(item.projectName));
            const $description = $("<div>").addClass("flex flex-align-center flex-gap-4 description");
            $description.append($("<span>").text(item.current),
                $("<span>").addClass("material-symbols-outlined").text("arrow_forward"),
                $("<span>").text(item.latest.version));
            $list.append($row.append($description));
        });
    }
}
