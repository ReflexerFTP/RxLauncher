const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const safety = require('../modrinthPackSafety');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-mod-update-'));
const packRoot = path.join(fixture, 'modpacks', 'example');
const oldPath = path.join(packRoot, 'mods', 'old.jar');
const manifestPath = path.join(packRoot, 'manifest.json');
fs.mkdirSync(path.dirname(oldPath), {recursive: true});
fs.writeFileSync(oldPath, 'old mod');
fs.writeFileSync(manifestPath, JSON.stringify({
    id: 'example', baseVersion: {type: 'fabric', number: '1.20.1'},
    files: [{path: 'mods/old.jar', name: 'old.jar',
        url: 'https://cdn.modrinth.com/data/abc/versions/1/old.jar'}]
}));
let failDownload = true;
const logs = [];
const chain = {hide() {return this;}, show() {return this;}, text() {return this;}, find() {return this;}};
const context = vm.createContext({
    fs, path, crypto, URL, GAME_DATA: fixture, $: () => chain,
    MESSAGES: {packs: {updatePackM: {checking: 'Checking', installing: 'Installing'}, filesFailed: 'Failed'}},
    RxPacks: {
        safety: () => safety, isSafePackId: id => id === 'example',
        getModpackManifest: () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        writeModpackManifest: (_id, manifest) => fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    },
    RxAssetsParsers: {readModInfo: async () => ({name: 'Example Mod', version: '1.0', icon: ''})},
    RxRequests: {get: async () => [true, [{version_type: 'release', version_number: '2.0', files: [{
        filename: 'new.jar', url: 'https://cdn.modrinth.com/data/abc/versions/2/new.jar',
        hashes: {sha1: 'a'.repeat(40)}, size: 7
    }]}]]},
    RxDownloader: {downloadMany: async files => {
        if (failDownload) throw new Error('simulated download failure');
        for (const file of files) {
            fs.mkdirSync(path.dirname(file.path), {recursive: true});
            fs.writeFileSync(file.path, 'new mod');
        }
    }},
    RxCollector: {writeLog: value => logs.push(value)}, RxToasts: {create: () => {}},
    RxFlyout: {changeMode: async () => {}, setUIStartMode: () => {}},
    fsPromises: fs.promises, console
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/js/RxModsUpdater.js'), 'utf8'), context);
const updater = vm.runInContext('RxModsUpdater', context);

(async () => {
    try {
        const updates = await updater.checkPackUpdatesAvailable('example');
        assert.equal(updates.length, 1, 'the first mod must be checked');
        assert.equal(updates[0].latest.version, '2.0');
        assert.equal(await updater.updateAllFromList(), false);
        assert.equal(fs.readFileSync(oldPath, 'utf8'), 'old mod');
        assert.equal(JSON.parse(fs.readFileSync(manifestPath)).files[0].path, 'mods/old.jar');
        failDownload = false;
        assert.equal(await updater.updateAllFromList(), true, logs.join('\n'));
        assert.equal(fs.readFileSync(path.join(packRoot, 'mods', 'new.jar'), 'utf8'), 'new mod');
        assert.equal(JSON.parse(fs.readFileSync(manifestPath)).files[0].path, path.join('mods', 'new.jar'));
        assert.equal(fs.existsSync(oldPath), false);
        console.log('Mod update first-item and download rollback tests passed');
    } finally {
        fs.rmSync(fixture, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
