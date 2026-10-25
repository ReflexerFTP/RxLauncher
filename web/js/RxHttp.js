// HTTP без сторонних библиотек (замена заброшенного пакета request): JSON, текст и загрузка файлов.
// Редиректы, таймаут, сжатие gzip/deflate/br, отмена через AbortSignal и проверка хеша при скачивании.
class RxHttp {
    static MAX_REDIRECTS = 5;

    static userAgent = () => `MaxRx/RxLauncher/${typeof LAUNCHER_VERSION === "string" ? LAUNCHER_VERSION : "3"} (${typeof SITE_URL === "string" ? SITE_URL : "https://rxlauncher.xyz"})`;

    // Открыть ответ (следуя редиректам). Возвращает {status, headers, url, stream}
    static open = (url, options = {}) => new Promise((resolve, reject) => {
        const {method = "GET", headers = {}, body = null, timeout = 20000, signal = null, redirects = RxHttp.MAX_REDIRECTS, compress = true} = options;
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            return reject(error);
        }
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
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                if (redirects <= 0) return reject(new Error("Too many redirects"));
                // 307/308 сохраняют метод и тело, остальные редиректы превращают запрос в GET
                const keep = status === 307 || status === 308;
                return resolve(RxHttp.open(new URL(response.headers.location, parsed).toString(), {
                    ...options, method: keep ? method : "GET", body: keep ? body : null, redirects: redirects - 1
                }));
            }
            const zlib = require("zlib");
            const decoder = {gzip: zlib.createGunzip, "x-gzip": zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress}[String(response.headers["content-encoding"] || "").toLowerCase()];
            let stream = response;
            if (decoder) {
                stream = response.pipe(decoder());
                response.on("error", error => stream.destroy(error));
            }
            if (signal) signal.addEventListener("abort", () => stream.destroy(new Error("Request aborted")), {once: true});
            resolve({status, headers: response.headers, url: parsed.toString(), stream, ok: status >= 200 && status < 300});
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

    static readAll = (stream) => new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });

    // Текст ответа любого статуса: {ok, status, url, headers, body}
    static text = async (url, options = {}) => {
        const response = await RxHttp.open(url, options);
        const body = (await RxHttp.readAll(response.stream)).toString("utf8");
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
    static download = async (url, filePath, {hashes = {}, signal = null, timeout = 30000, onProgress = null} = {}) => {
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        const temp = `${filePath}.rxdownload`;
        const expected = RxHttp.pickHash(hashes);
        const response = await RxHttp.open(url, {signal, timeout, compress: false});
        if (!response.ok) {
            response.stream.resume();
            const error = new Error(`Download failed with HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        const total = parseInt(response.headers["content-length"] || "0", 10) || 0;
        const hash = expected ? crypto.createHash(expected.algorithm) : null;
        let received = 0;
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(temp);
            let failed = false;
            const fail = (error) => {
                if (failed) return;
                failed = true;
                response.stream.destroy();
                file.destroy();
                file.once("close", () => {
                    try { fs.unlinkSync(temp); } catch (_) {}
                    reject(error);
                });
            };
            response.stream.on("data", (chunk) => {
                received += chunk.length;
                hash?.update(chunk);
                if (onProgress) onProgress(received, total);
            });
            response.stream.on("error", fail);
            file.on("error", fail);
            file.on("finish", resolve);
            response.stream.pipe(file);
        });
        if (hash && hash.digest("hex") !== expected.value) {
            try { fs.unlinkSync(temp); } catch (_) {}
            throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
        }
        fs.renameSync(temp, filePath);
        return {bytes: received, path: filePath};
    };
}
