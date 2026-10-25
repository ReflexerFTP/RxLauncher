const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-mods-test-"));
const modsPath = path.join(tempRoot, "mods");
fs.mkdirSync(modsPath, {recursive: true});

const jqueryStub = argument => {
    if (typeof argument === "function") return undefined;
    const chain = {
        length: 0,
        find: () => chain,
        on: () => chain,
        off: () => chain,
        toggle: () => chain,
        prop: () => chain,
        text: () => chain,
        attr: () => chain,
        empty: () => chain,
        append: () => chain,
        val: () => ""
    };
    return chain;
};

const context = vm.createContext({
    console,
    fs,
    os,
    path,
    Buffer,
    Date,
    Intl,
    MESSAGES: {commons: {notSelected: "none"}, mods: {}},
    RxTranslator: {getCurrentLanguage: () => "en"},
    RxVersionsManager: {
        getActiveVersion: () => "fabric-1.21.4",
        versionToDisplayName: () => "Fabric 1.21.4",
        parseVersionID: id => ({type: id.split("-")[0], name: id.split("-").slice(1).join("-")})
    },
    RxUtils: {getGameRoot: () => tempRoot},
    RxCollector: {writeLog: () => {}},
    RxToasts: {create: () => {}},
    ipcRenderer: {invoke: async () => false},
    openExternal: () => {},
    window: {confirm: () => true},
    $: jqueryStub
});

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxModsManager.js"), "utf8");
vm.runInContext(`${source}\nthis.RxModsManager = RxModsManager;`, context, {filename: "RxModsManager.js"});
const manager = context.RxModsManager;
manager.refresh = () => true;

const validJar = path.join(modsPath, "sodium-fabric-0.6.0+mc1.21.4.jar");
const invalidJar = path.join(modsPath, "broken.jar");
fs.writeFileSync(validJar, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
fs.writeFileSync(invalidJar, Buffer.from("not a zip"));
fs.writeFileSync(path.join(modsPath, "lithium-0.14.0.jar.disabled"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
fs.writeFileSync(path.join(modsPath, "readme.txt"), "ignore");

assert.strictEqual(manager.isValidJar(validJar), true, "valid ZIP/JAR signature must be accepted");
assert.strictEqual(manager.isValidJar(invalidJar), false, "fake JAR must be rejected");
assert.strictEqual(manager.scan().length, 3, "scanner must include enabled and disabled JAR files only");
assert.strictEqual(manager.scan().filter(file => file.enabled).length, 2);
assert.strictEqual(manager.resolveManagedPath("../escape.jar"), false, "path traversal must be rejected");
assert.ok(manager.displayName("sodium-fabric-0.6.0+mc1.21.4.jar").startsWith("Sodium"));

assert.strictEqual(manager.toggle(path.basename(validJar)), true, "enabled JAR must be disabled by a safe rename");
assert.ok(fs.existsSync(`${validJar}.disabled`));
assert.strictEqual(manager.toggle(`${path.basename(validJar)}.disabled`), true, "disabled JAR must be enabled again");
assert.ok(fs.existsSync(validJar));
assert.strictEqual(manager.remove(path.basename(validJar)), true, "managed JAR must be removable");
assert.strictEqual(fs.existsSync(validJar), false);

fs.rmSync(tempRoot, {recursive: true, force: true});
console.log("Mods manager tests passed");
