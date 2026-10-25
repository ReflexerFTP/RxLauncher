const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {pathToFileURL} = require("url");

const PROFILE_LOOKUP_BASE = "https://api.minecraftservices.com/minecraft/profile/lookup/name/";
const SESSION_PROFILE_BASE = "https://sessionserver.mojang.com/session/minecraft/profile/";
const TEXTURE_ORIGIN = "https://textures.minecraft.net";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXTURE_BYTES = 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const PROFILE_CACHE_SCHEMA = 1;
const PROFILE_CACHE_MAX_BYTES = 32 * 1024;
const NICKNAME_REGEX = /^[A-Za-z0-9_]{2,16}$/;
const PROFILE_ID_REGEX = /^[a-f0-9]{32}$/;
const TEXTURE_HASH_REGEX = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class MinecraftSkinError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? {cause: options.cause} : undefined);
        this.name = "MinecraftSkinError";
        this.code = String(code || "unknown_error");
        this.status = Number.isFinite(Number(options.status)) ? Number(options.status) : 0;
        this.retryable = options.retryable === true;
    }

    toPublicJSON() {
        return {
            code: this.code,
            message: this.message,
            status: this.status,
            retryable: this.retryable
        };
    }
}

const normalizeNickname = (value) => {
    const nickname = typeof value === "string" ? value.trim() : "";
    if (!NICKNAME_REGEX.test(nickname)) {
        throw new MinecraftSkinError(
            "invalid_nickname",
            "Nickname must contain 2-16 Latin letters, digits or underscores"
        );
    }
    return nickname;
};

const normalizeProfileId = (value) => {
    const profileId = String(value || "").trim().toLowerCase().replaceAll("-", "");
    if (!PROFILE_ID_REGEX.test(profileId)) {
        throw new MinecraftSkinError("invalid_profile", "Minecraft profile id is invalid");
    }
    return profileId;
};

const normalizeTextureHash = (value) => {
    const hash = String(value || "").trim().toLowerCase();
    if (!TEXTURE_HASH_REGEX.test(hash)) {
        throw new MinecraftSkinError("invalid_texture_hash", "Minecraft texture hash is invalid");
    }
    return hash;
};

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const isPowerOfTwo = (number) => Number.isInteger(number) && number > 0 && (number & (number - 1)) === 0;

const validatePng = (data, maxBytes = DEFAULT_MAX_TEXTURE_BYTES) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (buffer.length > maxBytes) {
        throw new MinecraftSkinError("response_too_large", "Skin texture exceeds the allowed size");
    }
    if (buffer.length < 45 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new MinecraftSkinError("invalid_png", "Skin texture is not a PNG file");
    }

    let offset = PNG_SIGNATURE.length;
    let width = 0;
    let height = 0;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;

    while (offset < buffer.length) {
        if (offset + 12 > buffer.length) {
            throw new MinecraftSkinError("invalid_png", "PNG chunk header is truncated");
        }

        const chunkLength = buffer.readUInt32BE(offset);
        const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + chunkLength;
        const chunkEnd = dataEnd + 4;
        if (!/^[A-Za-z]{4}$/.test(chunkType) || dataEnd < dataStart || chunkEnd > buffer.length) {
            throw new MinecraftSkinError("invalid_png", "PNG chunk is malformed");
        }

        if (!sawHeader) {
            if (chunkType !== "IHDR" || chunkLength !== 13) {
                throw new MinecraftSkinError("invalid_png", "PNG must start with a valid IHDR chunk");
            }
            width = buffer.readUInt32BE(dataStart);
            height = buffer.readUInt32BE(dataStart + 4);
            const bitDepth = buffer[dataStart + 8];
            const colorType = buffer[dataStart + 9];
            const compression = buffer[dataStart + 10];
            const filter = buffer[dataStart + 11];
            const interlace = buffer[dataStart + 12];
            if (![1, 2, 4, 8, 16].includes(bitDepth)
                || ![0, 2, 3, 4, 6].includes(colorType)
                || compression !== 0
                || filter !== 0
                || ![0, 1].includes(interlace)) {
                throw new MinecraftSkinError("invalid_png", "PNG IHDR contains unsupported values");
            }
            sawHeader = true;
        } else if (chunkType === "IHDR") {
            throw new MinecraftSkinError("invalid_png", "PNG contains more than one IHDR chunk");
        }

        if (chunkType === "IDAT") sawImageData = true;
        if (chunkType === "IEND") {
            if (chunkLength !== 0 || chunkEnd !== buffer.length) {
                throw new MinecraftSkinError("invalid_png", "PNG IEND chunk is malformed");
            }
            sawEnd = true;
            break;
        }
        offset = chunkEnd;
    }

    const validGeometry = width >= 64
        && width <= 1024
        && height >= 32
        && height <= 1024
        && isPowerOfTwo(width)
        && isPowerOfTwo(height)
        && (width === height || width === height * 2);
    if (!sawHeader || !sawImageData || !sawEnd || !validGeometry) {
        throw new MinecraftSkinError("invalid_png", "PNG dimensions are not compatible with a Minecraft skin");
    }

    return {width, height, size: buffer.length};
};

