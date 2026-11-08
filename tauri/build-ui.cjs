// Сборка интерфейса для Tauri: node tauri/build-ui.cjs [папка-вывода]
// 1) рендерит web/index.ejs (как ejs-electron) → index.html;
// 2) скрипты x-rx-script → обычные <script defer> в том же порядке, встроенные — в отдельные файлы (CSP без unsafe-inline);
// 3) обработчики data-rx-on* → функции в rx-handlers.js (без eval);
// 4) rx-runtime.js: загрузчик CommonJS + замены модулей Node/Electron + нужные корневые модули и пакеты;
// 5) копия web/ без шаблонов.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "dist-tauri"));
const WEB = path.join(ROOT, "web");
const RUNTIME = path.join(__dirname, "runtime");
const NODE_MODULES = [process.env.RX_NODE_MODULES, path.join(ROOT, "node_modules"), path.join(ROOT, "..", "RxLaunch", "node_modules")]
    .find(dir => dir && fs.existsSync(path.join(dir, "ejs")));
const NODE_MODULES_ABS = NODE_MODULES && path.resolve(NODE_MODULES);
if (!NODE_MODULES) throw new Error("node_modules with ejs not found (npm ci or set RX_NODE_MODULES)");
const ejs = require(path.join(NODE_MODULES_ABS, "ejs"));
const rel = file => path.relative(ROOT, file).split(path.sep).join("/");

// ---------- 1. шаблон ----------
const template = path.join(WEB, "index.ejs");
let html = ejs.render(fs.readFileSync(template, "utf8"), {}, {filename: template});

// ---------- 2–3. скрипты и обработчики ----------
const CSP = [
    "default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "form-action 'none'",
    "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "worker-src 'self' blob:",
    "img-src 'self' data: blob: https: http://asset.localhost asset:",
    "media-src 'self' data: blob: http://asset.localhost asset:",
    "connect-src 'self' ipc: http://ipc.localhost http://rxsync.localhost http://asset.localhost asset: https:"
].join("; ");
const cspTag = /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/?>/i;
if (!cspTag.test(html)) throw new Error("CSP meta tag not found in index.ejs");
html = html.replace(cspTag, `<meta http-equiv="Content-Security-Policy" content="${CSP}"/>`);

const inline = [];
html = html.replace(/<script\s+type="application\/x-rx-script"\s*(src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g, (match, _srcAttr, src, body) => {
    if (src) {
        if (body.trim()) throw new Error(`Script with src must be empty: ${src}`);
        return `<script defer src="${src}"></script>`;
    }
    const name = `rx-inline/${String(inline.length).padStart(3, "0")}.js`;
    inline.push({name, code: body});
    return `<script defer src="./${name}"></script>`;
});
if (/type="application\/x-rx-script"/.test(html)) throw new Error("Unprocessed x-rx-script tags left");
if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) throw new Error("Inline scripts are not allowed in the Tauri UI");

const handlers = new Map();
html = html.replace(/data-rx-on(click|change|input|submit|keydown)="([^"]*)"/g, (match, kind, encoded) => {
    const code = encoded.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    // Шаблоны с подстановками ($1, $4) preload тоже не исполнял
    if (code.includes("$1") || code.includes("$4")) return `data-rx-on${kind}=""`;
    if (!handlers.has(code)) handlers.set(code, `h${handlers.size}`);
    return `data-rx-on${kind}="${handlers.get(code)}"`;
});

// Рантайм и skinview3d — первыми (defer сохраняет порядок)
const firstScript = html.indexOf("<script defer");
if (firstScript === -1) throw new Error("No scripts in template");
html = `${html.slice(0, firstScript)}<script defer src="./rx-runtime.js"></script>\n    <script defer src="./rx-handlers.js"></script>\n    <script defer src="./js/skinview3d.bundle.js"></script>\n    ${html.slice(firstScript)}`;

// ---------- 4. rx-runtime.js ----------
const parts = [fs.readFileSync(path.join(RUNTIME, "core.js"), "utf8")];
const define = (id, source) => {
    parts.push(`__rxDef(${JSON.stringify(id)}, function (module, exports, require, __filename, __dirname) {\n${source}\n});`);
};
const RUNTIME_MODULES = ["bridge", "path", "buffer", "events", "fs", "system", "electron", "services", "mclc", "loaders", "archive", "jimp"];
for (const name of RUNTIME_MODULES) {
    const file = path.join(RUNTIME, `${name}.js`);
    if (fs.existsSync(file)) define(`tauri/runtime/${name}.js`, fs.readFileSync(file, "utf8"));
}
define("tauri/runtime/fs-promises.js", "module.exports = require('./fs').promises;");
define("tauri/runtime/os.js", "module.exports = require('./system').os;");
define("tauri/runtime/process.js", "module.exports = require('./system').process;");
const builtins = {
    fs: "fs", "fs/promises": "fs-promises", path: "path", buffer: "buffer", events: "events", os: "os", process: "process", electron: "electron",
    "minecraft-launcher-core": "mclc", "tomate-loaders": "loaders", compressing: "archive", jimp: "jimp", "jimp/fonts": "jimp"
};
for (const [name, file] of Object.entries(builtins)) {
    if (fs.existsSync(path.join(RUNTIME, `${file}.js`)) || ["fs-promises", "os", "process"].includes(file)) parts.push(`__rxBuiltin(${JSON.stringify(name)}, "tauri/runtime/${file}.js");`);
}
parts.push(fs.readFileSync(path.join(RUNTIME, "node-misc.js"), "utf8"));

