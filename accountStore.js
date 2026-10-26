const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only the main process can access the operating system's credential encryption.
exports.createAccountStore = (file, safeStorage) => {
    const readRaw = () => {
        if (!fs.existsSync(file)) return {};
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid account storage');
        return data;
    };
    const write = (accounts) => {
        if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new Error('Invalid accounts');
        const stored = {};
        for (const [id, source] of Object.entries(accounts)) {
            if (!source || !['local', 'elyby'].includes(source.type)) continue;
            if (!/^[a-zA-Z0-9_]{2,16}$/.test(source.nickname)) continue;
            const account = {...source, uuid: id};
            delete account.needsReauthentication;
            for (const key of ['accessToken', 'clientToken']) {
                if (account.type === 'elyby' && typeof account[key] === 'string' && account[key]) {
                    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable');
                    account[key + 'Encrypted'] = safeStorage.encryptString(account[key]).toString('base64');
                }
                delete account[key];
                if (account.type !== 'elyby') delete account[key + 'Encrypted'];
            }
            Object.defineProperty(stored, id, {value: account, enumerable: true});
        }
        fs.mkdirSync(path.dirname(file), {recursive: true});
        const temp = file + '.' + crypto.randomUUID() + '.tmp';
        try { fs.writeFileSync(temp, JSON.stringify(stored, null, 2), {mode: 0o600}); fs.renameSync(temp, file); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        return true;
    };
    const read = () => {
        const accounts = readRaw();
        if (Object.values(accounts).some(a => a?.accessToken || a?.clientToken)) write(accounts);
        const result = readRaw();
        for (const account of Object.values(result)) {
            for (const key of ['accessToken', 'clientToken']) {
                if (!account?.[key + 'Encrypted']) continue;
                try { account[key] = safeStorage.decryptString(Buffer.from(account[key + 'Encrypted'], 'base64')); }
                catch (_) { account.needsReauthentication = true; }
            }
        }
        return result;
    };
    return {read, write};
};
