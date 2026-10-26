const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createAccountStore} = require('../accountStore');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-account-test-'));
const file = path.join(root, 'accounts.json');
const key = crypto.randomBytes(32);
const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: bytes => {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
};
try {
    const store = createAccountStore(file, safeStorage);
    fs.writeFileSync(file, JSON.stringify({id: {type: 'elyby', nickname: 'Tester', accessToken: 'test-secret-42', clientToken: 'client-secret'}}));
    assert.equal(store.read().id.accessToken, 'test-secret-42');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('test-secret-42'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('client-secret'));
    const accounts = store.read();
    accounts.id.nickname = 'Renamed';
    store.write(accounts);
    assert.equal(store.read().id.accessToken, 'test-secret-42');
    const encryptedBefore = fs.readFileSync(file, 'utf8');
    const locked = createAccountStore(file, {...safeStorage, decryptString: () => { throw Error('Different Windows user'); }});
    const unavailable = locked.read();
    assert.equal(unavailable.id.needsReauthentication, true);
    assert.equal(unavailable.id.accessToken, undefined);
    locked.write(unavailable);
    assert.equal(store.read().id.accessToken, 'test-secret-42', 'An unavailable OS key must not destroy credentials');
    const offline = createAccountStore(file, {...safeStorage, isEncryptionAvailable: () => false});
    assert.throws(() => offline.write(accounts), /unavailable/);
    assert.equal(store.read().id.accessToken, 'test-secret-42');
    fs.writeFileSync(file, '{corrupt');
    assert.throws(() => store.read());
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt', 'Malformed storage must never be silently replaced');
    assert.ok(encryptedBefore.length);
    console.log('Account encryption, migration, locked-key and corruption tests passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
