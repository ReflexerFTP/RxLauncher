"use strict";

const assert = require("assert");
const path = require("path");
const {
    APP_USER_MODEL_ID,
    CONFIG_KEY,
    DEFAULT_AVATAR_ID,
    LAUNCHER_AVATARS,
    normalizeAvatarId,
    getAvatarMetadata,
    resolveSelectedAvatarId,
    readSelectedAvatarId,
    createLauncherBranding
} = require("../launcherBranding");

const winPath = path.win32;

const createFakeFs = (entries = {}) => {
    const files = new Map(Object.entries(entries));
    return {
        existsSync: (filePath) => files.has(filePath),
        readFileSync: (filePath) => {
            if (!files.has(filePath)) throw new Error("ENOENT");
            return files.get(filePath);
        },
        statSync: (filePath) => {
            if (!files.has(filePath)) throw new Error("ENOENT");
            const value = files.get(filePath);
            return {
                isFile: () => true,
                size: Buffer.byteLength(String(value), "utf8")
            };
        }
    };
};

assert.strictEqual(APP_USER_MODEL_ID, "ru.maxrx.rxlauncher");
assert.strictEqual(DEFAULT_AVATAR_ID, "classic");
assert.strictEqual(CONFIG_KEY, "launcherAvatarId");
assert.deepStrictEqual(LAUNCHER_AVATARS.map(({id}) => id), ["classic"], "Only the main launcher icon remains");
for (const avatar of LAUNCHER_AVATARS) {
    assert.match(avatar.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!avatar.pngRelativePath.includes(".."), `Unsafe PNG path for ${avatar.id}`);
    assert.ok(!avatar.icoRelativePath.includes(".."), `Unsafe ICO path for ${avatar.id}`);
    assert.ok(avatar.pngRelativePath.endsWith(".png"));
    assert.ok(avatar.icoRelativePath.endsWith(".ico"));
    assert.ok(Object.isFrozen(avatar));
}
assert.ok(Object.isFrozen(LAUNCHER_AVATARS));
assert.strictEqual(getAvatarMetadata("classic").pngRelativePath, "web/assets/icon.png");
assert.strictEqual(getAvatarMetadata("classic").icoRelativePath, "resources/icon.ico");
// Previously selectable avatars now fall back to the main icon
assert.strictEqual(getAvatarMetadata("ember").id, "classic");

assert.strictEqual(normalizeAvatarId("classic"), "classic");
assert.strictEqual(normalizeAvatarId("violet"), "classic");
assert.strictEqual(normalizeAvatarId("../violet"), "classic");
assert.strictEqual(normalizeAvatarId(null), "classic");
assert.strictEqual(resolveSelectedAvatarId({launcherAvatarId: "celestial"}), "classic");
assert.strictEqual(resolveSelectedAvatarId({launcherAvatarId: "C:\\evil.ico"}), "classic");
assert.strictEqual(resolveSelectedAvatarId([]), "classic");
assert.strictEqual(resolveSelectedAvatarId(null), "classic");
const inheritedConfig = Object.create({launcherAvatarId: "neon"});
assert.strictEqual(resolveSelectedAvatarId(inheritedConfig), "classic", "Inherited config properties are ignored");

{
    const configPath = "C:\\Users\\Tester\\AppData\\Roaming\\rxclient\\config.json";
    assert.strictEqual(
        readSelectedAvatarId(configPath, {fs: createFakeFs({[configPath]: "\uFEFF{\"launcherAvatarId\":\"frost\"}"})}),
        "classic"
    );
    assert.strictEqual(
        readSelectedAvatarId(configPath, {fs: createFakeFs({[configPath]: "{broken"})}),
        "classic"
    );
    assert.strictEqual(readSelectedAvatarId(configPath, {fs: createFakeFs()}), "classic");
    assert.strictEqual(
        readSelectedAvatarId(configPath, {
            fs: {
                statSync: () => ({isFile: () => true, size: 1024 * 1024 + 1}),
                readFileSync: () => { throw new Error("Oversized config must not be read"); }
            }
        }),
        "classic"
    );
}

const appPath = "C:\\Program Files\\RxLauncher\\resources\\app.asar";
const resourcesPath = "C:\\Program Files\\RxLauncher\\resources";
const executablePath = "C:\\Program Files\\RxLauncher\\RxLauncher.exe";
const desktopPath = "C:\\Users\\Tester\\Desktop";
const appDataPath = "C:\\Users\\Tester\\AppData\\Roaming";
const desktopShortcut = winPath.join(desktopPath, "RxLauncher.lnk");
const startMenuShortcut = winPath.join(
    appDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "RxLauncher.lnk"
);
const emberPng = winPath.join(appPath, "web", "assets", "icon.png");
const emberIco = winPath.join(resourcesPath, "icon.ico");

