const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {createRequire} = require('node:module');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-pack-delete-'));
const packRoot = path.join(fixture, 'modpacks', 'example');
const folder = path.join(packRoot, 'resourcepacks', 'My Pack');
const outside = path.join(fixture, 'outside.jar');
fs.mkdirSync(folder, {recursive: true});
fs.mkdirSync(path.join(packRoot, 'mods'), {recursive: true});
fs.writeFileSync(outside, 'outside');
fs.writeFileSync(path.join(folder, 'pack.mcmeta'), '{}');
fs.writeFileSync(path.join(packRoot, 'mods', 'keep.jar'), 'mod');
fs.writeFileSync(path.join(packRoot, 'manifest.json'), JSON.stringify({
    id: 'example', files: [
        {path: 'resourcepacks/My Pack/pack.mcmeta', name: 'pack.mcmeta'},
        {path: 'mods/keep.jar', name: 'keep.jar'}
    ]
}));
const trashed = [];
const rendererRequire = createRequire(path.join(__dirname, '..', 'web/index.ejs'));
const context = vm.createContext({
    fs, path, crypto, GAME_DATA: fixture,
    require: name => name === 'electron' ? {shell: {trashItem: async target => { trashed.push(target); }}} : rendererRequire(name),
    RxCollector: {writeLog: () => {}}, RxPacksUI: {loadInstalledList: () => {}}, console
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/js/RxPacks.js'), 'utf8'), context);
const RxPacks = vm.runInContext('RxPacks', context);

(async () => {
    try {
        assert.equal(await RxPacks.deleteFileFromModpack(outside, true, 'example'), false);
        assert.equal(await RxPacks.deleteFileFromModpack(path.join(packRoot, 'mods'), true, 'example'), false);
        assert.equal(trashed.length, 0);
        assert.equal(await RxPacks.deleteFileFromModpack(folder, true, 'example'), true);
        assert.deepEqual(trashed, [folder]);
        assert.deepEqual(Array.from(RxPacks.getModpackManifest('example').files, file => file.path), ['mods/keep.jar']);
        console.log('Pack deletion rejects root and outside paths, and handles folder packs');
    } finally {
        fs.rmSync(fixture, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
