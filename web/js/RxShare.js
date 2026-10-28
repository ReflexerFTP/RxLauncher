// «Играть вместе»: код сборки для друга, приглашение на сервер и экспорт в .mrpack.
// В код попадают только версии Modrinth (ID файлов), поэтому он короткий и проверяемый: друг скачает те же файлы по хешам
class RxShare {
    static PREFIX = "RX1-";
    static API = "https://api.modrinth.com/v2";
    static DIRS = {m: "mods", r: "resourcepacks", s: "shaderpacks"};
    static LOADERS = ["vanilla", "fabric", "quilt", "forge", "forgeOptiFine", "neoforge"];
    static MAX_FILES = 600;
    static HISTORY_KEY = "togetherHistory";

    // Что делимся: версия или сборка → название, версия игры, загрузчик и папка с модами
    static describe = (versionId) => {
        const parsed = RxVersionsManager.parseVersionID(versionId);
        if (parsed.type === "pack") {
            const manifest = RxPacks.getModpackManifest(parsed.name);
            if (!manifest) throw new Error("noSource");
            return {versionId, name: manifest.displayName, game: manifest.baseVersion.number, loader: manifest.baseVersion.type, loaderVersion: manifest.baseVersion.loaderVersion || "",
                root: path.join(GAME_DATA, "modpacks", parsed.name)};
        }
        // Свою версию у друга не воспроизвести — у него нет этих файлов
        if (!RxShare.LOADERS.includes(parsed.type)) throw new Error("customVersion");
        return {versionId, name: RxVersionsManager.versionToDisplayName(versionId), game: parsed.name, loader: parsed.type, root: RxUtils.getGameRoot(versionId)};
    };

    // Файлы источника, опознанные на Modrinth по SHA-1, и неопознанные
    static collect = async (source) => {
        const files = {};
        for (const [key, dir] of Object.entries(RxShare.DIRS)) {
            let names = [];
            try {
                names = fs.readdirSync(path.join(source.root, dir)).filter(name => key === "m" ? /\.jar$/i.test(name) : /\.(zip|jar)$/i.test(name));
            } catch (_) {}
            for (const name of names) {
                const file = path.join(source.root, dir, name);
                const sha1 = await RxHttp.hashFile(file, "sha1");
                if (sha1) files[sha1] = {key, dir, file, name};
            }
        }
        const known = Object.keys(files).length
            ? await RxHttp.json(`${RxShare.API}/version_files`, {method: "POST", body: {hashes: Object.keys(files), algorithm: "sha1"}, timeout: 30000})
            : {};
        const result = {m: [], r: [], s: [], unknown: [], matched: []};
        Object.entries(files).forEach(([sha1, info]) => {
            const version = known?.[sha1];
            if (version?.id) {
                result[info.key].push(version.id);
                result.matched.push({...info, sha1, version});
            } else {
                result.unknown.push(info);
            }
        });
        return result;
    };

    static encode = (data) => RxShare.PREFIX + require("zlib").deflateRawSync(Buffer.from(JSON.stringify(data))).toString("base64url");

