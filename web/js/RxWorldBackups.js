// Резервные копии миров: автокопия после игры (только миров, в которые играли) и ручные копии с восстановлением.
// Копии лежат в <папка игры>/backups/worlds/<мир>/<дата>-<причина>.zip
class RxWorldBackups {
    static KEEP_AUTO = 5;
    static MAX_BYTES = 2 * 1024 * 1024 * 1024;

    static isEnabled = () => RxConfig.read("autoBackupWorlds", true) === true;

    static root = () => path.join(GAME_DATA, "backups", "worlds");

    // У каждого мира своя папка: читаемое имя + короткий хеш пути (названия миров бывают одинаковые и на кириллице)
    static dirFor = (worldPath) => {
        const relative = path.relative(GAME_DATA, worldPath);
        const key = relative.startsWith("..") ? worldPath : relative;
        const readable = path.basename(worldPath).replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "world";
        return path.join(RxWorldBackups.root(), `${readable}-${crypto.createHash("sha1").update(key.toLowerCase()).digest("hex").slice(0, 8)}`);
    };

    static stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    // Размер папки; считаем до предела, дальше не важно
    static folderSize = async (dir, limit = Infinity) => {
        let total = 0;
        const stack = [dir];
        while (stack.length && total <= limit) {
            const current = stack.pop();
            let entries = [];
            try {
                entries = await fsPromises.readdir(current, {withFileTypes: true});
            } catch (_) {
                continue;
            }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) stack.push(full);
                else if (entry.isFile()) total += (await fsPromises.stat(full).catch(() => ({size: 0}))).size;
            }
        }
        return total;
    };

    static list = (worldPath) => {
        const dir = RxWorldBackups.dirFor(worldPath);
        try {
            return fs.readdirSync(dir)
                .filter(name => /\.zip$/i.test(name))
                .map(name => {
                    const file = path.join(dir, name);
                    const stat = fs.statSync(file);
                    return {file, name, time: stat.mtimeMs, size: stat.size, reason: (name.match(/-(auto|manual|restore)\.zip$/i) || [])[1] || "manual"};
                })
                .sort((a, b) => b.time - a.time);
        } catch (_) {
            return [];
        }
    };

    static backup = async (worldPath, reason = "manual") => {
        if (!fs.existsSync(path.join(worldPath, "level.dat"))) throw new Error("Not a world");
        const dir = RxWorldBackups.dirFor(worldPath);
        fs.mkdirSync(dir, {recursive: true});
        // Две копии в одну секунду не должны затирать друг друга
        const stamp = RxWorldBackups.stamp();
        let target = path.join(dir, `${stamp}-${reason}.zip`);
        for (let index = 2; fs.existsSync(target); index++) target = path.join(dir, `${stamp}_${index}-${reason}.zip`);
        const temp = `${target}.part`;
        try {
            await compressing.zip.compressDir(worldPath, temp);
            fs.renameSync(temp, target);
        } catch (error) {
            try { fs.unlinkSync(temp); } catch (_) {}
            throw error;
        }
        fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({path: worldPath, name: path.basename(worldPath)}, null, 2));
        RxWorldBackups.prune(worldPath);
        RxCollector.writeLog(`WorldBackups: Saved ${path.basename(worldPath)} [reason=${reason}] [file=${target}]`);
        return target;
    };

    // Автокопий храним не больше KEEP_AUTO на мир; ручные не удаляем
    static prune = (worldPath) => {
        RxWorldBackups.list(worldPath).filter(item => item.reason === "auto").slice(RxWorldBackups.KEEP_AUTO).forEach(item => {
            try { fs.unlinkSync(item.file); } catch (_) {}
        });
    };

    static remove = (backupFile) => {
        const resolved = path.resolve(backupFile);
        if (!resolved.startsWith(path.resolve(RxWorldBackups.root()) + path.sep)) return false;
        fs.unlinkSync(resolved);
        return true;
    };

    // Восстановить мир из копии. Текущее состояние мира сначала тоже сохраняется копией
    static restoring = new Set();

    static restore = async (worldPath, backupFile) => {
        worldPath = path.resolve(worldPath);
        if (this.restoring.has(worldPath)) throw new Error("World restore already running");
        this.restoring.add(worldPath);
        try { return await this.restoreUnlocked(worldPath, backupFile); } finally { this.restoring.delete(worldPath); }
    };

    static restoreUnlocked = async (worldPath, backupFile) => {
        if (typeof gamePid !== "undefined" && gamePid !== false) throw new Error("Game is running");
        if (fs.existsSync(path.join(worldPath, "level.dat"))) await RxWorldBackups.backup(worldPath, "restore");
        const stamp = crypto.randomUUID();
        let installed = false;
        const temp = `${worldPath}.rx-restore-${stamp}`;
        const old = `${worldPath}.rx-old-${stamp}`;
        try {
            await RxUtils.unpackArchive(backupFile, temp);
            // compressDir кладёт мир внутрь папки с его именем
            let source = temp;
            if (!fs.existsSync(path.join(source, "level.dat"))) {
                const inner = fs.readdirSync(temp).map(name => path.join(temp, name)).find(item => fs.existsSync(path.join(item, "level.dat")));
                if (!inner) throw new Error("level.dat not found in backup");
                source = inner;
            }
            if (fs.existsSync(worldPath)) fs.renameSync(worldPath, old);
            fs.renameSync(source, worldPath);
            installed = true;
            RxCollector.writeLog(`WorldBackups: Restored ${path.basename(worldPath)} from ${path.basename(backupFile)}`);
            return true;
        } catch (error) {
            // Не получилось — возвращаем мир на место
            if (!fs.existsSync(worldPath) && fs.existsSync(old)) {
                try { fs.renameSync(old, worldPath); }
                catch (rollbackError) {
                    const recoveryError = new Error(`Restore failed; original world preserved at ${old}: ${rollbackError.message}`, {cause: error});
                    recoveryError.recoveryPath = old;
                    throw recoveryError;
                }
            }
            throw error;
        } finally {
            await fsPromises.rm(temp, {recursive: true, force: true}).catch(() => {});
            if (installed) await fsPromises.rm(old, {recursive: true, force: true}).catch(() => {});
        }
    };

    // После закрытия игры: копируем миры, в которые заходили за эту сессию
    static afterGame = async (gameDirectory, startedAt) => {
        if (!RxWorldBackups.isEnabled() || !gameDirectory) return 0;
        const savesDir = path.join(gameDirectory, "saves");
        let names = [];
        try {
            names = fs.readdirSync(savesDir);
        } catch (_) {
            return 0;
        }
        let saved = 0;
        for (const name of names) {
            const worldPath = path.join(savesDir, name);
            try {
                const levelDat = path.join(worldPath, "level.dat");
                if (!fs.existsSync(levelDat) || fs.statSync(levelDat).mtimeMs < startedAt - 5000) continue;
                if (await RxWorldBackups.folderSize(worldPath, RxWorldBackups.MAX_BYTES) > RxWorldBackups.MAX_BYTES) {
                    RxCollector.writeLog(`WorldBackups: Skipped large world ${name}`);
                    continue;
                }
                await RxWorldBackups.backup(worldPath, "auto");
                saved++;
            } catch (error) {
                RxCollector.writeLog(`WorldBackups: Auto backup failed [world=${name}] [error=${error}]`);
            }
        }
        if (saved) RxToasts.create(MESSAGES.worlds.autoSaved, "backup", MESSAGES.worlds.autoSavedText.replace("{0}", saved), "success");
        return saved;
    };
}
