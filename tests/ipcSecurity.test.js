const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createTrustedIpc} = require('../ipcSecurity');
const {classifyExternalTarget} = require('../externalTargets');
const handlers = new Map();
const file = path.resolve(__dirname, '../web/index.ejs');
const frame = {url: pathToFileURL(file).href};
const sender = {mainFrame: frame};
const window = {webContents: sender, isDestroyed: () => false};
const ipc = createTrustedIpc({on: (key, fn) => handlers.set(key, fn), handle: (key, fn) => handlers.set(key, fn)}, () => window, file);
ipc.onTrusted('sync', (event, value) => { event.returnValue = value; });
ipc.handleTrusted('async', (_event, value) => value);
const trusted = {sender, senderFrame: frame};
handlers.get('sync')(trusted, 42); assert.equal(trusted.returnValue, 42);
assert.equal(handlers.get('async')(trusted, 42), 42);
for (const event of [
    {sender: {mainFrame: frame}, senderFrame: frame},
    {sender, senderFrame: {url: frame.url}},
    {sender, senderFrame: null}
]) {
    handlers.get('sync')(event, 42); assert.equal(event.returnValue.ok, false);
    assert.throws(() => handlers.get('async')(event, 42), /Untrusted/);
}
frame.url += '.attacker'; assert.throws(() => handlers.get('async')(trusted, 42), /Untrusted/);
frame.url = 'https://example.com'; assert.throws(() => handlers.get('async')(trusted, 42), /Untrusted/);
for (const url of ['javascript:alert(1)', 'file:///C:/Windows/System32/cmd.exe', 'ms-settings:privacy', 'https://user:password@example.com']) assert.throws(() => classifyExternalTarget(url));
assert.equal(classifyExternalTarget('https://github.com/ReflexerFTP/RxLauncher').kind, 'url');
assert.equal(classifyExternalTarget(__dirname).kind, 'path');
console.log('IPC sender/frame/navigation and external target validation tests passed');
