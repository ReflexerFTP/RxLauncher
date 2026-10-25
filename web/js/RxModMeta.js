// Метаданные модов из JAR (Fabric, Quilt, Forge, NeoForge) и примерная оценка совместимости.
// JAR читается выборочно через yauzl: в память попадают только нужные файлы, а не весь архив.
const yauzl = require("yauzl");

class RxModMeta {
    static cache = new Map();          // fullPath -> {stamp, meta}
    static MAX_ENTRY_BYTES = 2 * 1024 * 1024;
    static MAX_NESTED_BYTES = 6 * 1024 * 1024;
    static MAX_ICON_BYTES = 256 * 1024;
    static METADATA_FILES = new Set([
        "fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml",
        "META-INF/MANIFEST.MF", "META-INF/jarjar/metadata.json", "mcmod.info"
    ]);
    // Зависимости, которые обеспечивает сама игра или загрузчик
    static BUILTIN_DEPS = new Set([
        "minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "quilt_base", "forge", "neoforge",
        "javafml", "lowcodefml", "mcp", "mixinextras"
    ]);

    // ---------- чтение ZIP ----------
    static readEntries = (source, wanted, maxBytes = RxModMeta.MAX_ENTRY_BYTES) => new Promise((resolve) => {
        const result = {};
        const open = Buffer.isBuffer(source)
            ? (cb) => yauzl.fromBuffer(source, {lazyEntries: true}, cb)
            : (cb) => yauzl.open(source, {lazyEntries: true, autoClose: true}, cb);
        open((error, zip) => {
            if (error || !zip) return resolve(result);
            const finish = () => { try { zip.close(); } catch (_) {} resolve(result); };
            zip.on("entry", (entry) => {
                if (!wanted(entry.fileName) || entry.uncompressedSize > maxBytes) return zip.readEntry();
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) return zip.readEntry();
                    const chunks = [];
                    stream.on("data", (chunk) => chunks.push(chunk));
                    stream.on("end", () => { result[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
                    stream.on("error", () => zip.readEntry());
                });
            });
            zip.on("end", finish);
            zip.on("error", finish);
            zip.readEntry();
        });
    });

    static parseJson = (buffer) => {
        if (!buffer) return null;
        const text = buffer.toString("utf8").replace(/^﻿/, "");
        try {
            return JSON.parse(text);
        } catch (_) {
            // Некоторые моды кладут переносы строк внутрь строк и комментарии
            try {
                return JSON.parse(text.replace(/\/\/[^\n"]*$/gm, "").replace(/[\u0000-\u001f]+/g, " ").replace(/,\s*([}\]])/g, "$1"));
            } catch (__) {
                return null;
            }
        }
    };

    static parseToml = (buffer) => {
        if (!buffer) return null;
        const text = buffer.toString("utf8").replace(/^﻿/, "");
        try {
            return toml.parse(text);
        } catch (_) {
            return RxModMeta.parseTomlLoose(text);
        }
    };

    // Запасной разбор mods.toml, если строгий парсер не справился с новым синтаксисом
    static parseTomlLoose = (text) => {
        const value = (key) => (text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, "m")) || [])[1];
        const dependencies = {};
        const depBlocks = text.split(/\[\[\s*dependencies\.([\w-]+)\s*]]/).slice(1);
        for (let i = 0; i < depBlocks.length; i += 2) {
            const owner = depBlocks[i];
            const block = depBlocks[i + 1] || "";
            const field = (key) => (block.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]*)["']?`, "m")) || [])[1];
            (dependencies[owner] = dependencies[owner] || []).push({
                modId: field("modId"), versionRange: field("versionRange"),
                mandatory: field("mandatory") === "true", type: field("type")
            });
        }
        return {
            mods: [{modId: value("modId"), displayName: value("displayName"), version: value("version"),
                description: value("description"), authors: value("authors"), logoFile: value("logoFile")}],
            logoFile: value("logoFile"),
            dependencies
        };
    };

    static manifestValue = (buffer, key) => {
        if (!buffer) return "";
        const match = buffer.toString("utf8").match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
        return match ? match[1].trim() : "";
    };

    static authorsToList = (value) => {
        if (!value) return [];
        if (typeof value === "string") return value.split(/,\s*/).filter(Boolean);
        if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean);
        if (typeof value === "object") return Object.keys(value);
        return [];
    };

