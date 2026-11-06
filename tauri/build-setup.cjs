// Красивый установщик версии на Tauri: окно resources/installer/RxSetup.cs (символ TAURI) со встроенным NSIS Tauri.
//   node tauri/build-setup.cjs <RxLauncher_<версия>_x64-setup.exe> [папка вывода]
// Рядом получается «RxLauncher Setup <версия>.exe». Внутри — ещё и окно удаления: установщик кладёт его в папку
// лаунчера, и «Приложения» Windows открывают его вместо голого NSIS. Автообновление по-прежнему запускает сам NSIS.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");

const root = path.resolve(__dirname, "..");
const installerDir = path.join(root, "resources", "installer");
const version = require(path.join(root, "src-tauri", "tauri.conf.json")).version;

const payload = path.resolve(process.argv[2] || path.join(root, "src-tauri", "target", "release", "bundle", "nsis", `RxLauncher_${version}_x64-setup.exe`));
if (!fs.existsSync(payload)) throw new Error(`NSIS installer not found: ${payload}`);
const outDir = path.resolve(process.argv[3] || path.dirname(payload));
const output = path.join(outDir, `RxLauncher Setup ${version}.exe`);

const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) throw new Error(`C# compiler not found: ${csc}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-setup-"));
// Установленный лаунчер примерно на четверть больше сжатого NSIS — для полосы прогресса
fs.writeFileSync(path.join(temp, "version.txt"), version);
fs.writeFileSync(path.join(temp, "size.txt"), String(Math.round(fs.statSync(payload).size * 1.25)));

const resource = (file, name) => `/resource:${file},${name}`;
const compile = (out, extra) => {
    const log = execFileSync(csc, [
        "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", "/codepage:65001", "/define:TAURI",
        `/out:${out}`,
        `/win32icon:${path.join(root, "resources", "icon.ico")}`,
        `/win32manifest:${path.join(installerDir, "app.manifest")}`,
        "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
        resource(path.join(installerDir, "installer-art.png"), "installer-art.png"),
        resource(path.join(root, "web", "assets", "icon.png"), "logo.png"),
        resource(path.join(root, "resources", "icon.ico"), "icon.ico"),
        resource(path.join(temp, "version.txt"), "version.txt"),
        resource(path.join(temp, "size.txt"), "size.txt"),
        ...extra,
        path.join(installerDir, "RxSetup.cs")
    ], {encoding: "utf8"});
    if (log.trim()) console.log(log.trim());
};

try {
    // Без встроенного NSIS программа работает как окно удаления
    const uninstaller = path.join(temp, "RxUninstall.exe");
    compile(uninstaller, []);
    fs.mkdirSync(outDir, {recursive: true});
    compile(output, [resource(payload, "payload.exe"), resource(uninstaller, "uninstaller.exe")]);
    console.log(`SETUP OK ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}
