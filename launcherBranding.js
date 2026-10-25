"use strict";

const fs = require("fs");
const path = require("path");

const APP_USER_MODEL_ID = "ru.maxrx.rxlauncher";
const CONFIG_KEY = "launcherAvatarId";
const DEFAULT_AVATAR_ID = "classic";
const MAX_CONFIG_BYTES = 1024 * 1024;

const createAvatar = (id, label, accent, pngRelativePath, icoRelativePath) => Object.freeze({
    id,
    label,
    accent,
    pngRelativePath,
    icoRelativePath
});

// Paths in this registry are build-time, repository-relative paths. PNG files
// live in app.asar and are used by the renderer/window. ICO files are copied by
// electron-builder to process.resourcesPath so Windows Explorer can read them.
// Selectable avatars were removed: any previously saved id resolves to "classic",
// so existing windows and shortcuts are switched back to the main icon on start.
const LAUNCHER_AVATARS = Object.freeze([
    createAvatar("classic", "Rx Classic", "#e53935", "web/assets/icon.png", "resources/icon.ico")
]);

const AVATARS_BY_ID = new Map(LAUNCHER_AVATARS.map((avatar) => [avatar.id, avatar]));

function normalizeAvatarId(value) {
    return typeof value === "string" && AVATARS_BY_ID.has(value)
        ? value
        : DEFAULT_AVATAR_ID;
}

function getAvatarMetadata(value) {
    return AVATARS_BY_ID.get(normalizeAvatarId(value));
}

function resolveSelectedAvatarId(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return DEFAULT_AVATAR_ID;
    }
    if (!Object.prototype.hasOwnProperty.call(config, CONFIG_KEY)) {
        return DEFAULT_AVATAR_ID;
    }
    return normalizeAvatarId(config[CONFIG_KEY]);
}

function readSelectedAvatarId(configPath, dependencies = {}) {
    const fileSystem = dependencies.fs || fs;
    if (typeof configPath !== "string" || configPath.length === 0) {
        return DEFAULT_AVATAR_ID;
    }

    try {
        if (typeof fileSystem.statSync === "function") {
            const stats = fileSystem.statSync(configPath);
            if (!stats || !stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
                return DEFAULT_AVATAR_ID;
            }
        }

        let contents = fileSystem.readFileSync(configPath, "utf8");
        if (Buffer.isBuffer(contents)) {
            contents = contents.toString("utf8");
        }
        if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_CONFIG_BYTES) {
            return DEFAULT_AVATAR_ID;
        }

        // JSON files written by third-party editors may start with an UTF-8 BOM.
        const parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
        return resolveSelectedAvatarId(parsed);
    } catch {
        return DEFAULT_AVATAR_ID;
    }
}

