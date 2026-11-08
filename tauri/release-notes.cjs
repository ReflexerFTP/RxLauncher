// Текст релиза на GitHub из патчноута текущей версии: node tauri/release-notes.cjs > notes.md
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const context = vm.createContext({RxConfig: {read: () => "ru"}, RxTranslator: {getCurrentLanguage: () => "ru"}});
vm.runInContext(`${fs.readFileSync(path.join(root, "web", "js", "RxPatchNotes.js"), "utf8")}\nthis.items = RxPatchNotes.ITEMS;`, context);
const item = context.items.find(entry => entry.version === version);
if (!item) throw new Error(`No patch notes for ${version}`);

const lines = [
    `## ${item.title.ru}`,
    "",
    item.summary.ru,
    "",
    "### Что нового",
    ...item.changes.ru.map(change => `- ${change}`),
    "",
    "### Как установить",
    `1. Скачайте **RxLauncher Setup ${version}.exe** ниже и запустите.`,
    "2. Если Windows покажет «Windows защитила ваш компьютер» — нажмите «Подробнее» → «Выполнить в любом случае» (у установщика пока нет платной подписи).",
    "3. Аккаунты, настройки, сборки и Java сохраняются. Дальше лаунчер обновляется сам.",
    "",
    `Файл \`RxLauncher_${version}_x64-setup.exe\` — тот же установщик без оформления, его использует автообновление.`,
    "",
    "<details><summary>What's new (English)</summary>",
    "",
    `**${item.title.en}**`,
    "",
    item.summary.en,
    "",
    ...item.changes.en.map(change => `- ${change}`),
    "",
    "</details>",
    ""
];
process.stdout.write(lines.join("\n"));
