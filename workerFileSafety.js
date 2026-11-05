'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Only game data and files chosen in the native dialog may cross this IPC boundary.
function createWorkerFileSafety(getRoot) {
    const selected = new Map();
    const staging = new Set();
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const checked = value => {
        if (typeof value !== 'string' || value.length > 32767 || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw Error('Invalid worker path');
        const segments = value.slice(path.parse(value).root.length).split(/[\\/]/);
        if (segments.some(part => part === '..' || /[:]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('Unsafe worker path');
        return path.resolve(value);
    };
    const inside = (root, file) => {
        const relative = path.relative(root, file);
        return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const under = (root, file) => {
        root = path.resolve(root);
        if (!inside(root, file)) return false;
        let current = root;
        for (const part of path.relative(root, file).split(path.sep)) {
            current = path.join(current, part);
            try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked worker path is forbidden'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return true;
    };
    const gamePath = file => under(checked(getRoot()), file);
    const approveDialog = files => {
        const now = Date.now();
        for (const [file, expires] of selected) if (expires < now) selected.delete(file);
        for (const value of files || []) {
            try {
                const file = checked(value);
                if (!fs.lstatSync(file).isFile()) continue;
                if (selected.size >= 128) selected.delete(selected.keys().next().value);
                selected.set(key(file), now + 30 * 60 * 1000);
            } catch (_) {}
        }
    };
    const readNbt = value => {
        const file = checked(value);
        if (!gamePath(file)) throw Error('NBT file is outside game data');
        const parts = path.relative(path.resolve(getRoot()), file).split(path.sep);
        const saveIndex = parts[0] === 'saves' ? 0 : (['home', 'modpacks'].includes(parts[0]) && parts[2] === 'saves' ? 2 : -1);
        if (saveIndex < 0 || parts.length !== saveIndex + 3 || parts.at(-1) !== 'level.dat') throw Error('Not a world metadata file');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 ** 2) throw Error('NBT file is too large');
        return file;
    };
    const archive = payload => {
        if (!payload || !['zip', 'tar', 'tgz'].includes(payload.type)) throw Error('Unsupported archive type');
        const source = checked(payload.archive), destination = checked(payload.destination);
        const selectedFile = selected.get(key(source)) > Date.now();
        if (!gamePath(source) && !selectedFile) throw Error('Archive was not selected in the native dialog');
        if (fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw Error('Invalid archive source');
        if (!gamePath(destination) && ![...staging].some(root => key(root) === key(destination) || under(root, destination))) throw Error('Archive destination is outside game data');
        return {archive: source, destination, type: payload.type};
    };
    const createStaging = purpose => {
        for (const root of staging) if (!fs.existsSync(root)) staging.delete(root);
        if (purpose !== 'custom-version' || staging.size >= 64) throw Error('Invalid staging request');
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-version-'));
        staging.add(folder);
        return folder;
    };
    return {approveDialog, readNbt, archive, createStaging};
}
module.exports = {createWorkerFileSafety};