    // ---------- разбор форматов ----------
    static fromFabric = (json) => {
        const deps = [];
        Object.entries(json.depends || {}).forEach(([id, range]) => deps.push({id, range, required: true}));
        Object.entries(json.recommends || {}).forEach(([id, range]) => deps.push({id, range, required: false}));
        const breaks = Object.entries({...(json.breaks || {}), ...(json.conflicts || {})}).map(([id, range]) => ({id, range}));
        let icon = json.icon;
        if (icon && typeof icon === "object") {
            const sizes = Object.keys(icon).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            icon = icon[String(sizes.filter((size) => size <= 128).pop() || sizes[0])];
        }
        return {
            loaders: ["fabric"], id: String(json.id || ""), name: json.name || json.id, version: json.version,
            description: json.description || "", authors: RxModMeta.authorsToList(json.authors),
            icon: typeof icon === "string" ? icon.replace(/^\/+/, "") : "",
            provides: Array.isArray(json.provides) ? json.provides.map(String) : [],
            mcRange: json.depends?.minecraft ?? null, rangeKind: "semver",
            deps, breaks, nested: Array.isArray(json.jars) ? json.jars.map((jar) => jar?.file).filter(Boolean) : []
        };
    };

    static fromQuilt = (json) => {
        const loader = json.quilt_loader || {};
        const normalizeDep = (dep) => typeof dep === "string" ? {id: dep, range: "*"} : {id: dep?.id, range: dep?.versions ?? "*", optional: dep?.optional === true};
        const deps = (loader.depends || []).map(normalizeDep).filter((dep) => dep.id).map((dep) => ({...dep, required: !dep.optional}));
        const mc = deps.find((dep) => dep.id === "minecraft");
        return {
            loaders: ["quilt"], id: String(loader.id || ""), name: loader.metadata?.name || loader.id, version: loader.version,
            description: loader.metadata?.description || "", authors: RxModMeta.authorsToList(loader.metadata?.contributors),
            icon: typeof loader.metadata?.icon === "string" ? loader.metadata.icon.replace(/^\/+/, "") : "",
            provides: (loader.provides || []).map((item) => typeof item === "string" ? item : item?.id).filter(Boolean),
            mcRange: mc ? mc.range : null, rangeKind: "semver",
            deps, breaks: (loader.breaks || []).map(normalizeDep).filter((dep) => dep.id), nested: []
        };
    };

    static fromModsToml = (data, isNeoFile, manifest) => {
        const mod = (data.mods || [])[0] || {};
        const id = String(mod.modId || "");
        const rawDeps = data.dependencies?.[id] || Object.values(data.dependencies || {})[0] || [];
        const deps = [];
        const breaks = [];
        let mcRange = null;
        let neo = isNeoFile;
        (Array.isArray(rawDeps) ? rawDeps : []).forEach((dep) => {
            const depId = String(dep.modId || "");
            if (!depId) return;
            if (depId === "neoforge") neo = true;
            const required = dep.mandatory === true || String(dep.type || "").toLowerCase() === "required";
            if (String(dep.type || "").toLowerCase() === "incompatible") breaks.push({id: depId, range: dep.versionRange});
            else deps.push({id: depId, range: dep.versionRange, required});
            if (depId === "minecraft") mcRange = dep.versionRange || null;
        });
        let version = String(mod.version || "");
        if (version.includes("${")) version = RxModMeta.manifestValue(manifest, "Implementation-Version") || version;
        return {
            loaders: [neo ? "neoforge" : "forge"], id, name: mod.displayName || id, version,
            description: String(mod.description || "").trim(), authors: RxModMeta.authorsToList(mod.authors),
            icon: String(mod.logoFile || data.logoFile || "").replace(/^\/+/, ""), provides: [],
            mcRange, rangeKind: "maven", deps, breaks, nested: []
        };
    };

