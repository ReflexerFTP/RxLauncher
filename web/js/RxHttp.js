// HTTP через Rust-ядро (reqwest): JSON, текст и загрузка файлов. Редиректы, таймаут, сжатие, отмена через AbortSignal,
// проверка хеша и размера при скачивании. urlPolicy (адреса из чужих данных) — ядро проверяет https и что DNS-имя
// не ведёт в локальную сеть, в том числе после редиректов
class RxHttp {
    static MAX_REDIRECTS = 5;
    static bridge = () => require("../tauri/runtime/bridge");
    static nextId = 1;

    static userAgent = () => `MaxRx/RxLauncher/${typeof LAUNCHER_VERSION === "string" ? LAUNCHER_VERSION : "3"} (${typeof SITE_URL === "string" ? SITE_URL : "https://rxlauncher.xyz"})`;

    // Отмена по сигналу: ядро прерывает запрос с этим id
    static withAbort = async (signal, id, task) => {
        if (signal?.aborted) throw new Error("Request aborted");
        const onAbort = () => RxHttp.bridge().value("http.abort", {id}).catch(() => {});
        signal?.addEventListener("abort", onAbort, {once: true});
        try {
            return await task();
        } catch (error) {
            if (signal?.aborted) throw new Error("Request aborted");
            throw error;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    };

    // {ok, status, url, headers, body: Buffer}
    static request = async (url, options = {}) => {
        const {method = "GET", headers = {}, body = null, timeout = 20000, signal = null, redirects = RxHttp.MAX_REDIRECTS,
            compress = true, urlPolicy = null, maxBytes = 16 * 1024 * 1024} = options;
        if (urlPolicy) urlPolicy(String(url));
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid response size limit");
        const isJsonBody = body !== null && typeof body === "object" && !ArrayBuffer.isView(body);
        const payload = body === null ? null : (isJsonBody ? JSON.stringify(body) : body);
        const id = RxHttp.nextId++;
        const {value, payload: data} = await RxHttp.withAbort(signal, id, () => RxHttp.bridge().call("http.request", {
            id, url: String(url), method, timeout, redirects, maxBytes, compress, guarded: Boolean(urlPolicy),
            headers: {"User-Agent": RxHttp.userAgent(), ...(isJsonBody ? {"Content-Type": "application/json"} : {}), ...headers}
        }, payload));
        return {ok: value.status >= 200 && value.status < 300, status: value.status, url: value.url, headers: value.headers, body: Buffer.from(data)};
    };

    // Совместимость со старым API: ответ целиком, stream — заглушка с телом
    static open = async (url, options = {}) => {
        const response = await RxHttp.request(url, {maxBytes: 64 * 1024 * 1024, ...options});
        return {...response, stream: {body: response.body, resume: () => {}, destroy: () => {}, destroyed: false}};
    };

    static readAll = async (stream, maxBytes = 16 * 1024 * 1024) => {
        if (stream.body.length > maxBytes) throw new Error("Response too large");
        return stream.body;
    };

    // Текст ответа любого статуса: {ok, status, url, headers, body}
    static text = async (url, options = {}) => {
        const response = await RxHttp.request(url, options);
        return {ok: response.ok, status: response.status, url: response.url, headers: response.headers, body: response.body.toString("utf8")};
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

    static hashFile = (filePath, algorithm) => RxHttp.bridge().value("fs.hashFile", {path: filePath, algorithm}).catch(() => "");

    // Файл на месте и совпадает с хешем (без хеша — просто не пустой)
    static isFileValid = async (filePath, hashes = {}) => {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size === 0) return false;
        } catch (_) {
            return false;
        }
        const expected = RxHttp.pickHash(hashes);
        if (!expected) return true;
        return (await RxHttp.hashFile(filePath, expected.algorithm)) === expected.value;
    };

    // Прогресс загрузок приходит событием rx:http-progress {id, received, total}
    static progressHandlers = new Map();
    static progressListening = false;
    static listenProgress = () => {
        if (RxHttp.progressListening) return;
        RxHttp.progressListening = true;
        RxHttp.bridge().listen("rx:http-progress", ({id, received, total}) => {
            const handler = RxHttp.progressHandlers.get(id);
            if (!handler) return;
            try {
                handler(received, total);
            } catch (error) {
                // onProgress бросил ошибку (например, превышен общий бюджет) — прерываем загрузку
                RxHttp.progressHandlers.delete(id);
                RxHttp.bridge().value("http.abort", {id, reason: error.message}).catch(() => {});
            }
        });
    };

    // Скачать во временный файл, проверить хеш и размер и только потом положить на место (всё делает ядро)
    // expectedSize — точный размер из метаданных: больше него не принимаем, меньше — тоже ошибка
    static download = async (url, filePath, {hashes = {}, signal = null, timeout = 30000,
        onProgress = null, maxBytes = 4 * 1024 ** 3, urlPolicy = null, expectedSize = null} = {}) => {
        if (expectedSize !== null) {
            if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("Invalid expected download size");
            maxBytes = Math.min(maxBytes, Math.max(1, expectedSize));
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid download size limit");
        if (urlPolicy) urlPolicy(String(url));
        const id = RxHttp.nextId++;
        if (onProgress) {
            RxHttp.listenProgress();
            RxHttp.progressHandlers.set(id, onProgress);
        }
        try {
            const result = await RxHttp.withAbort(signal, id, () => RxHttp.bridge().value("http.download", {
                id, url: String(url), path: filePath, hash: RxHttp.pickHash(hashes), timeout, maxBytes, expectedSize,
                guarded: Boolean(urlPolicy), progress: Boolean(onProgress), userAgent: RxHttp.userAgent()
            }));
            return {bytes: result.bytes, path: filePath};
        } finally {
            RxHttp.progressHandlers.delete(id);
        }
    };
}
