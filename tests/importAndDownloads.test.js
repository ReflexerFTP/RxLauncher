// Импорт из других лаунчеров (галочки, резервная копия, откат) и быстрая загрузка файлов игры (зеркало, правила библиотек)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-import-test-"));
const gameData = path.join(tempRoot, "rx");
const appData = path.join(tempRoot, "AppData", "Roaming");
const config = {};
const accounts = {};
const savedServers = [];
const logs = [];

const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
};

const context = vm.createContext({
    console, Buffer, Date, Math, JSON, URL, setTimeout, clearTimeout, Promise, fs, path, os, crypto,
    fsPromises: fs.promises,
    process: {env: {APPDATA: appData}, platform: "win32", arch: "x64"},
    GAME_DATA: gameData,
    MESSAGES: {settings: {import: {}}, starter: {}},
    RxConfig: {read: (key, fallback) => key in config ? config[key] : fallback, write: (key, value) => { config[key] = value; }},
    RxCollector: {writeLog: message => logs.push(message)},
    RxUtils: {humanFileSize: bytes => `${bytes} B`},
    RxAccountsManager: {
        getAccounts: () => JSON.parse(JSON.stringify(accounts)),
        saveAccounts: list => { Object.keys(accounts).forEach(key => delete accounts[key]); Object.assign(accounts, list); },
        deleteAccount: uuid => { if (!accounts[uuid]) return false; delete accounts[uuid]; return true; }
    },
    RxMinecraftServers: {
        CONFIG_KEY: "savedCatalogServers",
        resolveCurrentGameDirectory: () => gameData,
        normalizeServer: server => ({name: server.name || server.ip, ip: String(server.ip || server.address).toLowerCase()}),
        addressKey: address => String(address).toLowerCase(),
        getSavedServers: () => config.savedCatalogServers || [],
        isSaved: ip => (config.savedCatalogServers || []).some(server => server.ip === String(ip).toLowerCase()),
        add: server => {
            const list = config.savedCatalogServers || [];
            if (list.some(item => item.ip === server.ip)) return false;
            config.savedCatalogServers = [...list, server];
            return true;
        },
        syncForCurrentVersion: () => ({changed: false}),
        // servers.dat в тесте — JSON, разбор NBT проверяется в minecraftServers.test.js
        parseDocument: buffer => JSON.parse(buffer.toString()),
        getServersList: document => ({count: () => document.length, selectAt: index => ({select: key => ({getValue: () => document[index][key]})})})
    }
});
for (const file of ["RxImport.js", "RxGameFiles.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", file), "utf8");
    vm.runInContext(`${source}\nthis.${file.replace(".js", "")} = ${file.replace(".js", "")};`, context, {filename: file});
}
const {RxImport, RxGameFiles} = context;