    // ---------- чтение одного мода ----------
    static read = async (fullPath) => {
        let stat;
        try { stat = fs.statSync(fullPath); } catch (_) { return null; }
        const stamp = `${stat.size}:${stat.mtimeMs}`;
        const cached = RxModMeta.cache.get(fullPath);
        if (cached && cached.stamp === stamp) return cached.meta;

        const files = await RxModMeta.readEntries(fullPath, (name) => RxModMeta.METADATA_FILES.has(name));
        const parts = [];
        const fabric = RxModMeta.parseJson(files["fabric.mod.json"]);
        if (fabric?.id) parts.push(RxModMeta.fromFabric(fabric));
        const quilt = RxModMeta.parseJson(files["quilt.mod.json"]);
        if (quilt?.quilt_loader?.id) parts.push(RxModMeta.fromQuilt(quilt));
        const neoToml = RxModMeta.parseToml(files["META-INF/neoforge.mods.toml"]);
        if (neoToml?.mods?.length) parts.push(RxModMeta.fromModsToml(neoToml, true, files["META-INF/MANIFEST.MF"]));
        const forgeToml = RxModMeta.parseToml(files["META-INF/mods.toml"]);
        if (forgeToml?.mods?.length) parts.push(RxModMeta.fromModsToml(forgeToml, false, files["META-INF/MANIFEST.MF"]));

        let meta;
        if (parts.length === 0) {
            meta = {loaders: [], id: "", name: "", version: RxModMeta.manifestValue(files["META-INF/MANIFEST.MF"], "Implementation-Version"),
                description: "", authors: [], icon: "", provides: [], mcRange: null, rangeKind: "semver", deps: [], breaks: [], nested: []};
        } else {
            // Мультизагрузочный JAR: берём основные поля из первого описания, загрузчики объединяем
            meta = {...parts[0], loaders: [...new Set(parts.flatMap((part) => part.loaders))]};
        }

        // Вложенные моды (jar-in-jar) тоже «предоставляют» свои id
        const nestedIds = [];
        const jarjar = RxModMeta.parseJson(files["META-INF/jarjar/metadata.json"]);
        (jarjar?.jars || []).forEach((jar) => { if (jar?.identifier?.artifact) nestedIds.push(String(jar.identifier.artifact).toLowerCase()); });
        const second = await RxModMeta.readEntries(fullPath, (name) => name === meta.icon || meta.nested.includes(name), RxModMeta.MAX_NESTED_BYTES);
        for (const nestedName of meta.nested) {
            if (!second[nestedName]) continue;
            const inner = await RxModMeta.readEntries(second[nestedName], (name) => name === "fabric.mod.json" || name === "quilt.mod.json");
            const innerFabric = RxModMeta.parseJson(inner["fabric.mod.json"]);
            if (innerFabric?.id) nestedIds.push(String(innerFabric.id), ...(innerFabric.provides || []).map(String));
            const innerQuilt = RxModMeta.parseJson(inner["quilt.mod.json"]);
            if (innerQuilt?.quilt_loader?.id) nestedIds.push(String(innerQuilt.quilt_loader.id));
        }
        meta.nestedIds = nestedIds;
        const iconBuffer = meta.icon ? second[meta.icon] : null;
        meta.iconData = iconBuffer && iconBuffer.length <= RxModMeta.MAX_ICON_BYTES ? `data:image/png;base64,${iconBuffer.toString("base64")}` : "";
        delete meta.nested;

        RxModMeta.cache.set(fullPath, {stamp, meta});
        return meta;
    };

