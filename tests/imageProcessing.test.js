const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {Jimp, ResizeStrategy} = require('jimp');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-images-test-'));
(async () => {
    // Голова скина по умолчанию (аватар аккаунта) читается и масштабируется
    const head = await Jimp.read(path.join(__dirname, '../web/assets/skins/steve-head.png'));
    head.resize({w: 128, h: 128, mode: ResizeStrategy.NEAREST_NEIGHBOR});
    assert.equal((await Jimp.read(await head.getBuffer('image/png'))).bitmap.width, 128);
    const logs = [];
    const context = vm.createContext({require, fs, path, __dirname: path.join(__dirname, '../web'), RxCollector: {writeLog: line => logs.push(line)}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/RxLaunchConfigurator.js'), 'utf8') + '\nthis.LC = RxLaunchConfigurator;', context);
    await context.LC.renderRxClientAltPanel(root);
    assert.ok(fs.existsSync(path.join(root, 'alt_panel.png')), logs.join('\n'));
    assert.equal((await Jimp.read(path.join(root, 'alt_panel.png'))).bitmap.width, 600);
    console.log('Updated image decoder, skin head and bitmap font rendering tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
