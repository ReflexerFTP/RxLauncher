// Надёжность сборок и отката импорта:
//  - отключённый игроком мод (foo.jar -> foo.jar.disabled/.dis) не считается пропавшим и не качается заново;
//  - откат импорта восстанавливает файл атомарно: обрыв копирования не портит текущий файл игрока.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-reliability-"));
const sha1 = buffer => crypto.createHash("sha1").update(buffer).digest("hex");

// ---------- RxPacks.isIntentionallyDisabled ----------
const packsContext = vm.createContext({
    console, Buffer, Date, Math, JSON, Promise, Set, Map, crypto, fs, path,
    require: name => require(name === "../modrinthPackSafety" ? path.join(root, "modrinthPackSafety.js") : name),
    GAME_DATA: temp,
    RxHttp: {
        pickHash: hashes => {
            for (const algo of ["sha512", "sha256", "sha1", "md5"]) if (hashes?.[algo]) return {algorithm: algo, value: hashes[algo].toLowerCase()};
            return null;
        },
        hashFile: async (file, algo) => { try { return crypto.createHash(algo).update(fs.readFileSync(file)).digest("hex"); } catch { return null; } },
        isFileValid: async (file, hashes) => {
            try { if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) return false; } catch { return false; }
            const expected = packsContext.RxHttp.pickHash(hashes);
            if (!expected) return true;
            return (await packsContext.RxHttp.hashFile(file, expected.algorithm)) === expected.value;
        }
    },
    RxCollector: {writeLog() {}},
    RxConfig: {read: (_k, f) => f}
});
vm.runInContext(fs.readFileSync(path.join(root, "web/js/RxPacks.js"), "utf8") + "\nthis.RxPacks = RxPacks;", packsContext, {filename: "RxPacks.js"});
const {RxPacks} = packsContext;

(async () => {
    const modsDir = path.join(temp, "modpacks", "pack", "mods");
    fs.mkdirSync(modsDir, {recursive: true});
    const body = Buffer.from("fake mod jar content");
    const hashes = {sha1: sha1(body)};
    const jar = path.join(modsDir, "cool-mod.jar");

    // Включённый мод с верным хешем — валиден, ничего не отключено
    fs.writeFileSync(jar, body);
    assert.equal(await packsContext.RxHttp.isFileValid(jar, hashes), true);
    assert.equal(await RxPacks.isIntentionallyDisabled(jar, hashes), false);

    // Отключён как .disabled: исходного .jar нет, но рядом та же версия — не пропал
    fs.rmSync(jar);
    fs.writeFileSync(jar + ".disabled", body);
    assert.equal(await packsContext.RxHttp.isFileValid(jar, hashes), false, "disabled .jar is missing at its path");
    assert.equal(await RxPacks.isIntentionallyDisabled(jar, hashes), true, ".disabled copy means intentionally disabled");
    fs.rmSync(jar + ".disabled");

    // Отключён как .dis (старое окно сборок)
    fs.writeFileSync(jar + ".dis", body);
    assert.equal(await RxPacks.isIntentionallyDisabled(jar, hashes), true, ".dis copy counts too");
    fs.rmSync(jar + ".dis");

    // Чужая версия под .disabled — не считаем тем же модом, качаем заново
    fs.writeFileSync(jar + ".disabled", Buffer.from("a different version of the mod"));
    assert.equal(await RxPacks.isIntentionallyDisabled(jar, hashes), false, "a different disabled version does not match");
    fs.rmSync(jar + ".disabled");

    // Отключать можно только моды: тот же приём вне папки mods не действует
    const cfgDir = path.join(temp, "modpacks", "pack", "config");
    fs.mkdirSync(cfgDir, {recursive: true});
    const cfg = path.join(cfgDir, "settings.jar");
    fs.writeFileSync(cfg + ".disabled", body);
    assert.equal(await RxPacks.isIntentionallyDisabled(cfg, hashes), false, "only files inside mods/ can be disabled");

    // ---------- атомарность отката импорта ----------
    // Повторяем точную логику восстановления overwritten-файла: копия во временный файл + rename поверх.
    const fsPromises = fs.promises;
    const live = path.join(temp, "import", "options.txt");
    const savedCopy = path.join(temp, "import-backup", "options.txt");
    fs.mkdirSync(path.dirname(live), {recursive: true});
    fs.mkdirSync(path.dirname(savedCopy), {recursive: true});
    fs.writeFileSync(live, "current player data");
    fs.writeFileSync(savedCopy, "backed up original");

    const restoreOverwritten = async (saved, target) => {
        const tmp = `${target}.rx-restore-${crypto.randomUUID()}`;
        try {
            await fsPromises.copyFile(saved, tmp);
            await fsPromises.rename(tmp, target);
        } catch (error) {
            await fsPromises.rm(tmp, {force: true}).catch(() => {});
            throw error;
        }
    };

    // Успешное восстановление
    await restoreOverwritten(savedCopy, live);
    assert.equal(fs.readFileSync(live, "utf8"), "backed up original");

    // Обрыв копирования (нет исходного файла) не трогает текущий файл игрока и не оставляет мусора
    fs.writeFileSync(live, "player edited this");
    await assert.rejects(restoreOverwritten(path.join(temp, "does-not-exist"), live));
    assert.equal(fs.readFileSync(live, "utf8"), "player edited this", "failed restore must not corrupt the live file");
    assert.deepEqual(fs.readdirSync(path.dirname(live)).filter(name => name.includes("rx-restore")), [], "no temp files left behind");

    // Исходный код действительно делает атомарную замену
    assert.match(fs.readFileSync(path.join(root, "web/js/RxImport.js"), "utf8"), /rx-restore-\$\{crypto\.randomUUID\(\)\}[\s\S]*?fsPromises\.rename\(temp, target\)/);
    assert.match(fs.readFileSync(path.join(root, "web/js/RxPacks.js"), "utf8"), /isIntentionallyDisabled\(filePath, item\.hashes/);

    fs.rmSync(temp, {recursive: true, force: true});
    console.log("Pack reliability: OK");
})().catch(error => { console.error(error); fs.rmSync(temp, {recursive: true, force: true}); process.exitCode = 1; });
