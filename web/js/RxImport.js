// Импорт из других лаунчеров (Legacy Launcher, TLauncher, официальный, любая папка .minecraft).
// Сборки Prism Launcher, MultiMC, PolyMC и CurseForge переносятся отдельной сборкой RxLauncher с тем же загрузчиком.
// Игрок галочками выбирает, что перенести; перед переносом можно сделать резервную копию —
// она хранит только то, что импорт заменил или добавил, и откатывается тоже по галочкам.
// Копии лежат в <папка игры>/backups/import/<дата>/manifest.json (+ files/ с прежними версиями файлов)
class RxImport {
    // Части, которые можно перенести. dirs — папки внутри игры, files — отдельные файлы
    static PARTS = [
        {id: "options", icon: "tune", files: ["options.txt", "optionsof.txt", "optionsshaders.txt", "optionsviveprofiles.txt"]},
        {id: "saves", icon: "public", dirs: ["saves"], worlds: true},
        {id: "mods", icon: "extension", dirs: ["mods"]},
        {id: "config", icon: "settings_applications", dirs: ["config", "defaultconfigs"]},
        {id: "resourcepacks", icon: "palette", dirs: ["resourcepacks", "texturepacks"]},
        {id: "shaderpacks", icon: "wb_sunny", dirs: ["shaderpacks"]},
        {id: "screenshots", icon: "photo_library", dirs: ["screenshots"]},
        {id: "servers", icon: "dns"},
        {id: "accounts", icon: "person"},
        // Уже скачанные библиотеки и ассеты: не придётся качать заново. Файлы не заменяются, поэтому и откатывать нечего
        {id: "cache", icon: "download_done", dirs: ["assets", "libraries"], shared: true, keepExisting: true}
    ];
    static DEFAULT_OFF = ["cache", "screenshots"];
    static GAME_MARKERS = ["options.txt", "saves", "mods", "resourcepacks", "shaderpacks", "screenshots", "config", "servers.dat", "versions"];
    static NICKNAME = /^[A-Za-z0-9_]{3,16}$/;

    static text = (key, fallback = "", ...args) => {
        let value = MESSAGES?.settings?.import?.[key];
        if (typeof value !== "string") value = fallback;
        args.forEach((arg, index) => { value = value.replaceAll(`{${index}}`, arg); });
        return value;
    };

    static partTitle = (id) => RxImport.text(`part_${id}`, id);

    static appData = () => process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

    static backupRoot = () => path.join(GAME_DATA, "backups", "import");

    // Куда переносить: папка игры активной версии/сборки (та же, что получит игра при запуске)
    static targetDirectory = () => RxMinecraftServers.resolveCurrentGameDirectory();

    static samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

