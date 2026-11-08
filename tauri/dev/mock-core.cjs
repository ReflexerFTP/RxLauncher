// Стенд для отладки интерфейса без Rust: Electron изображает WebView Tauri.
// Интерфейс — с http://tauri.localhost (dist-tauri), протокол rxsync — эталонная реализация на Node того же формата,
// что и Rust-ядро (src-tauri/src/bridge.rs). Запуск: electron tauri/dev/mock-core.cjs [--shot=файл.png] [--eval=код]
"use strict";
const {app, BrowserWindow, net, protocol, session} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist-tauri");
const DATA = process.env.RX_MOCK_APPDATA || path.join(os.tmpdir(), "rx-mock-appdata");
const USERDATA = path.join(DATA, "rxclient");
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=") || true]; }));
const calls = new Map();
const log = [];

const encode = (status, value, payload) => {
    const json = Buffer.from(JSON.stringify(value === undefined ? null : value));
    const head = Buffer.alloc(5);
    head[0] = status;
    head.writeUInt32LE(json.length, 1);
    return Buffer.concat([head, json, payload ? Buffer.from(payload) : Buffer.alloc(0)]);
};
const kind = stat => stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
const statJson = stat => ({kind: kind(stat), size: stat.size, mode: stat.mode, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs, dev: 0, ino: 0, nlink: 1});
const fds = new Map();
let nextFd = 100;

const FS = {
    exists: ({path: p}) => [fs.existsSync(p)],
    stat: ({path: p, lstat}) => [statJson(lstat ? fs.lstatSync(p) : fs.statSync(p))],
    readFile: ({path: p}) => [null, fs.readFileSync(p)],
    writeFile: ({path: p, flag}, data) => { fs.writeFileSync(p, data, {flag}); return [null]; },
    readdir: ({path: p}) => [fs.readdirSync(p, {withFileTypes: true}).map(e => ({name: e.name, kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file"}))],
    mkdir: ({path: p, recursive}) => [fs.mkdirSync(p, {recursive}) ?? null],
    rm: ({path: p, recursive, force}) => { fs.rmSync(p, {recursive, force}); return [null]; },
    rmdir: ({path: p, recursive}) => { fs.rmSync(p, {recursive}); return [null]; },
    unlink: ({path: p}) => { fs.unlinkSync(p); return [null]; },
    rename: ({from, to}) => { fs.renameSync(from, to); return [null]; },
    copyFile: ({from, to, exclusive}) => { fs.copyFileSync(from, to, exclusive ? fs.constants.COPYFILE_EXCL : 0); return [null]; },
    cp: ({from, to, recursive, force, errorOnExist}) => { fs.cpSync(from, to, {recursive, force, errorOnExist}); return [null]; },
    realpath: ({path: p}) => [fs.realpathSync(p)],
    mkdtemp: ({prefix}) => [fs.mkdtempSync(prefix)],
    statfs: ({path: p}) => { const s = fs.statfsSync(p); return [{bavail: s.bavail, bsize: s.bsize, blocks: s.blocks, bfree: s.bfree}]; },
    access: ({path: p}) => { fs.accessSync(p); return [null]; },
    open: ({path: p, flags}) => { const fd = fs.openSync(p, flags); fds.set(nextFd, fd); return [nextFd++]; },
    read: ({fd, length, position}) => { const b = Buffer.alloc(length); const n = fs.readSync(fds.get(fd), b, 0, length, position); return [null, b.subarray(0, n)]; },
    readFd: ({fd}) => [null, fs.readFileSync(fds.get(fd))],
    write: ({fd, position}, data) => [fs.writeSync(fds.get(fd), data, 0, data.length, position)],
    fstat: ({fd}) => [statJson(fs.fstatSync(fds.get(fd)))],
    fsync: ({fd}) => { fs.fsyncSync(fds.get(fd)); return [null]; },
    close: ({fd}) => { fs.closeSync(fds.get(fd)); fds.delete(fd); return [null]; },
    truncate: ({path: p, length}) => { fs.truncateSync(p, length); return [null]; },
    hashFile: ({path: p, algorithm}) => [crypto.createHash(algorithm).update(fs.readFileSync(p)).digest("hex")],
    utimes: ({path: p, atimeMs, mtimeMs}) => { fs.utimesSync(p, atimeMs / 1000, mtimeMs / 1000); return [null]; }
};

const IPC = {
    "get-userdata-path": () => USERDATA,
    isAppInDev: () => false,
    isAppInTest: () => false,
    "accounts-read": () => {
        const file = path.join(USERDATA, "accounts.json");
        return {ok: true, accounts: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}};
    },
    "accounts-write": accounts => { fs.mkdirSync(USERDATA, {recursive: true}); fs.writeFileSync(path.join(USERDATA, "accounts.json"), JSON.stringify(accounts, null, 2)); return {ok: true}; },
    "rx-account-token": () => "",
    "curseforge-key-status": () => ({configured: false, managedByEnvironment: false, secureStorageAvailable: true}),
    "discord-rpc-status": () => ({connected: false}),
    "server-catalog-connectivity": () => false,
    "network-compatibility-check": () => ({reachable: true}),
    "server-status-query": () => ({online: false}),
    "command-history-setting": () => ({})
};

// HTTP (эталон для src-tauri/src/http.rs): ответ целиком, без прогресса
const HTTP = {
    "http.request": async ({url, method, headers, timeout, maxBytes}, data) => {
        const response = await fetch(url, {method, headers, body: data && data.length ? data : undefined, signal: AbortSignal.timeout(timeout || 20000)});
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > maxBytes) throw new Error("Response too large");
        return [{status: response.status, url: response.url, headers: Object.fromEntries(response.headers)}, body];
    },
    "http.download": async ({url, path: target, hash, timeout, maxBytes, expectedSize}) => {
        const response = await fetch(url, {signal: AbortSignal.timeout(Math.max(timeout || 30000, 120000))});
        if (!response.ok) throw Object.assign(new Error(`Download failed with HTTP ${response.status}`), {status: response.status});
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > maxBytes) throw new Error("Download exceeds size limit");
        if (expectedSize !== null && expectedSize !== undefined && body.length !== expectedSize) throw new Error(`Size mismatch for ${path.basename(target)}`);
        if (hash && crypto.createHash(hash.algorithm).update(body).digest("hex") !== hash.value) throw new Error(`Checksum mismatch for ${path.basename(target)}`);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, body);
        return [{bytes: body.length}];
    },
    "http.abort": async () => [null]
};

