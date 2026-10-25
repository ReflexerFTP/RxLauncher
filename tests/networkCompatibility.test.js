const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const beginMarker = "// === Network compatibility service: begin ===";
const endMarker = "// === Network compatibility service: end ===";
const begin = appSource.indexOf(beginMarker);
const end = appSource.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, "network service markers must exist in app.js");
const serviceSource = appSource.slice(begin, end + endMarker.length);

const makeResponse = (status) => ({status, ok: status >= 200 && status < 300});

const createService = (fetchImpl) => {
    const logs = [];
    const context = vm.createContext({
        fetch: fetchImpl,
        AbortSignal,
        Date,
        console: {log: (message) => logs.push(String(message))},
        pjson: {version: "test"}
    });
    vm.runInContext(`${serviceSource}\n;globalThis.checkOfficialNetworkConnectivity = checkOfficialNetworkConnectivity;`, context, {
        filename: "app-network-service.js"
    });
    return {check: context.checkOfficialNetworkConnectivity, logs};
};

(async () => {
    const requests = [];
    const service = createService(async (url, options) => {
        requests.push({url, options});
        if (url.includes("authserver")) return makeResponse(401);
        if (url.includes("sessionserver")) throw new Error("offline provider");
        return makeResponse(404);
    });

    const result = await service.check();
    assert.strictEqual(result.reachable, true, "an HTTP error still proves connectivity");
    assert.strictEqual(result.reachableCount, 2);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.checks.length, 3);
    assert.ok(requests.every((request) => request.options.signal), "all probes must have a timeout signal");
    assert.ok(service.logs.some((line) => line.includes("count=2/3")));

    const offline = createService(async () => {
        throw new Error("network unavailable");
    });
    const offlineResult = await offline.check(250);
    assert.strictEqual(offlineResult.reachable, false);
    assert.strictEqual(offlineResult.reachableCount, 0);
    assert.strictEqual(offlineResult.total, 3);

    assert.ok(!appSource.includes("froglauncher.fix"), "authentication endpoint spoofing must not be copied");
    console.log("networkCompatibility.test.js: all tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
