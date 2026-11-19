const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {PNG} = require('pngjs');
const {Jimp, ResizeStrategy} = require('../tauri/runtime/jimp');

const source = PNG.sync.read(fs.readFileSync(path.join(__dirname, '../web/assets/skins/steve-head.png')));
const head = Jimp.fromImageData(source);
head.resize({w: 128, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR});
const output = PNG.sync.read(PNG.sync.write({...head.bitmap, data: Buffer.from(head.bitmap.data)}));
assert.equal(output.width, 128);
assert.equal(output.height, 128);
for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
        const src = 4 * (Math.floor(y * source.height / 128) * source.width + Math.floor(x * source.width / 128));
        const dst = 4 * (y * output.width + x);
        assert.equal(output.data.readUInt32BE(dst), source.data.readUInt32BE(src));
    }
}
console.log('PNG skin round trip and launcher resize passed');
