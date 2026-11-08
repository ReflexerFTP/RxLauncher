// Плащи: агент в сборке совпадает с закреплённым хешем, попадает в ресурсы Tauri и подключается к запуску
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const jar = fs.readFileSync(path.join(root, "web", "assets", "agents", "rxcapes.jar"));
const source = fs.readFileSync(path.join(root, "web", "js", "RxCapes.js"), "utf8");
const pinned = /sha256: "([0-9a-f]{64})"/.exec(source)[1];
assert.equal(crypto.createHash("sha256").update(jar).digest("hex"), pinned, "rebuild the agent and update RxCapes.AGENT.sha256 together");
assert.equal(jar.subarray(0, 2).toString("latin1"), "PK");
for (const entry of ["META-INF/MANIFEST.MF", "xyz/rxlauncher/capes/Agent.class", "xyz/rxlauncher/capes/Bridge.class",
    "rxiso/xyz/rxlauncher/capes/iso/AuthlibTransformer.class", "rxiso/org/objectweb/asm/ClassReader.class"]) {
    assert.ok(jar.includes(Buffer.from(entry)), `agent jar must contain ${entry}`);
}
// ASM только внутри rxiso/ — иначе столкнётся с ASM загрузчиков Fabric и Forge
const names = jar.toString("latin1");
const count = needle => names.split(needle).length - 1;
assert.equal(count("org/objectweb/asm/"), count("rxiso/org/objectweb/asm/"), "ASM classes outside rxiso/");
assert.ok(fs.readFileSync(path.join(root, "tauri", "build-ui.cjs"), "utf8").includes('"assets/agents"'), "agent must be copied next to the exe");
assert.ok(fs.readFileSync(path.join(root, "web", "js", "RxLaunchConfigurator.js"), "utf8").includes("RxCapes.setupLaunch(resultConfig, activeAccount)"));

// setupLaunch: копия в кэш с проверкой хеша, аргумент -javaagent с адресом сайта; выключатель отключает агент
const files = new Map();
const config = {};
const context = {
    path, SITE_URL: "https://rxlauncher.xyz", GAME_DATA: "C:/Game", __dirname: "C:/App/web",
    fs: {mkdirSync: () => {}, copyFileSync: (from, to) => files.set(to.replaceAll("\\", "/"), from)},
    RxConfig: {read: (key, fallback) => (key in config ? config[key] : fallback), write: (key, value) => { config[key] = value; }},
    RxHttp: {isFileValid: async file => files.has(file.replaceAll("\\", "/"))},
    RxCollector: {writeLog: () => {}},
    RxAccount: {isLoggedIn: () => false},
    RxAccountsManager: {getAccount: () => null}
};
vm.createContext(context);
vm.runInContext(`${source}\nthis.RxCapes = RxCapes;`, context);
(async () => {
    const launch = await context.RxCapes.setupLaunch({customArgs: ["-Xmx2G"]}, "uuid");
    assert.equal(launch.customArgs.length, 2);
    assert.match(launch.customArgs[1], /^-javaagent:C:\/Game\/cache\/rxcapes-[0-9a-f]{12}\.jar=https:\/\/rxlauncher\.xyz$/);
    context.RxCapes.setEnabledInGame(false);
    assert.deepEqual((await context.RxCapes.setupLaunch({customArgs: []}, "uuid")).customArgs, []);
    assert.ok(context.RxCapes.isAllowedGroup("player_plus") && context.RxCapes.isAllowedGroup("admin") && !context.RxCapes.isAllowedGroup("tester"));
    console.log("Cape tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
