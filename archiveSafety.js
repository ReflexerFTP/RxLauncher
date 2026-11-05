const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

exports.validateTar = (archive, destination, {gzip = false, maxBytes = 8 * 1024 ** 3, maxEntries = 200000} = {}) => new Promise((resolve, reject) => {
    const source = fs.createReadStream(archive);
    const decoder = gzip ? require('node:zlib').createGunzip() : null;
    const guard = require('./tarGuard')({maxBytes, maxEntries});
    const tar = new (require('compressing').tar.UncompressStream)();
    const streams = [source, decoder, guard, tar].filter(Boolean);
    const names = new Set();
    let count = 0, bytes = 0, total = 0, settled = false;
    const finish = error => {
        if (settled) return;
        settled = true;
        for (const stream of streams) stream.destroy();
        error ? reject(error) : resolve(true);
    };
    streams.forEach(stream => stream.on('error', finish));
    const input = decoder ? source.pipe(decoder) : source;
    input.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes + maxEntries * 1024) finish(new Error('TAR extraction limit exceeded'));
    });
    tar.on('entry', (header, stream, next) => {
        try {
            const name = String(header.name || '').replace(/\/$/, '');
            const parts = name.split('/');
            if (!name || /[\\:\x00-\x1f]/.test(name) || path.posix.isAbsolute(name)
                || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe TAR entry path');
            if (names.has(name.toLowerCase())) throw new Error('Duplicate TAR entry');
            names.add(name.toLowerCase());
            if (++count > maxEntries || !Number.isSafeInteger(header.size) || header.size < 0
                || (bytes += header.size) > maxBytes) throw new Error('TAR extraction limit exceeded');
            const target = path.resolve(destination, ...parts);
            let current = path.resolve(destination);
            for (const part of ['', ...parts]) {
                current = path.join(current, part);
                try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('TAR destination contains a symbolic link'); }
                catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
            if (header.type === 'symlink' || header.type === 'link') {
                const link = header.linkname;
                if (typeof link !== 'string' || !link || /[\\:\x00-\x1f]/.test(link) || path.posix.isAbsolute(link)) throw new Error('Unsafe TAR link');
                const resolved = path.resolve(header.type === 'link' ? destination : path.dirname(target), link);
                const relative = path.relative(path.resolve(destination), resolved);
                if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe TAR link');
            } else if (!['file', 'directory'].includes(header.type)) throw new Error('Unsupported TAR entry type');
            stream.on('error', finish);
            stream.on('end', next);
            stream.resume();
        } catch (error) { finish(error); }
    });
    tar.on('finish', () => finish());
    input.pipe(guard).pipe(tar);
});

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
