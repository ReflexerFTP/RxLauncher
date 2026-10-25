// Коды «Играть вместе»: кодирование, поиск кода в тексте приглашения и отказ от испорченных данных
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const context = vm.createContext({
    console, Buffer, require, path, fs, JSON,
    RxMinecraftServers: {
        normalizeAddress: (value) => {
            if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(value)) throw new Error("bad address");
            return value.toLowerCase();
        }
    }
});
const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxShare.js"), "utf8");
vm.runInContext(`${source}\nthis.RxShare = RxShare;`, context, {filename: "RxShare.js"});
const {RxShare} = context;

const data = {v: 1, n: "Выживание", g: "1.21.1", l: "fabric", m: ["AANobbMI", "P7dR8mSH"], r: ["abcdEFGH"], s: [], by: "Steve", sv: "Play.Example.org"};
const code = RxShare.encode(data);
assert.ok(code.startsWith("RX1-") && /^[\w-]+$/.test(code.slice(4)), "code must be URL-safe");

// Код находится внутри текста приглашения, адрес сервера нормализуется
const decoded = RxShare.decode(`Го играть!\nКод:\n${code}\nжду`);
assert.strictEqual(decoded.n, "Выживание");
assert.strictEqual(decoded.sv, "play.example.org");
assert.strictEqual(JSON.stringify(decoded.m), JSON.stringify(data.m));

const encodeRaw = (value) => "RX1-" + zlib.deflateRawSync(Buffer.from(JSON.stringify(value))).toString("base64url");
const rejects = (value, reason, message) => assert.throws(() => RxShare.decode(typeof value === "string" ? value : encodeRaw(value)), error => error.message === reason, message);

rejects("просто текст", "badCode", "text without a code");
rejects("RX1-AAAAAAAAAAAA", "badCode", "garbage payload");
rejects({...data, v: 2}, "badCode", "unknown format version");
rejects({...data, l: "custom"}, "badCode", "custom versions cannot be shared");
rejects({...data, g: "../../evil"}, "badCode", "game version is used in paths");
rejects({...data, m: ["../x"]}, "badCode", "file ids must be Modrinth version ids");
rejects({...data, m: Array(RxShare.MAX_FILES + 1).fill("AANobbMI")}, "badCode", "too many files");
rejects({...data, sv: "evil server; rm"}, "badServer", "server address is validated");

// Лишние поля отбрасываются, имя и ник очищаются
const cleaned = RxShare.decode(encodeRaw({...data, n: "a\u0000b".padEnd(100, "x"), by: "<script>", extra: "x"}));
assert.strictEqual(cleaned.n.length, 64);
assert.ok(!cleaned.n.includes("\u0000"));
assert.strictEqual(cleaned.by, "script");
assert.strictEqual(cleaned.extra, undefined);

console.log("Share code tests passed");
