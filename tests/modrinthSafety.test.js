const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const fsExtra = require('fs-extra');
const safety = require('../modrinthPackSafety');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-mrpack-'));
const requireFromRenderer = createRequire(path.join(__dirname, '..', 'web/index.ejs'));
let failIndexCopy = true;
const context = vm.createContext({
    fs, path, crypto, fsExtra, GAME_DATA: fixture, require: requireFromRenderer,
    fsPromises: {
        copyFile: async (from, to) => {
            if (failIndexCopy && from.endsWith('modrinth.index.json') && to.endsWith('modrinth.index.json')) throw new Error('simulated disk error');
            return fs.promises.copyFile(from, to);
        },
        rm: fs.promises.rm
    },
    RxCollector: {writeLog: () => {}},
    RxToasts: {create: () => {}},
    RxUtils: {translit: value => value},
    console
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/js/RxPacks.js'), 'utf8'), context);
const RxPacks = vm.runInContext('RxPacks', context);
const valid = {
    name: 'Example', versionId: '1.0', dependencies: {minecraft: '1.20.1'},
    files: [{path: 'mods/example.jar', downloads: ['https://cdn.modrinth.com/data/example.jar'],
        hashes: {sha1: 'a'.repeat(40)}, fileSize: 10}]
};

(async () => {
    try {
        assert.equal(RxPacks.parseModrinthIndex(valid).files[0].name, 'example.jar');
        for (const badPath of ['../saves/world.dat', 'saves/world/level.dat', 'C:\\outside.txt',
            'mods/CON.jar', 'mods/bad.', 'manifest.json']) {
            const pack = {...valid, files: [{...valid.files[0], path: badPath}]};
            assert.throws(() => RxPacks.parseModrinthIndex(pack), /path|data|Invalid/i, badPath);
        }
        assert.throws(() => RxPacks.parseModrinthIndex({...valid, files: [valid.files[0], valid.files[0]]}), /Duplicate/);
        assert.throws(() => RxPacks.parseModrinthIndex({...valid, files: [{...valid.files[0], hashes: {}}]}), /hash/);
        assert.throws(() => safety.safePackUrl('https://127.0.0.1/a.jar'), /local network/);

        const root = path.join(fixture, 'modpacks');
        const pack = path.join(root, 'existing');
        const temporary = path.join(root, '.rx-test-unpack');
        fs.mkdirSync(path.join(pack, 'mods'), {recursive: true});
        fs.mkdirSync(path.join(pack, 'config'), {recursive: true});
        fs.mkdirSync(path.join(pack, 'saves', 'MyWorld'), {recursive: true});
        fs.mkdirSync(path.join(temporary, 'overrides', 'config'), {recursive: true});
        fs.writeFileSync(path.join(pack, 'mods', 'old.jar'), 'old mod');
        fs.writeFileSync(path.join(pack, 'config', 'settings.txt'), 'old config');
        fs.writeFileSync(path.join(pack, 'saves', 'MyWorld', 'level.dat'), 'world');
        fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({
            id: 'existing', displayName: 'Existing', files: [{path: 'mods/old.jar'}], source: {packName: 'Old', packVersion: '1'}
        }));
        fs.writeFileSync(path.join(pack, 'modrinth.index.json'), 'old index');
        fs.writeFileSync(path.join(temporary, 'overrides', 'config', 'settings.txt'), 'new config');
        fs.writeFileSync(path.join(temporary, 'modrinth.index.json'), JSON.stringify(valid));
        RxPacks.unpackModrinthPack = async () => ({
            decompPath: temporary, indexPath: path.join(temporary, 'modrinth.index.json'),
            index: valid, files: [], baseVersion: {full: 'vanilla-1.20.1', type: 'vanilla', number: '1.20.1'}
        });
        assert.equal(await RxPacks.updateModrinthPack('existing', 'unused.mrpack'), false);
        assert.equal(fs.readFileSync(path.join(pack, 'mods', 'old.jar'), 'utf8'), 'old mod');
        assert.equal(fs.readFileSync(path.join(pack, 'config', 'settings.txt'), 'utf8'), 'old config');
        assert.equal(fs.readFileSync(path.join(pack, 'saves', 'MyWorld', 'level.dat'), 'utf8'), 'world');
        assert.equal(fs.readFileSync(path.join(pack, 'modrinth.index.json'), 'utf8'), 'old index');
        assert.equal(JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'))).displayName, 'Existing');
        assert.equal(fs.existsSync(temporary), false);
        failIndexCopy = false;
        fs.mkdirSync(path.join(temporary, 'overrides', 'config'), {recursive: true});
        fs.writeFileSync(path.join(temporary, 'overrides', 'config', 'settings.txt'), 'new config');
        fs.writeFileSync(path.join(temporary, 'modrinth.index.json'), JSON.stringify(valid));
        assert.equal(await RxPacks.updateModrinthPack('existing', 'unused.mrpack'), true);
        assert.equal(fs.readFileSync(path.join(pack, 'config', 'settings.txt'), 'utf8'), 'new config');
        assert.equal(fs.readFileSync(path.join(pack, 'saves', 'MyWorld', 'level.dat'), 'utf8'), 'world');
        assert.equal(fs.existsSync(path.join(pack, 'mods', 'old.jar')), false);
        const backupNames = fs.readdirSync(path.join(pack, 'rx-mod-backups'));
        assert.ok(backupNames.some(name => fs.existsSync(path.join(pack, 'rx-mod-backups', name, 'mods', 'old.jar'))));
        console.log('Modrinth index validation, path checks, successful update and rollback tests passed');
    } finally {
        fs.rmSync(fixture, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