const decodeBase64Json = (value) => {
    const encoded = typeof value === "string" ? value.replace(/\s+/g, "") : "";
    if (!encoded || encoded.length > DEFAULT_MAX_JSON_BYTES * 2 || encoded.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        throw new MinecraftSkinError("invalid_response", "Session texture property is not valid base64");
    }

    let decoded;
    try {
        decoded = Buffer.from(encoded, "base64");
    } catch (error) {
        throw new MinecraftSkinError("invalid_response", "Session texture property cannot be decoded", {cause: error});
    }
    if (decoded.length === 0 || decoded.length > DEFAULT_MAX_JSON_BYTES) {
        throw new MinecraftSkinError("response_too_large", "Session texture property is too large");
    }

    try {
        return JSON.parse(decoded.toString("utf8"));
    } catch (error) {
        throw new MinecraftSkinError("invalid_response", "Session texture property is not valid JSON", {cause: error});
    }
};

const parseTextureProperty = (session, expectedProfileId = "") => {
    if (!session || typeof session !== "object" || Array.isArray(session)) {
        throw new MinecraftSkinError("invalid_response", "Session profile response is invalid");
    }
    const sessionProfileId = normalizeProfileId(session.id);
    if (expectedProfileId && sessionProfileId !== normalizeProfileId(expectedProfileId)) {
        throw new MinecraftSkinError("invalid_response", "Session profile id does not match the lookup response");
    }
    if (!Array.isArray(session.properties) || session.properties.length > 32) {
        throw new MinecraftSkinError("invalid_response", "Session profile properties are invalid");
    }

    const textureProperty = session.properties.find(property => (
        property && property.name === "textures" && typeof property.value === "string"
    ));
    if (!textureProperty) {
        throw new MinecraftSkinError("skin_not_set", "This Minecraft profile has no skin texture");
    }

    const payload = decodeBase64Json(textureProperty.value);
    if (payload.profileId && normalizeProfileId(payload.profileId) !== sessionProfileId) {
        throw new MinecraftSkinError("invalid_response", "Texture payload profile id does not match");
    }
    const skin = payload?.textures?.SKIN;
    if (!skin || typeof skin.url !== "string") {
        throw new MinecraftSkinError("skin_not_set", "This Minecraft profile has no skin texture");
    }

    return {
        profileId: sessionProfileId,
        profileName: typeof session.name === "string" ? session.name : "",
        textureUrl: skin.url,
        model: skin?.metadata?.model === "slim" ? "slim" : "default",
        signed: typeof textureProperty.signature === "string" && textureProperty.signature.length > 0
    };
};

const validateTextureUrl = (value) => {
    let parsed;
    try {
        parsed = new URL(String(value || ""));
    } catch (error) {
        throw new MinecraftSkinError("untrusted_texture_url", "Minecraft texture URL is invalid", {cause: error});
    }

    if (!(["http:", "https:"].includes(parsed.protocol))
        || parsed.hostname.toLowerCase() !== "textures.minecraft.net"
        || parsed.port
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash) {
        throw new MinecraftSkinError("untrusted_texture_url", "Minecraft texture URL is not trusted");
    }
    const pathMatch = parsed.pathname.match(/^\/texture\/([a-f0-9]{64})$/i);
    if (!pathMatch) {
        throw new MinecraftSkinError("untrusted_texture_url", "Minecraft texture URL path is invalid");
    }

    const textureHash = pathMatch[1].toLowerCase();
    return {
        url: `${TEXTURE_ORIGIN}/texture/${textureHash}`,
        textureHash
    };
};

