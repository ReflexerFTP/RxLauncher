// Небольшие модули Node поверх ядра: crypto, url, zlib, string_decoder, net, dns, stream, util, child_process, tree-kill, fs-extra.
// Файл не оборачивается сборкой — модули объявляются здесь через __rxDefine
__rxDefine("crypto", (module, exports, require) => {
    const bridge = require("./bridge");
    const {Buffer} = require("buffer");
    const ALGORITHMS = new Set(["sha1", "sha256", "sha512", "md5"]);
    class Hash {
        constructor(algorithm) {
            this.algorithm = String(algorithm).toLowerCase().replace("-", "");
            if (!ALGORITHMS.has(this.algorithm)) throw new Error(`Digest method not supported: ${algorithm}`);
            this.chunks = [];
        }
        update(data, encoding) {
            this.chunks.push(typeof data === "string" ? Buffer.from(data, encoding || "utf8") : Buffer.from(data));
            return this;
        }
        digest(encoding) {
            const hex = bridge.syncValue("hash", {algorithm: this.algorithm}, Buffer.concat(this.chunks));
            this.chunks = [];
            const bytes = Buffer.from(hex, "hex");
            return encoding ? bytes.toString(encoding) : bytes;
        }
    }
    const web = globalThis.crypto;
    module.exports = {
        createHash: algorithm => new Hash(algorithm),
        randomBytes: size => {
            const bytes = Buffer.alloc(size);
            for (let offset = 0; offset < size; offset += 65536) web.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
            return bytes;
        },
        randomUUID: () => web.randomUUID(),
        randomInt: (min, max) => {
            if (max === undefined) { max = min; min = 0; }
            const range = max - min;
            const values = new Uint32Array(1);
            web.getRandomValues(values);
            return min + (values[0] % range);
        },
        getRandomValues: array => web.getRandomValues(array),
        timingSafeEqual: (a, b) => {
            if (a.length !== b.length) throw new RangeError("Input buffers must have the same byte length");
            let diff = 0;
            for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
            return diff === 0;
        },
        webcrypto: web,
        subtle: web.subtle
    };
});

__rxDefine("url", (module, exports, require) => {
    // Локальный файл в интерфейсе грузится через asset-протокол Tauri (file:// в WebView недоступен)
    const fileSrc = path => {
        const internals = window.__TAURI_INTERNALS__;
        return internals && typeof internals.convertFileSrc === "function" ? internals.convertFileSrc(path, "asset") : `file:///${path.replace(/\\/g, "/")}`;
    };
    const pathToFileURL = path => {
        const href = fileSrc(String(path));
        return {href, toString: () => href, valueOf: () => href, pathname: `/${String(path).replace(/\\/g, "/")}`, protocol: "file:", _rxPath: String(path)};
    };
    const fileURLToPath = value => {
        if (value && value._rxPath) return value._rxPath;
        const text = String(value && value.href ? value.href : value);
        const asset = /^https?:\/\/asset\.localhost\/(.*)$/.exec(text) || /^asset:\/\/localhost\/(.*)$/.exec(text);
        if (asset) return decodeURIComponent(asset[1]);
        const url = new URL(text);
        if (url.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), {code: "ERR_INVALID_URL_SCHEME"});
        return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/\//g, "\\");
    };
    module.exports = {URL, URLSearchParams, pathToFileURL, fileURLToPath, fileSrc};
});

__rxDefine("zlib", (module, exports, require) => {
    const bridge = require("./bridge");
    const {Buffer} = require("buffer");
    const run = op => (data, options = {}) => {
        const result = bridge.callSync("zlib", {op, maxOutputLength: options.maxOutputLength || 512 * 1024 * 1024, level: options.level ?? null}, typeof data === "string" ? Buffer.from(data) : data);
        return Buffer.from(result.payload);
    };
    const async = op => (data, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        try { callback(null, run(op)(data, options)); } catch (error) { callback(error); }
    };
    module.exports = {
        inflateRawSync: run("inflateRaw"), deflateRawSync: run("deflateRaw"), inflateSync: run("inflate"), deflateSync: run("deflate"),
        gunzipSync: run("gunzip"), gzipSync: run("gzip"), unzipSync: run("unzip"),
        inflateRaw: async("inflateRaw"), deflateRaw: async("deflateRaw"), inflate: async("inflate"), deflate: async("deflate"),
        gunzip: async("gunzip"), gzip: async("gzip"), unzip: async("unzip"),
        constants: {Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1}
    };
});

__rxDefine("string_decoder", (module) => {
    class StringDecoder {
        constructor(encoding = "utf8") {
            this.encoding = encoding;
            this.decoder = new TextDecoder(encoding === "utf8" || encoding === "utf-8" ? "utf-8" : encoding);
        }
        write(buffer) { return this.decoder.decode(buffer, {stream: true}); }
        end(buffer) { return this.decoder.decode(buffer || new Uint8Array(0)); }
    }
    module.exports = {StringDecoder};
});

