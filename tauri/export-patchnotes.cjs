// Заметки о версиях для сайта: node tauri/export-patchnotes.cjs [файл-вывода]
// Пишет patchnotes.json из web/js/RxPatchNotes.js. Файл кладётся в корень сайта (rxlauncher.xyz/patchnotes.json):
// лаунчер забирает его при запуске, поэтому текст выпущенной версии можно поправить без нового релиза
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "patchnotes.json"));
const context = vm.createContext({});
vm.runInContext(`${fs.readFileSync(path.join(ROOT, "web", "js", "RxPatchNotes.js"), "utf8")}\nthis.ITEMS = RxPatchNotes.ITEMS;`, context);

const items = context.ITEMS.map(({id, version, date, tag, title, summary, changes}) => ({id, version, date, tag, title, summary, changes}));
fs.writeFileSync(OUT, JSON.stringify({updated: new Date().toISOString(), items}));
console.log(`Patch notes: ${items.length} entries, latest ${items[0].version} → ${OUT}`);
