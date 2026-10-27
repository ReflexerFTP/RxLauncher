// «Анти-кража» истории команд Minecraft (command_history.txt, есть с 1.20.5).
// Игра читает и пишет файл только по пути <папка игры>/command_history.txt, поэтому:
//  - перед запуском история возвращается на место (и сливается с тем, что там уже лежит);
//  - пока игра идёт, команды входа с паролем (/l, /login, /reg …) сразу вычищаются из файла;
//  - после закрытия игры файл уезжает в хранилище лаунчера: каждый раз новое случайное имя в новой случайной папке,
//    содержимое зашифровано средствами Windows (DPAPI через safeStorage). Индекс «папка игры → файл» тоже зашифрован.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const FILE_NAME = 'command_history.txt';
const MAX_LINES = 50; // столько команд хранит сама игра
// Команды входа/регистрации на серверах без лицензии: в них пароль
const SENSITIVE = /^\/?(?:[a-z0-9_.-]+:)?(?:l|log|login|logon|reg|register|changepassword|changepass|changepw|cp|cpw|passwd|password|pass|unregister|unreg|2fa|totp)\s+\S/i;

const isSensitive = line => SENSITIVE.test(String(line).trim());
const sanitize = lines => lines.filter(line => !isSensitive(line));

const readLines = file => {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.replace(/\0/g, '')).filter(line => line.trim());
    } catch (_) {
        return null;
    }
};

// Старые записи, затем новые; подряд идущие повторы схлопываются, остаются последние 50 — как в самой игре
const merge = (...lists) => {
    const result = [];
    for (const line of lists.flat()) if (result[result.length - 1] !== line) result.push(line);
    return result.slice(-MAX_LINES);
};

const writeAtomic = (file, data) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temp, data, {mode: 0o600});
        fs.renameSync(temp, file);
    } finally {
        try { fs.unlinkSync(temp); } catch (_) {}
    }
};

// Windows может держать файл секунду после выхода игры
const retry = async (action, attempts = 5) => {
    for (let attempt = 1; ; attempt++) {
        try { return action(); }
        catch (error) {
            if (attempt >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 80 * attempt));
        }
    }
};