__rxDefine("net", (module) => {
    const isIPv4 = value => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(String(value));
    const isIPv6 = value => {
        const text = String(value);
        if (!text.includes(":") || /[^0-9a-fA-F:.]/.test(text)) return false;
        try { return Boolean(new URL(`http://[${text}]/`).hostname); } catch (_) { return false; }
    };
    const isIP = value => (isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0);
    // Адрес → BigInt для проверки подсетей
    const toBig = (address, family) => {
        if (family === "ipv4") return address.split(".").reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n);
        let text = address.toLowerCase();
        const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
        if (v4) {
            const n = toBig(v4[1], "ipv4");
            text = text.slice(0, -v4[1].length) + ((n >> 16n) & 0xffffn).toString(16) + ":" + (n & 0xffffn).toString(16);
        }
        const [head, tail] = text.split("::");
        const left = head ? head.split(":") : [];
        const right = tail !== undefined && tail ? tail.split(":") : [];
        const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
        return groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group || "0", 16)), 0n);
    };
    class BlockList {
        constructor() { this.rules = []; }
        addSubnet(network, prefix, family = "ipv4") {
            const bits = family === "ipv4" ? 32n : 128n;
            const shift = bits - BigInt(prefix);
            this.rules.push({family, base: toBig(network, family) >> shift, shift});
        }
        addAddress(address, family = "ipv4") { this.addSubnet(address, family === "ipv4" ? 32 : 128, family); }
        check(address, family = "ipv4") {
            let value;
            try { value = toBig(String(address), family); } catch (_) { return false; }
            return this.rules.some(rule => rule.family === family && (value >> rule.shift) === rule.base);
        }
    }
    module.exports = {isIP, isIPv4, isIPv6, BlockList, Socket: class { constructor() { throw new Error("Sockets are handled by the launcher core"); } }};
});

__rxDefine("dns", (module) => {
    module.exports = {lookup: (_host, _options, callback) => (typeof _options === "function" ? _options : callback)(new Error("DNS is handled by the launcher core"))};
});

__rxDefine("stream", (module, exports, require) => {
    const EventEmitter = require("events");
    class Stream extends EventEmitter {}
    const unsupported = () => { throw new Error("Node streams are handled by the launcher core"); };
    module.exports = {Stream, Readable: Stream, Writable: Stream, Transform: class extends Stream { constructor() { super(); unsupported(); } }, PassThrough: Stream, pipeline: unsupported};
});
__rxDefine("stream/promises", (module) => {
    module.exports = {pipeline: () => Promise.reject(new Error("Node streams are handled by the launcher core"))};
});
for (const name of ["http", "https"]) {
    __rxDefine(name, (module) => {
        const unsupported = () => { throw new Error(`${name} is handled by the launcher core (RxHttp)`); };
        module.exports = {request: unsupported, get: unsupported, Agent: class {}};
    });
}

__rxDefine("util", (module) => {
    const inspect = value => {
        try { return typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch (_) { return String(value); }
    };
    module.exports = {
        inspect,
        format: (format, ...args) => String(format).replace(/%[sdifjoO%]/g, token => token === "%%" ? "%" : args.length ? (token === "%j" ? JSON.stringify(args.shift()) : String(args.shift())) : token)
            + (args.length ? " " + args.map(inspect).join(" ") : ""),
        promisify: fn => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value))),
        deprecate: fn => fn,
        types: {isPromise: value => value instanceof Promise},
        TextEncoder, TextDecoder
    };
});

__rxDefine("child_process", (module) => {
    const unsupported = () => { throw new Error("Processes are started by the launcher core"); };
    module.exports = {exec: unsupported, execFile: unsupported, spawn: unsupported, execSync: unsupported, spawnSync: unsupported};
});

__rxDefine("tree-kill", (module, exports, require) => {
    const bridge = require("./bridge");
    module.exports = (pid, signal, callback) => {
        if (typeof signal === "function") callback = signal;
        bridge.value("process.killTree", {pid: Number(pid)}).then(() => callback && callback(null), error => callback && callback(error));
    };
});

__rxDefine("fs-extra", (module, exports, require) => {
    const fs = require("fs");
    const path = require("path");
    const extra = Object.create(fs);
    Object.assign(extra, {
        copy: async (from, to, options = {}) => fs.promises.cp(from, to, {recursive: true, force: options.overwrite !== false, errorOnExist: Boolean(options.errorOnExist)}),
        copySync: (from, to, options = {}) => fs.cpSync(from, to, {recursive: true, force: options.overwrite !== false, errorOnExist: Boolean(options.errorOnExist)}),
        move: async (from, to, options = {}) => extra.moveSync(from, to, options),
        moveSync: (from, to, options = {}) => {
            if (fs.existsSync(to)) {
                if (!options.overwrite) throw Object.assign(new Error("dest already exists."), {code: "EEXIST"});
                fs.rmSync(to, {recursive: true, force: true});
            }
            fs.mkdirSync(path.dirname(to), {recursive: true});
            try {
                fs.renameSync(from, to);
            } catch (error) {
                if (error.code !== "EXDEV") throw error;
                fs.cpSync(from, to, {recursive: true});
                fs.rmSync(from, {recursive: true, force: true});
            }
        },
        remove: async target => fs.promises.rm(target, {recursive: true, force: true}),
        removeSync: target => fs.rmSync(target, {recursive: true, force: true}),
        ensureDir: async dir => { await fs.promises.mkdir(dir, {recursive: true}); },
        ensureDirSync: dir => { fs.mkdirSync(dir, {recursive: true}); },
        mkdirp: async dir => { await fs.promises.mkdir(dir, {recursive: true}); },
        mkdirpSync: dir => { fs.mkdirSync(dir, {recursive: true}); },
        pathExists: async target => fs.existsSync(target),
        pathExistsSync: target => fs.existsSync(target),
        readJson: async file => JSON.parse(await fs.promises.readFile(file, "utf8")),
        readJsonSync: file => JSON.parse(fs.readFileSync(file, "utf8")),
        writeJson: async (file, data, options = {}) => fs.promises.writeFile(file, JSON.stringify(data, null, options.spaces || 0)),
        writeJsonSync: (file, data, options = {}) => fs.writeFileSync(file, JSON.stringify(data, null, options.spaces || 0)),
        emptyDir: async dir => extra.emptyDirSync(dir),
        emptyDirSync: dir => {
            fs.mkdirSync(dir, {recursive: true});
            for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), {recursive: true, force: true});
        }
    });
    module.exports = extra;
});
