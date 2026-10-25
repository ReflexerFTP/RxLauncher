const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const {
    PROFILE_LOOKUP_BASE,
    SESSION_PROFILE_BASE,
    TEXTURE_ORIGIN,
    createMinecraftSkinService,
    normalizeNickname,
    validatePng,
    validateTextureUrl
} = require("../minecraftSkinService");

const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
    const typeBuffer = Buffer.from(type, "ascii");
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    typeBuffer.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return result;
};

const createPng = (width = 64, height = 64, color = [30, 120, 220, 255]) => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = [];
    for (let row = 0; row < height; row++) {
        const scanline = Buffer.alloc(1 + width * 4);
        scanline[0] = 0;
        for (let pixel = 0; pixel < width; pixel++) {
            const offset = 1 + pixel * 4;
            scanline[offset] = (color[0] + pixel) & 0xff;
            scanline[offset + 1] = (color[1] + row) & 0xff;
            scanline[offset + 2] = color[2];
            scanline[offset + 3] = color[3];
        }
        rows.push(scanline);
    }
    return Buffer.concat([
        signature,
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
};

const mockResponse = (url, status, body, contentType) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
    const headers = new Map([
        ["content-length", String(buffer.length)],
        ["content-type", contentType]
    ]);
    return {
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: {get: name => headers.get(String(name).toLowerCase()) || null},
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
};

const createMockFetch = (routes) => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({url: String(url), options});
        const route = routes.get(String(url));
        if (route instanceof Error) throw route;
        if (typeof route === "function") return route(String(url), options);
        if (!route) throw new Error(`Unexpected mock request: ${url}`);
        return route;
    };
    fetchImpl.calls = calls;
    return fetchImpl;
};

const textureSession = (profileId, nickname, textureUrl, model = "default") => {
    const skin = {url: textureUrl};
    if (model === "slim") skin.metadata = {model: "slim"};
    const payload = {
        timestamp: 1700000000000,
        profileId,
        profileName: nickname,
        textures: {SKIN: skin}
    };
    return {
        id: profileId,
        name: nickname,
        properties: [{
            name: "textures",
            value: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
            signature: "deterministic-test-signature"
        }]
    };
};

const jsonResponse = (url, value, status = 200) => mockResponse(
    url,
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8"
);