function createLauncherBranding(dependencies = {}) {
    const fileSystem = dependencies.fs || fs;
    const pathApi = dependencies.path || path;
    const electronApp = dependencies.app || null;
    const electronShell = dependencies.shell || null;
    const nativeImage = dependencies.nativeImage || null;
    const platform = dependencies.platform || process.platform;
    const executablePath = dependencies.executablePath || process.execPath;

    const isPackaged = typeof dependencies.isPackaged === "boolean"
        ? dependencies.isPackaged
        : electronApp?.isPackaged === true;
    const appPath = dependencies.appPath
        || (typeof electronApp?.getAppPath === "function" ? electronApp.getAppPath() : "");
    const resourcesPath = dependencies.resourcesPath || process.resourcesPath || "";

    const resolvePathInside = (basePath, relativePath) => {
        if (typeof basePath !== "string" || basePath.length === 0) {
            return null;
        }
        if (typeof relativePath !== "string" || relativePath.length === 0 || pathApi.isAbsolute(relativePath)) {
            return null;
        }

        const base = pathApi.resolve(basePath);
        const resolved = pathApi.resolve(base, relativePath);
        const relative = pathApi.relative(base, resolved);
        if (relative === "" || relative === ".") {
            return resolved;
        }
        if (relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
            return null;
        }
        return resolved;
    };

    const resolveAvatarPaths = (avatarId) => {
        const avatar = getAvatarMetadata(avatarId);
        const externalIcoRelativePath = pathApi.relative("resources", avatar.icoRelativePath);
        return Object.freeze({
            avatarId: avatar.id,
            pngPath: resolvePathInside(appPath, avatar.pngRelativePath),
            icoPath: resolvePathInside(resourcesPath, externalIcoRelativePath)
        });
    };

    const applyAppUserModelId = () => {
        if (platform !== "win32") {
            return false;
        }
        if (typeof electronApp?.setAppUserModelId !== "function") {
            return false;
        }
        try {
            electronApp.setAppUserModelId(APP_USER_MODEL_ID);
            return true;
        } catch {
            return false;
        }
    };

    const applyWindowIcon = (browserWindow, avatarId) => {
        const avatarPaths = resolveAvatarPaths(avatarId);
        if (!browserWindow || typeof browserWindow.setIcon !== "function") {
            return {applied: false, avatarId: avatarPaths.avatarId, reason: "invalid-window"};
        }
        if (typeof browserWindow.isDestroyed === "function" && browserWindow.isDestroyed()) {
            return {applied: false, avatarId: avatarPaths.avatarId, reason: "window-destroyed"};
        }
        let pngExists = false;
        try {
            pngExists = Boolean(avatarPaths.pngPath && fileSystem.existsSync(avatarPaths.pngPath));
        } catch {
            pngExists = false;
        }
        if (!pngExists) {
            return {applied: false, avatarId: avatarPaths.avatarId, reason: "png-missing"};
        }

        try {
            let icon = avatarPaths.pngPath;
            if (typeof nativeImage?.createFromPath === "function") {
                icon = nativeImage.createFromPath(avatarPaths.pngPath);
                if (!icon || (typeof icon.isEmpty === "function" && icon.isEmpty())) {
                    return {applied: false, avatarId: avatarPaths.avatarId, reason: "invalid-png"};
                }
            }
            browserWindow.setIcon(icon);
            return {applied: true, avatarId: avatarPaths.avatarId, path: avatarPaths.pngPath};
        } catch (error) {
            return {
                applied: false,
                avatarId: avatarPaths.avatarId,
                reason: "set-icon-failed",
                error: error instanceof Error ? error.message : String(error)
            };
        }
    };

    const getShortcutCandidates = () => {
        if (typeof electronApp?.getPath !== "function") {
            return [];
        }

        const candidates = [];
        try {
            const desktopPath = electronApp.getPath("desktop");
            const shortcutPath = resolvePathInside(desktopPath, "RxLauncher.lnk");
            if (shortcutPath) candidates.push({location: "desktop", path: shortcutPath});
        } catch {
            // A missing shell folder must not block launcher startup.
        }

        try {
            const appDataPath = electronApp.getPath("appData");
            const shortcutPath = resolvePathInside(
                appDataPath,
                pathApi.join("Microsoft", "Windows", "Start Menu", "Programs", "RxLauncher.lnk")
            );
            if (shortcutPath) candidates.push({location: "start-menu", path: shortcutPath});
        } catch {
            // A missing shell folder must not block launcher startup.
        }
        return candidates;
    };

    const sameWindowsPath = (left, right) => {
        if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) {
            return false;
        }
        return pathApi.resolve(left).toLocaleLowerCase("en-US")
            === pathApi.resolve(right).toLocaleLowerCase("en-US");
    };

    const updateExistingShortcuts = (avatarId) => {
        const avatarPaths = resolveAvatarPaths(avatarId);
        const result = {
            eligible: false,
            avatarId: avatarPaths.avatarId,
            iconPath: avatarPaths.icoPath,
            updated: [],
            skipped: []
        };

        if (platform !== "win32") {
            result.reason = "unsupported-platform";
            return result;
        }
        if (!isPackaged) {
            result.reason = "not-packaged";
            return result;
        }
        if (!electronShell
            || typeof electronShell.readShortcutLink !== "function"
            || typeof electronShell.writeShortcutLink !== "function") {
            result.reason = "shortcut-api-unavailable";
            return result;
        }
        let icoExists = false;
        try {
            icoExists = Boolean(avatarPaths.icoPath && fileSystem.existsSync(avatarPaths.icoPath));
        } catch {
            icoExists = false;
        }
        if (!icoExists) {
            result.reason = "ico-missing";
            return result;
        }

        result.eligible = true;
        for (const candidate of getShortcutCandidates()) {
            let shortcutExists = false;
            try {
                shortcutExists = fileSystem.existsSync(candidate.path);
            } catch {
                shortcutExists = false;
            }
            if (!shortcutExists) {
                result.skipped.push({...candidate, reason: "shortcut-missing"});
                continue;
            }

            try {
                const existingDetails = electronShell.readShortcutLink(candidate.path);
                if (!existingDetails || !sameWindowsPath(existingDetails.target, executablePath)) {
                    result.skipped.push({...candidate, reason: "target-mismatch"});
                    continue;
                }

                const updated = electronShell.writeShortcutLink(candidate.path, "update", {
                    ...existingDetails,
                    target: existingDetails.target,
                    icon: avatarPaths.icoPath,
                    iconIndex: 0,
                    appUserModelId: APP_USER_MODEL_ID
                });
                if (updated === true) {
                    result.updated.push(candidate);
                } else {
                    result.skipped.push({...candidate, reason: "update-rejected"});
                }
            } catch (error) {
                result.skipped.push({
                    ...candidate,
                    reason: "shortcut-error",
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        return result;
    };

    const applyBranding = (browserWindow, avatarId) => ({
        avatarId: normalizeAvatarId(avatarId),
        appUserModelIdApplied: applyAppUserModelId(),
        window: applyWindowIcon(browserWindow, avatarId),
        shortcuts: updateExistingShortcuts(avatarId)
    });

    return Object.freeze({
        appUserModelId: APP_USER_MODEL_ID,
        listAvatars: () => LAUNCHER_AVATARS,
        getAvatarMetadata,
        normalizeAvatarId,
        resolveSelectedAvatarId,
        readSelectedAvatarId: (configPath) => readSelectedAvatarId(configPath, {fs: fileSystem}),
        resolveAvatarPaths,
        applyAppUserModelId,
        applyWindowIcon,
        updateExistingShortcuts,
        applyBranding
    });
}

module.exports = Object.freeze({
    APP_USER_MODEL_ID,
    CONFIG_KEY,
    DEFAULT_AVATAR_ID,
    MAX_CONFIG_BYTES,
    LAUNCHER_AVATARS,
    normalizeAvatarId,
    getAvatarMetadata,
    resolveSelectedAvatarId,
    readSelectedAvatarId,
    createLauncherBranding
});
