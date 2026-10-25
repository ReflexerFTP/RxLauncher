const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-server-catalog-test-"));
const config = Object.create(null);
let ipcPayload = null;
const ipcCalls = [];
const context = vm.createContext({
    console,
    Date,
    Intl,
    Map,
    Math,
    Object,
    Set,
    String,
    fs,
    path,
    require,
    USERDATA_PATH: tempRoot,
    MESSAGES: {servers: {catalog: {}}},
    RxTranslator: {getCurrentLanguage: () => "ru"},
    RxConfig: {
        read: (key, fallback) => Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback,
        write: (key, value) => {
            config[key] = JSON.parse(JSON.stringify(value));
            return true;
        }
    },
    RxCollector: {writeLog: () => true},
    ipcRenderer: {
        invoke: async (...args) => {
            ipcCalls.push(args);
            return ipcPayload;
        }
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
});

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxServersUI.js"), "utf8");
vm.runInContext(`${source}\nthis.RxServersUI = RxServersUI;`, context, {filename: "RxServersUI.js"});
const RxServersUI = context.RxServersUI;

assert.strictEqual(RxServersUI.normalizeAddress(" Play.InfinityBox.pro "), "play.infinitybox.pro");
assert.strictEqual(RxServersUI.normalizeAddress("example.org:25566"), "example.org:25566");
assert.strictEqual(RxServersUI.normalizeAddress("https://example.org"), "");
assert.strictEqual(RxServersUI.normalizeAddress("example.org:70000"), "");

const favicon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const mcsrvstatPayload = {
    online: true,
    players: {online: 1842, max: 5000},
    motd: {clean: ["§aFunTime Network", "§7Anarchy"]},
    version: "1.16.5-1.21.4",
    protocol: {name: "1.21.4", version: 769},
    icon: favicon,
    debug: {ping: true, apiversion: 3}
};
const normalizedPrimary = RxServersUI.normalizeStatusResponse("play.funtime.su", mcsrvstatPayload);
assert.strictEqual(normalizedPrimary.reachable, true, "a raw mcsrvstat response must count as reachable");
assert.strictEqual(normalizedPrimary.online, true);
assert.deepStrictEqual(JSON.parse(JSON.stringify(normalizedPrimary.players)), {online: 1842, max: 5000});
assert.strictEqual(normalizedPrimary.motd, "FunTime Network\nAnarchy");
assert.strictEqual(normalizedPrimary.icon, favicon);
assert.strictEqual(normalizedPrimary.provider, "mcsrvstat.us");

const minecraftPingerPayload = {
    message: "ok",
    server: {
        ip: "play.surebox.pro",
        port: 25565,
        players: {online: 326, max: 1000},
        motd: "SureBox — BoxPvP",
        version: "Requires MC 1.16 / 1.21",
        ping: 37,
        edition: "java",
        favicon
    }
};
const normalizedFallback = RxServersUI.normalizeStatusResponse("play.surebox.pro", minecraftPingerPayload);
assert.strictEqual(normalizedFallback.reachable, true, "a raw minecraftpinger response must count as reachable");
assert.strictEqual(normalizedFallback.online, true);
assert.strictEqual(normalizedFallback.players.online, 326);
assert.strictEqual(normalizedFallback.motd, "SureBox — BoxPvP");
assert.strictEqual(normalizedFallback.version, "Requires MC 1.16 / 1.21");
assert.strictEqual(normalizedFallback.ping, 37);
assert.strictEqual(normalizedFallback.icon, favicon);
assert.strictEqual(normalizedFallback.provider, "minecraftpinger.com");
assert.strictEqual(RxServersUI.normalizeStatusResponse("offline.example", {message: "ok", server: null}).reachable, true);
assert.strictEqual(RxServersUI.normalizeStatusResponse("offline.example", {message: "ok", server: null}).online, false);
assert.strictEqual(RxServersUI.normalizeFavicon("data:image/svg+xml;base64,PHN2Zz4="), "", "only Minecraft PNG favicons are accepted");

const builtins = RxServersUI.getServers();
assert.strictEqual(builtins.length, 13, "all requested built-in servers must be present");
assert.deepStrictEqual(
    [...new Set(builtins.map((server) => server.category))].sort(),
    ["anarchy", "boxpvp", "grief"]
);
assert.ok(builtins.some((server) => server.address === "play.funtime.su"));
assert.ok(builtins.some((server) => server.address === "hub.holyworld.ru"));
assert.ok(builtins.some((server) => server.address === "mc.reallyworld.me"));
assert.ok(builtins.some((server) => server.address === "play.infinitybox.pro"));

config.customCatalogServers = [
    {name: "My Server", address: "play.custom.example", category: "grief"},
    {name: "Duplicate", address: "PLAY.FUNTIME.SU", category: "boxpvp"},
    {name: "Broken", address: "https://bad.example", category: "anarchy"}
];
const withCustom = RxServersUI.getServers();
assert.strictEqual(withCustom.length, 14, "one valid unique custom server should be merged");
assert.strictEqual(withCustom.filter((server) => server.address === "play.funtime.su").length, 1, "custom entries must not duplicate built-ins");
assert.strictEqual(withCustom.find((server) => server.address === "play.custom.example").custom, true);

RxServersUI.statuses.set("play.funtime.su", {online: true, players: {online: 900}});
RxServersUI.statuses.set("hub.holyworld.ru", {online: true, players: {online: 1200}});
RxServersUI.statuses.set("mc.reallyworld.me", {online: true, players: {online: 700}});
RxServersUI.filter = "anarchy";
RxServersUI.sort = "online-desc";
RxServersUI.search = "";
const sortedAnarchy = RxServersUI.sortedAndFilteredServers();
assert.strictEqual(sortedAnarchy[0].address, "hub.holyworld.ru", "online-desc sort must use live counts");
assert.ok(sortedAnarchy.every((server) => server.category === "anarchy"));

RxServersUI.history = {version: 1, updatedAt: Date.now(), servers: {
    "play.funtime.su": [100, 500, 300].map((online, index) => ({at: Date.now() - index * 1000, online, max: 1000}))
}};
const stats = RxServersUI.historyStats("play.funtime.su");
assert.strictEqual(stats.peak, 500);
assert.strictEqual(stats.average, 300);
assert.strictEqual(RxServersUI.saveHistory(), true);
assert.ok(fs.existsSync(path.join(tempRoot, "server-status-history.json")), "history must be stored locally");

(async () => {
    config.serverPrivacyMode = true;
    ipcPayload = true;
    assert.strictEqual(await RxServersUI.canOpen(true), true, "privacy mode must still perform the connectivity check");
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(ipcCalls.at(-1))),
        ["server-catalog-connectivity", true, {allowDirect: false}],
        "privacy connectivity checks must remain HTTPS-only"
    );

    ipcPayload = mcsrvstatPayload;
    const explicitStatus = await RxServersUI.queryServer("play.funtime.su", true);
    assert.strictEqual(explicitStatus.online, true, "privacy mode must still allow an explicit HTTPS status request");
    const statusCall = ipcCalls.at(-1);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(statusCall)),
        ["server-status-query", "play.funtime.su", true, {allowDirect: false}],
        "privacy mode must prohibit the direct GameDig fallback without suppressing the API request"
    );
    RxServersUI.startRefreshTimer();
    assert.strictEqual(RxServersUI.refreshTimer, null, "privacy mode must keep background refresh disabled");

    config.serverPrivacyMode = false;
    await RxServersUI.queryServer("play.funtime.su", false);
    assert.strictEqual(ipcCalls.at(-1)[3].allowDirect, true, "normal mode may use the direct fallback");

    fs.rmSync(tempRoot, {recursive: true, force: true});
    console.log("Server catalog tests passed");
})().catch((error) => {
    fs.rmSync(tempRoot, {recursive: true, force: true});
    console.error(error.stack || error);
    process.exitCode = 1;
});