    static isInside = (base, target) => {
        const relative = path.relative(path.resolve(base), path.resolve(target));
        return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    // Путь внутри папки по относительному пути из манифеста; null — если он выходит наружу
    static assertUnlinkedPath = target => {
        const root = path.resolve(GAME_DATA);
        const rel = path.relative(root, path.resolve(target));
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Import path leaves game data');
        let current = root;
        for (const part of rel.split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked import path'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return path.resolve(target);
    };
    static trustedTarget = target => {
        if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Invalid import target');
        const rel = path.relative(path.resolve(GAME_DATA), path.resolve(target));
        const parts = rel.split(path.sep);
        if (rel && !(parts.length === 2 && ['home', 'modpacks'].includes(parts[0])
            && /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/.test(parts[1]) && !parts[1].endsWith('.'))) throw new Error('Unknown import target');
        return RxImport.assertUnlinkedPath(target);
    };
    static allowedPartPath = (id, rel) => {
        const part = RxImport.PARTS.find(item => item.id === id);
        if (!part || part.shared || typeof rel !== 'string') return false;
        const portable = rel.replaceAll('\\', '/');
        if (part.files) return part.files.includes(portable);
        return (part.dirs || []).some(dir => portable.startsWith(dir + '/'));
    };
    static resolveInside = (base, relative) => {
        if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
            || /[:\x00-\x1f]/.test(relative)
            || relative.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..'
                || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
        const target = path.resolve(base, relative);
        if (!RxImport.isInside(base, target)) return null;
        try { return RxImport.assertUnlinkedPath(target); } catch (_) { return null; }
    };

    static isDirectory = (dir) => {
        try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
    };

    static isFile = (file) => {
        try { return fs.lstatSync(file).isFile(); } catch (_) { return false; }
    };

    // Java .properties: key=value, экранирование \: \\ \= и \uXXXX
    static readProperties = (file) => {
        const result = {};
        let content = "";
        try { content = fs.readFileSync(file, "utf8"); } catch (_) { return result; }
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim() || /^\s*[#!]/.test(line)) continue;
            const match = line.match(/^\s*((?:\\.|[^=:\s\\])+)\s*[=:]\s*(.*)$/);
            if (!match) continue;
            const unescape = value => value
                .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
                .replace(/\\(.)/g, "$1");
            result[unescape(match[1])] = unescape(match[2]);
        }
        return result;
    };

    static looksLikeGameDir = (dir) => RxImport.isDirectory(dir) && RxImport.GAME_MARKERS.some(name => fs.existsSync(path.join(dir, name)));

    static listDirs = (dir) => {
        try { return fs.readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name); }
        catch (_) { return []; }
    };

    // Найти установленные лаунчеры. Папку самого RxLauncher не предлагаем
    static detectSources = () => {
        const appData = RxImport.appData();
        const found = [];
        const add = (name, dir, kind) => {
            if (typeof dir !== "string" || !dir.trim()) return;
            const resolved = path.resolve(dir.trim());
            if (RxImport.samePath(resolved, GAME_DATA) || RxImport.isInside(GAME_DATA, resolved) || RxImport.isInside(resolved, GAME_DATA)) return;
            if (found.some(source => RxImport.samePath(source.path, resolved)) || !RxImport.looksLikeGameDir(resolved)) return;
            found.push({name, path: resolved, kind});
        };
        const addWithHomes = (name, dir, kind) => {
            add(name, dir, kind);
            // Раздельные папки игры для версий: <папка>/home/<имя>
            RxImport.listDirs(path.join(dir, "home")).forEach(child => add(`${name} — ${child}`, path.join(dir, "home", child), kind));
        };

        const legacyHome = path.join(appData, ".tlauncher", "legacy", "Minecraft");
        const legacyProps = RxImport.readProperties(path.join(legacyHome, "tl.properties"));
        addWithHomes("Legacy Launcher", legacyProps["minecraft.gamedir"] || path.join(legacyHome, "game"), "legacy");

        const minecraft = path.join(appData, ".minecraft");
        let isTLauncher = false;
        try {
            isTLauncher = fs.readdirSync(minecraft).some(name => /^(tlauncher.*\.(properties|json)|TlauncherProfiles\.json)$/i.test(name));
        } catch (_) {}
        const tlProps = RxImport.readProperties(path.join(minecraft, "tlauncher-2.0.properties"));
        if (tlProps["minecraft.gamedir"]) addWithHomes("TLauncher", tlProps["minecraft.gamedir"], "tlauncher");
        addWithHomes(isTLauncher ? "TLauncher" : "Minecraft (.minecraft)", minecraft, isTLauncher ? "tlauncher" : "minecraft");
        // Сборки других лаунчеров
        RxImport.detectInstances().forEach(source => {
            if (!found.some(item => RxImport.samePath(item.path, source.path))) found.push(source);
        });
        return found;
    };

    // ---------- сборки Prism Launcher / MultiMC / PolyMC / CurseForge ----------
    static LOADER_UIDS = [["net.fabricmc.fabric-loader", "fabric"], ["org.quiltmc.quilt-loader", "quilt"], ["net.neoforged", "neoforge"], ["net.minecraftforge", "forge"]];

    // Папка сборки Prism/MultiMC: instance.cfg + mmc-pack.json, игра — в .minecraft или minecraft
    static readMultiMcInstance = (dir, label, kind) => {
        let pack = null;
        try { pack = JSON.parse(fs.readFileSync(path.join(dir, "mmc-pack.json"), "utf8")); } catch (_) { return null; }
        const components = Array.isArray(pack?.components) ? pack.components : [];
        const versionOf = uid => String(components.find(item => item?.uid === uid)?.version || "");
        const game = versionOf("net.minecraft");
        const loader = RxImport.LOADER_UIDS.find(([uid]) => versionOf(uid));
        const gameDir = [".minecraft", "minecraft"].map(name => path.join(dir, name)).find(RxImport.isDirectory);
        if (!/^\d+\.\d+(\.\d+)?$/.test(game) || !gameDir) return null;
        const name = String(RxImport.readProperties(path.join(dir, "instance.cfg")).name || path.basename(dir)).slice(0, 64);
        return {name: `${label} · ${name}`, path: path.resolve(gameDir), kind,
            instance: {name, game, loader: loader ? loader[1] : "vanilla", loaderVersion: loader ? versionOf(loader[0]) : ""}};
    };

    // Папка сборки CurseForge: minecraftinstance.json, игра — в самой папке
    static readCurseForgeInstance = (dir) => {
        let info = null;
        try { info = JSON.parse(fs.readFileSync(path.join(dir, "minecraftinstance.json"), "utf8")); } catch (_) { return null; }
        const game = String(info?.gameVersion || info?.baseModLoader?.minecraftVersion || "");
        const loader = String(info?.baseModLoader?.name || "").match(/^(fabric|quilt|neoforge|forge)-([0-9][^-]*)/i);
        if (!/^\d+\.\d+(\.\d+)?$/.test(game)) return null;
        const name = String(info?.name || path.basename(dir)).slice(0, 64);
        return {name: `CurseForge · ${name}`, path: path.resolve(dir), kind: "curseforge",
            instance: {name, game, loader: loader ? loader[1].toLowerCase() : "vanilla", loaderVersion: loader ? loader[2] : ""}};
    };

    // Все сборки внутри папки лаунчера (или сама папка — уже сборка)
    static instancesIn = (root, label, kind) => {
        const one = kind === "curseforge" ? RxImport.readCurseForgeInstance(root) : RxImport.readMultiMcInstance(root, label, kind);
        if (one) return [one];
        let instancesDir = root;
        const config = RxImport.readProperties(path.join(root, kind === "prism" ? "prismlauncher.cfg" : kind === "polymc" ? "polymc.cfg" : "multimc.cfg"));
        if (config.InstanceDir) instancesDir = path.isAbsolute(config.InstanceDir) ? config.InstanceDir : path.join(root, config.InstanceDir);
        else if (RxImport.isDirectory(path.join(root, "instances"))) instancesDir = path.join(root, "instances");
        else if (RxImport.isDirectory(path.join(root, "Instances"))) instancesDir = path.join(root, "Instances");
        return RxImport.listDirs(instancesDir).slice(0, 200)
            .map(name => kind === "curseforge" ? RxImport.readCurseForgeInstance(path.join(instancesDir, name)) : RxImport.readMultiMcInstance(path.join(instancesDir, name), label, kind))
            .filter(Boolean);
    };

    static detectInstances = () => {
        const appData = RxImport.appData();
        const home = os.homedir();
        const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        const roots = [
            [path.join(appData, "PrismLauncher"), "Prism Launcher", "prism"],
            [path.join(appData, "PolyMC"), "PolyMC", "polymc"],
            // MultiMC переносной: ищем в обычных местах
            ...[path.join(home, "MultiMC"), path.join(local, "Programs", "MultiMC"), path.join(home, "Desktop", "MultiMC"), path.join(home, "Downloads", "MultiMC"), "C:\\MultiMC", "D:\\MultiMC"]
                .map(dir => [dir, "MultiMC", "multimc"]),
            [path.join(home, "curseforge", "minecraft", "Instances"), "CurseForge", "curseforge"],
            [path.join(home, "Documents", "Curse", "Minecraft", "Instances"), "CurseForge", "curseforge"]
        ];
        const found = [];
        for (const [dir, label, kind] of roots) {
            if (!RxImport.isDirectory(dir)) continue;
            try { found.push(...RxImport.instancesIn(dir, label, kind)); } catch (_) {}
        }
        return found.filter(source => !RxImport.isInside(GAME_DATA, source.path) && !RxImport.samePath(source.path, GAME_DATA));
    };

    // Перенести сборку другого лаунчера как новую сборку RxLauncher: тот же Minecraft и загрузчик, выбранные папки
    static importInstance = async (source, partIds, {onProgress = () => {}} = {}) => {
        const info = source.instance;
        const id = RxInstancesUI.uniqueId(info.name);
        const root = path.join(GAME_DATA, "modpacks", id);
        const jobs = [];
        for (const part of RxImport.PARTS.filter(item => partIds.includes(item.id))) {
            if (part.files) {
                part.files.forEach(name => {
                    const from = path.join(source.path, name);
                    if (RxImport.isFile(from)) jobs.push({from, to: path.join(root, name), size: fs.statSync(from).size});
                });
            } else if (part.id === "servers") {
                const from = path.join(source.path, "servers.dat");
                if (RxImport.isFile(from)) jobs.push({from, to: path.join(root, "servers.dat"), size: fs.statSync(from).size});
            } else if (part.dirs && !part.shared) {
                for (const dir of part.dirs) {
                    for (const file of await RxImport.walk(path.join(source.path, dir))) jobs.push({from: file.full, to: path.join(root, dir, file.rel), size: file.size});
                }
            }
        }
        const total = jobs.reduce((sum, job) => sum + job.size, 0);
        let copied = 0, failed = 0;
        ["mods", "config", "resourcepacks", "shaderpacks", "saves"].forEach(dir => fs.mkdirSync(path.join(root, dir), {recursive: true}));
        for (const job of jobs) {
            try {
                await fsPromises.mkdir(path.dirname(job.to), {recursive: true});
                await fsPromises.copyFile(job.from, job.to);
            } catch (error) {
                failed++;
                RxCollector.writeLog(`Import: copy failed [file=${job.from}] [error=${error.message}]`);
            }
            copied += job.size;
            onProgress(copied, total, path.basename(job.from));
        }
        RxPacks.writeModpackManifest(id, {
            id,
            uuid: crypto.randomUUID(),
            displayName: info.name,
            baseVersion: {full: `${info.loader}-${info.game}`, type: info.loader, number: info.game, loaderVersion: info.loaderVersion || ""},
            files: [],
            icon: false,
            created: Date.now(),
            source: {provider: "import", from: source.kind}
        });
        RxCollector.writeLog(`Import: Instance ${source.name} → pack ${id} [files=${jobs.length}] [failed=${failed}]`);
        return {id, copied: jobs.length - failed, failed};
    };

    // Все файлы папки (без ссылок): [{full, rel, size}]
    static walk = async (dir, base = dir, out = []) => {
        let entries = [];
        try { if (fs.lstatSync(dir).isSymbolicLink()) return out; } catch (_) { return out; }
        try { entries = await fsPromises.readdir(dir, {withFileTypes: true}); } catch (_) { return out; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await RxImport.walk(full, base, out);
            else if (entry.isFile()) {
                const size = (await fsPromises.stat(full).catch(() => ({size: 0}))).size;
                out.push({full, rel: path.relative(base, full), size});
            }
        }
        return out;
    };

    static worlds = (sourceDir) => RxImport.listDirs(path.join(sourceDir, "saves"))
        .filter(name => RxImport.isFile(path.join(sourceDir, "saves", name, "level.dat")));

    // Серверы из servers.dat, которых ещё нет в списке лаунчера
    static readServers = (sourceDir) => {
        const file = path.join(sourceDir, "servers.dat");
        if (!RxImport.isFile(file)) return [];
        try {
            const list = RxMinecraftServers.getServersList(RxMinecraftServers.parseDocument(fs.readFileSync(file)));
            const result = [];
            for (let index = 0; index < list.count(); index++) {
                const tag = list.selectAt(index);
                const ip = String(tag.select("ip")?.getValue?.() || "").trim();
                if (!ip) continue;
                try {
                    const server = RxMinecraftServers.normalizeServer({ip, name: String(tag.select("name")?.getValue?.() || "")});
                    if (!RxMinecraftServers.isSaved(server.ip) && !result.some(item => item.ip === server.ip)) result.push(server);
                } catch (_) {}
            }
            return result;
        } catch (error) {
            RxCollector.writeLog(`Import: servers.dat unreadable [error=${error.message}]`);
            return [];
        }
    };

    // Ники из профилей TLauncher/Legacy (без паролей и токенов — переносятся как локальные аккаунты)
    static readNicknames = (sourceDir) => {
        const names = new Set();
        const visit = (node, depth) => {
            if (!node || typeof node !== "object" || depth > 6) return;
            for (const [key, value] of Object.entries(node)) {
                if (typeof value === "string" && /^(username|displayName|nickname|playerName)$/i.test(key) && RxImport.NICKNAME.test(value)) names.add(value);
                else if (value && typeof value === "object") visit(value, depth + 1);
            }
        };
        const files = [];
        try { files.push(...fs.readdirSync(sourceDir).filter(name => /profiles.*\.json$/i.test(name))); } catch (_) {}
        for (const name of files) {
            try { visit(JSON.parse(fs.readFileSync(path.join(sourceDir, name), "utf8")), 0); } catch (_) {}
        }
        const existing = Object.values(RxAccountsManager.getAccounts() || {}).map(account => String(account?.nickname || "").toLowerCase());
        return [...names].filter(name => !existing.includes(name.toLowerCase()));
    };

    // Что есть в источнике: {id: {count, bytes, items}}
    static scan = async (sourceDir) => {
        const result = {};
        for (const part of RxImport.PARTS) {
            let count = 0, bytes = 0, items = [];
            if (part.files) {
                for (const name of part.files) {
                    const file = path.join(sourceDir, name);
                    if (RxImport.isFile(file)) { count++; bytes += fs.statSync(file).size; }
                }
            } else if (part.worlds) {
                items = RxImport.worlds(sourceDir);
                count = items.length;
                for (const world of items) bytes += (await RxImport.walk(path.join(sourceDir, "saves", world))).reduce((sum, file) => sum + file.size, 0);
            } else if (part.id === "servers") {
                items = RxImport.readServers(sourceDir);
                count = items.length;
            } else if (part.id === "accounts") {
                items = RxImport.readNicknames(sourceDir);
                count = items.length;
            } else {
                for (const dir of part.dirs) {
                    for (const file of await RxImport.walk(path.join(sourceDir, dir))) {
                        if (part.keepExisting && fs.existsSync(path.join(GAME_DATA, dir, file.rel))) continue;
                        count++;
                        bytes += file.size;
                    }
                }
            }
            result[part.id] = {count, bytes, items};
        }
        return result;
    };

    static describe = (id, info) => {
        if (!info?.count) return RxImport.text("nothing", "Нечего переносить");
        const parts = [RxImport.text(`count_${id}`, "{0}", info.count)];
        if (info.bytes > 0) parts.push(RxUtils.humanFileSize(info.bytes));
        if (id === "accounts") parts.push(info.items.slice(0, 4).join(", ") + (info.items.length > 4 ? "…" : ""));
        return parts.join(" · ");
    };

    static freeWorldName = (savesDir, name) => {
        if (!fs.existsSync(path.join(savesDir, name))) return name;
        for (let index = 1; ; index++) {
            const candidate = `${name} (${RxImport.text("importedSuffix", "импорт")}${index > 1 ? ` ${index}` : ""})`;
            if (!fs.existsSync(path.join(savesDir, candidate))) return candidate;
        }
    };

    // Одинаковые файлы не копируем. Сравниваем всегда по содержимому: маленькие целиком,
    // большие — по блокам, без чтения всего файла в память (одинаковый размер ещё не значит одинаковый файл)
    static sameFile = async (a, b) => {
        let first = null, second = null;
        try {
            const [statA, statB] = await Promise.all([fsPromises.stat(a), fsPromises.stat(b)]);
            if (statA.size !== statB.size) return false;
            if (statA.size <= 4 * 1024 * 1024) {
                const [x, y] = await Promise.all([fsPromises.readFile(a), fsPromises.readFile(b)]);
                return x.equals(y);
            }
            [first, second] = await Promise.all([fsPromises.open(a, "r"), fsPromises.open(b, "r")]);
            const chunk = 1024 * 1024;
            const left = Buffer.alloc(chunk), right = Buffer.alloc(chunk);
            for (let position = 0; position < statA.size; position += chunk) {
                const [readA, readB] = await Promise.all([first.read(left, 0, chunk, position), second.read(right, 0, chunk, position)]);
                if (readA.bytesRead !== readB.bytesRead || !left.subarray(0, readA.bytesRead).equals(right.subarray(0, readB.bytesRead))) return false;
                if (!readA.bytesRead) break;
            }
            return true;
        } catch (_) {
            return false;
        } finally {
            await Promise.all([first?.close(), second?.close()].filter(Boolean)).catch(() => {});
        }
    };

    static stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    static writeManifest = (dir, manifest) => {
        fs.mkdirSync(dir, {recursive: true});
        const file = path.join(dir, "manifest.json");
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 2));
        fs.renameSync(`${file}.tmp`, file);
    };

    // Перенести выбранные части. options: {backup, onProgress(copiedBytes, totalBytes, label)}
    // Результат: {copied, skipped, failed, backupId}
    static run = async (source, partIds, {backup = true, onProgress = () => {}} = {}) => {
        const sourceDir = path.resolve(source.path);
        const target = path.resolve(RxImport.targetDirectory());
        RxImport.trustedTarget(target);
        if (RxImport.samePath(sourceDir, target) || RxImport.isInside(sourceDir, target) || RxImport.isInside(target, sourceDir)) {
            throw new Error("Source and target folders overlap");
        }
        const selected = RxImport.PARTS.filter(part => partIds.includes(part.id));
        const id = RxImport.stamp();
        const backupDir = backup ? path.join(RxImport.backupRoot(), id) : null;
        const manifest = {version: 1, id, createdAt: Date.now(), sourceName: source.name, sourcePath: sourceDir, target, parts: {}, restored: {}};
        const record = (partId, list, value) => {
            const part = manifest.parts[partId] = manifest.parts[partId] || {};
            (part[list] = part[list] || []).push(value);
        };
        const stats = {copied: 0, skipped: 0, failed: 0, backupId: backup ? id : null};

        // Список копирований: [{part, from, to, rel, size, keepExisting}]
        const jobs = [];
        for (const part of selected) {
            if (part.files) {
                part.files.forEach(name => {
                    const from = path.join(sourceDir, name);
                    if (RxImport.isFile(from)) jobs.push({part, from, to: path.join(target, name), rel: name, size: fs.statSync(from).size});
                });
            } else if (part.worlds) {
                const savesDir = path.join(target, "saves");
                const reserved = new Set();
                for (const world of RxImport.worlds(sourceDir)) {
                    let name = RxImport.freeWorldName(savesDir, world);
                    while (reserved.has(name.toLowerCase())) name = `${name}_`;
                    reserved.add(name.toLowerCase());
                    record(part.id, "added", path.join("saves", name));
                    for (const file of await RxImport.walk(path.join(sourceDir, "saves", world))) {
                        jobs.push({part, from: file.full, to: path.join(savesDir, name, file.rel), rel: null, size: file.size, fresh: true});
                    }
                }
            } else if (part.dirs) {
                const base = part.shared ? GAME_DATA : target;
                for (const dir of part.dirs) {
                    for (const file of await RxImport.walk(path.join(sourceDir, dir))) {
                        jobs.push({part, from: file.full, to: path.join(base, dir, file.rel), rel: path.join(dir, file.rel), size: file.size, keepExisting: !!part.keepExisting});
                    }
                }
            }
        }

        const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0);
        let copiedBytes = 0, lastPaint = 0;
        const paint = (label, force = false) => {
            const now = Date.now();
            if (!force && now - lastPaint < 120) return;
            lastPaint = now;
            onProgress(copiedBytes, totalBytes, label);
        };

        try {
            for (const job of jobs) {
                try {
                    RxImport.assertUnlinkedPath(job.to);
                    const exists = fs.existsSync(job.to);
                    if (exists && (job.keepExisting || await RxImport.sameFile(job.from, job.to))) {
                        stats.skipped++;
                    } else {
                        if (backupDir && job.rel && !job.part.keepExisting) {
                            if (exists) {
                                const saved = path.join(backupDir, "files", job.rel);
                                await fsPromises.mkdir(path.dirname(saved), {recursive: true});
                                await fsPromises.copyFile(job.to, saved);
                                record(job.part.id, "overwritten", job.rel);
                            } else {
                                record(job.part.id, "added", job.rel);
                            }
                        }
                        await fsPromises.mkdir(path.dirname(job.to), {recursive: true});
                        await fsPromises.copyFile(job.from, job.to);
                        stats.copied++;
                    }
                } catch (error) {
                    stats.failed++;
                    RxCollector.writeLog(`Import: copy failed [file=${job.from}] [error=${error.message}]`);
                }
                copiedBytes += job.size;
                paint(RxImport.partTitle(job.part.id));
            }

            if (partIds.includes("servers")) {
                for (const server of RxImport.readServers(sourceDir)) {
                    if (RxMinecraftServers.add(server)) record("servers", "added", server.ip);
                }
                if (manifest.parts.servers) {
                    try { RxMinecraftServers.syncForCurrentVersion(); } catch (_) {}
                }
            }

            if (partIds.includes("accounts")) {
                const nicknames = RxImport.readNicknames(sourceDir);
                if (nicknames.length) {
                    const accounts = RxAccountsManager.getAccounts();
                    for (const nickname of nicknames) {
                        const uuid = crypto.randomUUID();
                        accounts[uuid] = {type: "local", nickname, added: Date.now(), uuid};
                        record("accounts", "added", uuid);
                    }
                    RxAccountsManager.saveAccounts(accounts);
                }
            }
        } finally {
            paint("", true);
            if (backupDir && Object.keys(manifest.parts).length) RxImport.writeManifest(backupDir, manifest);
            else stats.backupId = null;
            RxCollector.writeLog(`Import: Done [source=${source.name}] [parts=${partIds.join(",")}] [copied=${stats.copied}] [skipped=${stats.skipped}] [failed=${stats.failed}] [backup=${stats.backupId}]`);
        }
        return stats;
    };

    static readManifest = (id) => {
        if (!/^[\w-]+$/.test(String(id))) return null;
        try {
            const file = RxImport.assertUnlinkedPath(path.join(RxImport.backupRoot(), id, 'manifest.json'));
            if (fs.statSync(file).size > 2 * 1024 * 1024) return null;
            const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
            return manifest?.version === 1 && manifest.parts && typeof manifest.target === "string" ? manifest : null;
        } catch (_) {
            return null;
        }
    };

    static listBackups = () => RxImport.listDirs(RxImport.backupRoot())
        .map(RxImport.readManifest)
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt);

    // Части копии в том же порядке, что и в окне импорта
    static backupParts = (manifest) => RxImport.PARTS.map(part => part.id).filter(id => manifest?.parts?.[id]);

    // Части копии, которые ещё можно откатить
    static restorableParts = (manifest) => RxImport.backupParts(manifest).filter(id => !manifest.restored?.[id]);

    // Вернуть всё как было до импорта (по выбранным частям): удалить добавленное, вернуть заменённые файлы
    static restore = async (id, partIds) => {
        const manifest = RxImport.readManifest(id);
        if (!manifest) throw new Error("Backup not found");
        manifest.target = RxImport.trustedTarget(manifest.target);
        const dir = RxImport.assertUnlinkedPath(path.join(RxImport.backupRoot(), id));
        // Validate the whole operation before any destructive filesystem action.
        for (const partId of partIds) {
            if (['servers', 'accounts'].includes(partId)) continue;
            const part = manifest.parts[partId];
            if (!part) continue;
            for (const key of ['added', 'overwritten']) {
                if (part[key] !== undefined && !Array.isArray(part[key])) throw new Error('Invalid import backup entries');
                for (const rel of part[key] || []) {
                    if (!RxImport.allowedPartPath(partId, rel) || !RxImport.resolveInside(manifest.target, rel)
                        || (key === 'overwritten' && !RxImport.resolveInside(path.join(dir, 'files'), rel))) throw new Error('Unsafe import backup path');
                }
            }
        }
        const stats = {removed: 0, restored: 0, failed: 0};
        for (const partId of partIds) {
            const part = manifest.parts[partId];
            if (!part || manifest.restored?.[partId]) continue;
            try {
                if (partId === "servers") {
                    const keys = (part.added || []).map(RxMinecraftServers.addressKey);
                    const saved = RxMinecraftServers.getSavedServers();
                    const kept = saved.filter(server => !keys.includes(RxMinecraftServers.addressKey(server.ip)));
                    stats.removed += saved.length - kept.length;
                    RxConfig.write(RxMinecraftServers.CONFIG_KEY, kept);
                } else if (partId === "accounts") {
                    (part.added || []).forEach(uuid => { if (RxAccountsManager.deleteAccount(uuid)) stats.removed++; });
                } else {
                    for (const rel of part.added || []) {
                        const target = RxImport.resolveInside(manifest.target, rel);
                        if (!target) throw new Error("Unsafe import restore target");
                        if (!fs.existsSync(target)) continue;
                        await fsPromises.rm(target, {recursive: true, force: true});
                        stats.removed++;
                    }
                    for (const rel of part.overwritten || []) {
                        const target = RxImport.resolveInside(manifest.target, rel);
                        const saved = RxImport.resolveInside(path.join(dir, "files"), rel);
                        if (!target || !saved || !RxImport.isFile(saved)) { stats.failed++; continue; }
                        await fsPromises.mkdir(path.dirname(target), {recursive: true});
                        // Атомарно: копируем во временный файл и переименовываем поверх.
                        // Иначе обрыв копирования оставил бы текущий файл игрока наполовину переписанным.
                        const temp = `${target}.rx-restore-${crypto.randomUUID()}`;
                        try {
                            await fsPromises.copyFile(saved, temp);
                            await fsPromises.rename(temp, target);
                        } catch (copyError) {
                            await fsPromises.rm(temp, {force: true}).catch(() => {});
                            throw copyError;
                        }
                        stats.restored++;
                    }
                }
                manifest.restored = {...(manifest.restored || {}), [partId]: Date.now()};
            } catch (error) {
                stats.failed++;
                RxCollector.writeLog(`Import: restore failed [backup=${id}] [part=${partId}] [error=${error.message}]`);
            }
        }
        RxImport.writeManifest(dir, manifest);
        if (partIds.includes("servers")) {
            try { RxMinecraftServers.syncForCurrentVersion(); } catch (_) {}
        }
        RxCollector.writeLog(`Import: Restored [backup=${id}] [parts=${partIds.join(",")}] [removed=${stats.removed}] [restored=${stats.restored}] [failed=${stats.failed}]`);
        return stats;
    };

    static deleteBackup = async (id) => {
        if (!RxImport.readManifest(id)) return false;
        await fsPromises.rm(path.join(RxImport.backupRoot(), id), {recursive: true, force: true});
        return true;
    };
}