// Корневые модули, которые интерфейс подключает через require; некоторые заменены версиями для Tauri
const REPLACED = Object.fromEntries(["archiveMetadata.js", "archiveWorker.js", "nbtWorker.js"].map(file => [file, path.join(RUNTIME, "replacements", file)]));
for (const file of ["externalTargets.js", "lowEndOptions.js", "modrinthPackSafety.js", "runtimeSecurity.js", "archiveWorker.js", "nbtWorker.js", "archiveMetadata.js", "minecraftSkinService.js", "web/js/RxNbt.js"]) {
    const source = REPLACED[file] && fs.existsSync(REPLACED[file]) ? REPLACED[file] : path.join(ROOT, file);
    define(file, fs.readFileSync(source, "utf8"));
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
parts.push(`__rxJson("package.json", ${JSON.stringify({name: pkg.name, version: pkg.version, description: pkg.description || "", productName: "RxLauncher"})});`);

// Пакеты из node_modules (чистый JS)
const addPackage = (name, dir = path.join(NODE_MODULES_ABS, name)) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const walk = folder => {
        for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) { if (!["test", "tests", "node_modules", "benchmark", "docs"].includes(entry.name)) walk(full); continue; }
            if (!entry.name.endsWith(".js") || entry.name.endsWith(".min.js")) continue;
            define(`node_modules/${name}/${path.relative(dir, full).split(path.sep).join("/")}`, fs.readFileSync(full, "utf8"));
        }
    };
    if (name === "jquery") define(`node_modules/jquery/dist/jquery.js`, fs.readFileSync(path.join(dir, "dist", "jquery.js"), "utf8"));
    else walk(dir);
    const main = name === "jquery" ? "dist/jquery.js" : (manifest.main || "index.js").replace(/^\.\//, "");
    parts.push(`__rxPackage(${JSON.stringify(name)}, ${JSON.stringify(`node_modules/${name}/${main.endsWith(".js") ? main : `${main}.js`}`)});`);
};
addPackage("jquery");
addPackage("toml");
addPackage("mcnbt");
// mcnbt нужна long@4 (её собственная копия), а не long@5 из корня node_modules
addPackage("long", fs.existsSync(path.join(NODE_MODULES_ABS, "mcnbt", "node_modules", "long")) ? path.join(NODE_MODULES_ABS, "mcnbt", "node_modules", "long") : path.join(NODE_MODULES_ABS, "long"));

parts.push(fs.readFileSync(path.join(RUNTIME, "start.js"), "utf8"));

// ---------- 5. вывод ----------
fs.rmSync(OUT, {recursive: true, force: true});
const copyWeb = (from, to) => {
    fs.mkdirSync(to, {recursive: true});
    for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyWeb(source, target);
        else if (!entry.name.endsWith(".ejs") && !entry.name.endsWith(".source.png")) fs.copyFileSync(source, target);
    }
};
copyWeb(WEB, OUT);
fs.writeFileSync(path.join(OUT, "index.html"), html);
fs.mkdirSync(path.join(OUT, "rx-inline"), {recursive: true});
for (const item of inline) fs.writeFileSync(path.join(OUT, item.name), item.code);
fs.writeFileSync(path.join(OUT, "rx-handlers.js"), `// Обработчики data-rx-on* из шаблона (собраны tauri/build-ui.cjs)\nwindow.__rxHandlers = {\n${
    [...handlers].map(([code, id]) => `    ${JSON.stringify(id)}: function (event) {\n        ${code}\n    }`).join(",\n")}\n};\n`);
const runtime = parts.join("\n");
fs.writeFileSync(path.join(OUT, "rx-runtime.js"), runtime);

// Файлы, которые код интерфейса читает через fs (__dirname): ресурсы Tauri рядом с exe
const RESOURCES = path.join(ROOT, "src-tauri", "resources", "web");
fs.rmSync(RESOURCES, {recursive: true, force: true});
for (const dir of ["languages", "assets/rxclient", "assets/data", "assets/agents"]) {
    if (fs.existsSync(path.join(WEB, dir))) copyWeb(path.join(WEB, dir), path.join(RESOURCES, dir));
}

// Проверка синтаксиса всего сгенерированного JS
const vm = require("node:vm");
for (const file of ["rx-runtime.js", "rx-handlers.js", ...inline.map(item => item.name)]) new vm.Script(fs.readFileSync(path.join(OUT, file), "utf8"), {filename: file});

const size = dir => fs.readdirSync(dir, {withFileTypes: true}).reduce((sum, entry) => sum + (entry.isDirectory() ? size(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0);
console.log(`UI built: ${rel(OUT) || OUT} — ${handlers.size} handlers, ${inline.length} inline scripts, runtime ${(runtime.length / 1024).toFixed(0)} KB, total ${(size(OUT) / 1024 / 1024).toFixed(1)} MB, sha256 ${crypto.createHash("sha256").update(runtime).digest("hex").slice(0, 12)}`);
