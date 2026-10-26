const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-java-test-'));
const executable = path.join(root, 'manual-java.exe'); fs.writeFileSync(executable, 'fixture');
let installed = 0;
const ctx = vm.createContext({fs, path, crypto, process, fsPromises: fs.promises, console,
    GAME_DATA: root, IS_APP_IN_DEV: false,
    RxConfig: {read: (key, fallback) => ({autoSelectJava: false, selectedJava: executable}[key] ?? fallback)},
    RxUtils: {getGameRoot: () => root, createMissingDirectories: dir => fs.mkdirSync(dir, {recursive: true})},
    RxAccountsManager: {getAccount: () => ({nickname: 'Tester', type: 'local'}), getActiveAccount: () => 'id'},
    RxCollector: {writeLog() {}}, RxVersionsManager: {versionToDisplayName: () => '1.21.1'},
    RxFlyout: {setUIStartMode() {}, setText() {}, changeMode: async () => {}}, MESSAGES: {starter: {configuring: 'Configuring'}},
    RxJavaManager: {gameVersionToJavaVersion: async () => '21', install: async () => { installed++; }, getPath: () => false},
    RxLaunchConfigurator: {createConfigForVersion: async () => ({javaPath: executable})}
});
(async () => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/RxStarter.js'), 'utf8') + '\nthis.Starter = RxStarter;', ctx);
    assert.equal((await new ctx.Starter('vanilla-1.21.1', 'vanilla', '1.21.1').prepare()).javaPath, executable);
    assert.equal(installed, 0, 'A manually selected runtime must not trigger a download');
    fs.unlinkSync(executable);
    assert.equal(await new ctx.Starter('vanilla-1.21.1', 'vanilla', '1.21.1').prepare(), false);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/RxJavaManager.js'), 'utf8') + '\nthis.Java = RxJavaManager;', ctx);
    ctx.Java.init();
    fs.mkdirSync(path.join(root, 'javaDownloads', '21'), {recursive: true});
    assert.equal(ctx.Java.isInstalled('21'), false, 'An empty directory is not an installed runtime');
    const bin = path.join(root, 'javaDownloads', '21', 'jdk', 'bin'); fs.mkdirSync(bin, {recursive: true});
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'), 'fixture');
    assert.equal(ctx.Java.isInstalled('21'), true);
    console.log('Manual Java selection and incomplete runtime tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
