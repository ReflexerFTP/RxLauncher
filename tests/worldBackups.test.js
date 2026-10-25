// Резервные копии миров: копия, восстановление, лимит автокопий, автокопия только сыгранных миров
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const compressing = require("compressing");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-worlds-test-"));
const gameData = path.join(tempRoot, "game");
const logs = [];
const toasts = [];
const context = vm.createContext({
    console, Buffer, Date, Math, setTimeout, fs, path, crypto, compressing,
    fsPromises: fs.promises,
    GAME_DATA: gameData,
    MESSAGES: {worlds: {autoSaved: "saved", autoSavedText: "{0}"}},
    RxConfig: {read: (key, fallback) => fallback},
    RxCollector: {writeLog: message => logs.push(message)},
    RxToasts: {create: (...args) => toasts.push(args)},
    RxUtils: {unpackArchive: (archive, target) => compressing.zip.uncompress(archive, target)}
});
const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxWorldBackups.js"), "utf8");
vm.runInContext(`${source}\nthis.RxWorldBackups = RxWorldBackups;`, context, {filename: "RxWorldBackups.js"});
const {RxWorldBackups} = context;

const makeWorld = (name, content) => {
    const world = path.join(gameData, "saves", name);
    fs.mkdirSync(path.join(world, "region"), {recursive: true});
    fs.writeFileSync(path.join(world, "level.dat"), "level");
    fs.writeFileSync(path.join(world, "region", "r.0.0.mca"), content);
    return world;
};

(async () => {
    try {
        const world = makeWorld("Мой мир", "first");
        const backup = await RxWorldBackups.backup(world, "manual");
        assert.ok(fs.existsSync(backup) && backup.startsWith(RxWorldBackups.root()), "backup must be saved in backups/worlds");
        assert.strictEqual(RxWorldBackups.list(world).length, 1);

        // Мир изменился — восстанавливаем прошлое состояние
        fs.writeFileSync(path.join(world, "region", "r.0.0.mca"), "broken");
        fs.writeFileSync(path.join(world, "extra.txt"), "new file");
        assert.strictEqual(await RxWorldBackups.restore(world, backup), true);
        assert.strictEqual(fs.readFileSync(path.join(world, "region", "r.0.0.mca"), "utf8"), "first");
        assert.ok(!fs.existsSync(path.join(world, "extra.txt")), "restore must replace the world, not merge");
        const reasons = RxWorldBackups.list(world).map(item => item.reason).sort();
        assert.deepStrictEqual([...reasons], ["manual", "restore"], "the state before restore must be kept as a backup");
        assert.ok(fs.readdirSync(path.join(gameData, "saves")).every(name => !/rx-(restore|old)/.test(name)), "no temp folders left");

        // Одинаковые названия миров в разных местах не смешиваются
        const other = path.join(gameData, "modpacks", "pack", "saves", "Мой мир");
        fs.mkdirSync(other, {recursive: true});
        fs.writeFileSync(path.join(other, "level.dat"), "x");
        assert.notStrictEqual(RxWorldBackups.dirFor(world), RxWorldBackups.dirFor(other));

        // Автокопий не больше KEEP_AUTO, ручные остаются
        const created = [];
        for (let index = 0; index < RxWorldBackups.KEEP_AUTO + 2; index++) {
            const file = await RxWorldBackups.backup(world, "auto");
            created.push(file);
            // Копии делаются в одну секунду — разводим их по времени, старые раньше
            const time = new Date(Date.now() - (100 - index) * 60000);
            fs.utimesSync(file, time, time);
        }
        RxWorldBackups.prune(world);
        const list = RxWorldBackups.list(world);
        assert.strictEqual(list.filter(item => item.reason === "auto").length, RxWorldBackups.KEEP_AUTO);
        assert.ok(fs.existsSync(created[created.length - 1]), "the newest auto backup is kept");
        // Копия в ту же секунду, что и предыдущая, получает своё имя
        const first = await RxWorldBackups.backup(world, "manual");
        const second = await RxWorldBackups.backup(world, "manual");
        assert.ok(first !== second && fs.existsSync(first) && fs.existsSync(second), "backups made in the same second must not overwrite each other");
        assert.ok(list.some(item => item.reason === "manual"), "manual backups are never pruned");

        // После игры копируются только миры, в которые заходили
        const untouched = makeWorld("Старый", "old");
        const old = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(path.join(untouched, "level.dat"), old, old);
        const startedAt = Date.now() - 1000;
        fs.utimesSync(path.join(world, "level.dat"), new Date(), new Date());
        assert.strictEqual(await RxWorldBackups.afterGame(gameData, startedAt), 1);
        assert.strictEqual(RxWorldBackups.list(untouched).length, 0);

        assert.strictEqual(RxWorldBackups.remove(path.join(tempRoot, "outside.zip")), false, "files outside backups must not be deleted");
        console.log("World backups tests passed");
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        fs.rmSync(tempRoot, {recursive: true, force: true});
    }
})();
