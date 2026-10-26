const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const compressing = require('compressing');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-reliability-'));
const load = (name, mocks) => {
    const context = vm.createContext({Buffer, require, console, path, fs, fsPromises: fs.promises, crypto, ...mocks});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', name + '.js'), 'utf8') + `\nthis.TestClass = ${name};`, context);
    return {Class: context.TestClass, context};
};
(async () => {
    const account = {uuid: 'id', nickname: 'Tester', accessToken: 'token', clientToken: 'original-client'};
    let saves = 0, deleted = 0, requests = [];
    const auth = load('RxElybyManager', {
        NICKNAME_REGEX: /^[a-zA-Z0-9_]{2,16}$/,
        RxHttp: {text: async (url, opts) => { requests.push({url, opts}); return {ok: true, status: 204, body: ''}; }},
        RxAccountsManager: {getAccount: () => account, getAccounts: () => ({id: account}), saveAccounts: () => saves++, deleteAccount: () => deleted++},
        $: () => ({text: () => ({show() {}})}), MESSAGES: {elyby: {repeat: 'Sign in again'}}, RxModals: {showModal: async () => {}}
    });
    assert.equal(await auth.Class.validateAccessToken('token', 'client'), true);
    assert.equal(requests[0].opts.body.clientToken, 'client');
    assert.equal((await auth.Class.getAccountForAuth('id')).access_token, 'token');
    assert.equal(saves, 0, 'A valid token does not need a refresh');
    auth.context.RxHttp.text = async () => { throw Error('Network unavailable'); };
    await assert.rejects(auth.Class.getAccountForAuth('id'), /Network/);
    assert.equal(deleted, 0);
    assert.equal(account.accessToken, 'token');
    auth.context.RxHttp.text = async (url, opts) => url.endsWith('/validate') ? {ok: false, status: 403, body: '{}'} : {ok: true, status: 200, body: JSON.stringify({accessToken: 'fresh', clientToken: opts.body.clientToken, selectedProfile: {id: 'id', name: 'Tester'}})};
    assert.equal((await auth.Class.getAccountForAuth('id')).access_token, 'fresh');
    assert.equal(account.clientToken, 'original-client');
    assert.equal(saves, 1);
    auth.context.RxHttp.text = async () => ({ok: false, status: 403, body: '{}'});
    assert.equal(await auth.Class.getAccountForAuth('id'), false);
    assert.equal(deleted, 0, 'Expired profiles remain available for reauthentication');

    const utils = {unpackArchive: (a, b) => compressing.zip.uncompress(a, b)};
    const worlds = load('RxWorldsManager', {RxUtils: utils}).Class;
    const source = path.join(root, 'world'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'level.dat'), 'original');
    const zip = path.join(root, 'import.zip'); await compressing.zip.compressDir(source, zip);
    const savesDir = path.join(root, 'saves'); fs.mkdirSync(savesDir);
    assert.equal(await worlds.installFromZip(savesDir, zip), true);
    assert.equal(fs.readFileSync(path.join(savesDir, 'import', 'level.dat'), 'utf8'), 'original');
    await assert.rejects(worlds.installFromZip(savesDir, zip), /already exists/);
    const broken = path.join(root, 'broken.zip'); fs.writeFileSync(broken, 'broken');
    await assert.rejects(worlds.installFromZip(savesDir, broken));
    assert.ok(!fs.readdirSync(savesDir).some(n => n.startsWith('.rx-import-')));

    const world = path.join(savesDir, 'import');
    const faultFs = Object.create(fs);
    let failSwap = false;
    faultFs.renameSync = (from, to) => {
        if (failSwap && to === world) { const error = Error('Simulated locked directory'); error.code = 'EPERM'; throw error; }
        return fs.renameSync(from, to);
    };
    const backups = load('RxWorldBackups', {fs: faultFs, GAME_DATA: root, compressing, RxUtils: utils, RxCollector: {writeLog() {}}, RxConfig: {read: (_k, v) => v}}).Class;
    const archive = await backups.backup(world);
    fs.writeFileSync(path.join(world, 'level.dat'), 'latest');
    failSwap = true;
    let recovery;
    try { await backups.restore(world, archive); assert.fail('Restore should fail'); } catch (error) { recovery = error.recoveryPath; }
    assert.ok(recovery, 'Failed rollback reports a recovery path');
    assert.equal(fs.readFileSync(path.join(recovery, 'level.dat'), 'utf8'), 'latest', 'Original data survives a failed rollback');

    const share = load('RxShare', {RxHttp: {json: async () => []}}).Class;
    await assert.rejects(share.install({m: ['abcdefgh'], r: [], s: []}), /Unavailable/);
    const bomb = share.PREFIX + require('node:zlib').deflateRawSync(Buffer.from('x'.repeat(200000))).toString('base64url');
    assert.throws(() => share.decode(bomb), /badCode/);
    console.log('Authentication, world import/rollback and incomplete-share regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
