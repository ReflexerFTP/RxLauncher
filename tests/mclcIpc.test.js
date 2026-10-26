const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pending = new Map();
const context = vm.createContext({
    path, __dirname: path.join(__dirname, '..', 'web'), GAME_DATA: path.join(__dirname, 'game-data'),
    RxConfig: {read: () => true}, RxCollector: {writeLog: () => {}},
    ipcRenderer: {invoke: (channel, payload) => {
        assert.equal(channel, 'generate-mclc-config');
        return new Promise(resolve => pending.set(payload.version, {payload, resolve}));
    }}
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/js/RxLaunchConfigurator.js'), 'utf8'), context);
const configurator = vm.runInContext('RxLaunchConfigurator', context);

(async () => {
    const first = configurator.getModdedLaunchConfig('fabric', '1.20.1', '0.16.1');
    const second = configurator.getModdedLaunchConfig('fabric', '1.21.1', '0.16.9');
    assert.ok(pending.get('1.20.1').payload.gameData.endsWith(path.join('home', 'fabric-1.20.1')));
    pending.get('1.21.1').resolve({version: {number: '1.21.1'}});
    pending.get('1.20.1').resolve({version: {number: '1.20.1'}});
    assert.equal((await first).version.number, '1.20.1');
    assert.equal((await second).version.number, '1.21.1');
    const custom = configurator.getModdedLaunchConfig('custom', 'MyPack');
    assert.equal(pending.get('MyPack').payload.gameData, context.GAME_DATA);
    pending.get('MyPack').resolve({version: {number: 'MyPack'}});
    assert.ok((await custom).overrides.gameDirectory.endsWith(path.join('home', 'custom-MyPack')));
    console.log('Concurrent loader config responses stay paired with their requests');
})().catch(error => { console.error(error); process.exitCode = 1; });
