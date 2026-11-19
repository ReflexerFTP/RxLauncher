const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const safety = require("../modrinthPackSafety");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rx-mod-deletion-"));
const pack = path.join(root, "modpacks", "test-pack");
const mods = path.join(pack, "mods");
const manifestPath = path.join(pack, "manifest.json");
const jar = Buffer.from([0x50, 0x4b, 3, 4]);
const url = "https://cdn.modrinth.com/data/example/versions/1/test.jar";
const entry = relative => ({path: relative, url});
const read = () => JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const files = () => read().files.map(file => file.path || file.name);
const put = name => fs.writeFileSync(path.join(mods, name), jar);
const trash = path.join(root, "trash");

function session() {
    const requested = [];
    const context = vm.createContext({
        fs, path, crypto, Buffer, console, URL, GAME_DATA: root,
        require: name => {
            if (name === "../modrinthPackSafety") return safety;
            if (name === "electron") return {shell: {trashItem: async file => fs.renameSync(file, path.join(trash, crypto.randomUUID()))}};
            throw Error(name);
        },
        RxCollector: {writeLog() {}}, RxToasts: {create() {}}, MESSAGES: {mods: {}, packs: {}},
        RxVersionsManager: {getActiveVersion: () => "pack-test-pack", parseVersionID: () => ({type: "pack", name: "test-pack"}), versionToDisplayName: () => "Test"},
        RxUtils: {getGameRoot: () => pack}, window: {confirm: () => true}, $() {},
        RxHttp: {isFileValid: async file => fs.existsSync(file)},
        RxDownloader: {downloadMany: async missing => {
            for (const item of missing) { requested.push(path.basename(item.path)); fs.writeFileSync(item.path, jar); }
        }}
    });
    for (const name of ["RxPacks", "RxModsManager"]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/js", name + ".js"), "utf8"), context);
    }
    const manager = vm.runInContext("RxModsManager", context);
    const packs = vm.runInContext("RxPacks", context);
    manager.refresh = () => { manager.files = manager.scan(); };
    return {manager, packs, context, requested};
}

async function run() {
    fs.mkdirSync(mods, {recursive: true});
    fs.mkdirSync(trash);
    const other = path.join(root, "modpacks", "other", "mods");
    fs.mkdirSync(other, {recursive: true});
    fs.writeFileSync(path.join(other, "alpha.jar"), jar);
    fs.mkdirSync(path.join(pack, "config"));
    fs.writeFileSync(path.join(pack, "config", "alpha.jar"), jar);
    fs.writeFileSync(path.join(mods, "readme.txt"), "keep");
    for (const name of ["alpha.jar", "beta.jar.disabled", "gamma.jar.dis", "manual.jar", "keep.jar"]) put(name);
    fs.writeFileSync(manifestPath, JSON.stringify({displayName: "Test", files: [
        entry("MODS\\ALPHA.jar"), entry("mods/alpha.jar"), {name: "mods\\beta.jar", url},
        entry("mods/gamma.jar"), entry("mods/keep.jar"), entry("config/alpha.jar"), entry("mods/repair.jar")
    ]}));

    const first = session();
    await Promise.all(["alpha.jar", "beta.jar.disabled", "gamma.jar.dis", "manual.jar"].map(async name => {
        assert.equal(await first.manager.remove(name), true);
    }));
    assert.deepEqual(files(), ["mods/keep.jar", "config/alpha.jar", "mods/repair.jar"]);
    const next = session();
    assert.equal(await next.packs.verifyAndInstall("test-pack"), true);
    assert.deepEqual(next.requested, ["repair.jar"], "only genuinely missing files are repaired");
    assert.deepEqual(Array.from(next.manager.scan(), x => x.fileName).sort(), ["keep.jar", "repair.jar"]);

    // Не удалось сохранить манифест: JAR возвращается на прежнее место.
    const save = next.packs.writeModpackManifest;
    next.packs.writeModpackManifest = () => { throw Error("simulated write failure"); };
    assert.equal(await next.manager.remove("keep.jar"), false);
    assert.ok(fs.existsSync(path.join(mods, "keep.jar")));
    assert.ok(files().includes("mods/keep.jar"));
    next.packs.writeModpackManifest = save;

    // Удаление, пока предыдущий запуск уже скачивает JAR.
    fs.unlinkSync(path.join(mods, "repair.jar"));
    let started, resume;
    const downloading = new Promise(r => { started = r; });
    next.context.RxDownloader.downloadMany = async () => {
        started();
        await new Promise(r => { resume = r; });
        put("repair.jar");
    };
    const repairing = next.packs.verifyAndInstall("test-pack");
    await downloading;
    const deleting = next.manager.remove("repair.jar");
    resume();
    assert.deepEqual(await Promise.all([repairing, deleting]), [true, true]);
    assert.equal(fs.existsSync(path.join(mods, "repair.jar")), false);

    const bulk = session();
    const manifest = read();
    for (let i = 0; i < 120; i++) {
        const file = "mod-" + i + ".jar";
        if (i % 4) put(file + ["", ".disabled", ".dis"][i % 3]);
        manifest.files.push(entry("mods\\" + file));
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    bulk.manager.refresh();
    assert.equal(await bulk.manager.removeAll(), true);
    const restarted = session();
    assert.equal(await restarted.packs.verifyAndInstall("test-pack"), true);
    assert.deepEqual(restarted.requested, []);
    assert.deepEqual(files(), ["config/alpha.jar"]);
    assert.deepEqual(fs.readdirSync(mods), ["readme.txt"]);
    assert.deepEqual(fs.readFileSync(path.join(other, "alpha.jar")), jar);
}

run().then(() => console.log("Pack mod deletion persists across reload, repair, rollback and bulk deletion"))
    .finally(() => fs.rmSync(root, {recursive: true, force: true}))
    .catch(error => { console.error(error); process.exitCode = 1; });
