const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let language = "en";
const context = vm.createContext({
    console,
    Intl,
    Date,
    RxTranslator: {getCurrentLanguage: () => language},
    $: () => ({})
});

// В лаунчере остались только русский и английский
const languagesDir = path.join(__dirname, "..", "web", "languages");
assert.deepStrictEqual(fs.readdirSync(languagesDir).filter((file) => file.endsWith(".json")).sort(), ["en.json", "ru.json"]);

const statisticsSource = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxStatisticsUI.js"), "utf8");
vm.runInContext(`${statisticsSource}\nthis.RxStatisticsUI = RxStatisticsUI;`, context, {filename: "RxStatisticsUI.js"});

assert.strictEqual(context.RxStatisticsUI.locale(), "en-US");
assert.doesNotThrow(() => context.RxStatisticsUI.formatNumber(12345));
assert.doesNotThrow(() => context.RxStatisticsUI.formatDate(Date.now()));
language = "ru";
assert.strictEqual(context.RxStatisticsUI.locale(), "ru-RU");

const notesSource = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxPatchNotes.js"), "utf8");
vm.runInContext(`${notesSource}\nthis.RxPatchNotes = RxPatchNotes;`, context, {filename: "RxPatchNotes.js"});
assert.strictEqual(context.RxPatchNotes.locale(), "ru-RU");
assert.doesNotThrow(() => context.RxPatchNotes.formatDate("2026-07-29T18:00:00+03:00"));
assert.strictEqual(context.RxPatchNotes.getAll()[0].title, "Скрипун — новый фон по умолчанию");
language = "en";
assert.strictEqual(context.RxPatchNotes.locale(), "en-US");
assert.strictEqual(context.RxPatchNotes.getAll()[0].title, "The Creaking is the new default wallpaper");
// Устаревший сохранённый язык откатывается на английские тексты
language = "ua";
assert.strictEqual(context.RxPatchNotes.getAll()[0].title, "The Creaking is the new default wallpaper");
// Каждый патч локализован для обоих языков
for (const lang of ["ru", "en"]) {
    language = lang;
    assert.ok(context.RxPatchNotes.getAll().every((item) => item.title && item.summary && item.changes.length), `patch notes must be complete for ${lang}`);
}

console.log("UI locale tests passed");
