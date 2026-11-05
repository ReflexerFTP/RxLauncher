// Модуль path рантайма Tauri ведёт себя как настоящий Node (win32 и posix): случайные и граничные пути
const assert = require("node:assert/strict");
const nodePath = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require("node:path").join(__dirname, "../runtime/path.js"), "utf8");
const sandbox = {exports: {}};
vm.runInNewContext(source, {module: sandbox, exports: sandbox.exports, process: {cwd: () => process.cwd()}});
const ours = sandbox.exports;

const parts = ["C:", "C:\\", "c:/", "D:\\games", "\\", "/", "\\\\server\\share", "//server/share/x", ".", "..", "a", "b.txt", ".hidden",
    "dir\\", "dir/", "x.tar.gz", "..\\up", "a\\..\\b", "C:foo", "", "мод.jar", "a//b", "a\\.\\b", "...", "a.", ".a.b"];
const random = () => {
    const n = 1 + Math.floor(Math.random() * 4);
    return Array.from({length: n}, () => parts[Math.floor(Math.random() * parts.length)]);
};
const cases = [];
for (let i = 0; i < 4000; i++) cases.push(random());

// Пути пространства устройств (\\.\, \\?\) в Node 24 обрабатываются особо, а в лаунчере не встречаются
const deviceLike = value => /^[\\/]{2}[.?]([\\/]|$)/.test(value);
const check = (flavor, name, args) => {
    if (flavor === "win32" && args.some(arg => deviceLike(arg) || deviceLike(args.join("\\")))) return;
    if (flavor === "win32" && (name === "join" || name === "resolve") && deviceLike(nodePath.win32.join(...args))) return;
    const expected = (() => { try { return nodePath[flavor][name](...args); } catch (e) { return "THROW"; } })();
    const actual = (() => { try { return ours[flavor][name](...args); } catch (e) { return "THROW"; } })();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), `${flavor}.${name}(${JSON.stringify(args)})`);
};
// resolve зависит от cwd — сравниваем только для абсолютных путей
for (const flavor of ["win32", "posix"]) {
    for (const args of cases) {
        check(flavor, "join", args);
        check(flavor, "normalize", [args.join(flavor === "win32" ? "\\" : "/")]);
        for (const one of args) {
            for (const name of ["dirname", "basename", "extname", "isAbsolute", "parse"]) check(flavor, name, [one]);
            check(flavor, "basename", [one, ".txt"]);
        }
        const absolute = args.filter(item => nodePath[flavor].isAbsolute(item) && (flavor === "posix" || /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(item)));
        if (absolute.length) {
            check(flavor, "resolve", [absolute[0], ...args]);
            if (absolute.length > 1) check(flavor, "relative", [absolute[0], absolute[1]]);
        }
    }
}
for (const obj of [{dir: "C:\\a", base: "b.txt"}, {root: "C:\\", name: "x", ext: "jar"}, {name: "x", ext: ".y"}]) {
    assert.equal(ours.win32.format(obj), nodePath.win32.format(obj));
    assert.equal(ours.posix.format(obj), nodePath.posix.format(obj));
}
assert.equal(ours.sep, "\\");
assert.equal(ours.join("C:\\Users\\Reflex\\AppData\\Roaming", ".minecraft", "mods"), "C:\\Users\\Reflex\\AppData\\Roaming\\.minecraft\\mods");
console.log("path: OK");
