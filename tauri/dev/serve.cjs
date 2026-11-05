// Локальный сервер интерфейса для отладочной сборки (RxLauncher Dev): node tauri/dev/serve.cjs [папка]
// Exe из GitHub Actions (--features devui) грузит интерфейс отсюда, а файлы для fs берёт из RX_WEB_ROOT
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "dist-tauri"));
const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm"};

http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1:1420");
    const file = path.join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404);
        return response.end("Not found");
    }
    response.writeHead(200, {"Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store"});
    fs.createReadStream(file).pipe(response);
}).listen(1420, "127.0.0.1", () => console.log(`RxLauncher UI: http://127.0.0.1:1420 (${ROOT})`));
