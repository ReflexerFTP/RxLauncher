const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));

const bitmapInfo = (relativePath) => {
    const absolutePath = path.join(root, relativePath);
    assert.ok(fs.existsSync(absolutePath), `Missing installer asset: ${relativePath}`);
    const buffer = fs.readFileSync(absolutePath);
    assert.ok(buffer.length >= 54, `Invalid BMP header: ${relativePath}`);
    assert.strictEqual(buffer.toString("ascii", 0, 2), "BM", `Not a BMP file: ${relativePath}`);
    return {
        width: buffer.readInt32LE(18),
        height: Math.abs(buffer.readInt32LE(22)),
        bitsPerPixel: buffer.readUInt16LE(28)
    };
};

const assertBitmap = (relativePath, width, height) => {
    const info = bitmapInfo(relativePath);
    assert.deepStrictEqual(info, {width, height, bitsPerPixel: 24}, `Wrong NSIS bitmap format: ${relativePath}`);
};

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

const assertJpeg = (relativePath) => {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    assert.ok(buffer.length > 1024, `JPEG is unexpectedly small: ${relativePath}`);
    assert.strictEqual(buffer[0], 0xff, `Invalid JPEG signature: ${relativePath}`);
    assert.strictEqual(buffer[1], 0xd8, `Invalid JPEG signature: ${relativePath}`);
    assert.strictEqual(buffer.at(-2), 0xff, `Invalid JPEG trailer: ${relativePath}`);
    assert.strictEqual(buffer.at(-1), 0xd9, `Invalid JPEG trailer: ${relativePath}`);
};

const latestPatchVersion = fs.readFileSync(path.join(root, "web", "js", "RxPatchNotes.js"), "utf8").match(/version:\s*"([\d.]+)"/)[1];
assert.strictEqual(packageJson.version, latestPatchVersion, "Installer version must match the patch feed");
assert.strictEqual(packageJson.build.nsis.oneClick, false, "Branded sidebar requires the assisted installer");
assert.strictEqual(packageJson.build.nsis.include, "resources/installer.nsh");

assertBitmap(packageJson.build.nsis.installerSidebar, 164, 314);
assertBitmap(packageJson.build.nsis.installerHeader, 150, 57);
assertBitmap(packageJson.build.nsis.uninstallerSidebar, 164, 314);
assertBitmap("resources/uninstallerHeaderRx.bmp", 150, 57);

const include = fs.readFileSync(path.join(root, packageJson.build.nsis.include), "utf8");
assert.ok(include.includes("uninstallerHeaderRx.bmp"), "Uninstaller header artwork is not configured");
assert.ok(include.includes("RX_WELCOME_TITLE"), "Branded installer text is missing");
assert.ok(fs.existsSync(path.join(root, "resources", "installer-art-master-rx.png")), "Generated master artwork is missing");
assert.ok(fs.existsSync(path.join(root, "resources", "logo", "generate_installer_assets.py")), "Installer asset generator is missing");

// Без сайта в установщике
assert.ok(!include.includes("rxlauncher.ru"), "The installer must not link to the website");
assert.ok(!include.includes("MUI_FINISHPAGE_LINK "), "The finish page must not have a website link");

// Собственный установщик: исходник, манифест без прав администратора, арт и скрипты сборки
const installerDir = path.join(root, "resources", "installer");
for (const file of ["RxSetup.cs", "app.manifest", "build-installer.cjs", "art/render.js", "art/render-art.cjs"]) {
    assert.ok(fs.existsSync(path.join(installerDir, file)), `Custom installer file is missing: ${file}`);
}
assertPng("resources/installer/installer-art.png");
const manifest = fs.readFileSync(path.join(installerDir, "app.manifest"), "utf8");
assert.ok(manifest.includes('level="asInvoker"'), "The custom installer must not require administrator rights");
const setupSource = fs.readFileSync(path.join(installerDir, "RxSetup.cs"), "utf8");
assert.ok(setupSource.includes("/S /currentuser /D="), "The custom installer must run NSIS silently per user");
assert.ok(!/https?:\/\//.test(setupSource.replace(/http:\/\/schemas[^"]*/g, "")), "The custom installer must not contain website links");
assert.ok(packageJson.build.files.includes("!resources/installer{,/**/*}"), "Installer sources must not be packed into the app");

// Основной установщик — собственный; NSIS-ядро под своим именем (на него ссылается latest.yml)
assert.strictEqual(packageJson.build.nsis.artifactName, "RxLauncher-Core-${version}.${ext}");
const buildScript = fs.readFileSync(path.join(installerDir, "build-installer.cjs"), "utf8");
assert.ok(buildScript.includes("RxLauncher Setup ${version}.exe"), "The custom installer must be the main “RxLauncher Setup” file");
assert.ok(buildScript.includes("RxLauncher-Core-${version}.exe"), "The custom installer must embed the NSIS core");

// Красивое удаление: деинсталлятор в папке лаунчера, NSIS открывает его только при ручном запуске
assert.ok(
    include.includes("!macro customInstall") && include.includes("installer\\build\\RxUninstall.exe"),
    "The custom uninstaller must be installed next to the launcher"
);
assert.ok(include.includes("!macro customUnInit") && include.includes("${IfNot} ${Silent}"), "Only interactive uninstall may open the custom window");
assert.ok(setupSource.includes("_?="), "The custom uninstaller must wait for NSIS in place");
assert.ok(setupSource.includes("installer-tabs.json"), "The installer must hand the chosen tabs to the launcher");

const extraResources = packageJson.build.extraResources || [];
assert.ok(
    extraResources.some((entry) => entry.from === "resources/icon.ico" && entry.to === "icon.ico"),
    "The classic runtime icon must be copied outside app.asar"
);
assert.ok(
    !extraResources.some((entry) => entry.from === "resources/launcher-avatars"),
    "Selectable launcher avatars were removed and must not be shipped"
);
assertPng("web/assets/icon.png");
assertIco("resources/icon.ico");

for (const wallpaperId of [6, 7, 8]) {
    assertJpeg(`web/assets/backgrounds/${wallpaperId}.jpg`);
    assertJpeg(`web/assets/backgrounds/min/${wallpaperId}.jpg`);
}

assertPng("web/assets/skins/default-steve.png");
for (const version of ["1.18", "1.19", "1.20", "1.21"]) {
    assertPng(`web/assets/version-heroes/${version}.png`);
}
assert.ok(
    packageJson.build.files.includes("!web/assets/**/*.source.png"),
    "Image-generation source files must not inflate the installer"
);

console.log("RxLauncher installer asset tests passed");
