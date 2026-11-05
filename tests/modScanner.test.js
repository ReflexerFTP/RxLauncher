// Проверка модов на стилеры (3.13): вебхуки и боты Discord, Telegram, кража данных, скрытые строки, вложенные jar
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const {scanFile, createModScanner, _internal} = require('../modScanner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-modscan-'));
// «Класс»: сканеру важны только байты, как в пуле констант настоящего .class
const fakeClass = (...strings) => Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]), ...strings.map(text => Buffer.from(`\u0001${text}`, 'latin1'))]);
// new byte[]{'h','t',…}: dup, bipush индекс, bipush значение, bastore
const byteArrayClass = text => Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    ...[...Buffer.from(text, 'latin1')].map((byte, index) => Buffer.from([0x59, 0x10, index, 0x10, byte, 0x54])), Buffer.from([0xb0])]);
const makeJar = (entries, file = null) => new Promise(resolve => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', chunk => chunks.push(chunk)).on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (file) fs.writeFileSync(file, buffer);
        resolve(buffer);
    });
});
const ids = result => result.findings.map(item => item.id);
const finding = (result, id) => result.findings.find(item => item.id === id);
const MOD_JSON = JSON.stringify({schemaVersion: 1, id: 'demo', version: '1.0.0', name: 'Demo'});

