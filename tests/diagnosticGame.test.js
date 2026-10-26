const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-diagnostic-'));
const kills = [];
const timers = [];
let client;
class Client extends EventEmitter {
    constructor() { super(); client = this; }
    launch() { return Promise.resolve({pid: 54321}); }
}
const context = vm.createContext({
    global: {}, fs, path, USERDATA_PATH: fixture, Client,
    RxFlyout: {changeMode: async () => {}, setText: () => {}},
    RxVersionsManager: {getInstalledVersionEntries: () => []},
    treeKill: pid => kills.push(pid),
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    RxDownloader: {},
    console
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web/js/RxTests.js'), 'utf8'), context);
const RxTests = vm.runInContext('RxTests', context);

(async () => {
    try {
        await RxTests.startTest(); // An empty installed list must complete without dereferencing undefined.
        RxTests.prepareConfig = async () => ({});
        const test = RxTests.testVersion('vanilla-1.20.1');
        await new Promise(setImmediate);
        client.emit('data', 'Sound engine started');
        await new Promise(setImmediate);
        assert.equal(timers.length, 1);
        timers[0]();
        assert.deepEqual(kills, [54321]);
        client.emit('close', 0);
        const result = await test;
        assert.equal(result.passed, true);
        assert.equal(result.exitCode, 0);
        assert.ok(fs.existsSync(path.join(fixture, 'testLogs', 'FULLTEST.log')));
        console.log('Diagnostic game isolation and empty-list tests passed');
    } finally {
        fs.rmSync(fixture, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
