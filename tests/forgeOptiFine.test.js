const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const projectRoot = path.join(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-forge-of-test-"));
const launcherData = path.join(tempRoot, "launcher-data");
const logs = [];

let pageMode = "offline";
let downloadMode = "valid";
let downloadCalls = 0;

const indexHtml = `
    <h2>Minecraft 1.21.8</h2>
    <tr class='downloadLine downloadLinePreview'>
      <td class='colMirror'><a href='adloadx?f=preview_OptiFine_1.21.8_HD_U_J6_pre16.jar'>Mirror</a></td>
      <td class='colForge'>Forge 58.1.0</td>
    </tr>
    <h2>Minecraft 1.21.4</h2>
    <tr class='downloadLine downloadLineMain'>
      <td class='colMirror'><a href='adloadx?f=OptiFine_1.21.4_HD_U_J3.jar'>Mirror</a></td>
      <td class='colForge'>Forge N/A</td>
    </tr>
    <h2>Minecraft 1.20.1</h2>
    <tr class='downloadLine downloadLineMain'>
      <td class='colMirror'><a href='http://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I6.jar'>Mirror</a></td>
      <td class='colForge'>Forge 47.2.18</td>
    </tr>`;

const page = (url, body) => ({ok: true, status: 200, url, headers: {}, body});

const RxHttp = {
    text: async (url) => {
        if (pageMode === "offline") throw new Error("offline");
        if (url === "https://optifine.net/downloads") return page(url, indexHtml);

        const parsed = new URL(url);
        const file = parsed.searchParams.get("f");
        if (pageMode === "malicious") {
            return page(url, `<a href='https://evil.example/downloadx?f=${file}&x=0123456789abcdef'>Download</a>`);
        }

        return page(url, `
            <a href='https://evil.example/downloadx?f=${file}&x=0123456789abcdef'>Bad</a>
            <a href='downloadx?f=${file}&amp;x=0123456789abcdef0123456789abcdef'>Download</a>`);
    }
};

const context = vm.createContext({
    console,
    Buffer,
    URL,
    __dirname: projectRoot,
    fs,
    path,
    os,
    process,
    require,
    RxHttp,
    performance,
    setTimeout,
    clearTimeout,
    GAME_DATA: launcherData,
    LAUNCHER_VERSION: "test",
    SITE_URL: "https://rxlauncher.ru",
    RxCollector: {writeLog: (message) => logs.push(message)},
    RxUtils: {},
    RxDownloader: {
        downloadFile: async (_url, filePath) => {
            downloadCalls++;
            assert.ok(fs.existsSync(path.join(launcherData, "cache", "of")), "cache/of must exist before download");
            if (downloadMode === "throw") throw new Error("network failed");
            if (downloadMode === "invalid") {
                fs.writeFileSync(filePath, "not a jar", "utf8");
                return true;
            }

            const jar = Buffer.alloc(128 * 1024);
            jar[0] = 0x50;
            jar[1] = 0x4b;
            jar[2] = 0x03;
            jar[3] = 0x04;
            jar[jar.length - 22] = 0x50;
            jar[jar.length - 21] = 0x4b;
            jar[jar.length - 20] = 0x05;
            jar[jar.length - 19] = 0x06;
            fs.writeFileSync(filePath, jar);
            return true;
        }
    }
});
context.global = context;

const versionsSource = fs.readFileSync(path.join(projectRoot, "web", "js", "RxVersionsManager.js"), "utf8");
vm.runInContext(`${versionsSource}\nthis.RxVersionsManager = RxVersionsManager;`, context, {filename: "RxVersionsManager.js"});
const assetsSource = fs.readFileSync(path.join(projectRoot, "web", "js", "RxAssets.js"), "utf8");
vm.runInContext(`${assetsSource}\nthis.RxAssets = RxAssets;`, context, {filename: "RxAssets.js"});

const RxVersionsManager = context.RxVersionsManager;
const RxAssets = context.RxAssets;

(async () => {
    const fallbackManifest = await RxVersionsManager.getOptiFineManifest(true);
    assert.ok(Object.keys(fallbackManifest.optifine).length >= 30, "local fallback must provide a broad version list");
    assert.strictEqual(fallbackManifest.optifine["1.20.1"].file, "OptiFine_1.20.1_HD_U_I6.jar");
    assert.strictEqual(fallbackManifest.optifine["1.21.11"].forge, "61.0.8");

    const parsed = RxVersionsManager.parseOptiFineDownloadsPage(indexHtml);
    assert.deepStrictEqual(Object.keys(parsed), ["1.20.1"], "only stable Forge-compatible releases may be parsed");
    assert.strictEqual(parsed["1.20.1"].page, "https://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I6.jar");
    assert.strictEqual(RxVersionsManager.normalizeOptiFineEntry("1.20.1", {file: "../bad.jar"}), false);

    pageMode = "online";
    const onlineManifest = await RxVersionsManager.getOptiFineManifest(true);
    assert.strictEqual(onlineManifest.updatedFromOfficial, true);
    assert.ok(onlineManifest.optifine["1.21.11"], "official data must be merged with fallback data");

    const resolved = await RxVersionsManager.resolveOptiFineDownload("1.20.1");
    assert.ok(resolved.url.startsWith("https://optifine.net/downloadx?"), "download must stay on official HTTPS host");
    assert.strictEqual(new URL(resolved.url).searchParams.get("f"), resolved.file);

    pageMode = "malicious";
    assert.strictEqual(await RxVersionsManager.resolveOptiFineDownload("1.20.1"), false, "third-party download links must be rejected");
    pageMode = "online";

    const gameRoot = path.join(tempRoot, "game-success");
    assert.strictEqual(await RxAssets.setupOptiFine("1.20.1", gameRoot), true);
    const fileName = "OptiFine_1.20.1_HD_U_I6.jar";
    const cachePath = path.join(launcherData, "cache", "of", fileName);
    const modPath = path.join(gameRoot, "mods", fileName);
    assert.strictEqual(RxAssets.isValidOptiFineJar(cachePath), true);
    assert.strictEqual(RxAssets.isValidOptiFineJar(modPath), true);

    const cachedGameRoot = path.join(tempRoot, "game-from-cache");
    pageMode = "offline";
    const callsBeforeCacheCopy = downloadCalls;
    assert.strictEqual(await RxAssets.setupOptiFine("1.20.1", cachedGameRoot), true, "verified cache must work offline");
    assert.strictEqual(downloadCalls, callsBeforeCacheCopy, "cache hit must not start another download");

    pageMode = "online";
    downloadMode = "throw";
    assert.strictEqual(await RxAssets.setupOptiFine("1.21.4", path.join(tempRoot, "game-failed")), false, "download errors must return false");

    downloadMode = "invalid";
    assert.strictEqual(await RxAssets.setupOptiFine("1.19.2", path.join(tempRoot, "game-invalid")), false, "HTML or corrupt downloads must return false");
    assert.strictEqual(await RxAssets.setupOptiFine("9.99.9", path.join(tempRoot, "game-unknown")), false, "unknown versions must return false");

    assert.strictEqual(RxAssets.removeOptiFine("1.20.1", gameRoot), true);
    assert.strictEqual(fs.existsSync(modPath), false);

    fs.rmSync(tempRoot, {recursive: true, force: true});
    console.log("ForgeOptiFine tests passed");
})().catch((error) => {
    fs.rmSync(tempRoot, {recursive: true, force: true});
    console.error(error);
    process.exitCode = 1;
});
