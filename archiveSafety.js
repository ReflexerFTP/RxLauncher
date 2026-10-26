const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

// Reject unsafe ZIPs before extraction; do not silently install a partial archive.
exports.validateZip = (archive, destination, {maxBytes = 8 * 1024 ** 3, maxEntries = 200000} = {}) => new Promise((resolve, reject) => {
    yauzl.open(archive, {lazyEntries: true, validateEntrySizes: true, strictFileNames: true}, (error, zip) => {
        if (error) return reject(error);
        let size = 0, count = 0, failed = false;
        const names = new Set();
        const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
        zip.on('error', fail);
        zip.on('end', () => { if (!failed) resolve(true); });
        zip.on('entry', entry => {
            try {
                const name = entry.fileName;
                const parts = name.replace(/\/$/, '').split('/');
                const normalized = name.toLowerCase().replace(/\/$/, '');
                if (!name || /[\\:\x00-\x1f]/.test(name) || path.posix.isAbsolute(name)
                    || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe ZIP entry path');
                if (names.has(normalized)) throw new Error('Duplicate ZIP entry');
                names.add(normalized);
                if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are not supported');
                if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted ZIP entries are not supported');
                if (++count > maxEntries || (size += entry.uncompressedSize) > maxBytes) throw new Error('ZIP extraction limit exceeded');
                let current = path.resolve(destination);
                for (const part of ['', ...parts]) {
                    current = path.join(current, part);
                    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('ZIP destination contains a symbolic link'); }
                    catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
                zip.readEntry();
            } catch (error) { fail(error); }
        });
        zip.readEntry();
    });
});