const handle = (op, input, data) => {
    if (HTTP[op]) return HTTP[op](input, data);
    calls.set(op, (calls.get(op) || 0) + 1);
    if (op.startsWith("fs.")) {
        const fn = FS[op.slice(3)];
        if (!fn) throw Object.assign(new Error(`mock: unknown fs op ${op}`), {code: "ENOSYS"});
        return fn(input || {}, data);
    }
    switch (op) {
        case "system.info": return [{arch: "x64", release: os.release(), version: os.version(), hostname: os.hostname(), homedir: os.homedir(), tmpdir: os.tmpdir(),
            totalmem: os.totalmem(), cpus: os.cpus().length, cpuModel: os.cpus()[0].model, cpuSpeed: os.cpus()[0].speed, username: os.userInfo().username,
            env: {APPDATA: DATA, LOCALAPPDATA: DATA, USERPROFILE: os.homedir(), TEMP: os.tmpdir()}, pid: process.pid, execPath: process.execPath,
            resourcesPath: ROOT, cwd: ROOT, versions: {tauri: "mock", webview: process.versions.chrome}}];
        case "system.freemem": return [os.freemem()];
        case "app.paths": return [{webRoot: DIST, userData: USERDATA}];
        case "hash": return [crypto.createHash(input.algorithm).update(data).digest("hex")];
        case "zlib": {
            const fn = {inflateRaw: zlib.inflateRawSync, deflateRaw: zlib.deflateRawSync, inflate: zlib.inflateSync, deflate: zlib.deflateSync, gunzip: zlib.gunzipSync, gzip: zlib.gzipSync, unzip: zlib.unzipSync}[input.op];
            return [null, fn(data, {maxOutputLength: input.maxOutputLength})];
        }
        case "log": log.push(input.message); console.log(`[UI ${input.level}] ${input.message}`); return [null];
        case "ipc": {
            const fn = IPC[input.channel];
            if (!fn) { log.push(`ipc stub: ${input.channel}`); return [null]; }
            return [fn(...(input.args || []))];
        }
        case "clipboard.writeText": return [null];
        case "clipboard.readText": return [""];
        default:
            log.push(`unknown op: ${op}`);
            throw Object.assign(new Error(`mock: unknown op ${op}`), {code: "ENOSYS"});
    }
};

