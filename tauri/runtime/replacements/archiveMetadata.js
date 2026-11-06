'use strict';
// Метаданные JAR/ZIP без распаковки (Tauri): ядро отдаёт список записей, нужные выбираются здесь и читаются ядром.
// Ограничения как в версии на yauzl: имя записи, шифрование, ссылки, размер записи и суммарный объём
const bridge = require('../tauri/runtime/bridge');
const safeName = name => typeof name === 'string' && name.length <= 1024 && name.length > 0
    && !/[\:\x00-\x1f]/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..');
async function readEntries(source, wanted, maxBytes = 2 * 1024 ** 2) {
    const result = Object.create(null);
    try {
        const isBuffer = Buffer.isBuffer(source);
        const args = isBuffer ? {} : {path: String(source)};
        const {value: entries} = await bridge.call('archive.list', args, isBuffer ? source : null);
        const names = [];
        let retained = 0;
        for (const entry of entries) {
            if (entry.dir || entry.encrypted || entry.symlink || !safeName(entry.name) || !wanted(entry.name)
                || entry.size > maxBytes || retained + entry.size > maxBytes * 2) continue;
            retained += entry.size;
            names.push(entry.name);
        }
        if (!names.length) return result;
        const {value: index, payload} = await bridge.call('archive.read', {...args, names, maxBytes}, isBuffer ? source : null);
        for (const item of index) result[item.name] = Buffer.from(payload.subarray(item.offset, item.offset + item.length));
    } catch (_) {}
    return result;
}
function pngBase64(bytes, maxBytes = 256 * 1024) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > maxBytes
        || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.toString('ascii', 12, 16) !== 'IHDR') return '';
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 2048 && height <= 2048 ? bytes.toString('base64') : '';
}
module.exports = {readEntries, safeName, pngBase64};
