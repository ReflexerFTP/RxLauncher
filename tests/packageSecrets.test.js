// В лаунчер (и на GitHub) не попадают сервер API, сайт и секреты
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// Сервер, сайт и Discord-бот — только локально и на VPS
for (const folder of ["server", "site", "bot"]) {
    assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(`${folder}/`), `${folder}/ must be gitignored`);
}

// Секретов в исходниках лаунчера нет: всё секретное живёт только на сервере
const SECRET = [
    /client_secret\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/i,
    /DISCORD_CLIENT_SECRET\s*=\s*\S{16,}/,
    /rx1_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
const skip = new Set(["node_modules", "dist", "dist-design", "server", "site", "bot", ".git", "tests", "resources", "logs"]);
const scan = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!/\.(js|cjs|json|ejs|html|md|env)$/i.test(entry.name)) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const pattern of SECRET) assert.ok(!pattern.test(text), `${path.relative(root, full)} looks like it contains a secret (${pattern})`);
    }
};
scan(root);
console.log("Package secrets: OK");
