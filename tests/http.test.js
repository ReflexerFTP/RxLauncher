// RxHttp и параллельная загрузка RxDownloader.downloadMany на локальном HTTP-сервере
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-http-test-"));
const sha1 = data => crypto.createHash("sha1").update(data).digest("hex");
const payload = crypto.randomBytes(200 * 1024);
const hits = {};
const logs = [];

const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    if (url.pathname === "/json") {
        response.writeHead(200, {"Content-Type": "application/json", "Content-Encoding": "gzip"});
        return response.end(zlib.gzipSync(JSON.stringify({ok: true, ua: request.headers["user-agent"]})));
    }
    if (url.pathname === "/redirect") {
        response.writeHead(302, {Location: "/json"});
        return response.end();
    }
    if (url.pathname === "/loop") {
        response.writeHead(302, {Location: "/loop"});
        return response.end();
    }
    if (url.pathname === "/echo" && request.method === "POST") {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        return request.on("end", () => {
            response.writeHead(200, {"Content-Type": "application/json"});
            response.end(Buffer.concat(chunks));
        });
    }
    if (url.pathname === "/missing") {
        response.writeHead(404);
        return response.end("nope");
    }
    if (url.pathname.startsWith("/file")) {
        // /file-flaky отвечает ошибкой на первую попытку
        if (url.pathname === "/file-flaky" && hits[url.pathname] === 1) {
            response.writeHead(503);
            return response.end();
        }
        response.writeHead(200, {"Content-Length": payload.length});
        return response.end(payload);
    }
    if (url.pathname === "/slow") {
        response.writeHead(200, {"Content-Length": payload.length});
        response.write(payload.subarray(0, 1024));
        return; // висит, пока клиент не отменит
    }
    response.writeHead(500);
    response.end();
});

const context = vm.createContext({
    console, Buffer, URL, AbortController, setTimeout, clearTimeout, require, fs, path, crypto,
    LAUNCHER_VERSION: "test", SITE_URL: "https://rxlauncher.ru",
    MESSAGES: {commons: {downloading: "Downloading", plsWait: "wait"}, starter: {sec: "s", min: "m", remaining: "{0} left"}, units: {size1: ["kB", "MB"], size2: ["KiB", "MiB", "GiB"]}},
    RxCollector: {writeLog: message => logs.push(message)},
    RxFlyout: {setProgress: () => true, setText: () => true, changeMode: async () => true},
    RxUtils: {humanFileSize: bytes => `${bytes} B`}
});
for (const file of ["RxHttp.js", "RxDownloader.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", file), "utf8");
    vm.runInContext(`${source}\nthis.${path.parse(file).name} = ${path.parse(file).name};`, context, {filename: file});
}
const {RxHttp, RxDownloader} = context;

server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const json = await RxHttp.json(`${base}/json`);
        assert.strictEqual(json.ok, true, "gzip JSON must be decoded");
        assert.ok(json.ua.startsWith("MaxRx/RxLauncher/test"), "User-Agent must identify the launcher");

        const redirected = await RxHttp.text(`${base}/redirect`);
        assert.strictEqual(redirected.url, `${base}/json`, "final URL must be reported after redirects");
        await assert.rejects(RxHttp.text(`${base}/loop`), /Too many redirects/);

        assert.strictEqual(JSON.stringify(await RxHttp.json(`${base}/echo`, {method: "POST", body: {hashes: ["a"]}})), '{"hashes":["a"]}');
        await assert.rejects(RxHttp.json(`${base}/missing`), error => error.status === 404);

        const target = path.join(tempRoot, "mods", "a.jar");
        let progress = 0;
        await RxHttp.download(`${base}/file`, target, {hashes: {sha1: sha1(payload)}, onProgress: bytes => { progress = bytes; }});
        assert.ok(payload.equals(fs.readFileSync(target)), "downloaded file must match");
        assert.strictEqual(progress, payload.length);
        assert.strictEqual(await RxHttp.isFileValid(target, {sha1: sha1(payload)}), true);
        assert.strictEqual(await RxHttp.isFileValid(target, {sha1: "0".repeat(40)}), false);

        const bad = path.join(tempRoot, "mods", "bad.jar");
        await assert.rejects(RxHttp.download(`${base}/file`, bad, {hashes: {sha1: "0".repeat(40)}}), /Checksum mismatch/);
        assert.ok(!fs.existsSync(bad) && !fs.existsSync(`${bad}.rxdownload`), "a file with the wrong hash must not stay on disk");

        const controller = new AbortController();
        const slowTarget = path.join(tempRoot, "slow.bin");
        const slow = RxHttp.download(`${base}/slow`, slowTarget, {signal: controller.signal});
        setTimeout(() => controller.abort(), 150);
        await assert.rejects(slow);
        assert.ok(!fs.existsSync(`${slowTarget}.rxdownload`), "an aborted download must clean up");

        // Параллельная загрузка: повтор после 503, общий результат
        const items = ["one", "two", "flaky"].map(name => ({
            url: `${base}/file${name === "flaky" ? "-flaky" : `?${name}`}`,
            path: path.join(tempRoot, "pack", `${name}.jar`),
            hashes: {sha1: sha1(payload)},
            size: payload.length,
            displayName: name
        }));
        assert.strictEqual(await RxDownloader.downloadMany(items, "Pack", 2), true);
        assert.ok(items.every(item => fs.existsSync(item.path)), "all pack files must be downloaded");
        assert.strictEqual(hits["/file-flaky"], 2, "a temporary error must be retried");

        // 404 не повторяется и роняет всю загрузку с именем файла
        const before = hits["/missing"];
        await assert.rejects(RxDownloader.downloadMany([{url: `${base}/missing`, path: path.join(tempRoot, "pack", "x.jar"), displayName: "x"}], "Pack"),
            error => error.file === "x");
        assert.strictEqual(hits["/missing"] - before, 1, "HTTP 404 must not be retried");

        console.log("HTTP tests passed");
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        server.close();
        fs.rmSync(tempRoot, {recursive: true, force: true});
    }
});
