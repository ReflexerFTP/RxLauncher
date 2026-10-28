// Регрессии по аудиту 3.10.0: токены не попадают в журнал (RX-06), загрузки сборок не ходят в локальную сеть (RX-03),
// размер файла ограничен заявленным и есть общий бюджет (RX-04), большие файлы импорта сравниваются по содержимому (RX-02),
// старые обработчики сборок не верят id/overrides из manifest.json и сохраняют версию загрузчика (LEGACY-01/02/03)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-audit-"));
const safety = require(path.join(root, "modrinthPackSafety.js"));
const logs = [];

const context = vm.createContext({
    console, Buffer, Date, Math, JSON, URL, Set, Map, Promise, Number, Array, String, setTimeout, clearTimeout,
    fs, path, os, crypto, fsPromises: fs.promises,
    require: name => name === "../modrinthPackSafety" ? safety : require(name),
    global: {LAST_LOG: ""},
    GAME_DATA: temp,
    LAUNCHER_VERSION: "test",
    SITE_URL: "https://rxlauncher.xyz",
    MESSAGES: {settings: {import: {}}, starter: {}},
    RxPrivacy: {maskIfParanoid: text => text, maskUserPaths: text => text},
    RxUtils: {humanFileSize: bytes => `${bytes} B`},
    RxPacks: {safety: () => safety}
});
context.globalThis = context;
const load = (file, name) => vm.runInContext(`${read(file)}\nthis.${name} = ${name};`, context, {filename: file});
load("web/js/RxCollector.js", "RxCollector");
context.RxCollector.writeLog = message => logs.push(context.RxCollector.redact(message));
load("web/js/RxHttp.js", "RxHttp");
load("web/js/RxImport.js", "RxImport");
load("web/js/RxCurseForge.js", "RxCurseForge");
context.RxDownloader = undefined;
load("web/js/RxDownloader.js", "RxDownloader");
const {RxCollector, RxHttp, RxImport, RxCurseForge, RxDownloader} = context;

