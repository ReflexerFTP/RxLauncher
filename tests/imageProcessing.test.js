const assert = require('node:assert/strict');
const path = require('node:path');
const {Jimp, ResizeStrategy} = require('jimp');
(async () => {
    // Голова скина по умолчанию (аватар аккаунта) читается и масштабируется
    const head = await Jimp.read(path.join(__dirname, '../web/assets/skins/steve-head.png'));
    head.resize({w: 128, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR});
    assert.equal((await Jimp.read(await head.getBuffer('image/png'))).bitmap.width, 128);
    console.log('Image decoder and skin head tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
