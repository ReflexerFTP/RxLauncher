// Buffer рантайма Tauri совпадает с Buffer из Node в том, что использует лаунчер
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = {exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../runtime/buffer.js"), "utf8"), {module: sandbox, exports: sandbox.exports, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Int16Array, SharedArrayBuffer});
const Ours = sandbox.exports.Buffer;
const same = (a, b, message) => assert.deepEqual(Array.from(a), Array.from(b), message);

const strings = ["", "hello", "Привет, мир", "😀 emoji", "a".repeat(1000), "\u0000ÿĀ"];
const encodings = ["utf8", "utf-8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", "ucs2"];
for (const text of strings) {
    for (const encoding of encodings) {
        const source = encoding === "hex" ? Buffer.from(text).toString("hex") : encoding.startsWith("base64") ? Buffer.from(text).toString(encoding) : text;
        same(Ours.from(source, encoding), Buffer.from(source, encoding), `from ${encoding} ${text.slice(0, 10)}`);
        assert.equal(Ours.from(text).toString(encoding), Buffer.from(text).toString(encoding), `toString ${encoding}`);
        assert.equal(Ours.byteLength(source, encoding), Buffer.byteLength(source, encoding));
    }
}
for (let n = 0; n < 50; n++) {
    const bytes = Array.from({length: n}, () => Math.floor(Math.random() * 256));
    for (const encoding of ["hex", "base64", "base64url", "latin1", "utf8"]) assert.equal(Ours.from(bytes).toString(encoding), Buffer.from(bytes).toString(encoding));
}
const a = Ours.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const b = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
for (const name of ["readUInt8", "readInt8", "readUInt16BE", "readUInt16LE", "readInt16BE", "readUInt32BE", "readUInt32LE", "readInt32BE", "readInt32LE", "readFloatBE", "readDoubleLE", "readBigInt64BE"]) {
    assert.equal(a[name](1), b[name](1), name);
}
assert.throws(() => a.readUInt32BE(8));
const w1 = Ours.alloc(8), w2 = Buffer.alloc(8);
w1.writeUInt32BE(0xdeadbeef, 0); w2.writeUInt32BE(0xdeadbeef, 0);
w1.writeInt16LE(-2, 4); w2.writeInt16LE(-2, 4);
same(w1, w2);
same(Ours.concat([Ours.from("ab"), Ours.from("cd")]), Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]));
same(Ours.concat([Ours.from("abcdef")], 3), Buffer.from("abc"));
assert.equal(Ours.isBuffer(a), true);
assert.equal(Ours.isBuffer(new Uint8Array(2)), false);
assert.equal(a.slice(2, 4) instanceof Ours, true);
const view = a.slice(0, 2); view[0] = 99; assert.equal(a[0], 99, "slice shares memory");
assert.equal(Ours.from("hello world").indexOf("world"), 6);
assert.equal(Ours.from("hello world").includes("xyz"), false);
assert.equal(Ours.from("abc").equals(Ours.from("abc")), true);
same(Ours.alloc(5, "ab"), Buffer.alloc(5, "ab"));
same(Ours.alloc(3, 7), Buffer.alloc(3, 7));
assert.equal(JSON.stringify(Ours.from("hi").toJSON()), JSON.stringify(Buffer.from("hi").toJSON()));
same(Ours.from(new Uint16Array([1, 2]).buffer), Buffer.from(new Uint16Array([1, 2]).buffer));
assert.equal(Ours.from("héllo").toString("utf8", 1, 3), Buffer.from("héllo").toString("utf8", 1, 3));
const target = Ours.alloc(4); Ours.from("xyz").copy(target, 1); same(target, Buffer.from([0, 120, 121, 122]));
console.log("buffer: OK");