(async () => {
    try {
        // Обычный мод — чисто, даже с упоминанием лаунчеров в проверке совместимости (как в Sodium)
        const clean = await scanFile(await makeJar({'fabric.mod.json': MOD_JSON, 'demo/Mod.class': fakeClass('net/minecraft/client/MinecraftClient', 'PrismLauncher detected', 'https://modrinth.com/mod/demo')}));
        assert.equal(clean.verdict, 'clean', JSON.stringify(clean));

        // Discord-вебхук открытым текстом
        const webhook = await scanFile(await makeJar({'a/Send.class': fakeClass('https://discord.com/api/webhooks/1234567890/abcDEF')}));
        assert.equal(webhook.verdict, 'danger');
        assert.ok(ids(webhook).includes('discordWebhook'));

        // Telegram-бот в base64 (три разных сдвига), в hex и задом наперёд
        for (const prefix of ['', 'x', 'xy']) {
            const encoded = Buffer.from(`${prefix}https://api.telegram.org/bot123:ABC/sendDocument`).toString('base64');
            const result = await scanFile(await makeJar({'a/B.class': fakeClass(encoded)}));
            assert.equal(finding(result, 'telegramBotApi')?.samples[0].form, 'base64', `base64 shift ${prefix.length}`);
        }
        const hex = await scanFile(await makeJar({'a/H.class': fakeClass(Buffer.from('api.telegram.org').toString('hex'))}));
        assert.equal(finding(hex, 'telegramBotApi')?.samples[0].form, 'hex');
        const reversed = await scanFile(await makeJar({'a/R.class': fakeClass([...'https://discordapp.com/api/webhooks/1/x'].reverse().join(''))}));
        assert.equal(finding(reversed, 'discordWebhook')?.samples[0].form, 'reversed');

        // Адрес собран из массива байтов в байткоде (так прятал fractureiser)
        assert.equal(_internal.arrayStrings(byteArrayClass('discord.com/api/webhooks'))[0].toString(), 'discord.com/api/webhooks');
        const bytes = await scanFile(await makeJar({'a/Loader.class': byteArrayClass('https://discord.com/api/webhooks/1/2')}));
        assert.equal(finding(bytes, 'discordWebhook')?.samples[0].form, 'bytes');

        // Discord-бот: API каналов и токен-чекер users/@me
        const bot = await scanFile(await makeJar({'a/Bot.class': fakeClass('https://discord.com/api/v10/channels/', 'Authorization')}));
        assert.equal(bot.verdict, 'danger');
        assert.ok(ids(bot).includes('discordBotApi'));
        // Библиотека вебхуков — опасно и без адреса
        assert.equal((await scanFile(await makeJar({'club/minnced/discord/webhook/WebhookClient.class': fakeClass('x')}))).verdict, 'danger');

        // JDA (мост чата с Discord) — только предупреждение, даже с его getSessionId
        const jda = await scanFile(await makeJar({'net/dv8tion/jda/api/JDA.class': fakeClass('getSessionId', 'getAccessToken')}));
        assert.equal(jda.verdict, 'warning', JSON.stringify(jda));

        // Классический стилер: пароли браузера + отправка
        const stealer = await scanFile(await makeJar({'s/Grab.class': fakeClass('Local State', 'encrypted_key', 'Login Data', 'https://api.ipify.org')}));
        assert.equal(stealer.findings[0].id, 'stealer');
        assert.deepEqual(stealer.findings[0].theft, ['browserData']);
        // Токен Discord (зашифрованный префикс dQw4w9WgXcQ:) — опасно само по себе
        assert.equal((await scanFile(await makeJar({'s/T.class': fakeClass('dQw4w9WgXcQ:')}))).verdict, 'danger');
        // Наш собственный файл аккаунтов
        assert.ok(ids(await scanFile(await makeJar({'s/Rx.class': fakeClass('rx_accounts.json')}))).includes('rxAccounts'));

        // Сессия Minecraft + отправка: intermediary-имя и пара User.getAccessToken в одном классе
        const session = await scanFile(await makeJar({'s/S.class': fakeClass('method_1674', 'https://pastebin.com/raw/abc')}));
        assert.equal(session.findings[0].id, 'stealer');
        const mojmap = await scanFile(await makeJar({'s/M.class': fakeClass('net/minecraft/client/User', 'getAccessToken', 'https://api.telegram.org/bot')}));
        assert.ok(mojmap.findings[0].theft.includes('session'));
        // getAccessToken без класса User (OAuth-библиотека) — не сессия
        assert.equal((await scanFile(await makeJar({'lib/OAuth.class': fakeClass('getAccessToken')}))).verdict, 'clean');

        // Автозапуск и скрытый PowerShell
        assert.equal((await scanFile(await makeJar({'x/P.class': fakeClass('Software\\Microsoft\\Windows\\CurrentVersion\\Run')}))).verdict, 'danger');
        assert.equal((await scanFile(await makeJar({'x/Q.class': fakeClass('powershell -WindowStyle Hidden -EncodedCommand AAA')}))).verdict, 'danger');
        // Скрипт внутри jar
        assert.ok(ids(await scanFile(await makeJar({'fabric.mod.json': MOD_JSON, 'run.bat': '@echo off'}))).includes('scriptFile'));
        // Известные адреса fractureiser
        assert.equal((await scanFile(await makeJar({'x/F.class': fakeClass('85.217.144.130')}))).verdict, 'danger');
        // Адрес по IP + загрузка кода — загрузчик второй части
        const dropper = await scanFile(await makeJar({'x/D.class': fakeClass('java/net/URLClassLoader', 'http://45.12.33.7:8080/stage2.jar')}));
        assert.ok(ids(dropper).includes('dropper') && ids(dropper).includes('rawIpUrl'), JSON.stringify(dropper));
        assert.equal((await scanFile(await makeJar({'x/L.class': fakeClass('java/net/URLClassLoader', 'http://127.0.0.1:25565/')}))).verdict, 'clean');

        // Вложенный jar (Fabric jar-in-jar)
        const inner = await makeJar({'evil/Send.class': fakeClass('https://discord.com/api/webhooks/9/9')});
        const nested = await scanFile(await makeJar({'fabric.mod.json': MOD_JSON, 'META-INF/jars/inner.jar': inner}));
        assert.match(finding(nested, 'discordWebhook').samples[0].entry, /^META-INF\/jars\/inner\.jar!\/evil\/Send\.class$/);

        // Запутанный код + доступ к паролям — опасно, даже когда адрес отправки зашифрован
        const obfEntries = {'META-INF/MANIFEST.MF': 'Obfuscated-By: Allatori', 'p/Steal.class': fakeClass('CryptUnprotectData')};
        assert.equal((await scanFile(await makeJar(obfEntries))).findings[0].id, 'hiddenStealer');
        // Просто запутанный мод — предупреждение
        const obfNames = Object.fromEntries(Array.from({length: 40}, (_, i) => [`a/${String.fromCharCode(97 + i % 26)}${i < 26 ? '' : 'b'}.class`, fakeClass('x')]));
        assert.equal((await scanFile(await makeJar(obfNames))).verdict, 'warning');

        // Не jar — результат «неизвестно», без падения
        assert.equal((await scanFile(Buffer.from('not a zip'))).verdict, 'unknown');

        // Папка модов: worker, отключённые моды, кеш по SHA-1
        const mods = path.join(temp, 'mods');
        fs.mkdirSync(mods);
        await makeJar({'fabric.mod.json': MOD_JSON, 'demo/Mod.class': fakeClass('hello')}, path.join(mods, 'good.jar'));
        await makeJar({'a/Send.class': fakeClass('https://discord.com/api/webhooks/1/2')}, path.join(mods, 'bad.jar.disabled'));
        fs.writeFileSync(path.join(mods, 'notes.txt'), 'x');
        const scanner = createModScanner({cachePath: path.join(temp, 'cache.json')});
        const first = await scanner.scan(mods);
        assert.equal(first.files.length, 2);
        assert.equal(first.scanned, 2);
        const bad = first.files.find(file => file.name === 'bad.jar.disabled');
        assert.equal(bad.verdict, 'danger');
        assert.equal(bad.enabled, false);
        assert.match(bad.sha1, /^[0-9a-f]{40}$/);
        assert.equal(first.files.find(file => file.name === 'good.jar').verdict, 'clean');
        assert.equal((await scanner.scan(mods, {onlyEnabled: true})).files.length, 1);
        const second = await createModScanner({cachePath: path.join(temp, 'cache.json')}).scan(mods);
        assert.equal(second.cached, 2, 'results come from the cache');
        assert.equal(second.files.find(file => file.name === 'bad.jar.disabled').verdict, 'danger');
        assert.deepEqual((await scanner.scan(path.join(temp, 'missing'))).files, []);
        await assert.rejects(scanner.scan('relative/mods'));

        // Лаунчер проверяет моды перед запуском и в окне модов
        const root = path.join(__dirname, '..');
        assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /handleTrusted\("mod-scan"/);
        assert.match(fs.readFileSync(path.join(root, 'web/js/RxStarter.js'), 'utf8'), /RxModScan\.beforeLaunch\(/);
        console.log('modScanner: OK');
    } finally {
        fs.rmSync(temp, {recursive: true, force: true});
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
