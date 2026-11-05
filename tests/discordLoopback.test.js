// Вход через Discord (3.13): код приходит на 127.0.0.1 лаунчера, лишние запросы отбрасываются
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createDiscordLoopback} = require('../discordLoopback');

const get = (port, pathname, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    const request = http.get({host: '127.0.0.1', port, path: pathname, headers: {Host: host}}, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({status: response.statusCode, body}));
    });
    request.on('error', reject);
});

(async () => {
    const loopback = createDiscordLoopback({timeoutMs: 5000});
    const code = 'A'.repeat(32);

    // Чужие пути, коды и Host (DNS rebinding) — 404, ожидание не завершается
    const first = await loopback.start();
    assert.ok(first.port > 0);
    assert.equal((await get(first.port, `/other?code=${code}`)).status, 404);
    assert.equal((await get(first.port, '/rx-discord?code=bad')).status, 404);
    assert.equal((await get(first.port, `/rx-discord?code=${code}`, `evil.example:${first.port}`)).status, 404);
    assert.equal(loopback.isActive(), true);

    // Настоящий код: страница «Вход выполнен», wait получает код, сервер закрывается
    const page = await get(first.port, `/rx-discord?code=${code}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Вход выполнен/);
    assert.equal(await loopback.wait(first.id), code);
    assert.equal(loopback.isActive(), false);
    await assert.rejects(get(first.port, `/rx-discord?code=${code}`));

    // Отмена и повторный старт: старое ожидание получает null
    const second = await loopback.start();
    const third = await loopback.start();
    assert.equal(await loopback.wait(second.id), null);
    loopback.stop();
    assert.equal(await loopback.wait(third.id), null);
    assert.equal(await loopback.wait(999), null);

    // Таймаут
    const short = createDiscordLoopback({timeoutMs: 100});
    const timed = await short.start();
    assert.equal(await short.wait(timed.id), null);

    // Лаунчер больше не берёт токен по ключу из ссылки (его мог подсунуть посторонний)
    const root = path.join(__dirname, '..');
    const account = fs.readFileSync(path.join(root, 'web/js/RxAccount.js'), 'utf8');
    assert.doesNotMatch(account, /auth\/discord\/poll/);
    assert.match(account, /auth\/discord\/exchange/);
    assert.match(account, /createHash\("sha256"\)\.update\(verifier\)/);
    assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /handleTrusted\("discord-loopback"/);
    console.log('discordLoopback: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