{
    let appliedAppId = "";
    let appliedWindowIcon = null;
    const fakeIcon = {isEmpty: () => false};
    const branding = createLauncherBranding({
        fs: createFakeFs({[emberPng]: "png"}),
        path: winPath,
        platform: "win32",
        isPackaged: false,
        appPath,
        resourcesPath,
        executablePath,
        app: {
            setAppUserModelId: (value) => { appliedAppId = value; },
            getPath: () => { throw new Error("Shortcuts must be gated in development"); }
        },
        nativeImage: {
            createFromPath: (value) => {
                assert.strictEqual(value, emberPng);
                return fakeIcon;
            }
        }
    });

    assert.deepStrictEqual(branding.resolveAvatarPaths("ember"), {
        avatarId: "classic",
        pngPath: emberPng,
        icoPath: emberIco
    });
    assert.strictEqual(branding.applyAppUserModelId(), true);
    assert.strictEqual(appliedAppId, APP_USER_MODEL_ID);
    const windowResult = branding.applyWindowIcon({setIcon: (icon) => { appliedWindowIcon = icon; }}, "ember");
    assert.strictEqual(windowResult.applied, true);
    assert.strictEqual(appliedWindowIcon, fakeIcon);
    assert.strictEqual(branding.updateExistingShortcuts("ember").reason, "not-packaged");
}

{
    const writeCalls = [];
    const existingDetails = {
        target: executablePath.toUpperCase(),
        cwd: winPath.dirname(executablePath),
        args: "--from-shortcut",
        description: "RxLauncher"
    };
    const fakeFs = createFakeFs({
        [emberIco]: "ico",
        [desktopShortcut]: "lnk",
        [startMenuShortcut]: "lnk"
    });
    const branding = createLauncherBranding({
        fs: fakeFs,
        path: winPath,
        platform: "win32",
        isPackaged: true,
        appPath,
        resourcesPath,
        executablePath,
        app: {
            isPackaged: true,
            getPath: (name) => name === "desktop" ? desktopPath : appDataPath
        },
        shell: {
            readShortcutLink: (shortcutPath) => {
                assert.ok(shortcutPath === desktopShortcut || shortcutPath === startMenuShortcut);
                return {...existingDetails};
            },
            writeShortcutLink: (shortcutPath, operation, details) => {
                writeCalls.push({shortcutPath, operation, details});
                return true;
            }
        }
    });

    const result = branding.updateExistingShortcuts("ember");
    assert.strictEqual(result.eligible, true);
    assert.deepStrictEqual(result.updated.map(({location}) => location), ["desktop", "start-menu"]);
    assert.strictEqual(writeCalls.length, 2);
    for (const call of writeCalls) {
        assert.strictEqual(call.operation, "update", "Shortcuts must never be created by the branding module");
        assert.strictEqual(call.details.target, existingDetails.target);
        assert.strictEqual(call.details.args, existingDetails.args, "Existing shortcut arguments must be preserved");
        assert.strictEqual(call.details.icon, emberIco);
        assert.strictEqual(call.details.iconIndex, 0);
        assert.strictEqual(call.details.appUserModelId, APP_USER_MODEL_ID);
    }
}

{
    let writeCount = 0;
    const fakeFs = createFakeFs({
        [emberIco]: "ico",
        [desktopShortcut]: "lnk"
    });
    const branding = createLauncherBranding({
        fs: fakeFs,
        path: winPath,
        platform: "win32",
        isPackaged: true,
        appPath,
        resourcesPath,
        executablePath,
        app: {
            isPackaged: true,
            getPath: (name) => name === "desktop" ? desktopPath : appDataPath
        },
        shell: {
            readShortcutLink: () => ({target: "C:\\OtherApp\\RxLauncher.exe"}),
            writeShortcutLink: () => { writeCount += 1; return true; }
        }
    });

    const result = branding.updateExistingShortcuts("../../outside");
    assert.strictEqual(result.avatarId, "classic", "Unknown ids must resolve to the allowlisted default");
    assert.strictEqual(writeCount, 0);

    const mismatch = branding.updateExistingShortcuts("ember");
    assert.strictEqual(mismatch.updated.length, 0);
    assert.strictEqual(mismatch.skipped[0].reason, "target-mismatch");
    assert.strictEqual(writeCount, 0, "A same-name shortcut targeting another app must not be modified");
}

{
    const branding = createLauncherBranding({
        fs: createFakeFs({[emberIco]: "ico"}),
        path: winPath,
        platform: "linux",
        isPackaged: true,
        appPath,
        resourcesPath,
        executablePath
    });
    assert.strictEqual(branding.applyAppUserModelId(), false);
    assert.strictEqual(branding.updateExistingShortcuts("ember").reason, "unsupported-platform");
}

console.log("RxLauncher branding backend tests passed");
