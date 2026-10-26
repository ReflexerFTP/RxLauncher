// HTTP без сторонних библиотек (замена заброшенного пакета request): JSON, текст и загрузка файлов.
// Редиректы, таймаут, сжатие gzip/deflate/br, отмена через AbortSignal и проверка хеша при скачивании.
class RxHttp {
    static MAX_REDIRECTS = 5;

    static userAgent = () => `MaxRx/RxLauncher/${typeof LAUNCHER_VERSION === "string" ? LAUNCHER_VERSION : "3"} (${typeof SITE_URL === "string" ? SITE_URL : "https://rxlauncher.xyz"})`;

    // Открыть ответ (следуя редиректам). Возвращает {status, headers, url, stream}
    static open = (url, options = {}) => new Promise((resolve, reject) => {
        const {method = "GET", headers = {}, body = null, timeout = 20000, signal = null,
            redirects = RxHttp.MAX_REDIRECTS, compress = true, urlPolicy = null} = options;
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            return reject(error);
        }
        try { urlPolicy?.(parsed.toString()); } catch (error) { return reject(error); }
        const client = {"https:": require("https"), "http:": require("http")}[parsed.protocol];
        if (!client) return reject(new Error(`Unsupported protocol ${parsed.protocol}`));
        if (signal?.aborted) return reject(new Error("Request aborted"));

        const isJsonBody = body !== null && typeof body === "object" && !Buffer.isBuffer(body);
        const payload = body === null ? null : (isJsonBody ? JSON.stringify(body) : body);
        const request = client.request(parsed, {
            method,
            timeout,
            headers: {
                "User-Agent": RxHttp.userAgent(),
                "Accept-Encoding": compress ? "gzip, deflate, br" : "identity",
                ...(isJsonBody ? {"Content-Type": "application/json"} : {}),
                ...(payload !== null ? {"Content-Length": Buffer.byteLength(payload)} : {}),
                ...headers
            }
        }, (response) => {
            signal?.removeEventListener("abort", onAbort);
            try {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                const destination = new URL(response.headers.location, parsed);
                if (parsed.protocol === "https:" && destination.protocol !== "https:") { response.resume(); return reject(new Error("Insecure redirect")); }
                const forwardedHeaders = {...headers};
                if (destination.origin !== parsed.origin) {
                    for (const key of Object.keys(forwardedHeaders)) if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete forwardedHeaders[key];
                    if (body !== null && (status === 307 || status === 308)) { response.resume(); return reject(new Error("Cross-origin body redirect")); }
                }
                response.destroy();
                if (redirects <= 0) return reject(new Error("Too many redirects"));
                // 307/308 сохраняют метод и тело, остальные редиректы превращают запрос в GET
                const keep = status === 307 || status === 308;
                if (!keep) {
                    for (const key of Object.keys(forwardedHeaders)) {
                        if (/^(content-length|content-type|transfer-encoding)$/i.test(key)) delete forwardedHeaders[key];
                    }
                }
                return resolve(RxHttp.open(new URL(response.headers.location, parsed).toString(), {
                    ...options, headers: forwardedHeaders, method: keep ? method : "GET", body: keep ? body : null, redirects: redirects - 1
                }));
            }
            const zlib = require("zlib");
            const decoder = {gzip: zlib.createGunzip, "x-gzip": zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress}[String(response.headers["content-encoding"] || "").toLowerCase()];
            let stream = response;
            if (decoder) {
                stream = response.pipe(decoder());
                response.on("error", error => stream.destroy(error));
                response.on("aborted", () => stream.destroy(new Error("Incomplete response")));
            }
            const abortStream = () => stream.destroy(new Error("Request aborted"));
            const cleanup = () => signal?.removeEventListener("abort", abortStream);
            stream.once("end", cleanup);
            stream.once("error", cleanup);
            stream.once("close", () => {
                cleanup();
                // Stopping a decompressor must also close the upstream socket.
                if (!response.complete) response.destroy();
            });
            if (signal) {
                signal.addEventListener("abort", abortStream, {once: true});
                if (signal.aborted) abortStream();
            }
            resolve({status, headers: response.headers, url: parsed.toString(), stream, ok: status >= 200 && status < 300});
            } catch (error) {
                response.destroy();
                reject(error);
            }
        });
        const onAbort = () => request.destroy(new Error("Request aborted"));
        signal?.addEventListener("abort", onAbort, {once: true});
        request.on("timeout", () => request.destroy(new Error("Request timed out")));
        request.on("error", (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
        if (payload !== null) request.write(payload);
        request.end();
    });

