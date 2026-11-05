// Начало rx-runtime.js: загрузчик CommonJS для кода интерфейса в Tauri.
// Модули адресуются путями от корня проекта (web/js/RxNbt.js, externalTargets.js, node_modules/toml/toml.js),
// встроенные модули Node (fs, path, electron…) — замены из tauri/runtime. require из скриптов интерфейса
// работает как createRequire(web/index.ejs) в Electron
(function () {
    "use strict";
    const definitions = Object.create(null);
    const cache = Object.create(null);
    const BUILTINS = Object.create(null);
    const PACKAGES = Object.create(null); // имя пакета → id главного файла

    const normalize = parts => {
        const out = [];
        for (const part of parts) {
            if (!part || part === ".") continue;
            if (part === "..") out.pop();
            else out.push(part);
        }
        return out.join("/");
    };
    const dirname = id => id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
    const candidates = base => [base, `${base}.js`, `${base}.json`, `${base}/index.js`];

    const resolve = (request, fromDir) => {
        const name = String(request).replace(/^node:/, "");
        if (BUILTINS[name]) return BUILTINS[name];
        if (name.startsWith("./") || name.startsWith("../") || name.startsWith("/")) {
            const base = normalize(`${fromDir}/${name}`.split("/"));
            for (const id of candidates(base)) if (definitions[id]) return id;
            throw Object.assign(new Error(`Cannot find module '${request}' from '${fromDir || "."}'`), {code: "MODULE_NOT_FOUND"});
        }
        const [scopeOrName, maybeName] = name.split("/");
        const packageName = scopeOrName.startsWith("@") ? `${scopeOrName}/${maybeName}` : scopeOrName;
        const rest = name.slice(packageName.length);
        if (!rest && PACKAGES[packageName]) return PACKAGES[packageName];
        for (const id of candidates(`node_modules/${packageName}${rest}`)) if (definitions[id]) return id;
        throw Object.assign(new Error(`Cannot find module '${request}'`), {code: "MODULE_NOT_FOUND"});
    };

    const load = id => {
        if (cache[id]) return cache[id].exports;
        const definition = definitions[id];
        const module = {id, exports: {}, loaded: false};
        cache[id] = module;
        if (definition.json !== undefined) {
            module.exports = definition.json;
        } else {
            const dir = dirname(id);
            const localRequire = request => load(resolve(request, dir));
            localRequire.resolve = request => resolve(request, dir);
            definition.call(module.exports, module, module.exports, localRequire, id, dir);
        }
        module.loaded = true;
        return module.exports;
    };

    window.__rxDef = (id, factory) => { definitions[id] = factory; };
    window.__rxJson = (id, value) => { definitions[id] = {json: value}; };
    window.__rxPackage = (name, mainId) => { PACKAGES[name] = mainId; };
    window.__rxBuiltin = (name, id) => { BUILTINS[name] = id; };
    // Модули, объявленные прямо в коде рантайма (node-misc.js)
    window.__rxDefine = (name, factory) => {
        const id = `tauri/runtime/${name}`;
        definitions[id] = factory;
        BUILTINS[name] = id;
    };
    const webRequire = request => load(resolve(request, "web"));
    webRequire.resolve = request => resolve(request, "web");
    webRequire.cache = cache;
    window.__rxRequire = webRequire;
})();
