// os и process: сведения о системе приходят из ядра один раз при старте
const bridge = require("./bridge");
let info = null;
const system = () => info || (info = bridge.syncValue("system.info"));

const os = {
    EOL: "\r\n",
    platform: () => "win32",
    type: () => "Windows_NT",
    arch: () => system().arch,
    release: () => system().release,
    version: () => system().version,
    hostname: () => system().hostname,
    homedir: () => system().homedir,
    tmpdir: () => system().tmpdir,
    totalmem: () => system().totalmem,
    freemem: () => bridge.syncValue("system.freemem"),
    cpus: () => Array.from({length: system().cpus}, () => ({model: system().cpuModel, speed: system().cpuSpeed, times: {user: 0, nice: 0, sys: 0, idle: 0, irq: 0}})),
    availableParallelism: () => system().cpus,
    endianness: () => "LE",
    uptime: () => bridge.syncValue("system.uptime"),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({username: system().username, homedir: system().homedir, shell: null, uid: -1, gid: -1}),
    machine: () => system().arch === "x64" ? "x86_64" : system().arch,
    constants: {signals: {}, errno: {}}
};

const listeners = new Map();
const process = {
    platform: "win32",
    get arch() { return system().arch; },
    get env() { return system().env; },
    get pid() { return system().pid; },
    get execPath() { return system().execPath; },
    get resourcesPath() { return system().resourcesPath; },
    get versions() { return system().versions; },
    get version() { return `v${system().versions.node || "0.0.0"}`; },
    type: "renderer",
    argv: ["rxlauncher"],
    title: "RxLauncher",
    cwd: () => system().cwd,
    chdir: () => {},
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    hrtime: Object.assign((previous) => {
        const now = performance.now();
        const seconds = Math.floor(now / 1000);
        const nanos = Math.floor((now % 1000) * 1e6);
        if (!previous) return [seconds, nanos];
        let ds = seconds - previous[0], dn = nanos - previous[1];
        if (dn < 0) { ds -= 1; dn += 1e9; }
        return [ds, dn];
    }, {bigint: () => BigInt(Math.floor(performance.now() * 1e6))}),
    memoryUsage: () => {
        const heap = performance.memory || {};
        return {rss: heap.totalJSHeapSize || 0, heapTotal: heap.totalJSHeapSize || 0, heapUsed: heap.usedJSHeapSize || 0, external: 0, arrayBuffers: 0};
    },
    uptime: () => performance.now() / 1000,
    emitWarning: (warning) => console.warn(warning),
    on(name, fn) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); return process; },
    once(name, fn) { return process.on(name, fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); return process; },
    removeListener(name, fn) { return process.off(name, fn); },
    removeAllListeners() { listeners.clear(); return process; },
    emit() { return false; },
    exit: () => bridge.value("ipc", {channel: "close-main-window", args: []}),
    stdout: {write: text => console.log(String(text).replace(/\n$/, ""))},
    stderr: {write: text => console.error(String(text).replace(/\n$/, ""))}
};

module.exports = {os, process, system};