protocol.registerSchemesAsPrivileged([{scheme: "http", privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}}]);
app.whenReady().then(async () => {
    fs.mkdirSync(USERDATA, {recursive: true});
    session.defaultSession.protocol.handle("http", async request => {
        const url = new URL(request.url);
        if (url.hostname === "rxsync.localhost") {
            const body = Buffer.from(await request.arrayBuffer());
            const length = body.readUInt32LE(0);
            const input = JSON.parse(body.subarray(4, 4 + length).toString("utf8"));
            const data = body.subarray(4 + length);
            const op = decodeURIComponent(url.pathname.slice(1));
            let result;
            try {
                const [value, payload] = await handle(op, input, data);
                result = encode(0, value, payload);
            } catch (error) {
                result = encode(1, {message: error.message, code: error.code, errno: error.errno, syscall: error.syscall, path: error.path});
            }
            return new Response(result, {headers: {"Access-Control-Allow-Origin": "*", "Content-Type": "application/octet-stream"}});
        }
        if (url.hostname === "tauri.localhost") {
            const file = path.join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
            if (!file.startsWith(DIST) || !fs.existsSync(file)) return new Response("not found", {status: 404});
            const type = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".gif": "image/gif", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4"}[path.extname(file).toLowerCase()] || "application/octet-stream";
            return new Response(fs.readFileSync(file), {headers: {"Content-Type": type}});
        }
        if (url.hostname === "asset.localhost") {
            const file = decodeURIComponent(url.pathname.slice(1));
            return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response("not found", {status: 404});
        }
        // Локальный API для проверок (node server/api/server.js на 127.0.0.1)
        if (url.hostname === "127.0.0.1") return net.fetch(request, {bypassCustomProtocolHandlers: true});
        return new Response("blocked in mock", {status: 403});
    });
    const preload = path.join(__dirname, "mock-preload.cjs");
    const win = new BrowserWindow({width: 1400, height: 900, show: Boolean(args.show), frame: false, backgroundColor: "#091012",
        webPreferences: {preload, contextIsolation: false, nodeIntegration: false, sandbox: false}});
    const errors = [];
    win.webContents.on("console-message", event => { if (event.level === "error" || event.level === "warning" || event.level >= 2) errors.push(event.message); });
    await win.loadURL("http://tauri.localhost/index.html");
    await new Promise(resolve => setTimeout(resolve, Number(args.wait || 4000)));
    let evalResult = null;
    if (args.eval) { try { evalResult = await win.webContents.executeJavaScript(String(args.eval)); } catch (error) { evalResult = `EVAL ERROR: ${error.message}`; } }
    if (args.shot) { win.showInactive(); await new Promise(r => setTimeout(r, 600)); fs.writeFileSync(String(args.shot), (await win.webContents.capturePage()).toPNG()); }
    const state = await win.webContents.executeJavaScript(`({display: document.documentElement.style.display, title: document.title, classes: typeof RxConfig, translator: typeof MESSAGES, modals: document.querySelectorAll('.modal').length})`).catch(e => ({error: e.message}));
    console.log(JSON.stringify({state, evalResult, errors: errors.slice(0, 40), log: log.slice(0, 60), calls: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1]).slice(0, 40))}, null, 2));
    app.exit(0);
});
