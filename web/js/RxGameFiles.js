// Файлы игры перед запуском: библиотеки и ассеты качаются заранее, параллельно, с проверкой SHA-1, повторами
// и запасным зеркалом. MCLC потом находит готовые файлы и пропускает их (сам он качает их по одному).
// Источник: «auto» — серверы Mojang, при сбое зеркало BMCLAPI; «official» — только Mojang; «mirror» — сначала зеркало.
class RxGameFiles {
    static CONCURRENCY = 16;
    static MIRROR = "https://bmclapi2.bangbang93.com";
    static SOURCES = ["auto", "official", "mirror"];
    // Хост Mojang → путь на зеркале
    static MIRROR_PATHS = {
        "resources.download.minecraft.net": "/assets",
        "libraries.minecraft.net": "/maven",
        "piston-meta.mojang.com": "",
        "piston-data.mojang.com": "",
        "launchermeta.mojang.com": "",
        "launcher.mojang.com": ""
    };

    static source = () => {
        const value = RxConfig.read("downloadSource", "auto");
        return RxGameFiles.SOURCES.includes(value) ? value : "auto";
    };

    // Ссылка на зеркало для официального файла Mojang (null, если у зеркала такого файла нет)
    static mirrorUrl = (url) => {
        try {
            const parsed = new URL(url);
            const prefix = RxGameFiles.MIRROR_PATHS[parsed.hostname];
            if (prefix === undefined || parsed.protocol !== "https:") return null;
            return `${RxGameFiles.MIRROR}${prefix}${parsed.pathname}`;
        } catch (_) {
            return null;
        }
    };

    // Основная и запасная ссылка с учётом выбранного источника
    static routes = (url, source = RxGameFiles.source()) => {
        const mirror = RxGameFiles.mirrorUrl(url);
        if (!mirror || source === "official") return {url, fallbackUrl: null};
        return source === "mirror" ? {url: mirror, fallbackUrl: url} : {url, fallbackUrl: mirror};
    };

    static osName = () => ({win32: "windows", darwin: "osx"})[process.platform] || "linux";

    // Правила библиотеки из манифеста: последнее подходящее правило решает, нужна ли она на этой ОС
    static libraryAllowed = (library, osName = RxGameFiles.osName(), arch = process.arch) => {
        if (!Array.isArray(library?.rules) || !library.rules.length) return true;
        let allowed = false;
        for (const rule of library.rules) {
            if (rule?.features) continue;
            const os = rule?.os;
            const matches = !os || ((!os.name || os.name === osName) && (!os.arch || os.arch === (arch === "ia32" ? "x86" : arch)));
            if (matches) allowed = rule.action === "allow";
        }
        return allowed;
    };

