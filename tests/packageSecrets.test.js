// В лаунчер (и на GitHub) не попадают сервер API, сайт и секреты; exe защищён флагами Electron от подмены и отладки
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Сервер и сайт — только локально и на VPS
for (const folder of ["server", "site"]) {
    assert.ok(pkg.build.files.includes(`!${folder}{,/**/*}`), `${folder}/ must be excluded from the build`);
    assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(`${folder}/`), `${folder}/ must be gitignored`);
}

// Флаги Electron: не запустить как Node, не подключить отладчик, не подменить app.asar
assert.deepStrictEqual(pkg.build.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
});
assert.match(fs.readFileSync(path.join(root, "windows", "mainWindow.js"), "utf8"), /devTools: !app\.isPackaged/);
assert.match(fs.readFileSync(path.join(root, "app.js"), "utf8"), /app\.isPackaged && \["remote-debugging-port"/);

// Секретов в исходниках лаунчера нет: всё секретное живёт только на сервере
const SECRET = [
    /client_secret\s*[:=]\s*["'][A-Za-z0-9_-]{16,}/i,
    /DISCORD_CLIENT_SECRET\s*=\s*\S{16,}/,
    /rx1_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
const skip = new Set(["node_modules", "dist", "dist-design", "server", "site", ".git", "tests", "resources", "logs"]);
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
