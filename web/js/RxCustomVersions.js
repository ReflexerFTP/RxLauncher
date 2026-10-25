// Свои (кастомные) версии: папка в versions/ с <имя>.json (+ <имя>.jar).
// Например, установка OptiFine, Fabric из официального установщика или сборка клиента.
class RxCustomVersions {
    static CONFIG_KEY = "customVersions";
    static VANILLA_TYPES = ["release", "snapshot", "old_beta", "old_alpha"];

    static versionsRoot = () => path.join(GAME_DATA, "versions");

    static readJson = (filePath) => {
        try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (_) {
            return null;
        }
    };

    // Манифест похож на версию Minecraft: наследуется от другой или описывает запуск сам
    static isVersionManifest = (json) => Boolean(json && typeof json === "object"
        && (typeof json.inheritsFrom === "string" || (typeof json.mainClass === "string" && Array.isArray(json.libraries))));

    static sanitizeName = (name) => String(name || "")
        .replace(/[^\w.+\-]+/g, "_")
        .replace(/^[._\-]+|[._\-]+$/g, "")
        .slice(0, 64);

    static getImportedNames = () => {
        const value = RxConfig.read(RxCustomVersions.CONFIG_KEY, []);
        return Array.isArray(value) ? value.map(String) : [];
    };

    static setImportedNames = (names) => RxConfig.write(RxCustomVersions.CONFIG_KEY, [...new Set(names)]);

    // Папка в versions/ — своя версия, если её добавили через лаунчер
    // или её манифест наследуется от другой версии (OptiFine, fabric-loader-…)
    static isCustomFolder = (name) => {
        const manifest = RxCustomVersions.readJson(path.join(RxCustomVersions.versionsRoot(), name, `${name}.json`));
        if (!RxCustomVersions.isVersionManifest(manifest)) return false;
        if (RxCustomVersions.getImportedNames().includes(name)) return true;
        if (typeof manifest.inheritsFrom === "string") return true;
        // Чистая vanilla (в т.ч. снапшоты) — не своя
        return !(manifest.id === name && RxCustomVersions.VANILLA_TYPES.includes(manifest.type));
    };

    static getInfo = (name) => {
        const manifest = RxCustomVersions.readJson(path.join(RxCustomVersions.versionsRoot(), name, `${name}.json`));
        if (!RxCustomVersions.isVersionManifest(manifest)) return null;
        return {
            name,
            baseVersion: manifest.inheritsFrom || manifest.id || name,
            inherits: typeof manifest.inheritsFrom === "string",
            javaVersion: manifest.javaVersion?.majorVersion ? String(manifest.javaVersion.majorVersion) : "",
            releaseTime: Date.parse(manifest.releaseTime || manifest.time || "") || 0
        };
    };

    // Найти папку версии: сама папка, или вложенная (до 2 уровней — например, внутри архива)
    static findVersionFolder = (rootPath, depth = 0) => {
        let entries = [];
        try {
            entries = fs.readdirSync(rootPath, {withFileTypes: true});
        } catch (_) {
            return null;
        }
        const preferred = entries.find(entry => entry.isFile() && entry.name === `${path.basename(rootPath)}.json`);
        const candidates = preferred ? [preferred] : entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
        for (const entry of candidates) {
            const manifest = RxCustomVersions.readJson(path.join(rootPath, entry.name));
            if (RxCustomVersions.isVersionManifest(manifest)) {
                return {dir: rootPath, jsonFile: entry.name, manifest};
            }
        }
        if (depth >= 2) return null;
        for (const entry of entries.filter(item => item.isDirectory())) {
            const found = RxCustomVersions.findVersionFolder(path.join(rootPath, entry.name), depth + 1);
            if (found) return found;
        }
        return null;
    };