(async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-minecraft-skins-test-"));
    try {
        assert.strictEqual(normalizeNickname(" Notch "), "Notch");
        assert.throws(() => normalizeNickname("../Notch"), error => error.code === "invalid_nickname");
        assert.throws(() => normalizeNickname("x"), error => error.code === "invalid_nickname");
        assert.throws(() => normalizeNickname("кириллица"), error => error.code === "invalid_nickname");

        const modernPng = createPng(64, 64);
        const legacyPng = createPng(64, 32, [220, 80, 30, 255]);
        assert.deepStrictEqual(validatePng(modernPng), {width: 64, height: 64, size: modernPng.length});
        assert.deepStrictEqual(validatePng(legacyPng), {width: 64, height: 32, size: legacyPng.length});
        assert.throws(() => validatePng(Buffer.from("not a png")), error => error.code === "invalid_png");
        assert.throws(() => validatePng(createPng(32, 32)), error => error.code === "invalid_png");

        const profileId = "069a79f444e94726a5befca90e38aaf5";
        const textureHash = crypto.createHash("sha256").update(modernPng).digest("hex");
        const lookupUrl = `${PROFILE_LOOKUP_BASE}Notch`;
        const sessionUrl = `${SESSION_PROFILE_BASE}${profileId}?unsigned=false`;
        const httpTextureUrl = `http://textures.minecraft.net/texture/${textureHash}`;
        const httpsTextureUrl = `${TEXTURE_ORIGIN}/texture/${textureHash}`;
        const trustedTexture = validateTextureUrl(httpTextureUrl);
        assert.strictEqual(trustedTexture.url, httpsTextureUrl, "trusted Mojang texture HTTP URLs must be upgraded to HTTPS");
        assert.strictEqual(trustedTexture.textureHash, textureHash);
        assert.throws(
            () => validateTextureUrl(`https://evil.example/texture/${textureHash}`),
            error => error.code === "untrusted_texture_url"
        );
        assert.throws(
            () => validateTextureUrl(`${TEXTURE_ORIGIN}/texture/${textureHash}?redirect=evil.example`),
            error => error.code === "untrusted_texture_url"
        );

        const routes = new Map([
            [lookupUrl, jsonResponse(lookupUrl, {id: profileId, name: "Notch"})],
            [sessionUrl, jsonResponse(sessionUrl, textureSession(profileId, "Notch", httpTextureUrl, "slim"))],
            [httpsTextureUrl, mockResponse(httpsTextureUrl, 200, modernPng, "image/png")]
        ]);
        const fetchImpl = createMockFetch(routes);
        let nowValue = 1700000000000;
        const service = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "cache"),
            fetchImpl,
            now: () => nowValue,
            cacheTtlMs: 60000
        });

        const found = await service.lookupSkin("Notch", {forceRefresh: true});
        assert.strictEqual(found.ok, true);
        assert.strictEqual(found.nickname, "Notch");
        assert.strictEqual(found.profileId, profileId);
        assert.strictEqual(found.model, "slim");
        assert.strictEqual(found.signed, true);
        assert.strictEqual(found.textureHash, textureHash);
        assert.strictEqual(found.sha256, textureHash);
        assert.strictEqual(found.width, 64);
        assert.strictEqual(found.height, 64);
        assert.strictEqual(found.source, "network");
        assert.strictEqual(found.stale, false);
        assert.ok(fs.existsSync(found.texturePath));
        assert.deepStrictEqual(fs.readFileSync(found.texturePath), modernPng);
        assert.deepStrictEqual(fetchImpl.calls.map(call => call.url), [lookupUrl, sessionUrl, httpsTextureUrl]);
        assert.ok(fetchImpl.calls.every(call => call.options.redirect === "manual"));
        assert.ok(fetchImpl.calls.every(call => call.options.signal instanceof AbortSignal));

        const callsBeforeFreshCache = fetchImpl.calls.length;
        nowValue += 1000;
        const freshCached = await service.lookupSkin("Notch");
        assert.strictEqual(freshCached.source, "cache");
        assert.strictEqual(freshCached.stale, false);
        assert.strictEqual(fetchImpl.calls.length, callsBeforeFreshCache, "fresh cache must avoid network requests");

        const offlineFetch = createMockFetch(new Map([[lookupUrl, new Error("offline")]]));
        const offlineService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "cache"),
            fetchImpl: offlineFetch,
            now: () => nowValue + 120000,
            cacheTtlMs: 0
        });
        const staleCached = await offlineService.lookupSkin("Notch", {forceRefresh: true});
        assert.strictEqual(staleCached.source, "cache");
        assert.strictEqual(staleCached.stale, true);
        assert.strictEqual(staleCached.fallbackReason, "network_error");
        assert.strictEqual(staleCached.profileId, profileId);

        const noFallback = await offlineService.lookupSkinSafe("Notch", {
            forceRefresh: true,
            allowFallback: false
        });
        assert.strictEqual(noFallback.ok, false);
        assert.strictEqual(noFallback.error.code, "network_error");
        assert.strictEqual(noFallback.error.retryable, true);

        const missingLookupUrl = `${PROFILE_LOOKUP_BASE}Missing_Player`;
        const missingFetch = createMockFetch(new Map([
            [missingLookupUrl, jsonResponse(missingLookupUrl, {path: "/minecraft/profile/lookup/name/Missing_Player"}, 404)]
        ]));
        const missingService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "missing-cache"),
            fetchImpl: missingFetch
        });
        const missing = await missingService.lookupSkinSafe("Missing_Player");
        assert.strictEqual(missing.ok, false);
        assert.strictEqual(missing.error.code, "not_found");
        assert.strictEqual(missing.error.status, 404);

        const emptyLookupUrl = `${PROFILE_LOOKUP_BASE}Empty_Player`;
        const emptyService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "empty-cache"),
            fetchImpl: createMockFetch(new Map([
                [emptyLookupUrl, mockResponse(emptyLookupUrl, 204, Buffer.alloc(0), "application/json")]
            ]))
        });
        const empty = await emptyService.lookupSkinSafe("Empty_Player");
        assert.strictEqual(empty.ok, false);
        assert.strictEqual(empty.error.code, "not_found");
        assert.strictEqual(empty.error.status, 204);

        const evilLookupUrl = `${PROFILE_LOOKUP_BASE}BadHost`;
        const evilSessionUrl = `${SESSION_PROFILE_BASE}${profileId}?unsigned=false`;
        const evilRoutes = new Map([
            [evilLookupUrl, jsonResponse(evilLookupUrl, {id: profileId, name: "BadHost"})],
            [evilSessionUrl, jsonResponse(
                evilSessionUrl,
                textureSession(profileId, "BadHost", `https://evil.example/texture/${textureHash}`)
            )]
        ]);
        const evilService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "evil-cache"),
            fetchImpl: createMockFetch(evilRoutes)
        });
        const evil = await evilService.lookupSkinSafe("BadHost");
        assert.strictEqual(evil.ok, false);
        assert.strictEqual(evil.error.code, "untrusted_texture_url");

        const badPng = Buffer.from("not really a png", "utf8");
        const badHash = crypto.createHash("sha256").update(badPng).digest("hex");
        const badLookupUrl = `${PROFILE_LOOKUP_BASE}BadPng`;
        const badTextureUrl = `${TEXTURE_ORIGIN}/texture/${badHash}`;
        const badRoutes = new Map([
            [badLookupUrl, jsonResponse(badLookupUrl, {id: profileId, name: "BadPng"})],
            [sessionUrl, jsonResponse(sessionUrl, textureSession(profileId, "BadPng", badTextureUrl))],
            [badTextureUrl, mockResponse(badTextureUrl, 200, badPng, "image/png")]
        ]);
        const badService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "bad-cache"),
            fetchImpl: createMockFetch(badRoutes)
        });
        const invalidImage = await badService.lookupSkinSafe("BadPng");
        assert.strictEqual(invalidImage.ok, false);
        assert.strictEqual(invalidImage.error.code, "invalid_png");

        const otherPng = createPng(64, 64, [1, 2, 3, 255]);
        const mismatchLookupUrl = `${PROFILE_LOOKUP_BASE}Mismatch`;
        const mismatchRoutes = new Map([
            [mismatchLookupUrl, jsonResponse(mismatchLookupUrl, {id: profileId, name: "Mismatch"})],
            [sessionUrl, jsonResponse(sessionUrl, textureSession(profileId, "Mismatch", httpsTextureUrl))],
            [httpsTextureUrl, mockResponse(httpsTextureUrl, 200, otherPng, "image/png")]
        ]);
        const mismatchService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "mismatch-cache"),
            fetchImpl: createMockFetch(mismatchRoutes)
        });
        const mismatch = await mismatchService.lookupSkinSafe("Mismatch");
        assert.strictEqual(mismatch.ok, false);
        assert.strictEqual(mismatch.error.code, "hash_mismatch");

        const hugeLookupUrl = `${PROFILE_LOOKUP_BASE}HugeSkin`;
        const hugeRoutes = new Map([
            [hugeLookupUrl, jsonResponse(hugeLookupUrl, {id: profileId, name: "HugeSkin"})],
            [sessionUrl, jsonResponse(sessionUrl, textureSession(profileId, "HugeSkin", httpsTextureUrl))],
            [httpsTextureUrl, {
                ok: true,
                status: 200,
                url: httpsTextureUrl,
                headers: {get: name => String(name).toLowerCase() === "content-length" ? "4096" : "image/png"},
                arrayBuffer: async () => { throw new Error("oversized response body must not be read"); }
            }]
        ]);
        const hugeService = createMinecraftSkinService({
            cacheRoot: path.join(tempRoot, "huge-cache"),
            fetchImpl: createMockFetch(hugeRoutes),
            maxTextureBytes: 1024
        });
        const huge = await hugeService.lookupSkinSafe("HugeSkin");
        assert.strictEqual(huge.ok, false);
        assert.strictEqual(huge.error.code, "response_too_large");

        const exportPath = path.join(tempRoot, "Notch-skin.png");
        const exported = await service.exportTexture(textureHash, exportPath);
        assert.strictEqual(exported.ok, true);
        assert.strictEqual(exported.sha256, textureHash);
        assert.deepStrictEqual(fs.readFileSync(exportPath), modernPng);
        const exists = await service.exportTextureSafe(textureHash, exportPath);
        assert.strictEqual(exists.ok, false);
        assert.strictEqual(exists.error.code, "destination_exists");
        const overwritten = await service.exportTexture(textureHash, exportPath, {overwrite: true});
        assert.strictEqual(overwritten.ok, true);
        assert.deepStrictEqual(fs.readFileSync(exportPath), modernPng);
        const unsafeExport = await service.exportTextureSafe("../texture", path.join(tempRoot, "unsafe.png"));
        assert.strictEqual(unsafeExport.ok, false);
        assert.strictEqual(unsafeExport.error.code, "invalid_texture_hash");
        const cacheOverwrite = await service.exportTextureSafe(textureHash, found.texturePath, {overwrite: true});
        assert.strictEqual(cacheOverwrite.ok, false);
        assert.strictEqual(cacheOverwrite.error.code, "invalid_destination");
        const missingDirectoryExport = await service.exportTextureSafe(
            textureHash,
            path.join(tempRoot, "does-not-exist", "skin.png")
        );
        assert.strictEqual(missingDirectoryExport.ok, false);
        assert.strictEqual(missingDirectoryExport.error.code, "invalid_destination");

        const cached = service.getCachedSkin("notch");
        assert.strictEqual(cached.textureHash, textureHash);
        assert.strictEqual(cached.source, "cache");

        console.log("Minecraft skin service tests passed");
    } finally {
        fs.rmSync(tempRoot, {recursive: true, force: true});
    }
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
