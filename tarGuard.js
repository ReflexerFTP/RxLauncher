'use strict';
const {Transform} = require('node:stream');
const headers = require('tar-stream/headers');

// tar-stream buffers extended headers before emitting an entry. Bound them first.
module.exports = ({maxBytes = 8 * 1024 ** 3, maxEntries = 200000} = {}) => {
    const header = Buffer.alloc(512);
    let filled = 0, remaining = 0, count = 0, metadataBytes = 0, meta = null, metaUsed = 0, pax = false;
    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                let offset = 0;
                while (offset < chunk.length) {
                    if (remaining > 0) {
                        const length = Math.min(remaining, chunk.length - offset);
                        if (meta && metaUsed < meta.length) {
                            const take = Math.min(length, meta.length - metaUsed);
                            chunk.copy(meta, metaUsed, offset, offset + take); metaUsed += take;
                        }
                        remaining -= length; offset += length;
                        if (remaining === 0 && meta && pax) {
                            let pos = 0;
                            while (pos < meta.length) {
                                const space = meta.indexOf(32, pos), raw = meta.toString('ascii', pos, space < 0 ? pos : space);
                                const size = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
                                if (size <= raw.length + 2 || pos + size > meta.length || meta[pos + size - 1] !== 10) throw Error('Invalid TAR PAX record');
                                if (meta.toString('utf8', space + 1, pos + size - 1).startsWith('size=')) throw Error('TAR PAX size overrides are not supported');
                                pos += size;
                            }
                        }
                        if (remaining === 0) meta = null;
                        continue;
                    }
                    const take = Math.min(512 - filled, chunk.length - offset);
                    chunk.copy(header, filled, offset, offset + take); filled += take; offset += take;
                    if (filled < 512) continue;
                    filled = 0;
                    const entry = headers.decode(header);
                    if (!entry) continue;
                    if (++count > maxEntries || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maxBytes) throw Error('TAR header limit exceeded');
                    const extended = ['pax-header', 'pax-global-header', 'gnu-long-path', 'gnu-long-link-path'].includes(entry.type);
                    if (extended && (entry.size > 64 * 1024 || (metadataBytes += entry.size) > 2 * 1024 ** 2)) throw Error('TAR extended metadata is too large');
                    if (entry.type === 'directory' && entry.size !== 0) throw Error('Invalid TAR directory size');
                    remaining = Math.ceil(entry.size / 512) * 512;
                    meta = extended && entry.size ? Buffer.alloc(entry.size) : null; metaUsed = 0;
                    pax = entry.type === 'pax-header' || entry.type === 'pax-global-header';
                }
                callback(null, chunk);
            } catch (error) { callback(error); }
        },
        flush(callback) { callback(filled || remaining ? Error('Truncated TAR data') : null); }
    });
};
