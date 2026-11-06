// Манифест автообновления для релиза: node tauri/sign-update.cjs <папка с установщиком>
// Подписывает «rxlauncher-update\n<версия>\n<файл>\n<sha256>\n<размер>» ключом Ed25519 из RX_UPDATE_SIGNING_KEY (PEM).
// Без ключа манифест не создаётся — лаунчер такое обновление и не принял бы
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const dir = path.resolve(process.argv[2] || "out");
const key = String(process.env.RX_UPDATE_SIGNING_KEY || "").trim();
if (!key) {
    console.log("RX_UPDATE_SIGNING_KEY is not set — update manifest skipped");
    process.exit(0);
}
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8")).version;
// Автообновление ставит сам NSIS Tauri (RxLauncher_<версия>_x64-setup.exe), а не «RxLauncher Setup <версия>.exe»
const file = fs.readdirSync(dir).find(name => /_x64-setup\.exe$/i.test(name) && name.includes(version));
if (!file) throw new Error(`Installer for ${version} not found in ${dir}`);
const data = fs.readFileSync(path.join(dir, file));
const sha256 = crypto.createHash("sha256").update(data).digest("hex");
const message = `rxlauncher-update\n${version}\n${file}\n${sha256}\n${data.length}`;
const signature = crypto.sign(null, Buffer.from(message), crypto.createPrivateKey(key)).toString("base64");
const url = `https://github.com/ReflexerFTP/RxLauncher/releases/download/v${version}/${encodeURIComponent(file)}`;
fs.writeFileSync(path.join(dir, "rxlauncher-tauri-update.json"), JSON.stringify({version, file, url, sha256, size: data.length, signature}, null, 2));
console.log(`Update manifest signed for ${file} (${data.length} bytes)`);
