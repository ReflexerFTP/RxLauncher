// Сборка собственного установщика и деинсталлятора (csc из .NET Framework 4.x).
//   node build-installer.cjs --uninstaller          → resources/installer/build/RxUninstall.exe (кладётся в папку лаунчера)
//   node build-installer.cjs <папка сборки>         → «RxLauncher Setup <версия>.exe» со встроенным NSIS
//   node build-installer.cjs <папка> --no-payload   → окно для проверки дизайна без установки
// NSIS собирается electron-builder как «RxLauncher-Core-<версия>.exe» — на него же ссылается latest.yml автообновлений.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFileSync} = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const version = require(path.join(root, "package.json")).version;
const uninstallerOnly = process.argv.includes("--uninstaller");
const withPayload = !uninstallerOnly && !process.argv.includes("--no-payload");
const distDir = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) || path.join(root, "dist-design"));

const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
if (!fs.existsSync(csc)) throw new Error(`C# compiler not found: ${csc}`);

const payload = path.join(distDir, `RxLauncher-Core-${version}.exe`);
if (withPayload && !fs.existsSync(payload)) throw new Error(`NSIS installer not found: ${payload}`);

// Объём распакованного лаунчера — для полосы прогресса
const dirSize = (dir) => fs.readdirSync(dir, {withFileTypes: true}).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? dirSize(full) : fs.statSync(full).size);
}, 0);
const unpacked = path.join(distDir, "win-unpacked");
const expectedBytes = fs.existsSync(unpacked) ? dirSize(unpacked) : 360 * 1024 * 1024;

const output = uninstallerOnly
    ? path.join(__dirname, "build", "RxUninstall.exe")
    : path.join(distDir, withPayload ? `RxLauncher Setup ${version}.exe` : "RxLauncher Setup preview.exe");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-installer-"));
fs.writeFileSync(path.join(temp, "version.txt"), version);
fs.writeFileSync(path.join(temp, "size.txt"), String(expectedBytes));

const resource = (file, name) => `/resource:${file},${name}`;
const args = [
    "/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", "/codepage:65001",
    `/out:${output}`,
    `/win32icon:${path.join(root, "resources", "icon.ico")}`,
    `/win32manifest:${path.join(__dirname, "app.manifest")}`,
    "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
    resource(path.join(__dirname, "installer-art.png"), "installer-art.png"),
    resource(path.join(root, "web", "assets", "icon.png"), "logo.png"),
    resource(path.join(root, "resources", "icon.ico"), "icon.ico"),
    resource(path.join(temp, "version.txt"), "version.txt"),
    resource(path.join(temp, "size.txt"), "size.txt"),
    ...(withPayload ? [resource(payload, "payload.exe")] : []),
    path.join(__dirname, "RxSetup.cs")
];

try {
    fs.mkdirSync(path.dirname(output), {recursive: true});
    const log = execFileSync(csc, args, {encoding: "utf8"});
    if (log.trim()) console.log(log.trim());
    console.log(`INSTALLER OK ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}
