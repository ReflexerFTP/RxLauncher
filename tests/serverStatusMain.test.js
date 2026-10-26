const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.join(__dirname, "..", "app.js");
const BEGIN_MARKER = "// === Minecraft server status service: begin ===";
const END_MARKER = "// === Minecraft server status service: end ===";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

const source = fs.readFileSync(APP_PATH, "utf8");
const begin = source.indexOf(BEGIN_MARKER);
const end = source.indexOf(END_MARKER);
assert(begin >= 0 && end > begin, "server status service markers must exist in app.js");
const serviceSource = source.slice(begin, end + END_MARKER.length);

const createHeaders = (values = {}) => {
    const normalized = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)])
    );
    return {get: (name) => normalized[String(name).toLowerCase()] ?? null};
};

const jsonResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: createHeaders({"content-type": "application/json"}),
    json: async () => data,
    arrayBuffer: async () => Buffer.from(JSON.stringify(data))
});

const pngResponse = (bytes = PNG_BYTES, contentType = "image/png") => ({
    ok: true,
    status: 200,
    headers: createHeaders({"content-type": contentType, "content-length": bytes.length}),
    json: async () => { throw new Error("not json"); },
    arrayBuffer: async () => bytes
});

const createService = ({fetchImpl, gameDigQuery} = {}) => {
    const logs = [];
    const warnings = [];
    const directCalls = [];
    const context = {
        pjson: {version: "test"},
        fetch: fetchImpl,
        AbortSignal,
        Buffer,
        Date,
        console: {
            log: message => logs.push(String(message)),
            warn: message => warnings.push(String(message))
        },
        require: moduleName => {
            assert.strictEqual(moduleName, "gamedig");
            return {
                GameDig: {
                    query: async options => {
                        directCalls.push(options);
                        return gameDigQuery(options);
                    }
                }
            };
        }
    };
    vm.runInNewContext(`${serviceSource}\n;globalThis.__serverStatusTestHooks = {\n        normalizeMinecraftAddress,\n        normalizePrimaryServerStatus,\n        normalizeSecondaryServerStatus,\n        normalizeFallbackServerStatus,\n        fetchMinecraftServerIcon,\n        checkServerCatalogConnectivity,\n        queryMinecraftServerStatus,\n        clearCache: () => serverStatusCache.clear()\n    };`, context, {filename: APP_PATH});
    return {hooks: context.__serverStatusTestHooks, logs, warnings, directCalls};
};