    // "group:artifact:version[:classifier][@ext]" → путь в Maven-репозитории
    static mavenPath = (name) => {
        const [coords, extension = "jar"] = String(name || "").split("@");
        const [group, artifact, version, classifier] = coords.split(":");
        if (!group || !artifact || !version) return null;
        const file = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.${extension}`;
        const parts = [...group.split("."), artifact, version, file];
        if (parts.some(part => !part || part === "." || part === ".." || /[\\/:*?"<>|]/.test(part))) return null;
        return parts.join("/");
    };

    // Путь внутри папки; null, если он выходит за её пределы
    static inside = (base, relative) => {
        const target = path.resolve(base, relative);
        const rel = path.relative(base, target);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? target : null;
    };

    // Файл уже есть и размер совпадает (хеш потом всё равно проверит MCLC)
    static present = (filePath, size) => {
        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() && stat.size > 0 && (!(size > 0) || stat.size === size);
        } catch (_) {
            return false;
        }
    };

    static libraryItems = (libraries, libraryRoot, source) => {
        const items = [];
        for (const library of Array.isArray(libraries) ? libraries : []) {
            if (!RxGameFiles.libraryAllowed(library)) continue;
            const artifact = library?.downloads?.artifact;
            let relative, url, sha1, size;
            if (artifact?.url && artifact?.path) {
                ({url, sha1, size} = artifact);
                relative = artifact.path;
            } else if (typeof library?.url === "string" && library.name) {
                relative = RxGameFiles.mavenPath(library.name);
                if (!relative) continue;
                url = `${library.url.replace(/\/?$/, "/")}${relative}`;
                ({sha1, size} = library);
            } else {
                continue;
            }
            const target = RxGameFiles.inside(libraryRoot, relative);
            if (!target || !/^https:\/\//i.test(url)) continue;
            items.push({...RxGameFiles.routes(url, source), path: target, size: Number(size) || 0,
                hashes: typeof sha1 === "string" ? {sha1} : {}, displayName: path.basename(target)});
        }
        return items;
    };

    // Всё, чего не хватает для запуска: библиотеки версии и загрузчика, индекс и объекты ассетов
    static collect = async (config, source = RxGameFiles.source()) => {
        const number = config?.version?.number;
        if (typeof number !== "string" || !number) return [];
        const manifest = await RxVersionsManager.getVersionManifest(number);
        if (!manifest || !manifest.assetIndex?.url) return [];

        const root = path.resolve(config.root || GAME_DATA);
        const libraryRoot = path.resolve(config.overrides?.libraryRoot || path.join(root, "libraries"));
        const items = RxGameFiles.libraryItems(manifest.libraries, libraryRoot, source);
        const custom = config.version.custom;
        if (typeof custom === "string" && custom) {
            try {
                const customJson = JSON.parse(fs.readFileSync(path.join(root, "versions", custom, `${custom}.json`), "utf8"));
                items.push(...RxGameFiles.libraryItems(customJson.libraries, libraryRoot, source));
            } catch (_) {}
        }

        // Индекс ассетов MCLC хранит под именем версии загрузчика, если она есть
        const assetRoot = path.resolve(config.overrides?.assetRoot || path.join(root, "assets"));
        const indexPath = path.join(assetRoot, "indexes", `${custom || number}.json`);
        const indexHashes = manifest.assetIndex.sha1 ? {sha1: manifest.assetIndex.sha1} : {};
        if (!(await RxHttp.isFileValid(indexPath, indexHashes))) {
            const route = RxGameFiles.routes(manifest.assetIndex.url, source);
            try {
                await RxHttp.download(route.url, indexPath, {hashes: indexHashes});
            } catch (error) {
                if (!route.fallbackUrl) throw error;
                await RxHttp.download(route.fallbackUrl, indexPath, {hashes: indexHashes});
            }
        }
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        const seen = new Set();
        for (const object of Object.values(index?.objects || {})) {
            const hash = String(object?.hash || "").toLowerCase();
            if (!/^[0-9a-f]{40}$/.test(hash) || seen.has(hash)) continue;
            seen.add(hash);
            items.push({...RxGameFiles.routes(`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`, source),
                path: path.join(assetRoot, "objects", hash.slice(0, 2), hash), size: Number(object.size) || 0, hashes: {sha1: hash}, displayName: hash});
        }

        const unique = new Map();
        items.forEach(item => unique.set(item.path.toLowerCase(), item));
        return [...unique.values()].filter(item => !RxGameFiles.present(item.path, item.size));
    };

    // false — подготовить не вышло или запуск отменили (тогда MCLC докачает сам либо запуск остановится)
    static prepare = async (config) => {
        const started = Date.now();
        let items = [];
        try {
            items = await RxGameFiles.collect(config);
            if (!items.length) return true;
            RxCollector.writeLog(`GameFiles: Downloading ${items.length} files [source=${RxGameFiles.source()}]`);
            await RxDownloader.downloadMany(items, MESSAGES.starter.gameFiles || "Minecraft", RxGameFiles.CONCURRENCY);
            RxCollector.writeLog(`GameFiles: Done in ${Math.round((Date.now() - started) / 1000)} s`);
            return true;
        } catch (error) {
            RxCollector.writeLog(`GameFiles: Prefetch failed, MCLC will continue [files=${items.length}] [error=${error.message}]`);
            return false;
        }
    };
}
