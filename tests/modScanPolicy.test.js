const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({
    $() {}, RxConfig: {read: (key, fallback) => fallback},
    RxCollector: {writeLog() {}}, RxToasts: {create() {}}, RxFlyout: {setText() {}},
    MESSAGES: {modScan: {}, dialog: {}}, ipcRenderer: {}, RxDialog: {}, Set, Map
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/js/RxModScan.js"), "utf8"), context);
const scan = vm.runInContext("RxModScan", context);
const clean = p => ({name: p, path: p, sha1: p, verdict: "clean", findings: []});

async function run() {
    const paths = Array.from({length: 401}, (_, i) => i + ".jar");
    const sizes = [];
    context.ipcRenderer.invoke = async (_, batch) => {
        sizes.push(batch.files.length);
        return {files: batch.files.map(clean)};
    };
    assert.deepEqual(await scan.checkBeforeInstall(paths), paths);
    assert.deepEqual(sizes, [200, 200, 1]);
    context.ipcRenderer.invoke = async () => ({files: []});
    assert.equal((await scan.checkBeforeInstall(paths)).length, 0);
    context.ipcRenderer.invoke = async () => { throw Error("temporarily unavailable"); };
    assert.equal(await scan.beforeLaunch("mods"), false);
    const unread = {...clean("unfinished.jar"), verdict: "unknown"};
    assert.equal(scan.flagged([unread], new Map([[unread.sha1, true]])).length, 1);
    scan.scan = async () => ({files: [unread]});
    context.RxDialog.confirm = async () => true;
    scan.disable = () => 0;
    assert.equal(await scan.beforeLaunch("mods"), false);
    scan.disable = () => 1;
    assert.equal(await scan.beforeLaunch("mods"), true);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