(async () => {
    const server = http.createServer((request, response) => {
        response.writeHead(200, {"Content-Type": "application/octet-stream"});
        response.end(Buffer.alloc(128 * 1024, 7));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        // ---------- RX-06: секреты сессии не остаются в журнале ни под каким именем ----------
        const access = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
        const client = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
        RxCollector.addSecrets(access, client);
        const line = RxCollector.redact(`[MCLC]: Launching with arguments --username Steve --accessToken ${access} --clientId ${client} --xuid ${access} --session ${access} --uuid 1234`);
        assert.ok(!line.includes(access) && !line.includes(client), line);
        assert.ok(line.includes("--uuid 1234") && line.includes("--username Steve"), "non-secret arguments stay readable");
        // имя аргумента неизвестно — значение всё равно вырезается
        assert.ok(!RxCollector.redact(`token=${client}`).includes(client));
        // Ely.by отдаёт свои xuid/clientId, а не токены
        assert.match(read("web/js/RxElybyManager.js"), /meta: \{type: "mojang", xuid: "0", clientId: "0"\}/);
        assert.match(read("web/js/RxLaunchConfigurator.js"), /RxCollector\.addSecrets\(resultConfig\.authorization\.access_token, resultConfig\.authorization\.client_token\)/);
        // MCLC подставляет meta.xuid/meta.clientId, только если их нет — берёт токены (поэтому meta обязательна)
        const handler = fs.readFileSync(path.join(root, "node_modules/minecraft-launcher-core/components/handler.js"), "utf8");
        assert.match(handler, /'\$\{auth_xuid\}': this\.options\.authorization\.meta\.xuid \|\|/);

        // ---------- RX-03: DNS-имя, ведущее в локальную сеть, при загрузке сборки не открывается ----------
        assert.equal(safety.isLocalAddress("127.0.0.1"), true);
        assert.equal(safety.isLocalAddress("::ffff:127.0.0.1"), true);
        assert.equal(safety.isLocalAddress("192.168.1.10"), true);
        assert.equal(safety.isLocalAddress("1.1.1.1"), false);
        const blocked = await new Promise(resolve => safety.safeLookup("localhost", {}, error => resolve(error)));
        assert.equal(blocked?.code, "ELOCALADDRESS");
        // через RxHttp: с политикой URL (данные сборки) — отказ при соединении, без политики (наши запросы) — работает
        await assert.rejects(RxHttp.open(`http://localhost:${port}/file`, {urlPolicy: () => {}}), /local network/);
        const plain = await RxHttp.open(`http://localhost:${port}/file`, {});
        plain.stream.resume();
        assert.equal(plain.status, 200);

        // ---------- RX-04: заявленный размер — жёсткий предел, общий бюджет загрузки ----------
        await assert.rejects(RxHttp.download(`http://127.0.0.1:${port}/file`, path.join(temp, "dl", "one.bin"), {expectedSize: 1}), /size limit|Size mismatch/);
        assert.ok(!fs.existsSync(path.join(temp, "dl", "one.bin")), "oversized file is not kept");
        await assert.rejects(RxHttp.download(`http://127.0.0.1:${port}/file`, path.join(temp, "dl", "two.bin"), {expectedSize: 200 * 1024}), /Incomplete|Size mismatch/);
        const ok = await RxHttp.download(`http://127.0.0.1:${port}/file`, path.join(temp, "dl", "three.bin"), {expectedSize: 128 * 1024});
        assert.equal(ok.bytes, 128 * 1024);
        assert.throws(() => RxDownloader.assertBudget([1, 2, 3].map(i => ({path: path.join(temp, `big${i}`), size: 12 * 1024 ** 3}))), /too large/);
        assert.throws(() => RxDownloader.assertBudget([{path: path.join(temp, "neg"), size: -5}]), /Invalid download size/);
        assert.ok(RxDownloader.assertBudget([{path: path.join(temp, "small"), size: 1024}, {path: path.join(temp, "nosize")}]) >= 1024);
        assert.match(read("web/js/RxDownloader.js"), /expectedSize: size/);

        // ---------- RX-02: большие файлы одинакового размера сравниваются по содержимому ----------
        const big = 5 * 1024 * 1024;
        fs.writeFileSync(path.join(temp, "a.bin"), Buffer.alloc(big, 1));
        fs.writeFileSync(path.join(temp, "b.bin"), Buffer.alloc(big, 2));
        fs.writeFileSync(path.join(temp, "c.bin"), Buffer.alloc(big, 1));
        const tail = Buffer.alloc(big, 1);
        tail[big - 1] = 9;
        fs.writeFileSync(path.join(temp, "d.bin"), tail);
        assert.equal(await RxImport.sameFile(path.join(temp, "a.bin"), path.join(temp, "b.bin")), false);
        assert.equal(await RxImport.sameFile(path.join(temp, "a.bin"), path.join(temp, "d.bin")), false, "difference in the last byte is found");
        assert.equal(await RxImport.sameFile(path.join(temp, "a.bin"), path.join(temp, "c.bin")), true);

        // ---------- LEGACY-01: overrides CurseForge только внутри распакованного архива ----------
        const unpacked = path.join(temp, "cf", "unpacked");
        fs.mkdirSync(path.join(unpacked, "overrides", "config"), {recursive: true});
        fs.mkdirSync(path.join(temp, "cf", "private-fixture"), {recursive: true});
        assert.equal(RxCurseForge.safeOverridesDir(unpacked, undefined), fs.realpathSync(path.join(unpacked, "overrides")));
        assert.throws(() => RxCurseForge.safeOverridesDir(unpacked, "../private-fixture"), /Unsafe overrides/);
        assert.throws(() => RxCurseForge.safeOverridesDir(unpacked, "C:\\Windows"), /Unsafe overrides/);
        assert.equal(RxCurseForge.safeOverridesDir(unpacked, "missing-folder"), null);
        // ---------- LEGACY-02: точная версия загрузчика сохраняется ----------
        assert.equal(RxCurseForge.loaderVersion("forge-47.2.0", "forge"), "47.2.0");
        assert.equal(RxCurseForge.loaderVersion("neoforge-21.1.77", "neoforge"), "21.1.77");
        assert.equal(RxCurseForge.loaderVersion("fabric-0.16.9", "fabric"), "0.16.9");
        assert.equal(RxCurseForge.loaderVersion("forge", "forge"), "");
        assert.equal(RxCurseForge.loaderVersion("vanilla", "vanilla"), "");
        assert.match(read("web/js/RxCurseForge.js"), /\.\.\.\(loaderVersion \? \{loaderVersion\} : \{\}\)/);

        // ---------- LEGACY-03: id сборки — только проверенное имя папки, удаление — в корзину через главный процесс ----------
        const manager = read("web/js/RxPackManagerUI.js");
        assert.match(manager, /manifest = \{\.\.\.manifest, id: packId\}/);
        assert.match(manager, /if \(!RxPacks\.isSafePackId\(packId\)\) return false;/);
        assert.match(manager, /ipcRenderer\.invoke\("trash-instance-folder"/);
        assert.ok(!/fsExtra\.remove\(modpackPath/.test(manager), "no recursive delete by manifest id");
        assert.match(read("web/js/RxPacksUI.js"), /let packData = \{\.\.\.RxPacks\.getModpackManifest\(pack\), id: pack\}/);
        console.log("Audit fixes: OK");
    } finally {
        server.close();
        fs.rmSync(temp, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
