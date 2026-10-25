const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

// Временная папка игры: Fabric и чистая vanilla установлены, одна vanilla-папка недокачана
const gameData = fs.mkdtempSync(path.join(os.tmpdir(), "rx-offline-"));
const writeJson = (file, data) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(data));
};
writeJson(path.join(gameData, "versions", "fabric-1.21.4", "fabric-1.21.4.json"), {id: "fabric-1.21.4"});
writeJson(path.join(gameData, "versions", "fabric-1.21.4", "1.21.4.json"), {id: "1.21.4", javaVersion: {majorVersion: 21}});
writeJson(path.join(gameData, "versions", "1.20.1", "1.20.1.json"), {id: "1.20.1", javaVersion: {majorVersion: 17}});
fs.mkdirSync(path.join(gameData, "versions", "1.19.2"), {recursive: true});
fs.mkdirSync(path.join(gameData, "versions", "OptiFine"), {recursive: true});
writeJson(path.join(gameData, "home", "quilt-1.20.4", "versions", "quilt-1.20.4", "quilt-1.20.4.json"), {id: "quilt-1.20.4"});

const configStore = {};
const context = vm.createContext({
    console, fs, os, path, performance,
    require,
    GAME_DATA: gameData,
    MESSAGES: {commons: {version: "Версия"}},
    RxCollector: {writeLog: () => {}},
    RxPacks: {getPacksList: () => []},
    RxConfig: {
        read: (key, fallback) => (key in configStore ? configStore[key] : fallback),
        write: (key, value) => { configStore[key] = value; return true; }
    },
    RxVersionsUI: {getVersionsTypeSelected: () => ["release"]},
    RxUtils: {promiseWithTimeout: (promise) => promise},
    // Сеть недоступна: все онлайн-запросы падают
    vanilla: {getVersionManifest: () => Promise.reject(new Error("ENOTFOUND"))},
    fabric: {listSupportedVersions: () => Promise.reject(new Error("ENOTFOUND"))},
    forge: {listSupportedVersions: () => Promise.reject(new Error("ENOTFOUND"))},
    neoforge: {listSupportedVersions: () => Promise.reject(new Error("ENOTFOUND"))},
    quilt: {listSupportedVersions: () => Promise.reject(new Error("ENOTFOUND"))}
});
const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxVersionsManager.js"), "utf8");
vm.runInContext(`${source}\nthis.RxVersionsManager = RxVersionsManager;`, context, {filename: "RxVersionsManager.js"});
const customSource = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxCustomVersions.js"), "utf8");
vm.runInContext(`${customSource}\nthis.RxCustomVersions = RxCustomVersions;`, context, {filename: "RxCustomVersions.js"});
const manager = context.RxVersionsManager;
const custom = context.RxCustomVersions;
manager.getOptiFineVersionsAvailable = () => Promise.reject(new Error("ENOTFOUND"));

