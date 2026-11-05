// Buffer на основе Uint8Array — то, что использует код лаунчера (сверяется с Node тестом tauri/tests/buffer.test.cjs)
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP["-".charCodeAt(0)] = 62;
B64_LOOKUP["_".charCodeAt(0)] = 63;

const normalizeEncoding = encoding => {
    const value = String(encoding || "utf8").toLowerCase();
    if (value === "utf-8" || value === "utf8") return "utf8";
    if (value === "binary" || value === "latin1") return "latin1";
    if (value === "ucs2" || value === "ucs-2" || value === "utf16le" || value === "utf-16le") return "utf16le";
    if (["hex", "base64", "base64url", "ascii"].includes(value)) return value;
    throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), {code: "ERR_UNKNOWN_ENCODING"});
};

const base64Encode = (bytes, url) => {
    let out = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += B64[n >> 18] + B64[(n >> 12) & 63] + (url ? "" : "==");
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + (url ? "" : "=");
    }
    return url ? out.replace(/\+/g, "-").replace(/\//g, "_") : out;
};
const base64Decode = text => {
    const out = new Uint8Array(Math.ceil(text.length * 3 / 4));
    let length = 0, buffer = 0, bits = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 61) break; // '='
        const value = code < 256 ? B64_LOOKUP[code] : -1;
        if (value < 0) continue;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[length++] = (buffer >> bits) & 0xff;
        }
    }
    return out.subarray(0, length);
};
const hexDecode = text => {
    const out = new Uint8Array(text.length >>> 1);
    let length = 0;
    for (let i = 0; i + 1 < text.length; i += 2) {
        const value = parseInt(text.substr(i, 2), 16);
        if (Number.isNaN(value)) break;
        out[length++] = value;
    }
    return out.subarray(0, length);
};
const encodeString = (string, encoding) => {
    switch (normalizeEncoding(encoding)) {
        case "utf8": return encoder.encode(string);
        case "hex": return hexDecode(string);
        case "base64":
        case "base64url": return base64Decode(string);
        case "latin1":
        case "ascii": {
            const out = new Uint8Array(string.length);
            for (let i = 0; i < string.length; i++) out[i] = string.charCodeAt(i) & 0xff;
            return out;
        }
        case "utf16le": {
            const out = new Uint8Array(string.length * 2);
            for (let i = 0; i < string.length; i++) {
                const code = string.charCodeAt(i);
                out[i * 2] = code & 0xff;
                out[i * 2 + 1] = code >> 8;
            }
            return out;
        }
    }
};
const decodeBytes = (bytes, encoding) => {
    switch (normalizeEncoding(encoding)) {
        case "utf8": return decoder.decode(bytes);
        case "hex": {
            let out = "";
            for (const byte of bytes) out += (byte < 16 ? "0" : "") + byte.toString(16);
            return out;
        }
        case "base64": return base64Encode(bytes, false);
        case "base64url": return base64Encode(bytes, true);
        case "latin1": {
            let out = "";
            for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
            return out;
        }
        case "ascii": {
            let out = "";
            for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] & 0x7f);
            return out;
        }
        case "utf16le": {
            let out = "";
            for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
            return out;
        }
    }
};