(async () => {
    try {
        // --- Зеркало и правила библиотек ---------------------------------------------------------------------------
        assert.strictEqual(RxGameFiles.mirrorUrl("https://resources.download.minecraft.net/ab/abcdef"), "https://bmclapi2.bangbang93.com/assets/ab/abcdef");
        assert.strictEqual(RxGameFiles.mirrorUrl("https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar"),
            "https://bmclapi2.bangbang93.com/maven/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar");
        assert.strictEqual(RxGameFiles.mirrorUrl("https://maven.fabricmc.net/net/fabricmc/x.jar"), null, "unknown hosts have no mirror");
        assert.strictEqual(RxGameFiles.mirrorUrl("http://resources.download.minecraft.net/ab/x"), null, "only https is mirrored");
        const official = "https://resources.download.minecraft.net/ab/abc";
        assert.deepStrictEqual({...RxGameFiles.routes(official, "auto")}, {url: official, fallbackUrl: "https://bmclapi2.bangbang93.com/assets/ab/abc"});
        assert.deepStrictEqual({...RxGameFiles.routes(official, "mirror")}, {url: "https://bmclapi2.bangbang93.com/assets/ab/abc", fallbackUrl: official});
        assert.deepStrictEqual({...RxGameFiles.routes(official, "official")}, {url: official, fallbackUrl: null});
        config.downloadSource = "weird";
        assert.strictEqual(RxGameFiles.source(), "auto", "unknown setting falls back to auto");
        delete config.downloadSource;

        assert.strictEqual(RxGameFiles.libraryAllowed({}), true);
        assert.strictEqual(RxGameFiles.libraryAllowed({rules: [{action: "allow", os: {name: "osx"}}]}, "windows"), false);
        assert.strictEqual(RxGameFiles.libraryAllowed({rules: [{action: "allow"}, {action: "disallow", os: {name: "osx"}}]}, "windows"), true);
        assert.strictEqual(RxGameFiles.libraryAllowed({rules: [{action: "allow", os: {name: "windows", arch: "x86"}}]}, "windows", "x64"), false);
        assert.strictEqual(RxGameFiles.mavenPath("net.fabricmc:fabric-loader:0.16.9"), "net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar");
        assert.strictEqual(RxGameFiles.mavenPath("org.lwjgl:lwjgl:3.3.3:natives-windows"), "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar");
        assert.strictEqual(RxGameFiles.mavenPath("a:..:1"), null, "path traversal in maven names is rejected");

        const libRoot = path.join(gameData, "libraries");
        const libs = RxGameFiles.libraryItems([
            {name: "a:b:1", downloads: {artifact: {url: "https://libraries.minecraft.net/a/b/1/b-1.jar", path: "a/b/1/b-1.jar", sha1: "x", size: 5}}},
            {name: "evil", downloads: {artifact: {url: "https://libraries.minecraft.net/x.jar", path: "../../evil.jar"}}},
            {name: "mac:only:1", rules: [{action: "allow", os: {name: "osx"}}], downloads: {artifact: {url: "https://libraries.minecraft.net/m.jar", path: "m.jar"}}},
            {name: "net.fabricmc:fabric-loader:0.16.9", url: "https://maven.fabricmc.net"}
        ], libRoot, "auto");
        assert.strictEqual(libs.length, 2, "traversal and foreign-OS libraries are skipped");
        assert.strictEqual(libs[0].path, path.join(libRoot, "a", "b", "1", "b-1.jar"));
        assert.ok(libs[0].fallbackUrl.startsWith("https://bmclapi2.bangbang93.com/maven/"));
        assert.strictEqual(libs[1].url, "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar");
        assert.strictEqual(libs[1].fallbackUrl, null);

        // collect: недостающие ассеты и библиотеки, уже скачанные пропускаются
        const assetHash = "0".repeat(39) + "1", presentHash = "0".repeat(39) + "2";
        write(path.join(gameData, "assets", "objects", "00", presentHash), "12345");
        write(path.join(libRoot, "a", "b", "1", "b-1.jar"), "12345");
        context.RxVersionsManager = {getVersionManifest: async () => ({
            assetIndex: {url: "https://piston-meta.mojang.com/v1/packages/x/19.json", sha1: ""},
            libraries: [{name: "a:b:1", downloads: {artifact: {url: "https://libraries.minecraft.net/a/b/1/b-1.jar", path: "a/b/1/b-1.jar", size: 5}}},
                {name: "c:d:2", downloads: {artifact: {url: "https://libraries.minecraft.net/c/d/2/d-2.jar", path: "c/d/2/d-2.jar", size: 7}}}]
        })};
        const downloaded = [];
        context.RxHttp = {
            isFileValid: async file => fs.existsSync(file),
            download: async (url, file) => {
                downloaded.push(url);
                write(file, JSON.stringify({objects: {"a.ogg": {hash: assetHash, size: 3}, "b.ogg": {hash: presentHash, size: 5}, "c.ogg": {hash: assetHash, size: 3}}}));
            }
        };
        const items = await RxGameFiles.collect({version: {number: "1.21.4"}, root: gameData});
        assert.deepStrictEqual(downloaded, ["https://piston-meta.mojang.com/v1/packages/x/19.json"], "asset index is fetched once");
        assert.deepStrictEqual([...items.map(item => path.basename(item.path))].sort(), [assetHash, "d-2.jar"].sort(), "only missing files, without duplicates");
        assert.ok(fs.existsSync(path.join(gameData, "assets", "indexes", "1.21.4.json")));

        // --- Импорт: поиск Legacy Launcher и TLauncher ------------------------------------------------------------------
        const legacyGame = path.join(tempRoot, "LegacyGame");
        write(path.join(appData, ".tlauncher", "legacy", "Minecraft", "tl.properties"),
            `# Legacy\nminecraft.gamedir=${legacyGame.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`);
        write(path.join(legacyGame, "options.txt"), "fov:1.0\nlang:ru_ru\n");
        write(path.join(legacyGame, "optionsof.txt"), "ofFastRender:true\n");
        write(path.join(legacyGame, "saves", "Выживание", "level.dat"), "legacy-level");
        write(path.join(legacyGame, "saves", "Выживание", "region", "r.0.0.mca"), "legacy-region");
        write(path.join(legacyGame, "saves", "not-a-world", "readme.txt"), "x");
        write(path.join(legacyGame, "mods", "sodium.jar"), "sodium-new");
        write(path.join(legacyGame, "mods", "same.jar"), "same");
        write(path.join(legacyGame, "config", "sodium.json"), "{}");
        write(path.join(legacyGame, "assets", "objects", "00", presentHash), "OTHER");
        write(path.join(legacyGame, "assets", "objects", "11", "1".repeat(40)), "asset");
        write(path.join(legacyGame, "servers.dat"), JSON.stringify([{ip: "mc.example.org", name: "Example"}, {ip: "known.org", name: "Known"}]));
        write(path.join(legacyGame, "tlauncher_profiles.json"), JSON.stringify({userSet: {list: [{username: "Steve_RU", type: "plain"}, {username: "bad name!"}, {username: "Existing"}]}}));
        write(path.join(appData, ".minecraft", "TlauncherProfiles.json"), "{}");
        write(path.join(appData, ".minecraft", "options.txt"), "fov:0.5\n");

        const props = RxImport.readProperties(path.join(appData, ".tlauncher", "legacy", "Minecraft", "tl.properties"));
        assert.strictEqual(props["minecraft.gamedir"], legacyGame, ".properties escapes are decoded");
        const sources = RxImport.detectSources();
        assert.deepStrictEqual([...sources.map(source => source.name)], ["Legacy Launcher", "TLauncher"]);
        assert.strictEqual(sources[0].path, path.resolve(legacyGame));

        // Цель: в ней уже есть свои настройки и мир с тем же именем
        write(path.join(gameData, "options.txt"), "fov:0.0\n");
        write(path.join(gameData, "saves", "Выживание", "level.dat"), "own-level");
        write(path.join(gameData, "mods", "sodium.jar"), "sodium-old");
        write(path.join(gameData, "mods", "same.jar"), "same");
        accounts.own = {type: "local", nickname: "Existing", uuid: "own"};
        config.savedCatalogServers = [{name: "Known", ip: "known.org"}];

        const scan = await RxImport.scan(sources[0].path);
        assert.strictEqual(scan.options.count, 2);
        assert.strictEqual(scan.saves.count, 1, "folders without level.dat are not worlds");
        assert.strictEqual(scan.mods.count, 2);
        assert.strictEqual(scan.shaderpacks.count, 0);
        assert.strictEqual(scan.cache.count, 1, "already downloaded cache files are not counted");
        assert.deepStrictEqual([...scan.servers.items.map(server => server.ip)], ["mc.example.org"]);
        assert.deepStrictEqual([...scan.accounts.items], ["Steve_RU"], "existing and invalid nicknames are skipped");

        // --- Импорт с резервной копией ------------------------------------------------------------------------------
        const progress = [];
        const stats = await RxImport.run(sources[0], ["options", "saves", "mods", "config", "servers", "accounts", "cache"],
            {backup: true, onProgress: (copied, total) => progress.push([copied, total])});
        assert.strictEqual(stats.failed, 0);
        assert.ok(stats.backupId, "backup id is returned");
        assert.ok(progress.length && progress.at(-1)[0] === progress.at(-1)[1], "progress reaches 100%");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "options.txt"), "utf8"), "fov:1.0\nlang:ru_ru\n");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "saves", "Выживание", "level.dat"), "utf8"), "own-level", "own world is never overwritten");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "saves", "Выживание (импорт)", "level.dat"), "utf8"), "legacy-level");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "mods", "sodium.jar"), "utf8"), "sodium-new");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "assets", "objects", "00", presentHash), "utf8"), "12345", "cache never replaces files");
        assert.ok(fs.existsSync(path.join(gameData, "assets", "objects", "11", "1".repeat(40))));
        assert.ok(config.savedCatalogServers.some(server => server.ip === "mc.example.org"));
        assert.ok(Object.values(accounts).some(account => account.nickname === "Steve_RU" && account.type === "local"));

        const backups = RxImport.listBackups();
        assert.strictEqual(backups.length, 1);
        const manifest = backups[0];
        assert.deepStrictEqual([...manifest.parts.options.overwritten], ["options.txt"]);
        assert.deepStrictEqual([...manifest.parts.options.added], ["optionsof.txt"]);
        assert.ok(!manifest.parts.cache, "cache is not part of the backup");
        assert.ok(!manifest.parts.mods.added?.includes(path.join("mods", "same.jar")) && !manifest.parts.mods.overwritten?.includes(path.join("mods", "same.jar")),
            "identical files are skipped and not recorded");

        // --- Откат по галочкам: сначала только настройки и миры, потом остальное ------------------------------------------
        await RxImport.restore(manifest.id, ["options", "saves"]);
        assert.strictEqual(fs.readFileSync(path.join(gameData, "options.txt"), "utf8"), "fov:0.0\n", "replaced file comes back");
        assert.ok(!fs.existsSync(path.join(gameData, "optionsof.txt")), "added file is removed");
        assert.ok(!fs.existsSync(path.join(gameData, "saves", "Выживание (импорт)")), "imported world is removed");
        assert.ok(fs.existsSync(path.join(gameData, "saves", "Выживание", "level.dat")), "own world stays");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "mods", "sodium.jar"), "utf8"), "sodium-new", "unchecked parts stay imported");
        assert.deepStrictEqual([...RxImport.restorableParts(RxImport.readManifest(manifest.id))].sort(), ["accounts", "config", "mods", "servers"]);

        await RxImport.restore(manifest.id, ["mods", "config", "servers", "accounts"]);
        assert.strictEqual(fs.readFileSync(path.join(gameData, "mods", "sodium.jar"), "utf8"), "sodium-old");
        assert.strictEqual(fs.readFileSync(path.join(gameData, "mods", "same.jar"), "utf8"), "same", "untouched files stay");
        assert.ok(!fs.existsSync(path.join(gameData, "config", "sodium.json")));
        assert.deepStrictEqual([...config.savedCatalogServers.map(server => server.ip)], ["known.org"]);
        assert.deepStrictEqual(Object.values(accounts).map(account => account.nickname), ["Existing"]);
        assert.strictEqual(RxImport.restorableParts(RxImport.readManifest(manifest.id)).length, 0);

        // Подменённый манифест не может удалить файлы вне папки игры
        const outside = path.join(tempRoot, "outside.txt");
        write(outside, "keep");
        const evilDir = path.join(RxImport.backupRoot(), "evil");
        write(path.join(evilDir, "manifest.json"), JSON.stringify({version: 1, id: "evil", createdAt: 1, sourceName: "x", target: gameData,
            parts: {mods: {added: ["../outside.txt", path.join("..", "outside.txt"), outside]}}, restored: {}}));
        await RxImport.restore("evil", ["mods"]);
        assert.strictEqual(fs.readFileSync(outside, "utf8"), "keep");
        assert.strictEqual(RxImport.readManifest("../evil"), null, "backup ids cannot leave the backup folder");

        // Импорт без резервной копии не создаёт манифест; папка самого лаунчера как источник запрещена
        const noBackup = await RxImport.run(sources[1], ["options"], {backup: false});
        assert.strictEqual(noBackup.backupId, null);
        assert.strictEqual(RxImport.listBackups().length, 2);
        await assert.rejects(RxImport.run({name: "self", path: gameData}, ["options"]), /overlap/);
        assert.ok(!RxImport.detectSources().some(source => RxImport.samePath(source.path, gameData)));

        await RxImport.deleteBackup(manifest.id);
        assert.strictEqual(RxImport.listBackups().length, 1);
        // --- Загрузка: вторая попытка идёт через зеркало ----------------------------------------------------------------
        const queue = (download) => {
            const queueContext = vm.createContext({console, Date, Math, Promise, Set, Map, Error, AbortController, setTimeout, clearTimeout, path,
                RxHttp: {download}, RxCollector: {writeLog: () => {}}, RxUtils: {humanFileSize: String},
                RxFlyout: {setProgress: () => {}, setText: () => {}, changeMode: async () => {}}, MESSAGES: {commons: {}, starter: {remaining: "{0}"}}});
            vm.runInContext(`${fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxDownloader.js"), "utf8")}
this.RxDownloader = RxDownloader;`, queueContext);
            return queueContext.RxDownloader;
        };
        const item = {url: "https://primary.example/a", fallbackUrl: "https://mirror.example/a", path: path.join(tempRoot, "q", "a"), size: 1};
        let urls = [];
        await queue(async url => { urls.push(url); if (url.startsWith("https://primary")) throw Object.assign(new Error("missing"), {status: 404}); })
            .downloadMany([item], "x");
        assert.deepStrictEqual(urls, ["https://primary.example/a", "https://mirror.example/a"], "404 on Mojang falls back to the mirror");
        urls = [];
        await assert.rejects(queue(async url => { urls.push(url); throw Object.assign(new Error("missing"), {status: 404}); }).downloadMany([item], "x"));
        assert.strictEqual(urls.length, 2, "a file missing on both hosts is not retried further");
        urls = [];
        await assert.rejects(queue(async url => { urls.push(url); throw Object.assign(new Error("missing"), {status: 404}); })
            .downloadMany([{...item, fallbackUrl: null}], "x"));
        assert.strictEqual(urls.length, 1, "without a mirror a 404 is not retried");

        console.log("Import and fast downloads: OK");
    } finally {
        fs.rmSync(tempRoot, {recursive: true, force: true});
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
