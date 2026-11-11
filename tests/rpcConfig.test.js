// Картинка статуса Discord берётся с сайта (rpc.json): только https на rxlauncher.xyz, последняя удачная запоминается
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const load = ({config, saved = null}) => {
    const storage = new Map(saved ? [["rxRpcLargeImage", saved]] : []);
    const activities = [];
    const requests = [];
    const bridge = {
        call: async (op, args) => {
            requests.push(args.url);
            const body = typeof config === "string" ? config : JSON.stringify(config);
            return {value: {status: config === null ? 404 : 200, headers: {}}, payload: Buffer.from(body || "")};
        },
        value: async (op, args) => { if (op === "discord.setActivity") activities.push(args.activity); return null; },
        listen: () => () => {}
    };
    const module = {exports: {}};
    const context = vm.createContext({module, exports: module.exports, require: name => (name === "./bridge" ? bridge : require(name)),
        Buffer, URL, setTimeout: () => 0, clearTimeout: () => {}, Promise, Date, JSON, Math, String, Object, Number, console,
        localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../tauri/runtime/services.js"), "utf8"), context);
    return {handlers: module.exports, activities, storage, requests};
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const image = activity => activity.assets.large_image;

(async () => {
    // Нет файла на сайте — встроенная картинка v4
    let run = load({config: null});
    run.handlers["launcher-ready"]({});
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(run.requests[0], "https://rxlauncher.xyz/rpc.json");
    assert.match(image(run.activities.at(-1)), /rxlauncher-rpc-3d-v4\.gif$/);

    // Новый адрес с сайта — статус обновляется сразу и адрес запоминается
    run = load({config: {largeImage: "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v5.gif"}});
    run.handlers["launcher-ready"]({});
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(image(run.activities.at(-1)), "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v5.gif");
    assert.equal(run.storage.get("rxRpcLargeImage"), "https://rxlauncher.xyz/assets/rpc/rxlauncher-rpc-3d-v5.gif");

    // Запомненный адрес действует с первого статуса, ещё до ответа сайта
    run = load({config: null, saved: "https://cdn.rxlauncher.xyz/rpc.gif"});
    run.handlers["launcher-ready"]({});
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(image(run.activities[0]), "https://cdn.rxlauncher.xyz/rpc.gif");

    // Чужие и небезопасные адреса не принимаются
    for (const bad of ["http://rxlauncher.xyz/a.gif", "https://evil.example/a.gif", "https://rxlauncher.xyz.evil.example/a.gif",
        "https://user:pass@rxlauncher.xyz/a.gif", "javascript:alert(1)", 42]) {
        run = load({config: {largeImage: bad}});
        run.handlers["launcher-ready"]({});
        for (let i = 0; i < 5; i++) await flush();
        assert.match(image(run.activities.at(-1)), /rxlauncher-rpc-3d-v4\.gif$/, String(bad));
        assert.equal(run.storage.size, 0);
    }
    // Битый JSON — без ошибок, встроенная картинка
    run = load({config: "{not json"});
    run.handlers["launcher-ready"]({});
    for (let i = 0; i < 5; i++) await flush();
    assert.match(image(run.activities.at(-1)), /rxlauncher-rpc-3d-v4\.gif$/);
    console.log("RPC config tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