    // ---------- версии ----------
    static parseVersion = (value) => {
        const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
    };

    static compare = (a, b) => {
        for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    };

    // Один токен семвер-диапазона Fabric/Quilt: true / false / null (не разобрать)
    static matchSemverToken = (token, version) => {
        const raw = String(token || "").trim();
        if (!raw || raw === "*") return true;
        const match = raw.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
        const op = match[1] || "";
        const body = match[2].replace(/-.*$/, "");
        if (/(^|\.)[xX*]($|\.)/.test(body)) {
            const prefix = body.split(".").filter((part) => !/^[xX*]$/.test(part)).map(Number);
            return prefix.every((part, index) => part === version[index]);
        }
        const target = RxModMeta.parseVersion(body);
        if (!target) return null;
        const c = RxModMeta.compare(version, target);
        switch (op) {
            case ">=": return c >= 0;
            case "<=": return c <= 0;
            case ">": return c > 0;
            case "<": return c < 0;
            case "~": return c >= 0 && version[0] === target[0] && version[1] === target[1];
            case "^": return c >= 0 && version[0] === target[0];
            default: return c === 0;
        }
    };

    static matchSemver = (spec, version) => {
        if (spec === null || spec === undefined) return null;
        const alternatives = Array.isArray(spec) ? spec.map(String) : String(spec).split("||");
        let unknown = false;
        for (const alternative of alternatives) {
            const results = alternative.trim().split(/\s+/).map((token) => RxModMeta.matchSemverToken(token, version));
            if (results.every((result) => result === true)) return true;
            if (!results.includes(false)) unknown = true;
        }
        return unknown ? null : false;
    };