class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
        if (typeof value === "string") {
            const bytes = encodeString(value, encodingOrOffset);
            return Buffer._wrap(bytes);
        }
        if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) {
            const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset);
            return new Buffer(value, offset, length === undefined ? value.byteLength - offset : Number(length));
        }
        if (ArrayBuffer.isView(value)) {
            const copy = new Buffer(value.byteLength);
            copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            return copy;
        }
        if (Array.isArray(value) || (value && typeof value.length === "number")) {
            const copy = new Buffer(value.length);
            for (let i = 0; i < value.length; i++) copy[i] = value[i] & 0xff;
            return copy;
        }
        if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
        throw new TypeError("The first argument must be of type string, Buffer, ArrayBuffer, Array, or Array-like Object.");
    }

    // Uint8Array → Buffer над той же памятью
    static _wrap(bytes) {
        return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    static alloc(size, fill, encoding) {
        const buffer = new Buffer(size);
        if (fill !== undefined && fill !== 0) buffer.fill(fill, 0, size, encoding);
        return buffer;
    }

    static allocUnsafe(size) {
        return new Buffer(size);
    }

    static allocUnsafeSlow(size) {
        return new Buffer(size);
    }

    static isBuffer(value) {
        return value instanceof Buffer;
    }

    static isEncoding(encoding) {
        try { normalizeEncoding(encoding); return true; } catch (_) { return false; }
    }

    static byteLength(value, encoding) {
        if (typeof value === "string") return encodeString(value, encoding).length;
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
        throw new TypeError("The \"string\" argument must be of type string or an instance of Buffer or ArrayBuffer.");
    }

    static concat(list, totalLength) {
        if (totalLength === undefined) totalLength = list.reduce((sum, item) => sum + item.length, 0);
        const result = Buffer.alloc(totalLength);
        let offset = 0;
        for (const item of list) {
            if (offset >= totalLength) break;
            const part = item.length > totalLength - offset ? item.subarray(0, totalLength - offset) : item;
            result.set(part, offset);
            offset += part.length;
        }
        return result;
    }

    static compare(a, b) {
        const length = Math.min(a.length, b.length);
        for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
        return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }

    toString(encoding, start = 0, end = this.length) {
        start = Math.max(0, start | 0);
        end = Math.min(this.length, end === undefined ? this.length : end | 0);
        if (end <= start) return "";
        return decodeBytes(this.subarray(start, end), encoding);
    }

    toJSON() {
        return {type: "Buffer", data: Array.from(this)};
    }

    equals(other) {
        return Buffer.compare(this, other) === 0;
    }

    compare(other) {
        return Buffer.compare(this, other);
    }

    // Как в Node: slice — это вид на ту же память
    slice(start, end) {
        return this.subarray(start, end);
    }

    subarray(start, end) {
        const view = Uint8Array.prototype.subarray.call(this, start, end);
        return new Buffer(view.buffer, view.byteOffset, view.byteLength);
    }

    write(string, offset = 0, length, encoding) {
        if (typeof offset === "string") { encoding = offset; offset = 0; length = undefined; }
        if (typeof length === "string") { encoding = length; length = undefined; }
        const bytes = encodeString(String(string), encoding);
        const count = Math.min(bytes.length, this.length - offset, length === undefined ? Infinity : length);
        this.set(bytes.subarray(0, count), offset);
        return count;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        const part = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + (target.length - targetStart)));
        target.set(part, targetStart);
        return part.length;
    }

    fill(value, offset = 0, end = this.length, encoding) {
        if (typeof offset === "string") { encoding = offset; offset = 0; end = this.length; }
        if (typeof value === "string") {
            const bytes = value.length === 1 && normalizeEncoding(encoding) === "utf8" && value.charCodeAt(0) < 128
                ? [value.charCodeAt(0)] : encodeString(value, encoding);
            if (!bytes.length) return Uint8Array.prototype.fill.call(this, 0, offset, end), this;
            for (let i = offset, j = 0; i < end; i++, j = (j + 1) % bytes.length) this[i] = bytes[j];
            return this;
        }
        Uint8Array.prototype.fill.call(this, typeof value === "number" ? value & 0xff : 0, offset, end);
        return this;
    }

    indexOf(value, byteOffset = 0, encoding) {
        if (typeof value === "number") return Uint8Array.prototype.indexOf.call(this, value & 0xff, byteOffset);
        const needle = typeof value === "string" ? encodeString(value, encoding) : value;
        if (byteOffset < 0) byteOffset = Math.max(0, this.length + byteOffset);
        if (!needle.length) return Math.min(byteOffset, this.length);
        outer: for (let i = byteOffset; i <= this.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    lastIndexOf(value, byteOffset = this.length - 1, encoding) {
        if (typeof value === "number") return Uint8Array.prototype.lastIndexOf.call(this, value & 0xff, byteOffset);
        const needle = typeof value === "string" ? encodeString(value, encoding) : value;
        outer: for (let i = Math.min(byteOffset, this.length - needle.length); i >= 0; i--) {
            for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    includes(value, byteOffset, encoding) {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    _view() {
        return new DataView(this.buffer, this.byteOffset, this.byteLength);
    }

    _check(offset, size) {
        if (offset < 0 || offset + size > this.length) throw Object.assign(new RangeError(`The value of "offset" is out of range.`), {code: "ERR_OUT_OF_RANGE"});
    }
}

// read/write для целых и дробных чисел
const NUMBER_ACCESSORS = [
    ["UInt8", "Uint8", 1], ["Int8", "Int8", 1],
    ["UInt16LE", "Uint16", 2, true], ["UInt16BE", "Uint16", 2, false], ["Int16LE", "Int16", 2, true], ["Int16BE", "Int16", 2, false],
    ["UInt32LE", "Uint32", 4, true], ["UInt32BE", "Uint32", 4, false], ["Int32LE", "Int32", 4, true], ["Int32BE", "Int32", 4, false],
    ["FloatLE", "Float32", 4, true], ["FloatBE", "Float32", 4, false], ["DoubleLE", "Float64", 8, true], ["DoubleBE", "Float64", 8, false],
    ["BigInt64LE", "BigInt64", 8, true], ["BigInt64BE", "BigInt64", 8, false], ["BigUInt64LE", "BigUint64", 8, true], ["BigUInt64BE", "BigUint64", 8, false]
];
for (const [name, viewName, size, little] of NUMBER_ACCESSORS) {
    Buffer.prototype[`read${name}`] = function (offset = 0) {
        this._check(offset, size);
        return this._view()[`get${viewName}`](offset, little);
    };
    Buffer.prototype[`write${name}`] = function (value, offset = 0) {
        this._check(offset, size);
        this._view()[`set${viewName}`](offset, value, little);
        return offset + size;
    };
    if (name.startsWith("UInt")) {
        Buffer.prototype[`readUint${name.slice(4)}`] = Buffer.prototype[`read${name}`];
        Buffer.prototype[`writeUint${name.slice(4)}`] = Buffer.prototype[`write${name}`];
    }
}

module.exports = {Buffer, kMaxLength: 2 ** 32 - 1, constants: {MAX_LENGTH: 2 ** 32 - 1}};