    static readAll = async (stream, maxBytes = 16 * 1024 * 1024) => {
        const chunks = [];
        let size = 0;
        try {
            if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid response size limit");
            for await (const chunk of stream) {
                size += chunk.length;
                if (size > maxBytes) throw new Error("Response too large");
                chunks.push(chunk);
            }
            return Buffer.concat(chunks, size);
        } finally {
            chunks.length = 0;
            if (!stream.destroyed) stream.destroy();
        }
    };

    // Текст ответа любого статуса: {ok, status, url, headers, body}
    static text = async (url, options = {}) => {
        const response = await RxHttp.open(url, options);
        const body = (await RxHttp.readAll(response.stream, options.maxBytes)).toString("utf8");
        return {ok: response.ok, status: response.status, url: response.url, headers: response.headers, body};
    };

    // JSON; при статусе не 2xx — ошибка со status
    static json = async (url, options = {}) => {
        const response = await RxHttp.text(url, {...options, headers: {"Accept": "application/json", ...(options.headers || {})}});
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.body ? JSON.parse(response.body) : null;
    };

    // Самый надёжный из известных хешей файла
    static pickHash = (hashes = {}) => {
        for (const algorithm of ["sha512", "sha256", "sha1", "md5"]) {
            if (typeof hashes?.[algorithm] === "string" && hashes[algorithm]) return {algorithm, value: hashes[algorithm].toLowerCase()};
        }
        return null;
    };

    static hashFile = (filePath, algorithm) => new Promise((resolve) => {
        const hash = crypto.createHash(algorithm);
        fs.createReadStream(filePath)
            .on("data", chunk => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")))
            .on("error", () => resolve(""));
    });

    // Файл на месте и совпадает с хешем (без хеша — просто не пустой)
    static isFileValid = async (filePath, hashes = {}) => {
        try {
            if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size === 0) return false;
        } catch (_) {
            return false;
        }
        const expected = RxHttp.pickHash(hashes);
        if (!expected) return true;
        return (await RxHttp.hashFile(filePath, expected.algorithm)) === expected.value;
    };

    // Скачать во временный файл, проверить хеш и только потом положить на место
    static download = async (url, filePath, {hashes = {}, signal = null, timeout = 30000,
        onProgress = null, maxBytes = 4 * 1024 ** 3, urlPolicy = null} = {}) => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid download size limit");
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        const temp = `${filePath}.${crypto.randomUUID()}.rxdownload`;
        const expected = RxHttp.pickHash(hashes);
        const response = await RxHttp.open(url, {signal, timeout, compress: false, urlPolicy});
        if (!response.ok) {
            response.stream.destroy();
            const error = new Error(`Download failed with HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        const total = parseInt(response.headers["content-length"] || "0", 10) || 0;
        if (total > maxBytes) {
            response.stream.destroy();
            throw new Error("Download exceeds size limit");
        }
        const hash = expected ? crypto.createHash(expected.algorithm) : null;
        let received = 0;
        try {
            const {Transform} = require("node:stream");
            const {pipeline} = require("node:stream/promises");
            const meter = new Transform({transform(chunk, _encoding, callback) {
                try {
                    received += chunk.length;
                    if (received > maxBytes) throw new Error("Download exceeds size limit");
                    hash?.update(chunk);
                    if (onProgress) onProgress(received, total);
                    callback(null, chunk);
                } catch (error) { callback(error); }
            }});
            await pipeline(response.stream, meter, fs.createWriteStream(temp));
            if (signal?.aborted) throw new Error("Request aborted");
            if (total && received !== total) throw new Error("Incomplete download");
            if (hash && hash.digest("hex") !== expected.value) throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
            fs.renameSync(temp, filePath);
            return {bytes: received, path: filePath};
        } finally {
            try { fs.unlinkSync(temp); } catch (_) {}
        }
    };
}