(async () => {
    // 1. Без сети и без кэша в списке — только установленные версии
    const offlineList = await manager.getPreparedVersions();
    assert.deepStrictEqual([...offlineList.map((item) => item.id)],["fabric-1.21.4", "quilt-1.20.4", "vanilla-1.20.1"]);
    assert.ok(offlineList.every((item) => item.installed));
    assert.strictEqual(manager.lastListOffline, true);

    // 2. Java подбирается по локальному манифесту, в т.ч. из папки загрузчика
    assert.strictEqual((await manager.getVersionManifest("1.21.4")).javaVersion.majorVersion, 21);
    assert.strictEqual((await manager.getVersionManifest("1.20.1")).javaVersion.majorVersion, 17);

    // 3. Удачный онлайн-список сохраняется и используется, когда сеть снова пропала
    const online = manager.mergeWithVersionsCache({vanilla: ["1.21.4", "1.21.3"], fabric: ["1.21.4"], forge: [], neoforge: [], quilt: [], forgeOptiFine: []});
    assert.strictEqual(online.offline, false);
    const fromCache = manager.mergeWithVersionsCache({vanilla: [], fabric: [], forge: [], neoforge: [], quilt: [], forgeOptiFine: []});
    assert.deepStrictEqual([...fromCache.versions.vanilla], ["1.21.4", "1.21.3"]);
    assert.strictEqual(fromCache.offline, true);

    const cachedList = await manager.getPreparedVersions();
    const ids = cachedList.map((item) => item.id);
    assert.ok(ids.includes("vanilla-1.21.3") && ids.includes("fabric-1.21.4") && ids.includes("vanilla-1.20.1"));
    assert.strictEqual(new Set(ids).size, ids.length, "no duplicates");
    assert.strictEqual(cachedList.find((item) => item.id === "fabric-1.21.4").installed, true);
    assert.strictEqual(cachedList.find((item) => item.id === "vanilla-1.21.3").installed, false);

    // 4. Своя версия из папки (как после установщика OptiFine)
    const sources = fs.mkdtempSync(path.join(os.tmpdir(), "rx-custom-src-"));
    const optiDir = path.join(sources, "1.21.4-OptiFine_HD_U_J3");
    writeJson(path.join(optiDir, "1.21.4-OptiFine_HD_U_J3.json"), {id: "1.21.4-OptiFine_HD_U_J3", inheritsFrom: "1.21.4", mainClass: "net.minecraft.launchwrapper.Launch", libraries: []});
    fs.writeFileSync(path.join(optiDir, "1.21.4-OptiFine_HD_U_J3.jar"), "jar");
    const imported = await custom.importFrom(optiDir);
    assert.deepStrictEqual({...imported}, {ok: true, name: "1.21.4-OptiFine_HD_U_J3"});
    const optiTarget = path.join(gameData, "versions", "1.21.4-OptiFine_HD_U_J3");
    assert.ok(fs.existsSync(path.join(optiTarget, "1.21.4-OptiFine_HD_U_J3.jar")));
    // Базовый манифест скопирован рядом — для запуска офлайн
    assert.ok(fs.existsSync(path.join(optiTarget, "1.21.4.json")));
    assert.strictEqual((await custom.importFrom(optiDir)).error, "exists");

    // 5. Отдельный .json с jar рядом, имя со странными символами
    const looseDir = path.join(sources, "downloads");
    writeJson(path.join(looseDir, "My Client.json"), {id: "My Client!", mainClass: "net.minecraft.client.main.Main", libraries: [], type: "release"});
    fs.writeFileSync(path.join(looseDir, "My Client.jar"), "jar");
    fs.writeFileSync(path.join(looseDir, "unrelated.txt"), "junk");
    const loose = await custom.importFrom(path.join(looseDir, "My Client.json"));
    assert.strictEqual(loose.name, "My_Client");
    assert.ok(fs.existsSync(path.join(gameData, "versions", "My_Client", "My_Client.jar")));
    assert.ok(!fs.existsSync(path.join(gameData, "versions", "My_Client", "unrelated.txt")));

    // 6. Папка без манифеста и неподходящий файл
    fs.mkdirSync(path.join(sources, "empty"));
    assert.strictEqual((await custom.importFrom(path.join(sources, "empty"))).error, "noManifest");
    assert.strictEqual((await custom.importFrom(path.join(looseDir, "unrelated.txt"))).error, "unsupported");

    // 7. Установка Fabric официальным установщиком определяется как своя без импорта
    writeJson(path.join(gameData, "versions", "fabric-loader-0.16.9-1.21.4", "fabric-loader-0.16.9-1.21.4.json"), {id: "fabric-loader-0.16.9-1.21.4", inheritsFrom: "1.21.4", mainClass: "x", libraries: []});

    const customEntries = manager.getInstalledVersionEntries().filter((item) => item.type === "custom");
    assert.deepStrictEqual([...customEntries.map((item) => item.id)].sort(),["custom-1.21.4-OptiFine_HD_U_J3", "custom-My_Client", "custom-fabric-loader-0.16.9-1.21.4"]);
    assert.strictEqual(customEntries.find((item) => item.id === "custom-1.21.4-OptiFine_HD_U_J3").version, "1.21.4");
    assert.strictEqual(custom.getInfo("1.21.4-OptiFine_HD_U_J3").baseVersion, "1.21.4");
    // Обычные установки не путаются со своими
    assert.ok(manager.getInstalledVersionEntries().some((item) => item.id === "fabric-1.21.4"));
    assert.ok(manager.getInstalledVersionEntries().some((item) => item.id === "vanilla-1.20.1"));

    fs.rmSync(sources, {recursive: true, force: true});
    fs.rmSync(gameData, {recursive: true, force: true});
    console.log("Offline versions tests passed");
})().catch((error) => {
    fs.rmSync(gameData, {recursive: true, force: true});
    console.error(error);
    process.exit(1);
});