const responseHeader = (response, name) => {
    if (!response?.headers || typeof response.headers.get !== "function") return "";
    return String(response.headers.get(name) || "");
};

const readResponseBuffer = async (response, maxBytes) => {
    const contentLengthText = responseHeader(response, "content-length").trim();
    if (contentLengthText) {
        const contentLength = Number(contentLengthText);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
            throw new MinecraftSkinError("response_too_large", "Remote response exceeds the allowed size");
        }
    }

    if (response?.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                total += chunk.length;
                if (total > maxBytes) {
                    if (typeof reader.cancel === "function") await reader.cancel();
                    throw new MinecraftSkinError("response_too_large", "Remote response exceeds the allowed size");
                }
                chunks.push(chunk);
            }
        } finally {
            if (typeof reader.releaseLock === "function") reader.releaseLock();
        }
        return Buffer.concat(chunks, total);
    }

    if (!response || typeof response.arrayBuffer !== "function") {
        throw new MinecraftSkinError("invalid_response", "Remote response body is unavailable");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
        throw new MinecraftSkinError("response_too_large", "Remote response exceeds the allowed size");
    }
    return buffer;
};

const classifyHttpError = (status) => {
    if (status === 404 || status === 204) {
        return new MinecraftSkinError("not_found", "Minecraft profile was not found", {status});
    }
    if (status === 429) {
        return new MinecraftSkinError("rate_limited", "Minecraft services rate limit was reached", {
            status,
            retryable: true
        });
    }
    if (status >= 500) {
        return new MinecraftSkinError("service_unavailable", "Minecraft services are temporarily unavailable", {
            status,
            retryable: true
        });
    }
    return new MinecraftSkinError("http_error", `Minecraft service returned HTTP ${status}`, {
        status,
        retryable: status === 408
    });
};

const publicError = (error) => {
    if (error instanceof MinecraftSkinError) return error;
    return new MinecraftSkinError("unknown_error", "Unexpected Minecraft skin service error", {cause: error});
};

