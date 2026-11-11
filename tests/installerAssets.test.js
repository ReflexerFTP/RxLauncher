// Установщик версии на Tauri: своё окно (resources/installer/RxSetup.cs) со встроенным NSIS Tauri, арт и значки
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const tauriConfig = require(path.join(root, "src-tauri", "tauri.conf.json"));

const assertPng = (relativePath) => {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.length > 128, `PNG is unexpectedly small: ${relativePath}`);
    assert.deepStrictEqual(
        [...buffer.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `Invalid PNG signature: ${relativePath}`
    );
};

const assertIco = (relativePath) => {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.length > 1024, `ICO is unexpectedly small: ${relativePath}`);
    assert.strictEqual(buffer.readUInt16LE(0), 0, `Invalid ICO reserved field: ${relativePath}`);
    assert.strictEqual(buffer.readUInt16LE(2), 1, `Invalid ICO image type: ${relativePath}`);
    assert.ok(buffer.readUInt16LE(4) >= 7, `ICO must contain at least seven resolutions: ${relativePath}`);
};

const assertWebp = (relativePath) => {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.length > 1024, `WebP is unexpectedly small: ${relativePath}`);
    assert.strictEqual(buffer.toString("latin1", 0, 4), "RIFF", `Invalid WebP signature: ${relativePath}`);
    assert.strictEqual(buffer.toString("latin1", 8, 12), "WEBP", `Invalid WebP signature: ${relativePath}`);
};

const assertJpeg = (relativePath) => {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.length > 1024, `JPEG is unexpectedly small: ${relativePath}`);
    assert.strictEqual(buffer[0], 0xff, `Invalid JPEG signature: ${relativePath}`);
    assert.strictEqual(buffer[1], 0xd8, `Invalid JPEG signature: ${relativePath}`);
    assert.strictEqual(buffer.at(-2), 0xff, `Invalid JPEG trailer: ${relativePath}`);
    assert.strictEqual(buffer.at(-1), 0xd9, `Invalid JPEG trailer: ${relativePath}`);
};

// Версия установщика совпадает с лентой обновлений и с ядром
const latestPatchVersion = fs.readFileSync(path.join(root, "web", "js", "RxPatchNotes.js"), "utf8").match(/version:\s*"([\d.]+)"/)[1];
assert.strictEqual(packageJson.version, latestPatchVersion, "Installer version must match the patch feed");
assert.strictEqual(tauriConfig.version, packageJson.version, "Tauri core version must match package.json");
assert.deepStrictEqual(tauriConfig.bundle.targets, ["nsis"]);

// Собственный установщик: исходник, манифест без прав администратора, арт и скрипт сборки
const installerDir = path.join(root, "resources", "installer");
for (const file of ["RxSetup.cs", "app.manifest", "art/render.js", "art/render.html"]) {
    assert.ok(fs.existsSync(path.join(installerDir, file)), `Custom installer file is missing: ${file}`);
}
assert.ok(fs.existsSync(path.join(root, "tauri", "build-setup.cjs")), "The Tauri installer build script is missing");
assertPng("resources/installer/installer-art.png");
const manifest = fs.readFileSync(path.join(installerDir, "app.manifest"), "utf8");
assert.ok(manifest.includes('level="asInvoker"'), "The custom installer must not require administrator rights");
const setupSource = fs.readFileSync(path.join(installerDir, "RxSetup.cs"), "utf8");
assert.ok(!/https?:\/\//.test(setupSource.replace(/http:\/\/schemas[^"]*/g, "")), "The custom installer must not contain website links");
assert.ok(setupSource.includes("_?="), "The custom uninstaller must wait for NSIS in place");
assert.ok(setupSource.includes("installer-tabs.json"), "The installer must hand the chosen tabs to the launcher");
// Вкладки, которые предлагает установщик, есть в лаунчере
const tabs = setupSource.match(/AllTabs = \{([^}]*)\}/)[1].match(/"([a-z]+)"/g).map(item => item.slice(1, -1));
const launcherTabs = fs.readFileSync(path.join(root, "web", "js", "RxTabs.js"), "utf8").match(/static ALL = \[([^\]]*)\]/)[1];
for (const tab of tabs) assert.ok(launcherTabs.includes(`"${tab}"`), `Installer offers a tab the launcher does not have: ${tab}`);
const buildSetup = fs.readFileSync(path.join(root, "tauri", "build-setup.cjs"), "utf8");
assert.ok(buildSetup.includes("TAURI"), "The installer must be built with the TAURI symbol");

assertPng("web/assets/icon.png");
assertIco("resources/icon.ico");

for (const wallpaperId of [6, 7, 8]) {
    assertJpeg(`web/assets/backgrounds/${wallpaperId}.jpg`);
    assertJpeg(`web/assets/backgrounds/min/${wallpaperId}.jpg`);
}

for (const version of ["1.18", "1.19", "1.20", "1.21"]) {
    assertWebp(`web/assets/version-heroes/${version}.webp`);
}

console.log("RxLauncher installer asset tests passed");
