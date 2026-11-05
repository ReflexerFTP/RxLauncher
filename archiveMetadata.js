'use strict';
const yauzl = require('yauzl');
const safeName = name => typeof name === 'string' && name.length <= 1024 && name.length > 0
    && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..');
function readEntries(source, wanted, maxBytes = 2 * 1024 ** 2) {
    return new Promise(resolve => {
        const result = Object.create(null);
        let zip, active, settled = false, retained = 0, scanned = 0;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            active?.destroy();
            try { zip?.close(); } catch (_) {}
            resolve(result);
        };
        const timer = setTimeout(finish, 5000);
        const open = Buffer.isBuffer(source) ? yauzl.fromBuffer : yauzl.open;
        open(source, {lazyEntries: true, validateEntrySizes: true, strictFileNames: true}, (error, opened) => {
            if (settled) { try { opened?.close(); } catch (_) {} return; }
            if (error || !opened) return finish();
            zip = opened;
            zip.on('error', finish);
            zip.on('end', finish);
            zip.on('entry', entry => {
                if (settled) return;
                if (++scanned > 50000) return finish();
                if (!safeName(entry.fileName) || (entry.generalPurposeBitFlag & 1)
                    || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
                    || !wanted(entry.fileName) || entry.uncompressedSize > maxBytes
                    || retained + entry.uncompressedSize > maxBytes * 2) return zip.readEntry();
                zip.openReadStream(entry, (streamError, stream) => {
                    if (settled) { stream?.destroy(); return; }
                    if (streamError || !stream) return zip.readEntry();
                    active = stream;
                    const chunks = [];
                    let bytes = 0, advanced = false;
                    stream.on('data', chunk => {
                        bytes += chunk.length;
                        if (bytes > maxBytes || retained + bytes > maxBytes * 2) stream.destroy(new Error('Metadata size limit'));
                        else chunks.push(chunk);
                    });
                    const next = () => { if (!settled && !advanced) { advanced = true; active = null; zip.readEntry(); } };
                    stream.on('end', () => {
                        if (!settled) { retained += bytes; result[entry.fileName] = Buffer.concat(chunks, bytes); }
                        next();
                    });
                    stream.on('error', next);
                });
            });
            zip.readEntry();
        });
    });
}
function pngBase64(bytes, maxBytes = 256 * 1024) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > maxBytes
        || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.toString('ascii', 12, 16) !== 'IHDR') return '';
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 2048 && height <= 2048 ? bytes.toString('base64') : '';
}
module.exports = {readEntries, safeName, pngBase64};