const isPathInside = (parentPath, childPath) => {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const createMinecraftSkinService = (options = {}) => {
    if (typeof options.fetchImpl !== "function" && typeof globalThis.fetch !== "function") {
        throw new TypeError("A Fetch-compatible implementation is required");
    }
    if (typeof options.cacheRoot !== "string" || options.cacheRoot.trim() === "") {
        throw new TypeError("cacheRoot must be a non-empty path");
    }

    const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    const cacheRoot = path.resolve(options.cacheRoot);
    const textureDirectory = path.join(cacheRoot, "textures");
    const profileDirectory = path.join(cacheRoot, "profiles");
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.min(30000, Math.max(250, Math.round(Number(options.timeoutMs))))
        : DEFAULT_TIMEOUT_MS;
    const maxJsonBytes = Number.isFinite(Number(options.maxJsonBytes))
        ? Math.min(1024 * 1024, Math.max(1024, Math.round(Number(options.maxJsonBytes))))
        : DEFAULT_MAX_JSON_BYTES;
    const maxTextureBytes = Number.isFinite(Number(options.maxTextureBytes))
        ? Math.min(8 * 1024 * 1024, Math.max(1024, Math.round(Number(options.maxTextureBytes))))
        : DEFAULT_MAX_TEXTURE_BYTES;
    const cacheTtlMs = Number.isFinite(Number(options.cacheTtlMs))
        ? Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(Number(options.cacheTtlMs))))
        : DEFAULT_CACHE_TTL_MS;
    const now = typeof options.now === "function" ? options.now : Date.now;
    const userAgent = typeof options.userAgent === "string" && options.userAgent.trim()
        ? options.userAgent.trim().slice(0, 256)
        : "MaxRx/RxLauncher (https://rxlauncher.xyz)";

    const texturePath = (textureHash) => path.join(textureDirectory, `${normalizeTextureHash(textureHash)}.png`);
    const profilePath = (nickname) => {
        const normalized = normalizeNickname(nickname).toLocaleLowerCase("en-US");
        return path.join(profileDirectory, `${sha256(normalized)}.json`);
    };

    const atomicWrite = (targetPath, data) => {
        fs.mkdirSync(path.dirname(targetPath), {recursive: true});
        const temporaryPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.part`
        );
        try {
            fs.writeFileSync(temporaryPath, data, {flag: "wx"});
            try {
                fs.renameSync(temporaryPath, targetPath);
            } catch (error) {
                if (!["EEXIST", "EPERM"].includes(error?.code) || !fs.existsSync(targetPath)) throw error;
                fs.unlinkSync(targetPath);
                fs.renameSync(temporaryPath, targetPath);
            }
        } finally {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
    };

    const fetchResponse = async (url, expectedOrigin, accept) => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        let response;
        try {
            response = await fetchImpl(url, {
                method: "GET",
                redirect: "manual",
                headers: {Accept: accept, "User-Agent": userAgent},
                signal: controller.signal
            });
        } catch (error) {
            if (timedOut) {
                throw new MinecraftSkinError("timeout", "Minecraft service request timed out", {
                    retryable: true,
                    cause: error
                });
            }
            throw new MinecraftSkinError("network_error", "Could not connect to Minecraft services", {
                retryable: true,
                cause: error
            });
        } finally {
            clearTimeout(timer);
        }

        const status = Number(response?.status) || 0;
        if (status >= 300 && status < 400) {
            throw new MinecraftSkinError("untrusted_redirect", "Minecraft service returned an unexpected redirect", {
                status
            });
        }
        if (status === 204) throw classifyHttpError(status);
        if (!response || response.ok !== true) throw classifyHttpError(status);

        if (response.url) {
            let finalUrl;
            try {
                finalUrl = new URL(response.url);
            } catch (error) {
                throw new MinecraftSkinError("invalid_response", "Minecraft service response URL is invalid", {cause: error});
            }
            if (finalUrl.origin !== expectedOrigin) {
                throw new MinecraftSkinError("untrusted_redirect", "Minecraft service response came from an untrusted host");
            }
        }
        return response;
    };

    const fetchJson = async (url, expectedOrigin) => {
        const response = await fetchResponse(url, expectedOrigin, "application/json");
        const contentType = responseHeader(response, "content-type").toLowerCase();
        if (contentType && !contentType.includes("json")) {
            throw new MinecraftSkinError("invalid_response", "Minecraft service returned a non-JSON response");
        }
        const buffer = await readResponseBuffer(response, maxJsonBytes);
        try {
            return JSON.parse(buffer.toString("utf8"));
        } catch (error) {
            throw new MinecraftSkinError("invalid_response", "Minecraft service returned invalid JSON", {cause: error});
        }
    };

    const fetchTexture = async (trustedTexture) => {
        const response = await fetchResponse(trustedTexture.url, TEXTURE_ORIGIN, "image/png");
        const contentType = responseHeader(response, "content-type").toLowerCase();
        if (contentType && !contentType.includes("image/png") && !contentType.includes("application/octet-stream")) {
            throw new MinecraftSkinError("invalid_png", "Minecraft texture response is not a PNG image");
        }
        const buffer = await readResponseBuffer(response, maxTextureBytes);
        const dimensions = validatePng(buffer, maxTextureBytes);
        const digest = sha256(buffer);
        if (digest !== trustedTexture.textureHash) {
            throw new MinecraftSkinError("hash_mismatch", "Minecraft texture hash does not match its URL");
        }
        return {buffer, digest, ...dimensions};
    };

    const readTexture = (textureHash) => {
        const normalizedHash = normalizeTextureHash(textureHash);
        const filePath = texturePath(normalizedHash);
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxTextureBytes) {
            throw new MinecraftSkinError("invalid_cache", "Cached skin texture is invalid");
        }
        const buffer = fs.readFileSync(filePath);
        const dimensions = validatePng(buffer, maxTextureBytes);
        const digest = sha256(buffer);
        if (digest !== normalizedHash) {
            throw new MinecraftSkinError("invalid_cache", "Cached skin texture hash does not match");
        }
        return {filePath, buffer, digest, ...dimensions};
    };

    const readCachedProfile = (nickname) => {
        const normalized = normalizeNickname(nickname);
        const metadataPath = profilePath(normalized);
        try {
            const stat = fs.statSync(metadataPath);
            if (!stat.isFile() || stat.size <= 0 || stat.size > PROFILE_CACHE_MAX_BYTES) return null;
            const record = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
            if (!record || record.schema !== PROFILE_CACHE_SCHEMA
                || String(record.query || "").toLocaleLowerCase("en-US") !== normalized.toLocaleLowerCase("en-US")) {
                return null;
            }

            const canonicalName = normalizeNickname(record.nickname);
            const profileId = normalizeProfileId(record.profileId);
            const textureHash = normalizeTextureHash(record.textureHash);
            const texture = readTexture(textureHash);
            const cachedAt = Number(record.cachedAt);
            if (!Number.isFinite(cachedAt) || cachedAt <= 0 || record.sha256 !== texture.digest) return null;

            return {
                ok: true,
                query: normalized,
                nickname: canonicalName,
                profileId,
                model: record.model === "slim" ? "slim" : "default",
                signed: record.signed === true,
                textureHash,
                sha256: texture.digest,
                width: texture.width,
                height: texture.height,
                size: texture.size,
                texturePath: texture.filePath,
                textureFileUrl: pathToFileURL(texture.filePath).href,
                cachedAt,
                source: "cache",
                stale: false
            };
        } catch (_) {
            return null;
        }
    };

    const writeProfileRecord = (query, data) => {
        const record = {
            schema: PROFILE_CACHE_SCHEMA,
            query: normalizeNickname(query).toLocaleLowerCase("en-US"),
            nickname: normalizeNickname(data.nickname),
            profileId: normalizeProfileId(data.profileId),
            model: data.model === "slim" ? "slim" : "default",
            signed: data.signed === true,
            textureHash: normalizeTextureHash(data.textureHash),
            sha256: normalizeTextureHash(data.sha256),
            cachedAt: Number(data.cachedAt)
        };
        atomicWrite(profilePath(query), `${JSON.stringify(record, null, 2)}\n`);
    };

    const saveTexture = (textureHash, downloaded) => {
        const filePath = texturePath(textureHash);
        try {
            const cached = readTexture(textureHash);
            return {...cached, cached: true};
        } catch (_) {
            atomicWrite(filePath, downloaded.buffer);
            const saved = readTexture(textureHash);
            return {...saved, cached: false};
        }
    };

    const shouldUseFallback = (error) => ![
        "invalid_nickname",
        "not_found",
        "skin_not_set",
        "aborted"
    ].includes(error?.code);

    const lookupSkin = async (nickname, lookupOptions = {}) => {
        const query = normalizeNickname(nickname);
        const forceRefresh = lookupOptions.forceRefresh === true;
        const allowFallback = lookupOptions.allowFallback !== false;
        const cachedBeforeRequest = readCachedProfile(query);
        const requestTime = Number(now());

        if (!forceRefresh && cachedBeforeRequest && cacheTtlMs > 0
            && requestTime - cachedBeforeRequest.cachedAt >= 0
            && requestTime - cachedBeforeRequest.cachedAt <= cacheTtlMs) {
            return {...cachedBeforeRequest, stale: false};
        }

        let resolvedProfileId = "";
        try {
            const lookupUrl = PROFILE_LOOKUP_BASE + encodeURIComponent(query);
            const profile = await fetchJson(lookupUrl, new URL(PROFILE_LOOKUP_BASE).origin);
            if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
                throw new MinecraftSkinError("invalid_response", "Minecraft profile lookup response is invalid");
            }
            let canonicalName;
            try {
                canonicalName = normalizeNickname(profile.name);
            } catch (error) {
                throw new MinecraftSkinError("invalid_response", "Minecraft profile name is invalid", {cause: error});
            }
            resolvedProfileId = normalizeProfileId(profile.id);

            const sessionUrl = `${SESSION_PROFILE_BASE}${resolvedProfileId}?unsigned=false`;
            const session = await fetchJson(sessionUrl, new URL(SESSION_PROFILE_BASE).origin);
            const textureProperty = parseTextureProperty(session, resolvedProfileId);
            const trustedTexture = validateTextureUrl(textureProperty.textureUrl);
            const downloaded = await fetchTexture(trustedTexture);
            const saved = saveTexture(trustedTexture.textureHash, downloaded);
            const cachedAt = Number(now());
            const result = {
                ok: true,
                query,
                nickname: canonicalName,
                profileId: resolvedProfileId,
                model: textureProperty.model,
                signed: textureProperty.signed,
                textureHash: trustedTexture.textureHash,
                sha256: saved.digest,
                width: saved.width,
                height: saved.height,
                size: saved.size,
                texturePath: saved.filePath,
                textureFileUrl: pathToFileURL(saved.filePath).href,
                cachedAt,
                source: saved.cached ? "cache" : "network",
                stale: false
            };
            writeProfileRecord(query, result);
            if (canonicalName.toLocaleLowerCase("en-US") !== query.toLocaleLowerCase("en-US")) {
                writeProfileRecord(canonicalName, {...result, query: canonicalName});
            }
            return result;
        } catch (rawError) {
            const error = publicError(rawError);
            if (allowFallback && shouldUseFallback(error) && cachedBeforeRequest
                && (!resolvedProfileId || cachedBeforeRequest.profileId === resolvedProfileId)) {
                return {
                    ...cachedBeforeRequest,
                    stale: true,
                    fallbackReason: error.code
                };
            }
            throw error;
        }
    };

    const lookupSkinSafe = async (nickname, lookupOptions = {}) => {
        try {
            return await lookupSkin(nickname, lookupOptions);
        } catch (error) {
            return {ok: false, error: publicError(error).toPublicJSON()};
        }
    };

    const getCachedSkin = (nickname) => readCachedProfile(nickname);

    const exportTexture = async (textureHash, destinationPath, exportOptions = {}) => {
        const normalizedHash = normalizeTextureHash(textureHash);
        if (typeof destinationPath !== "string" || !path.isAbsolute(destinationPath)
            || path.extname(destinationPath).toLocaleLowerCase("en-US") !== ".png") {
            throw new MinecraftSkinError("invalid_destination", "Skin export destination must be an absolute PNG path");
        }

        const targetPath = path.resolve(destinationPath);
        if (isPathInside(cacheRoot, targetPath)) {
            throw new MinecraftSkinError("invalid_destination", "Skin cannot be exported over the service cache");
        }
        let parentStat;
        try {
            parentStat = fs.statSync(path.dirname(targetPath));
        } catch (error) {
            throw new MinecraftSkinError("invalid_destination", "Skin export directory does not exist", {cause: error});
        }
        if (!parentStat.isDirectory()) {
            throw new MinecraftSkinError("invalid_destination", "Skin export directory does not exist");
        }
        if (fs.existsSync(targetPath)) {
            const targetStat = fs.lstatSync(targetPath);
            if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
                throw new MinecraftSkinError("invalid_destination", "Skin export destination is not a regular file");
            }
            if (exportOptions.overwrite !== true) {
                throw new MinecraftSkinError("destination_exists", "Skin export destination already exists");
            }
        }

        let texture;
        try {
            texture = readTexture(normalizedHash);
        } catch (error) {
            throw new MinecraftSkinError("cache_miss", "Requested skin texture is not available in cache", {cause: error});
        }

        const temporaryPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.part`
        );
        try {
            fs.writeFileSync(temporaryPath, texture.buffer, {flag: "wx"});
            try {
                fs.renameSync(temporaryPath, targetPath);
            } catch (error) {
                if (exportOptions.overwrite !== true || !["EEXIST", "EPERM"].includes(error?.code)
                    || !fs.existsSync(targetPath)) throw error;
                const targetStat = fs.lstatSync(targetPath);
                if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
                    throw new MinecraftSkinError("invalid_destination", "Skin export destination is not a regular file");
                }
                fs.unlinkSync(targetPath);
                fs.renameSync(temporaryPath, targetPath);
            }
        } catch (error) {
            if (error instanceof MinecraftSkinError) throw error;
            throw new MinecraftSkinError("export_failed", "Could not export the skin texture", {cause: error});
        } finally {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }

        return {
            ok: true,
            path: targetPath,
            textureHash: normalizedHash,
            sha256: texture.digest,
            size: texture.size
        };
    };

    const exportTextureSafe = async (textureHash, destinationPath, exportOptions = {}) => {
        try {
            return await exportTexture(textureHash, destinationPath, exportOptions);
        } catch (error) {
            return {ok: false, error: publicError(error).toPublicJSON()};
        }
    };

    return Object.freeze({
        lookupSkin,
        lookupSkinSafe,
        getCachedSkin,
        exportTexture,
        exportTextureSafe
    });
};

module.exports = Object.freeze({
    MinecraftSkinError,
    PROFILE_LOOKUP_BASE,
    SESSION_PROFILE_BASE,
    TEXTURE_ORIGIN,
    createMinecraftSkinService,
    normalizeNickname,
    normalizeProfileId,
    normalizeTextureHash,
    parseTextureProperty,
    validatePng,
    validateTextureUrl
});