    // Maven-диапазоны Forge: [1.21,1.22)  [1.20.1]  [1.21,)
    static matchMaven = (spec, version) => {
        const text = String(spec || "").trim();
        if (!text || text === "*") return true;
        const ranges = [...text.matchAll(/([[(])\s*([^,\])]*)\s*(?:,\s*([^\])]*))?\s*([\])])/g)];
        if (ranges.length === 0) {
            const exact = RxModMeta.parseVersion(text);
            return exact && RxModMeta.compare(version, exact) === 0 ? true : null;
        }
        for (const [, open, lowRaw, highRaw, close] of ranges) {
            const isExact = highRaw === undefined;
            const low = RxModMeta.parseVersion(lowRaw);
            const high = isExact ? low : RxModMeta.parseVersion(highRaw);
            if (isExact) {
                if (low && RxModMeta.compare(version, low) === 0) return true;
                continue;
            }
            const lowOk = !low || (open === "[" ? RxModMeta.compare(version, low) >= 0 : RxModMeta.compare(version, low) > 0);
            const highOk = !high || (close === "]" ? RxModMeta.compare(version, high) <= 0 : RxModMeta.compare(version, high) < 0);
            if (lowOk && highOk) return true;
        }
        return false;
    };

    static matchRange = (kind, spec, version) => kind === "maven" ? RxModMeta.matchMaven(spec, version) : RxModMeta.matchSemver(spec, version);

    static rangeToText = (spec) => Array.isArray(spec) ? spec.join(" | ") : String(spec ?? "");

    // ---------- цель запуска ----------
    static getTarget = () => {
        const versionId = typeof RxVersionsManager !== "undefined" ? RxVersionsManager.getActiveVersion() : "none";
        if (!versionId || versionId === "none") return null;
        const parsed = RxVersionsManager.parseVersionID(versionId);
        let loader = parsed.type;
        let mcText = String(parsed.name || "");
        if (loader === "pack" && typeof RxPacks !== "undefined") {
            try {
                const base = RxPacks.getModpackManifest(parsed.name)?.baseVersion;
                loader = base?.type || loader;
                mcText = String(base?.number || mcText);
            } catch (_) {}
        }
        if (loader === "forgeOptiFine") loader = "forge";
        return {loader, mcText, mc: RxModMeta.parseVersion(mcText)};
    };

    static loaderLabel = (loader) => ({fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", vanilla: "Vanilla"})[loader] || loader;

    // ---------- индекс установленных модов ----------
    static buildIndex = (entries) => {
        // entries: [{fileName, enabled, meta}]
        const index = new Map();
        // Отдельно — только самостоятельно установленные моды: встроенные (jar-in-jar)
        // копии библиотек загрузчик разрешает сам, это не дубликат
        index.topLevel = new Map();
        index.versions = new Map();
        entries.filter((entry) => entry.enabled && entry.meta).forEach((entry) => {
            if (entry.meta.id && entry.meta.version) index.versions.set(entry.meta.id.toLowerCase(), String(entry.meta.version));
            const ids = new Set([entry.meta.id, ...(entry.meta.provides || []), ...(entry.meta.nestedIds || [])].filter(Boolean).map((id) => id.toLowerCase()));
            ids.forEach((id) => {
                if (!index.has(id)) index.set(id, []);
                index.get(id).push(entry.fileName);
            });
            if (entry.meta.id) {
                const key = entry.meta.id.toLowerCase();
                if (!index.topLevel.has(key)) index.topLevel.set(key, []);
                index.topLevel.get(key).push(entry.fileName);
            }
        });
        return index;
    };

    static isProvided = (id, index) => {
        const key = String(id).toLowerCase();
        if (index.has(key)) return true;
        // Модули Fabric API (fabric-*-api-v1 и т.п.) лежат внутри fabric-api
        if ((key === "fabric" || key.startsWith("fabric-")) && index.has("fabric-api")) return true;
        if ((key === "quilted_fabric_api" || key.startsWith("quilted_")) && index.has("qsl")) return true;
        return false;
    };

    // ---------- оценка совместимости ----------
    // Возвращает {verdict: "ok"|"warn"|"error"|"unknown", checks: [{level, text}]}
    static evaluate = (entry, index, target) => {
        const t = RxModMeta.text;
        const meta = entry.meta;
        const checks = [];
        if (!meta || meta.loaders.length === 0) {
            return {verdict: "unknown", checks: [{level: "warn", text: t("noMetadata")}]};
        }
        if (target) {
            // Загрузчик
            const accepts = {fabric: ["fabric"], quilt: ["quilt", "fabric"], forge: ["forge"], neoforge: ["neoforge"]}[target.loader] || [];
            const loaders = meta.loaders.map(RxModMeta.loaderLabel).join(" / ");
            if (target.loader === "vanilla") {
                checks.push({level: "error", text: t("vanilla")});
            } else if (meta.loaders.some((loader) => accepts.includes(loader))) {
                checks.push({level: "ok", text: t("loaderOk", RxModMeta.loaderLabel(target.loader))});
            } else if (target.loader === "neoforge" && meta.loaders.includes("forge") && target.mcText.startsWith("1.20.1")) {
                checks.push({level: "warn", text: t("loaderMaybe", loaders, RxModMeta.loaderLabel(target.loader))});
            } else if (accepts.length) {
                checks.push({level: "error", text: t("loaderBad", loaders, RxModMeta.loaderLabel(target.loader))});
            }
            // Версия Minecraft
            if (meta.mcRange !== null && meta.mcRange !== undefined && target.mc) {
                const match = RxModMeta.matchRange(meta.rangeKind, meta.mcRange, target.mc);
                const range = RxModMeta.rangeToText(meta.mcRange);
                if (match === true) checks.push({level: "ok", text: t("mcOk", range)});
                else if (match === false) checks.push({level: "error", text: t("mcBad", range, target.mcText)});
                else checks.push({level: "warn", text: t("mcUnknown", range)});
            } else {
                checks.push({level: "warn", text: t("mcNotDeclared")});
            }
        }
        // Зависимости
        meta.deps.filter((dep) => dep.required && !RxModMeta.BUILTIN_DEPS.has(String(dep.id).toLowerCase())).forEach((dep) => {
            if (RxModMeta.isProvided(dep.id, index)) checks.push({level: "ok", text: t("depOk", dep.id)});
            else checks.push({level: "error", text: t("depMissing", dep.id), dependency: dep.id});
        });
        // Объявленные конфликты — обычно только с определёнными версиями другого мода
        meta.breaks.forEach((rule) => {
            if (!RxModMeta.isProvided(rule.id, index)) return;
            const installed = RxModMeta.parseVersion(index.versions?.get(String(rule.id).toLowerCase()));
            const hit = installed ? RxModMeta.matchRange(meta.rangeKind, rule.range ?? "*", installed) : null;
            if (hit === true) checks.push({level: "error", text: t("breaks", rule.id)});
            else if (hit === null) checks.push({level: "warn", text: t("breaksMaybe", rule.id, RxModMeta.rangeToText(rule.range))});
        });
        // Дубликаты
        if (entry.enabled && meta.id) {
            const owners = (index.topLevel?.get(meta.id.toLowerCase()) || []).filter((file) => file !== entry.fileName);
            if (owners.length) checks.push({level: "error", text: t("duplicate", owners.join(", "))});
        }
        const verdict = checks.some((check) => check.level === "error") ? "error"
            : checks.some((check) => check.level === "warn") ? "warn" : "ok";
        return {verdict, checks};
    };

    // ---------- тексты ----------
    static TEXTS = {
        ru: {
            noMetadata: "В файле нет описания мода — совместимость не определить",
            vanilla: "Выбрана Vanilla: для модов нужен загрузчик (Fabric, Forge, NeoForge или Quilt)",
            loaderOk: "Подходит для загрузчика {0}",
            loaderMaybe: "Мод для {0}; на {1} может работать, но не гарантируется",
            loaderBad: "Мод для {0}, а выбрана версия на {1}",
            mcOk: "Версия Minecraft подходит ({0})",
            mcBad: "Нужен Minecraft {0}, а выбран {1}",
            mcUnknown: "Требование к версии Minecraft: {0}",
            mcNotDeclared: "Мод не указывает версию Minecraft",
            depOk: "Зависимость установлена: {0}",
            depMissing: "Не хватает зависимости: {0}",
            breaks: "Объявленный конфликт с модом {0}",
            breaksMaybe: "Возможен конфликт с {0} (версии {1})",
            duplicate: "Этот мод установлен несколько раз: {0}"
        },
        en: {
            noMetadata: "The file has no mod description — compatibility cannot be determined",
            vanilla: "Vanilla is selected: mods need a loader (Fabric, Forge, NeoForge or Quilt)",
            loaderOk: "Works with the {0} loader",
            loaderMaybe: "Made for {0}; may run on {1}, but it is not guaranteed",
            loaderBad: "Made for {0}, but the selected version uses {1}",
            mcOk: "Minecraft version fits ({0})",
            mcBad: "Requires Minecraft {0}, but {1} is selected",
            mcUnknown: "Minecraft requirement: {0}",
            mcNotDeclared: "The mod does not declare a Minecraft version",
            depOk: "Dependency installed: {0}",
            depMissing: "Missing dependency: {0}",
            breaks: "Declared conflict with {0}",
            breaksMaybe: "Possible conflict with {0} (versions {1})",
            duplicate: "This mod is installed more than once: {0}"
        }
    };

    static text = (key, ...args) => {
        const language = typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru";
        const template = (RxModMeta.TEXTS[language] || RxModMeta.TEXTS.en)[key] || RxModMeta.TEXTS.en[key] || key;
        return template.replace(/\{(\d)}/g, (_, index) => String(args[Number(index)] ?? ""));
    };
}
