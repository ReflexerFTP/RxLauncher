const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {crc32} = require('node:zlib');
const {validateZip} = require('../archiveSafety');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-archive-test-'));
const makeZip = (name, size = 1, mode = 0) => {
    const filename = Buffer.from(name), data = Buffer.from('x');
    const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(1, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(1, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
    const file = path.join(root, 'fixture.zip'); fs.writeFileSync(file, Buffer.concat([local, filename, data, central, filename, end])); return file;
};
(async () => {
    assert.equal(await validateZip(makeZip('world/level.dat'), path.join(root, 'output')), true);
    for (const name of ['../outside', '/absolute', 'C:/outside', 'world/file:stream', 'world/CON.txt', 'world/../outside']) {
        await assert.rejects(validateZip(makeZip(name), path.join(root, 'output')), undefined, name);
    }
    await assert.rejects(validateZip(makeZip('link', 1, 0xa1ff), path.join(root, 'output')), /symbolic/);
    await assert.rejects(validateZip(makeZip('world/level.dat'), path.join(root, 'output'), {maxBytes: 0}), /limit/);
    console.log('Archive path traversal, links, Windows paths and extraction limits tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
