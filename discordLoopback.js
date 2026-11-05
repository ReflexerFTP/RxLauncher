'use strict';
// Вход через Discord в лаунчере (RFC 8252): сайт после входа отправляет браузер на 127.0.0.1 этого ПК
// с одноразовым кодом. Токен по коду выдаётся только вместе с verifier (PKCE), который знает лишь лаунчер,
// поэтому чужая ссылка «войти через Discord» больше не уводит аккаунт.
const http = require('node:http');

const CODE = /^[A-Za-z0-9_-]{32,64}$/;
const PATHNAME = '/rx-discord';
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>RxLauncher</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#e8e8ea;font:16px system-ui,sans-serif;text-align:center}
b{display:block;font-size:22px;margin-bottom:8px}span{color:#9a9aa3}</style></head>
<body><div><b>Вход выполнен</b><span>Вернитесь в RxLauncher — эту вкладку можно закрыть.</span></div></body></html>`;

exports.createDiscordLoopback = ({timeoutMs = 5 * 60e3} = {}) => {
    let active = null; // {id, server, timer, finish}
    let nextId = 0;
    const results = new Map(); // id -> Promise<код | null>: wait() может прийти и после того, как код уже получен

    const stop = () => { if (active) active.finish(null); };

    const start = () => new Promise((resolve, reject) => {
        stop();
        const id = ++nextId;
        let port = 0;
        let settle;
        const result = new Promise(done => { settle = done; });
        const server = http.createServer((request, response) => {
            let url;
            try { url = new URL(request.url, 'http://127.0.0.1'); } catch (_) { url = null; }
            const code = url?.searchParams.get('code') || '';
            // Host проверяем, чтобы сюда не достучалась чужая страница через DNS rebinding
            if (request.method !== 'GET' || url?.pathname !== PATHNAME || request.headers.host !== `127.0.0.1:${port}` || !CODE.test(code)) {
                response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close'});
                return response.end('Not found');
            }
            response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'close',
                'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'});
            response.end(PAGE, () => current.finish(code));
        });
        const current = {
            id, server,
            finish: code => {
                if (current.done) return;
                current.done = true;
                clearTimeout(current.timer);
                if (active === current) active = null;
                server.close();
                server.closeAllConnections?.();
                settle(code);
            }
        };
        server.on('error', error => { current.finish(null); reject(error); });
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            current.timer = setTimeout(() => current.finish(null), timeoutMs);
            active = current;
            resolve({id, port});
        });
        results.set(id, result);
        if (results.size > 4) results.delete(results.keys().next().value);
    });

    // Код из браузера или null (отмена, таймаут, другой вход начат заново)
    const wait = id => results.get(Number(id)) || Promise.resolve(null);

    return {start, wait, stop, isActive: () => Boolean(active)};
};
