const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const safeName = value => typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(value)
    && !value.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
const samePath = (left, right) => {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const within = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function createGameFileSafety(configPath, defaultGameRoot = process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft')
    : path.join(os.homedir(), '.minecraft')) {
    const configuredRoot = () => {
        try {
            const stat = fs.statSync(configPath);
            if (stat.isFile() && stat.size > 0 && stat.size <= MAX_CONFIG_BYTES) {
                const value = JSON.parse(fs.readFileSync(configPath, 'utf8')).gameDirectory;
                if (typeof value === 'string' && path.isAbsolute(value)) return path.resolve(value);
            }
        } catch (_) {}
        return path.resolve(defaultGameRoot);
    };
    const acceptedRoot = supplied => {
        if (typeof supplied !== 'string' || !path.isAbsolute(supplied)) return null;
        const root = configuredRoot();
        if (!samePath(root, supplied) || !fs.existsSync(root)) return null;
        return fs.realpathSync(root);
    };
    const folder = (suppliedRoot, kind, name, requiredFile) => {
        if (!safeName(name) || !['modpacks', 'versions'].includes(kind)) return null;
        const root = acceptedRoot(suppliedRoot);
        if (!root) return null;
        const target = path.join(root, kind, name);
        try {
            if (!fs.statSync(target).isDirectory()) return null;
            const realTarget = fs.realpathSync(target);
            if (!within(root, realTarget) || !within(path.join(root, kind), realTarget)) return null;
            if (!fs.statSync(path.join(target, requiredFile)).isFile()) return null;
            return target;
        } catch (_) { return null; }
    };
    const screenshot = file => {
        if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.(?:png|jpe?g)$/i.test(file)) return null;
        const root = configuredRoot();
        try {
            const realRoot = fs.realpathSync(root);
            const realFile = fs.realpathSync(file);
            if (!within(realRoot, realFile)) return null;
            const parts = path.relative(realRoot, realFile).split(path.sep);
            const common = parts.length === 2 && parts[0] === 'screenshots';
            const nested = parts.length === 4 && ['home', 'modpacks'].includes(parts[0])
                && safeName(parts[1]) && parts[2] === 'screenshots';
            if (!common && !nested) return null;
            const stat = fs.statSync(realFile);
            if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) return null;
            return realFile;
        } catch (_) { return null; }
    };
    return {configuredRoot, folder, screenshot};
}

module.exports = {createGameFileSafety};