    // Код можно вставить вместе с текстом приглашения — ищем его внутри
    static decode = (text) => {
        if (String(text || "").length > 65536) throw new Error("badCode");
        const match = String(text || "").match(/RX1-([A-Za-z0-9_-]{8,})/);
        if (!match) throw new Error("badCode");
        let data;
        try {
            data = JSON.parse(require("zlib").inflateRawSync(Buffer.from(match[1], "base64url"), {maxOutputLength: 128 * 1024}).toString("utf8"));
        } catch (_) {
            throw new Error("badCode");
        }
        const ids = value => Array.isArray(value) && value.length <= RxShare.MAX_FILES && value.every(id => /^[A-Za-z0-9]{8}$/.test(id));
        if (data?.v !== 1 || typeof data.n !== "string" || !/^[\w.\-]{1,32}$/.test(String(data.g)) || !RxShare.LOADERS.includes(data.l)
            || [data.m, data.r, data.s].reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0) > RxShare.MAX_FILES
            || !ids(data.m || []) || !ids(data.r || []) || !ids(data.s || [])) {
            throw new Error("badCode");
        }
        const clean = {
            v: 1,
            n: data.n.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 64) || "RxLauncher",
            g: String(data.g),
            l: data.l,
            m: data.m || [],
            r: data.r || [],
            s: data.s || [],
            by: typeof data.by === "string" ? data.by.replace(/[^\w.\-]/g, "").slice(0, 32) : ""
        };
        if (data.lv !== undefined) {
            if (typeof data.lv !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/.test(data.lv)) throw new Error("badCode");
            clean.lv = data.lv;
        }
        if (data.sv) {
            try {
                clean.sv = RxMinecraftServers.normalizeAddress(String(data.sv));
            } catch (_) {
                throw new Error("badServer");
            }
        }
        return clean;
    };

    static nickname = () => {
        try {
            return RxAccountsManager.getAccount(RxAccountsManager.getActiveAccount())?.nickname || "";
        } catch (_) {
            return "";
        }
    };

    // remember: false — код для друзей (сборку копируют из списка друзей), в историю «Недавние коды» не попадает
    static createCode = async (versionId, server = "", {remember = true} = {}) => {
        const source = RxShare.describe(versionId);
        const collected = await RxShare.collect(source);
        const data = {v: 1, n: source.name.slice(0, 64), g: source.game, l: source.loader, m: collected.m, r: collected.r, s: collected.s, by: RxShare.nickname()};
        const loaderVersion = source.loaderVersion || await RxShare.loaderVersion(source.loader, source.game);
        if (source.loader !== "vanilla" && !loaderVersion) throw new Error("Cannot determine loader version");
        if (loaderVersion) data.lv = loaderVersion;
        if (server) data.sv = RxMinecraftServers.normalizeAddress(server);
        const code = RxShare.encode(data);
        if (remember) RxShare.remember({direction: "sent", code, name: data.n, server: data.sv || ""});
        return {code, data, unknown: collected.unknown};
    };

    // Метаданные файлов по ID версий Modrinth → записи манифеста сборки
    static resolveFiles = async (data) => {
        const wanted = [];
        Object.entries(RxShare.DIRS).forEach(([key, dir]) => (data[key] || []).forEach(id => wanted.push({id, dir})));
        const versions = new Map();
        for (let index = 0; index < wanted.length; index += 100) {
            const chunk = wanted.slice(index, index + 100).map(item => item.id);
            const result = await RxHttp.json(`${RxShare.API}/versions?ids=${encodeURIComponent(JSON.stringify(chunk))}`, {timeout: 30000});
            (result || []).forEach(version => versions.set(version.id, version));
        }
        const files = [];
        const missing = [];
        wanted.forEach(({id, dir}) => {
            const version = versions.get(id);
            const file = (version?.files || []).find(item => item.primary) || version?.files?.[0];
            const name = path.basename(String(file?.filename || ""));
            if (!file || !name || name !== file.filename || !/^https:\/\//.test(file.url || "")) {
                missing.push(id);
                return;
            }
            files.push({
                path: path.join(dir, name),
                name,
                url: file.url,
                hashes: file.hashes || {},
                size: file.size,
                displayName: version.name || path.parse(name).name
            });
        });
        return {files, missing};
    };

    // Создать сборку по коду, скачать файлы и выбрать её. Возвращает ID сборки
    static install = async (data) => {
        const {files, missing} = await RxShare.resolveFiles(data);
        if (missing.length) throw new Error(`Unavailable Modrinth files: ${missing.join(", ")}`);
        const id = RxInstancesUI.uniqueId(data.n);
        const root = path.join(GAME_DATA, "modpacks", id);
        ["mods", "config", "resourcepacks", "shaderpacks", "saves"].forEach(dir => fs.mkdirSync(path.join(root, dir), {recursive: true}));
        RxPacks.writeModpackManifest(id, {
            id,
            uuid: crypto.randomUUID(),
            displayName: data.n,
            baseVersion: {full: `${data.l}-${data.g}`, type: data.l, number: data.g, loaderVersion: data.lv || ""},
            files,
            icon: false,
            created: Date.now(),
            source: {provider: "share", from: data.by || "", server: data.sv || ""}
        });
        if (data.sv) {
            try {
                RxMinecraftServers.add({name: data.by ? `${data.sv} (${data.by})` : data.sv, ip: data.sv});
            } catch (_) {}
        }
        RxVersionsManager.setActiveVersion(`pack-${id}`);
        await RxVersionsUI.loadVersions();
        try {
            if (await RxPacks.verifyAndInstall(id) === false) throw new Error("Modpack download incomplete; retry from the installed packs list");
        } finally {
            await RxFlyout.changeMode("idle");
        }
        RxShare.remember({direction: "received", code: RxShare.encode(data), name: data.n, server: data.sv || "", from: data.by || "", instance: id});
        RxCollector.writeLog(`Share: Installed ${id} from code [files=${files.length}] [missing=${missing.length}] [from=${data.by}]`);
        return {id, missing};
    };

    // ---------- история ----------
    static history = () => {
        const list = RxConfig.read(RxShare.HISTORY_KEY, []);
        return Array.isArray(list) ? list : [];
    };

    static remember = (entry) => {
        const list = RxShare.history().filter(item => item.code !== entry.code || item.direction !== entry.direction);
        list.unshift({...entry, time: Date.now()});
        RxConfig.write(RxShare.HISTORY_KEY, list.slice(0, 12));
    };

    // ---------- экспорт .mrpack ----------
    // Версия загрузчика для modrinth.index.json: из установленной версии, иначе — актуальная с сайта загрузчика
    static loaderVersion = async (loader, game) => {
        const versionsDir = path.join(GAME_DATA, "versions");
        const fromLibraries = (pattern) => {
            try {
                for (const name of fs.readdirSync(versionsDir)) {
                    const json = path.join(versionsDir, name, `${name}.json`);
                    if (!fs.existsSync(json) || !name.split(/[-_ ]/).includes(game)) continue;
                    const match = fs.readFileSync(json, "utf8").match(pattern);
                    if (match) return match[1];
                }
            } catch (_) {}
            return "";
        };
        try {
            if (loader === "fabric") {
                return fromLibraries(/net\.fabricmc:fabric-loader:([\w.+\-]+)/)
                    || (await RxHttp.json(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(game)}`))?.[0]?.loader?.version || "";
            }
            if (loader === "quilt") {
                return fromLibraries(/org\.quiltmc:quilt-loader:([\w.+\-]+)/)
                    || (await RxHttp.json(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(game)}`))?.[0]?.loader?.version || "";
            }
            if (loader === "forge" || loader === "forgeOptiFine") {
                const local = fromLibraries(/net\.minecraftforge:forge:[\d.]+-([\w.\-]+?)(?::|")/);
                if (local) return local;
                const promos = (await RxHttp.json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"))?.promos || {};
                return promos[`${game}-recommended`] || promos[`${game}-latest`] || "";
            }
            if (loader === "neoforge") {
                const local = fromLibraries(/net\.neoforged:neoforge:([\w.\-]+?)(?::|")/);
                if (local) return local;
                const prefix = game.replace(/^1\./, "");
                const latest = await RxHttp.json(`https://maven.neoforged.net/api/maven/latest/version/releases/net/neoforged/neoforge?filter=${encodeURIComponent(prefix + ".")}`);
                return latest?.version || "";
            }
        } catch (error) {
            RxCollector.writeLog(`Share: Loader version lookup failed [loader=${loader}] [error=${error}]`);
        }
        return "";
    };

    static LOADER_KEYS = {fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", forgeOptiFine: "forge", neoforge: "neoforge"};

    // Файлы с Modrinth — ссылками, остальные моды/паки и папка config — внутри архива (overrides)
    static exportMrpack = async (versionId, target) => {
        const source = RxShare.describe(versionId);
        const collected = await RxShare.collect(source);
        const files = collected.matched.map(item => {
            const file = (item.version.files || []).find(entry => entry.hashes?.sha1 === item.sha1) || (item.version.files || [])[0];
            return {
                path: `${item.dir}/${file.filename}`,
                hashes: {sha1: file.hashes.sha1, sha512: file.hashes.sha512},
                env: {client: "required", server: item.key === "m" ? "required" : "unsupported"},
                downloads: [file.url],
                fileSize: file.size
            };
        });
        const dependencies = {minecraft: source.game};
        const loaderKey = RxShare.LOADER_KEYS[source.loader];
        if (loaderKey) {
            const version = source.loaderVersion || await RxShare.loaderVersion(source.loader, source.game);
            if (!version) throw new Error("Cannot determine loader version");
            if (version) dependencies[loaderKey] = version;
        }
        const index = {formatVersion: 1, game: "minecraft", versionId: "1.0.0", name: source.name, summary: `RxLauncher ${LAUNCHER_VERSION}`, files, dependencies};

        // Всё, что пойдёт в архив, решаем заранее: поток закрывается, как только очередь записей опустеет
        const configDir = path.join(source.root, "config");
        const withConfig = fs.existsSync(configDir) && fs.readdirSync(configDir).length > 0
            && await RxWorldBackups.folderSize(configDir, 50 * 1024 * 1024) <= 50 * 1024 * 1024;
        const zip = new compressing.zip.Stream();
        zip.addEntry(Buffer.from(JSON.stringify(index, null, 2)), {relativePath: "modrinth.index.json"});
        collected.unknown.forEach(item => zip.addEntry(item.file, {relativePath: `overrides/${item.dir}/${item.name}`}));
        if (withConfig) zip.addEntry(configDir, {relativePath: "overrides/config", ignoreBase: true});
        const temp = `${target}.part`;
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(temp);
            zip.on("error", reject);
            output.on("error", reject);
            output.on("finish", resolve);
            zip.pipe(output);
        });
        fs.renameSync(temp, target);
        RxCollector.writeLog(`Share: Exported ${source.name} to ${target} [modrinth=${files.length}] [embedded=${collected.unknown.length}] [loader=${dependencies[loaderKey] || "-"}]`);
        return {files: files.length, embedded: collected.unknown.length, loaderVersion: dependencies[loaderKey] || ""};
    };
}