const runMockTests = async () => {
    const requestedUrls = [];
    let directResult = null;
    const fetchImpl = async (rawUrl) => {
        const url = String(rawUrl);
        requestedUrls.push(url);
        if (url.includes("networkfail.example") && !url.includes("/icon/")) {
            throw new Error("simulated network failure");
        }
        if (url.includes("api.mcsrvstat.us/3/primary.example")) {
            return jsonResponse({
                online: true,
                players: {online: 42, max: 100},
                motd: {clean: ["§aPrimary", "MOTD"]},
                version: "1.21.4",
                icon: PNG_DATA_URI
            });
        }
        if (url.includes("api.mcsrvstat.us/3/")) return jsonResponse({online: false});
        if (url.includes("api.mcstatus.io") && url.includes("secondary.example")) {
            return jsonResponse({
                online: true,
                players: {online: 7, max: 50},
                motd: {clean: "Secondary MOTD"},
                version: {name_clean: "1.20-1.21"},
                icon: null
            });
        }
        if (url.includes("api.mcstatus.io")) return jsonResponse({online: false});
        if (url.includes("minecraftpinger.com")) return jsonResponse({message: "offline", server: null});
        if (url.includes("api.mcsrvstat.us/icon/")) return pngResponse();
        throw new Error(`Unexpected URL: ${url}`);
    };

    const service = createService({
        fetchImpl,
        gameDigQuery: async () => directResult
    });
    const {hooks, directCalls} = service;

    assert.strictEqual(hooks.normalizeMinecraftAddress(" Play.Example.Org:25565 "), "play.example.org:25565");
    assert.strictEqual(hooks.normalizeMinecraftAddress("https://bad.example"), "");
    assert.strictEqual(hooks.normalizeMinecraftAddress("bad host"), "");

    let result = await hooks.queryMinecraftServerStatus("primary.example", true);
    assert.strictEqual(result.online, true);
    assert.strictEqual(result.provider, "mcsrvstat.us");
    assert.deepStrictEqual({...result.players}, {online: 42, max: 100});
    assert.strictEqual(result.motd, "Primary\nMOTD");
    assert.strictEqual(result.icon, PNG_DATA_URI);
    assert.strictEqual(directCalls.length, 0, "direct query must not run for a successful HTTPS provider");

    result = await hooks.queryMinecraftServerStatus("secondary.example", true);
    assert.strictEqual(result.online, true);
    assert.strictEqual(result.provider, "mcstatus.io");
    assert.strictEqual(result.motd, "Secondary MOTD");
    assert.strictEqual(result.icon, PNG_DATA_URI, "missing provider icon must use the safe PNG endpoint");
    assert.strictEqual(directCalls.length, 0, "direct query must remain disabled by default");

    result = await hooks.queryMinecraftServerStatus("offline.example", true);
    assert.strictEqual(result.online, false);
    assert.strictEqual(result.reachable, true);
    assert.strictEqual(result.icon, PNG_DATA_URI, "offline status must still be able to show a PNG icon");
    assert.strictEqual(directCalls.length, 0, "offline HTTPS results must not implicitly reveal the client IP");

    result = await hooks.queryMinecraftServerStatus("networkfail.example", true);
    assert.strictEqual(result.online, false);
    assert.strictEqual(result.reachable, false, "an icon response must not masquerade as a working status provider");
    assert.strictEqual(result.icon, PNG_DATA_URI, "safe icon fallback may survive a status-provider outage");
    assert.strictEqual(directCalls.length, 0);

    directResult = {
        name: "§bDirect MOTD",
        numplayers: 9,
        maxplayers: 20,
        version: "1.21",
        ping: 31,
        raw: {vanilla: {raw: {favicon: PNG_DATA_URI}}}
    };
    result = await hooks.queryMinecraftServerStatus("direct.example", true, {allowDirect: true});
    assert.strictEqual(result.online, true);
    assert.strictEqual(result.provider, "direct-gamedig");
    assert.strictEqual(result.motd, "Direct MOTD");
    assert.strictEqual(result.ping, 31);
    assert.strictEqual(directCalls.length, 1, "allowDirect: true must enable exactly one direct query");
    assert.strictEqual(directCalls[0].host, "direct.example");

    const callsBeforeCacheCheck = requestedUrls.length;
    await hooks.queryMinecraftServerStatus("primary.example", true, {allowDirect: false});
    const callsAfterForcedQuery = requestedUrls.length;
    await hooks.queryMinecraftServerStatus("primary.example", false, {allowDirect: false});
    assert(callsAfterForcedQuery > callsBeforeCacheCheck);
    assert.strictEqual(requestedUrls.length, callsAfterForcedQuery, "non-forced query must reuse the cached status");

    assert.match(source, /handleTrusted\("server-status-query", \(_event, address, force = false, options = \{\}\)/);
    assert.match(source, /queryMinecraftServerStatus\(address, force === true, options\)/);
    assert.match(source, /handleTrusted\("server-catalog-connectivity", \(\) => checkServerCatalogConnectivity\(\)\)/);

    const fastProbeService = createService({
        fetchImpl: async url => {
            if (String(url).includes("mcsrvstat.us")) return jsonResponse({error: "busy"}, 503);
            return new Promise(() => {});
        },
        gameDigQuery: async () => { throw new Error("direct query is not expected"); }
    });
    let startedAt = Date.now();
    assert.strictEqual(await fastProbeService.hooks.checkServerCatalogConnectivity(500), true);
    assert(Date.now() - startedAt < 200, "any HTTP response must unlock the catalog without waiting for slower probes");

    const failedProbeService = createService({
        fetchImpl: async () => { throw new Error("simulated offline"); },
        gameDigQuery: async () => { throw new Error("direct query is not expected"); }
    });
    startedAt = Date.now();
    assert.strictEqual(await failedProbeService.hooks.checkServerCatalogConnectivity(500), false);
    assert(Date.now() - startedAt < 200, "connectivity errors must resolve to false instead of rejecting IPC");

    const timedOutProbeService = createService({
        fetchImpl: async (_url, options = {}) => new Promise((resolve, reject) => {
            const signal = options.signal;
            const rejectOnAbort = () => reject(new Error("simulated timeout"));
            if (signal?.aborted) rejectOnAbort();
            else signal?.addEventListener("abort", rejectOnAbort, {once: true});
        }),
        gameDigQuery: async () => { throw new Error("direct query is not expected"); }
    });
    startedAt = Date.now();
    assert.strictEqual(await timedOutProbeService.hooks.checkServerCatalogConnectivity(250), false);
    const timeoutDuration = Date.now() - startedAt;
    assert(timeoutDuration >= 200 && timeoutDuration < 800, `connectivity timeout must be bounded, got ${timeoutDuration}ms`);
};

const runLiveSmoke = async () => {
    if (process.env.RX_SERVER_STATUS_LIVE !== "1") return;
    const service = createService({
        fetchImpl: global.fetch,
        gameDigQuery: options => require("gamedig").GameDig.query(options)
    });
    const connectivityStartedAt = Date.now();
    assert.strictEqual(await service.hooks.checkServerCatalogConnectivity(), true);
    const connectivityDuration = Date.now() - connectivityStartedAt;
    assert(connectivityDuration < 4000, `live connectivity probe took too long: ${connectivityDuration}ms`);
    const address = process.env.RX_SERVER_STATUS_LIVE_ADDRESS || "play.funtime.su";
    const result = await service.hooks.queryMinecraftServerStatus(address, true);
    assert.strictEqual(result.reachable, true, "live HTTPS status endpoint must be reachable");
    assert.strictEqual(result.address, address);
    assert.strictEqual(typeof result.online, "boolean");
    if (result.online) {
        assert(result.players.online >= 0);
        assert(result.motd.length > 0, "online live result must include MOTD");
        assert(result.icon.startsWith("data:image/png;base64,"), "online live result must include a PNG data URI");
    }
    console.log(`Live server status: ${JSON.stringify({address, connectivityDuration, provider: result.provider, online: result.online, players: result.players, motd: Boolean(result.motd), icon: Boolean(result.icon)})}`);
};

(async () => {
    const keepAlive = setInterval(() => {}, 1000);
    try {
    await runMockTests();
    await runLiveSmoke();
    console.log("Server status main-process tests passed");
    } finally {
        clearInterval(keepAlive);
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
