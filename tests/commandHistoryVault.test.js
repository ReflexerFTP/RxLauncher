// Анти-кража command_history.txt: прячем между запусками (шифр, случайное имя и папка), возвращаем перед игрой,
// пароли из команд входа не сохраняются
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCommandHistoryVault, isSensitive, sanitize, merge} = require('../commandHistoryVault');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-cmd-history-'));
const game = path.join(temp, 'game');
const vaultRoot = path.join(temp, 'user-data', 'vault');
fs.mkdirSync(game, {recursive: true});
// Подменный DPAPI: обратимый, но без открытого текста на диске
const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(Buffer.from(text, 'utf8').map(byte => byte ^ 0x5a)),
    decryptString: buffer => Buffer.from(buffer.map(byte => byte ^ 0x5a)).toString('utf8')
};
const vault = createCommandHistoryVault({vaultRoot, safeStorage});
const historyFile = path.join(game, 'command_history.txt');
const write = lines => fs.writeFileSync(historyFile, lines.join('\n') + '\n');
const read = () => fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean);
const vaultFiles = () => {
    const out = [];
    const walk = dir => { for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}) : []) {
        const full = path.join(dir, entry.name);
        entry.isDirectory() ? walk(full) : out.push(full);
    } };
    walk(vaultRoot);
    return out.filter(file => file.endsWith('.dat'));
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    try {
        // Какие команды считаются паролями
        for (const line of ['/l qwerty', '/L Qwerty1', '/login pass word', '/reg a a', '/register p p', '/changepassword old new', '/cp old new', 'authme:login pw', '/2fa 123456', 'l secret'])
            assert.equal(isSensitive(line), true, line);
        for (const line of ['/l', '/login', '/list', '/gamemode creative', '/tp 0 64 0', '/lobby', '/msg Steve hi', '/locate village'])
            assert.equal(isSensitive(line), false, line);
        assert.deepEqual(merge(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'], 'a repeated command is merged');
        assert.equal(merge(Array.from({length: 60}, (_, i) => `/c${i}`)).length, 50, 'only the last 50 commands are kept, like the game');
        assert.equal(merge(Array.from({length: 60}, (_, i) => `/c${i}`))[0], '/c10');

        // После игры: файл уходит в хранилище, пароли вычищены, на диске нет открытого текста
        write(['/gamemode creative', '/l secret123', '/tp 0 64 0', '/register secret123 secret123']);
        const saved = await vault.protect(game, {strip: true});
        assert.deepEqual(saved, {saved: true, lines: 2});
        assert.ok(!fs.existsSync(historyFile), 'the file must leave the game folder');
        const [first] = vaultFiles();
        assert.equal(vaultFiles().length, 1);
        assert.match(path.relative(vaultRoot, first), /^[0-9a-f]{8}[\\/][0-9a-f]{8}[\\/][0-9a-f]{16}\.dat$/, 'random folder and random name');
        for (const file of [first, path.join(vaultRoot, 'index.bin')]) {
            const raw = fs.readFileSync(file).toString('latin1');
            for (const secret of ['gamemode', 'secret123', 'command_history', game]) assert.ok(!raw.includes(secret), `${path.basename(file)} must not contain ${secret}`);
        }

        // Перед игрой: история возвращается на место, Minecraft читает её как обычно
        const restored = await vault.restore(game, {strip: true});
        assert.deepEqual(restored, {restored: true, lines: 2});
        assert.deepEqual(read(), ['/gamemode creative', '/tp 0 64 0']);
        assert.equal(vaultFiles().length, 0, 'the vault copy is removed once the game has the file');

        // Каждый раз новое случайное место
        const places = new Set();
        for (let round = 0; round < 3; round++) {
            await vault.protect(game);
            places.add(vaultFiles()[0]);
            assert.equal(vaultFiles().length, 1, 'only one hidden copy per game folder');
            await vault.restore(game);
        }
        assert.equal(places.size, 3);

        // Пока игра запущена: игра дописала пароль — он сразу пропадает из файла, остальное на месте
        vault.watch(game);
        await sleep(100);
        write(['/gamemode creative', '/tp 0 64 0', '/login hunter2']);
        for (let waited = 0; waited < 2000 && read().includes('/login hunter2'); waited += 50) await sleep(50);
        assert.deepEqual(read(), ['/gamemode creative', '/tp 0 64 0'], 'password line removed while the game is running');
        vault.unwatch(game);

        // Игру запускали другим лаунчером: история в папке и в хранилище сливается, ничего не теряется
        await vault.protect(game);
        write(['/weather clear']);
        await vault.restore(game);
        assert.deepEqual(read(), ['/gamemode creative', '/tp 0 64 0', '/weather clear']);

        // Без вычистки паролей команды остаются как есть
        write(['/l keepme']);
        await vault.protect(game, {strip: false});
        await vault.restore(game, {strip: false});
        assert.deepEqual(read(), ['/l keepme']);

        // Функцию выключили: всё возвращается по папкам
        const other = path.join(temp, 'game', 'home', 'fabric-1.21.4');
        fs.mkdirSync(other, {recursive: true});
        fs.writeFileSync(path.join(other, 'command_history.txt'), '/time set day\n');
        await vault.protect(game, {strip: false});
        await vault.protect(other);
        assert.equal(vaultFiles().length, 2);
        assert.equal(await vault.releaseAll(), 2);
        assert.equal(vaultFiles().length, 0);
        assert.deepEqual(read(), ['/l keepme']);
        assert.equal(fs.readFileSync(path.join(other, 'command_history.txt'), 'utf8').trim(), '/time set day');

        // Подменённый индекс не может заставить лаунчер читать или удалять файлы вне хранилища
        const outside = path.join(temp, 'outside.dat');
        fs.writeFileSync(outside, 'keep');
        const key = require('node:crypto').createHash('sha256').update(path.resolve(game).toLowerCase()).digest('hex');
        fs.writeFileSync(path.join(vaultRoot, 'index.bin'), Buffer.concat([Buffer.from([1]),
            safeStorage.encryptString(JSON.stringify({entries: {[key]: {dir: game, file: path.join('..', '..', 'outside.dat')}}}))]));
        fs.rmSync(historyFile);
        await vault.restore(game);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');

        // Битый индекс — не ошибка, просто пустое хранилище
        fs.writeFileSync(path.join(vaultRoot, 'index.bin'), 'garbage');
        assert.deepEqual(await vault.restore(game), {restored: false, lines: 0});
        assert.deepEqual(sanitize(['/l a', '/home']), ['/home']);
        console.log('Command history anti-theft: OK');
    } finally {
        vault.unwatchAll();
        fs.rmSync(temp, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
