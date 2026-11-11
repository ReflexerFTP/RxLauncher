// Модуль fs поверх Rust-ядра: синхронные функции через callSync, fs.promises — через call (без блокировки интерфейса)
const bridge = require("./bridge");
const {Buffer} = require("buffer");
const EventEmitter = require("events");

const constants = {F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
    O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_EXCL: 1024, O_TRUNC: 512, O_APPEND: 8, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960};

const toPath = value => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return decodeURIComponent(value.pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/\//g, "\\");
    if (value && typeof value.toString === "function" && Buffer.isBuffer(value)) return value.toString("utf8");
    throw Object.assign(new TypeError("The \"path\" argument must be of type string or an instance of Buffer or URL."), {code: "ERR_INVALID_ARG_TYPE"});
};
const encodingOf = options => typeof options === "string" ? options : options && options.encoding ? options.encoding : null;
const dataBytes = (data, options) => {
    if (typeof data === "string") return Buffer.from(data, encodingOf(options) || "utf8");
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return Buffer.from(String(data));
};

class Stats {
    constructor(raw) {
        Object.assign(this, {dev: raw.dev || 0, ino: raw.ino || 0, mode: raw.mode, nlink: raw.nlink || 1, uid: 0, gid: 0, rdev: 0, size: raw.size,
            blksize: 4096, blocks: Math.ceil(raw.size / 4096), atimeMs: raw.atimeMs, mtimeMs: raw.mtimeMs, ctimeMs: raw.ctimeMs, birthtimeMs: raw.birthtimeMs});
        this.atime = new Date(raw.atimeMs);
        this.mtime = new Date(raw.mtimeMs);
        this.ctime = new Date(raw.ctimeMs);
        this.birthtime = new Date(raw.birthtimeMs);
        Object.defineProperty(this, "_kind", {value: raw.kind});
    }
    isFile() { return this._kind === "file"; }
    isDirectory() { return this._kind === "dir"; }
    isSymbolicLink() { return this._kind === "symlink"; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

class Dirent {
    constructor(name, kind, parent) {
        this.name = name;
        this.parentPath = this.path = parent;
        Object.defineProperty(this, "_kind", {value: kind});
    }
    isFile() { return this._kind === "file"; }
    isDirectory() { return this._kind === "dir"; }
    isSymbolicLink() { return this._kind === "symlink"; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

const decodeRead = (payload, options) => {
    const buffer = Buffer.from(payload);
    const encoding = encodingOf(options);
    return encoding ? buffer.toString(encoding) : buffer;
};
const mapReaddir = (list, options, parent) => options && options.withFileTypes
    ? list.map(item => new Dirent(item.name, item.kind, parent))
    : list.map(item => (encodingOf(options) === "buffer" ? Buffer.from(item.name) : item.name));
// Список папки с размером и временем изменения за одно обращение к ядру (вместо readdir и stat на каждый файл).
// depth — сколько уровней вложенности читать (имена вложенных — относительные пути), head — сколько первых байт файла вернуть
const listArgs = (path, options = {}) => ({path: toPath(path), depth: options.depth || 1, head: options.head || 0, limit: options.limit || 20000});
const mapList = list => list.map(item => ({name: item.name, kind: item.kind, size: item.size, mtimeMs: item.mtimeMs,
    head: typeof item.head === "string" ? Buffer.from(item.head, "hex") : null}));
const flagOf = (options, fallback) => (options && typeof options === "object" && options.flag) || fallback;

// ---------- синхронные ----------
const sync = (op, args, payload) => bridge.callSync(`fs.${op}`, args, payload);

const fs = {
    constants,
    Stats,
    Dirent,

    existsSync(path) {
        try { return Boolean(sync("exists", {path: toPath(path)}).value); } catch (_) { return false; }
    },
    statSync(path, options = {}) {
        try {
            return new Stats(sync("stat", {path: toPath(path), lstat: false}).value);
        } catch (error) {
            if (options && options.throwIfNoEntry === false && error.code === "ENOENT") return undefined;
            throw error;
        }
    },
    lstatSync(path, options = {}) {
        try {
            return new Stats(sync("stat", {path: toPath(path), lstat: true}).value);
        } catch (error) {
            if (options && options.throwIfNoEntry === false && error.code === "ENOENT") return undefined;
            throw error;
        }
    },
    readFileSync(path, options) {
        if (typeof path === "number") return decodeRead(sync("readFd", {fd: path}).payload, options);
        return decodeRead(sync("readFile", {path: toPath(path)}).payload, options);
    },
    writeFileSync(path, data, options) {
        if (typeof path === "number") {
            sync("write", {fd: path, position: null}, dataBytes(data, options));
            return;
        }
        sync("writeFile", {path: toPath(path), flag: flagOf(options, "w")}, dataBytes(data, options));
    },
    appendFileSync(path, data, options) {
        sync("writeFile", {path: toPath(path), flag: flagOf(options, "a")}, dataBytes(data, options));
    },
    readdirSync(path, options) {
        const target = toPath(path);
        return mapReaddir(sync("readdir", {path: target}).value, options, target);
    },
    rxListSync(path, options) {
        return mapList(sync("list", listArgs(path, options)).value);
    },
    mkdirSync(path, options) {
        const recursive = typeof options === "object" && options !== null ? Boolean(options.recursive) : false;
        return sync("mkdir", {path: toPath(path), recursive}).value ?? undefined;
    },
    rmSync(path, options = {}) {
        sync("rm", {path: toPath(path), recursive: Boolean(options.recursive), force: Boolean(options.force)});
    },
    rmdirSync(path, options = {}) {
        sync("rmdir", {path: toPath(path), recursive: Boolean(options && options.recursive)});
    },
    unlinkSync(path) {
        sync("unlink", {path: toPath(path)});
    },
    renameSync(from, to) {
        sync("rename", {from: toPath(from), to: toPath(to)});
    },
    copyFileSync(from, to, mode = 0) {
        sync("copyFile", {from: toPath(from), to: toPath(to), exclusive: Boolean(mode & constants.COPYFILE_EXCL)});
    },
    cpSync(from, to, options = {}) {
        sync("cp", {from: toPath(from), to: toPath(to), recursive: Boolean(options.recursive), force: options.force !== false, errorOnExist: Boolean(options.errorOnExist)});
    },
    realpathSync(path) {
        return sync("realpath", {path: toPath(path)}).value;
    },
    // Только в Tauri: хеш файла считает ядро (Rust) — в разы быстрее, чем читать файл по кускам через мост
    hashFileSync(path, algorithm = "sha256") {
        return sync("hashFile", {path: toPath(path), algorithm}).value;
    },
    mkdtempSync(prefix) {
        return sync("mkdtemp", {prefix: toPath(prefix)}).value;
    },
    statfsSync(path) {
        return sync("statfs", {path: toPath(path)}).value;
    },
    accessSync(path, mode = constants.F_OK) {
        sync("access", {path: toPath(path), mode});
    },
    openSync(path, flags = "r") {
        return sync("open", {path: toPath(path), flags: String(flags)}).value;
    },
    readSync(fd, buffer, offsetOrOptions = 0, length, position = null) {
        let offset = offsetOrOptions;
        if (typeof offsetOrOptions === "object" && offsetOrOptions !== null) ({offset = 0, length = buffer.length - offset, position = null} = offsetOrOptions);
        if (length === undefined) length = buffer.length - offset;
        const payload = sync("read", {fd, length, position: typeof position === "bigint" ? Number(position) : position}).payload;
        buffer.set(payload, offset);
        return payload.length;
    },
    writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
        let bytes;
        let at = null;
        if (typeof data === "string") {
            bytes = Buffer.from(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8");
            at = typeof offsetOrPosition === "number" ? offsetOrPosition : null;
        } else {
            const offset = offsetOrPosition || 0;
            const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.byteLength - offset;
            bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length);
            at = typeof position === "number" ? position : null;
        }
        return sync("write", {fd, position: at}, bytes).value;
    },
    fsyncSync(fd) {
        sync("fsync", {fd});
    },
    closeSync(fd) {
        sync("close", {fd});
    },
    utimesSync(path, atime, mtime) {
        sync("utimes", {path: toPath(path), atimeMs: +atime * (atime instanceof Date ? 1 : 1000), mtimeMs: +mtime * (mtime instanceof Date ? 1 : 1000)});
    },
    truncateSync(path, length = 0) {
        sync("truncate", {path: toPath(path), length});
    }
};

// ---------- асинхронные (fs.promises) ----------
const call = (op, args, payload) => bridge.call(`fs.${op}`, args, payload);

class FileHandle {
    constructor(fd) { this.fd = fd; }
    async read(buffer, offset = 0, length = buffer.length - offset, position = null) {
        if (typeof buffer === "object" && !ArrayBuffer.isView(buffer) && buffer !== null) ({buffer = Buffer.alloc(16384), offset = 0, length = buffer.length - offset, position = null} = buffer);
        const payload = (await call("read", {fd: this.fd, length, position})).payload;
        buffer.set(payload, offset);
        return {bytesRead: payload.length, buffer};
    }
    async write(data, offset = 0, length, position = null) {
        const bytes = typeof data === "string" ? Buffer.from(data) : new Uint8Array(data.buffer, data.byteOffset + offset, length === undefined ? data.byteLength - offset : length);
        const written = (await call("write", {fd: this.fd, position}, bytes)).value;
        return {bytesWritten: written, buffer: data};
    }
    async readFile(options) { return decodeRead((await call("readFd", {fd: this.fd})).payload, options); }
    async writeFile(data, options) { await call("write", {fd: this.fd, position: null}, dataBytes(data, options)); }
    async stat() { return new Stats((await call("fstat", {fd: this.fd})).value); }
    async sync() { await call("fsync", {fd: this.fd}); }
    async close() { await call("close", {fd: this.fd}); }
}

const promises = {
    constants,
    async access(path, mode = constants.F_OK) { await call("access", {path: toPath(path), mode}); },
    async stat(path) { return new Stats((await call("stat", {path: toPath(path), lstat: false})).value); },
    async lstat(path) { return new Stats((await call("stat", {path: toPath(path), lstat: true})).value); },
    async readFile(path, options) { return decodeRead((await call("readFile", {path: toPath(path)})).payload, options); },
    async writeFile(path, data, options) { await call("writeFile", {path: toPath(path), flag: flagOf(options, "w")}, dataBytes(data, options)); },
    async appendFile(path, data, options) { await call("writeFile", {path: toPath(path), flag: flagOf(options, "a")}, dataBytes(data, options)); },
    async readdir(path, options) {
        const target = toPath(path);
        return mapReaddir((await call("readdir", {path: target})).value, options, target);
    },
    async rxList(path, options) { return mapList((await call("list", listArgs(path, options))).value); },
    async mkdir(path, options) {
        const recursive = typeof options === "object" && options !== null ? Boolean(options.recursive) : false;
        return (await call("mkdir", {path: toPath(path), recursive})).value ?? undefined;
    },
    async rm(path, options = {}) { await call("rm", {path: toPath(path), recursive: Boolean(options.recursive), force: Boolean(options.force)}); },
    async rmdir(path, options = {}) { await call("rmdir", {path: toPath(path), recursive: Boolean(options && options.recursive)}); },
    async unlink(path) { await call("unlink", {path: toPath(path)}); },
    async rename(from, to) { await call("rename", {from: toPath(from), to: toPath(to)}); },
    async copyFile(from, to, mode = 0) { await call("copyFile", {from: toPath(from), to: toPath(to), exclusive: Boolean(mode & constants.COPYFILE_EXCL)}); },
    async cp(from, to, options = {}) {
        await call("cp", {from: toPath(from), to: toPath(to), recursive: Boolean(options.recursive), force: options.force !== false, errorOnExist: Boolean(options.errorOnExist)});
    },
    async realpath(path) { return (await call("realpath", {path: toPath(path)})).value; },
    async mkdtemp(prefix) { return (await call("mkdtemp", {prefix: toPath(prefix)})).value; },
    async open(path, flags = "r") { return new FileHandle((await call("open", {path: toPath(path), flags: String(flags)})).value); },
    async truncate(path, length = 0) { await call("truncate", {path: toPath(path), length}); },
    async utimes(path, atime, mtime) { fs.utimesSync(path, atime, mtime); }
};
fs.promises = promises;

// ---------- колбэк-версии (на всякий случай) ----------
for (const name of Object.keys(promises)) {
    if (typeof promises[name] !== "function" || fs[name]) continue;
    fs[name] = (...args) => {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        const result = promises[name](...args);
        if (callback) result.then(value => callback(null, value), error => callback(error));
        return undefined;
    };
}
fs.exists = (path, callback) => callback(fs.existsSync(path));

// ---------- потоки ----------
class ReadStream extends EventEmitter {
    constructor(path, options = {}) {
        super();
        this.path = toPath(path);
        this.bytesRead = 0;
        this.destroyed = false;
        this.readable = true;
        const chunkSize = options.highWaterMark || 1024 * 1024;
        const encoding = encodingOf(options);
        queueMicrotask(async () => {
            let handle;
            try {
                handle = await promises.open(this.path, "r");
                this.emit("open", handle.fd);
                this.emit("ready");
                let position = options.start || 0;
                const end = options.end === undefined ? Infinity : options.end + 1;
                while (!this.destroyed && position < end) {
                    const length = Math.min(chunkSize, end - position);
                    const {bytesRead, buffer} = await handle.read(Buffer.alloc(length), 0, length, position);
                    if (!bytesRead) break;
                    position += bytesRead;
                    this.bytesRead += bytesRead;
                    const chunk = buffer.subarray(0, bytesRead);
                    this.emit("data", encoding ? chunk.toString(encoding) : chunk);
                    if (this._pipeTarget) await this._pipeTarget._writeAsync(chunk);
                }
                if (!this.destroyed) {
                    this.emit("end");
                    if (this._pipeTarget && this._pipeEnd) this._pipeTarget.end();
                }
            } catch (error) {
                this.emit("error", error);
            } finally {
                if (handle) await handle.close().catch(() => {});
                this.emit("close");
            }
        });
    }
    pipe(target, {end = true} = {}) {
        this._pipeTarget = target;
        this._pipeEnd = end;
        return target;
    }
    destroy(error) {
        this.destroyed = true;
        if (error) this.emit("error", error);
        return this;
    }
    async *[Symbol.asyncIterator]() {
        const queue = [];
        let done = false, failure = null, wake = null;
        this.on("data", chunk => { queue.push(chunk); wake && wake(); });
        this.on("end", () => { done = true; wake && wake(); });
        this.on("error", error => { failure = error; wake && wake(); });
        while (true) {
            if (failure) throw failure;
            if (queue.length) { yield queue.shift(); continue; }
            if (done) return;
            await new Promise(resolve => { wake = resolve; });
            wake = null;
        }
    }
}

class WriteStream extends EventEmitter {
    constructor(path, options = {}) {
        super();
        this.path = toPath(path);
        this.bytesWritten = 0;
        this.destroyed = false;
        this.writable = true;
        this._flags = options.flags || "w";
        this._chain = promises.open(this.path, this._flags).then(handle => {
            this._handle = handle;
            this.emit("open", handle.fd);
            this.emit("ready");
        }, error => { this.emit("error", error); });
    }
    _writeAsync(chunk) {
        this._chain = this._chain.then(async () => {
            if (!this._handle) return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            await this._handle.write(bytes);
            this.bytesWritten += bytes.length;
        });
        return this._chain;
    }
    write(chunk, encoding, callback) {
        if (typeof encoding === "function") callback = encoding;
        this._writeAsync(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk)
            .then(() => callback && callback(), error => { callback && callback(error); this.emit("error", error); });
        return true;
    }
    end(chunk, encoding, callback) {
        if (typeof chunk === "function") { callback = chunk; chunk = null; }
        if (chunk) this.write(chunk, encoding);
        this._chain = this._chain.then(async () => {
            if (this._handle) await this._handle.close();
            this.emit("finish");
            this.emit("close");
            callback && callback();
        }, error => this.emit("error", error));
        return this;
    }
    destroy(error) {
        this.destroyed = true;
        if (this._handle) this._handle.close().catch(() => {});
        if (error) this.emit("error", error);
        this.emit("close");
        return this;
    }
}
fs.ReadStream = ReadStream;
fs.WriteStream = WriteStream;
fs.createReadStream = (path, options) => new ReadStream(path, typeof options === "string" ? {encoding: options} : options || {});
fs.createWriteStream = (path, options) => new WriteStream(path, typeof options === "string" ? {encoding: options} : options || {});

// fs.watch не нужен интерфейсу — наблюдение за файлами делает ядро
fs.watch = () => { throw Object.assign(new Error("fs.watch is not available in the launcher UI"), {code: "ENOSYS"}); };

module.exports = fs;