function createCommandHistoryVault({vaultRoot, safeStorage, log = () => {}}) {
    const indexFile = path.join(vaultRoot, 'index.bin');
    const watchers = new Map();

    const encrypt = text => safeStorage?.isEncryptionAvailable?.()
        ? Buffer.concat([Buffer.from([1]), safeStorage.encryptString(text)])
        : Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf8')]);
    const decrypt = buffer => {
        if (!buffer?.length) throw new Error('Empty vault file');
        if (buffer[0] === 1) return safeStorage.decryptString(buffer.subarray(1));
        if (buffer[0] === 0) return buffer.subarray(1).toString('utf8');
        throw new Error('Unknown vault format');
    };

    const keyFor = dir => crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex');

    const readIndex = () => {
        try {
            const index = JSON.parse(decrypt(fs.readFileSync(indexFile)));
            return index && typeof index.entries === 'object' && !Array.isArray(index.entries) ? index : {entries: {}};
        } catch (_) {
            return {entries: {}};
        }
    };
    const writeIndex = index => writeAtomic(indexFile, encrypt(JSON.stringify(index)));

    // Путь файла хранилища из индекса — только внутри хранилища
    const vaultPath = relative => {
        if (typeof relative !== 'string' || !/^[0-9a-f]{8}[\\/][0-9a-f]{8}[\\/][0-9a-f]{16}\.dat$/.test(relative)) return null;
        return path.join(vaultRoot, relative);
    };

    const readEntry = entry => {
        const file = vaultPath(entry?.file);
        if (!file) return [];
        try {
            const lines = JSON.parse(decrypt(fs.readFileSync(file))).lines;
            return Array.isArray(lines) ? lines.filter(line => typeof line === 'string') : [];
        } catch (error) {
            log(`CommandHistory: vault entry unreadable [error=${error.message}]`);
            return [];
        }
    };

    const removeEntryFile = entry => {
        const file = vaultPath(entry?.file);
        if (!file) return;
        try { fs.unlinkSync(file); } catch (_) {}
        // Пустые случайные папки тоже убираем
        for (let dir = path.dirname(file); dir !== vaultRoot && dir.startsWith(vaultRoot); dir = path.dirname(dir)) {
            try { fs.rmdirSync(dir); } catch (_) { break; }
        }
    };

    const randomRelative = () => path.join(crypto.randomBytes(4).toString('hex'), crypto.randomBytes(4).toString('hex'),
        `${crypto.randomBytes(8).toString('hex')}.dat`);

    // Убрать историю из папки игры в хранилище (новое случайное имя и папка). strip — вычистить пароли
    const protect = async (gameDir, {strip = true} = {}) => {
        const source = path.join(gameDir, FILE_NAME);
        const fileLines = readLines(source);
        const index = readIndex();
        const key = keyFor(gameDir);
        const previous = index.entries[key];
        if (fileLines === null && !previous) return {saved: false, lines: 0};
        let lines = merge(previous ? readEntry(previous) : [], fileLines || []);
        if (strip) lines = sanitize(lines);

        const relative = randomRelative();
        writeAtomic(path.join(vaultRoot, relative), encrypt(JSON.stringify({lines, savedAt: Date.now()})));
        index.entries[key] = {dir: path.resolve(gameDir), file: relative, savedAt: Date.now()};
        writeIndex(index);
        if (previous) removeEntryFile(previous);
        if (fileLines !== null) await retry(() => fs.rmSync(source, {force: true}));
        return {saved: true, lines: lines.length};
    };

    // Вернуть историю в папку игры перед запуском (то, что уже лежит в папке, не теряется)
    const restore = async (gameDir, {strip = false} = {}) => {
        const index = readIndex();
        const key = keyFor(gameDir);
        const entry = index.entries[key];
        const target = path.join(gameDir, FILE_NAME);
        const fileLines = readLines(target);
        if (!entry && !(strip && fileLines)) return {restored: false, lines: fileLines?.length || 0};
        let lines = merge(entry ? readEntry(entry) : [], fileLines || []);
        if (strip) lines = sanitize(lines);
        await retry(() => writeAtomic(target, lines.length ? lines.join(os.EOL) + os.EOL : ''));
        if (entry) {
            delete index.entries[key];
            writeIndex(index);
            removeEntryFile(entry);
        }
        return {restored: !!entry, lines: lines.length};
    };

    // Пока игра идёт: игра переписывает файл после каждой команды — сразу убираем из него пароли
    const cleanNow = async gameDir => {
        const file = path.join(gameDir, FILE_NAME);
        const lines = readLines(file);
        if (!lines) return false;
        const clean = sanitize(lines);
        if (clean.length === lines.length) return false;
        try {
            await retry(() => fs.writeFileSync(file, clean.length ? clean.join(os.EOL) + os.EOL : ''), 3);
            return true;
        } catch (error) {
            log(`CommandHistory: live clean failed [error=${error.message}]`);
            return false;
        }
    };

    const watch = gameDir => {
        unwatch(gameDir);
        let timer = null;
        try {
            const watcher = fs.watch(gameDir, (_event, name) => {
                if (name && String(name).toLowerCase() !== FILE_NAME) return;
                clearTimeout(timer);
                timer = setTimeout(() => cleanNow(gameDir).catch(() => {}), 40);
            });
            watcher.on('error', () => unwatch(gameDir));
            watchers.set(keyFor(gameDir), {watcher, clear: () => clearTimeout(timer)});
        } catch (error) {
            log(`CommandHistory: watch failed [error=${error.message}]`);
        }
    };
    const unwatch = gameDir => {
        const key = keyFor(gameDir);
        const item = watchers.get(key);
        if (!item) return;
        item.clear();
        try { item.watcher.close(); } catch (_) {}
        watchers.delete(key);
    };
    const unwatchAll = () => [...watchers.keys()].forEach(key => {
        const item = watchers.get(key);
        item.clear();
        try { item.watcher.close(); } catch (_) {}
        watchers.delete(key);
    });

    // Вернуть всё из хранилища по своим папкам (функцию выключили)
    const releaseAll = async () => {
        let count = 0;
        for (const entry of Object.values(readIndex().entries)) {
            try {
                if (fs.statSync(entry.dir).isDirectory()) { await restore(entry.dir); count++; }
            } catch (error) {
                log(`CommandHistory: release failed [error=${error.message}]`);
            }
        }
        return count;
    };

    return {protect, restore, watch, unwatch, unwatchAll, cleanNow, releaseAll, readIndex};
}

module.exports = {createCommandHistoryVault, isSensitive, sanitize, merge, FILE_NAME, MAX_LINES};