    // Импорт из папки, .json или .zip. Возвращает {ok, name} или {ok: false, error}
    static importFrom = async (sourcePath) => {
        let tempDir = "";
        try {
            if (!sourcePath || !fs.existsSync(sourcePath)) return {ok: false, error: "notFound"};
            const stat = fs.statSync(sourcePath);
            const ext = path.extname(sourcePath).toLowerCase();
            let found = null;
            let copyWholeFolder = false;

            if (stat.isDirectory()) {
                found = RxCustomVersions.findVersionFolder(sourcePath);
                copyWholeFolder = true;
            } else if (ext === ".json") {
                const manifest = RxCustomVersions.readJson(sourcePath);
                if (RxCustomVersions.isVersionManifest(manifest)) {
                    found = {dir: path.dirname(sourcePath), jsonFile: path.basename(sourcePath), manifest};
                }
            } else if (ext === ".zip") {
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rx-version-"));
                await RxUtils.unpackArchive(sourcePath, tempDir);
                found = RxCustomVersions.findVersionFolder(tempDir);
                copyWholeFolder = true;
            } else {
                return {ok: false, error: "unsupported"};
            }
            if (!found) return {ok: false, error: "noManifest"};

            const jsonBase = path.basename(found.jsonFile, ".json");
            const name = RxCustomVersions.sanitizeName(typeof found.manifest.id === "string" && found.manifest.id ? found.manifest.id : jsonBase);
            if (!name) return {ok: false, error: "noManifest"};
            const target = path.join(RxCustomVersions.versionsRoot(), name);
            if (fs.existsSync(target)) return {ok: false, error: "exists", name};

            fs.mkdirSync(target, {recursive: true});
            if (copyWholeFolder) {
                fs.cpSync(found.dir, target, {recursive: true});
            }
            // MCLC ищет <имя>.json и <имя>.jar в папке <имя>
            const sourceJar = path.join(found.dir, `${jsonBase}.jar`);
            const manifest = {...found.manifest, id: name};
            if (copyWholeFolder) {
                RxCustomVersions.renameIfExists(path.join(target, found.jsonFile), path.join(target, `${name}.json`));
                RxCustomVersions.renameIfExists(path.join(target, `${jsonBase}.jar`), path.join(target, `${name}.jar`));
            } else if (fs.existsSync(sourceJar)) {
                fs.copyFileSync(sourceJar, path.join(target, `${name}.jar`));
            }
            fs.writeFileSync(path.join(target, `${name}.json`), JSON.stringify(manifest, null, 2));

            // Манифест базовой версии рядом — чтобы своя версия запускалась и без интернета
            if (manifest.inheritsFrom) {
                const baseManifest = RxVersionsManager.findLocalGameManifest(manifest.inheritsFrom);
                const basePath = path.join(target, `${manifest.inheritsFrom}.json`);
                if (baseManifest && !fs.existsSync(basePath)) fs.writeFileSync(basePath, JSON.stringify(baseManifest));
            }

            RxCustomVersions.setImportedNames([...RxCustomVersions.getImportedNames(), name]);
            RxCollector.writeLog(`CustomVersions: Imported [name=${name}] [source=${sourcePath}]`);
            return {ok: true, name};
        } catch (error) {
            RxCollector.writeLog(`CustomVersions: Import failed [source=${sourcePath}] [error=${error}]`);
            return {ok: false, error: "failed"};
        } finally {
            if (tempDir) fs.rmSync(tempDir, {recursive: true, force: true});
        }
    };

    static renameIfExists = (from, to) => {
        if (from !== to && fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    };

    // Удалить в корзину (можно восстановить)
    static remove = async (name) => {
        const target = path.join(RxCustomVersions.versionsRoot(), name);
        if (!name || path.dirname(target) !== RxCustomVersions.versionsRoot() || !fs.existsSync(target)) return false;
        // Корзина Windows доступна только из главного процесса
        try {
            if (!await ipcRenderer.invoke("trash-version-folder", {root: GAME_DATA, name})) return false;
        } catch (error) {
            RxCollector.writeLog(`CustomVersions: Could not move to trash [name=${name}] [error=${error}]`);
            return false;
        }
        RxCustomVersions.setImportedNames(RxCustomVersions.getImportedNames().filter(item => item !== name));
        RxCollector.writeLog(`CustomVersions: Moved to trash [name=${name}]`);
        return true;
    };
}
