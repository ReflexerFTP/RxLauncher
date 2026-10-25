const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const load = (file, name, extra = {}) => {
    const context = vm.createContext({console, Date, Math, Number, String, isFinite, ...extra});
    const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", file), "utf8");
    vm.runInContext(`${source}\nthis.${name} = ${name};`, context, {filename: file});
    return context[name];
};

// ---------- Авто-память ----------
const memory = load("RxMemoryAdvisor.js", "RxMemoryAdvisor", {os: {totalmem: () => 16 * 1024 ** 3}, fs, RxConfig: {read: (key, fallback) => fallback}});
const gb = 1024;
// Vanilla — 2 ГБ, независимо от объёма ОЗУ
assert.strictEqual(memory.recommend({totalMb: 16 * gb, modsCount: 0, modded: false}), 2048);
// Небольшая модовая сборка — 3 ГБ, большая — больше
assert.strictEqual(memory.recommend({totalMb: 16 * gb, modsCount: 22, modded: true}), 3072);
// 200 модов на 32 ГБ упираются в потолок 12 ГБ
assert.strictEqual(memory.recommend({totalMb: 32 * gb, modsCount: 200, modded: true}), 12288);
// На слабом ПК системе остаётся запас, но игре не меньше 1 ГБ
assert.ok(memory.recommend({totalMb: 8 * gb, modsCount: 150, modded: true}) <= 8 * gb - 2560);
assert.strictEqual(memory.recommend({totalMb: 3 * gb, modsCount: 50, modded: true}), 1024);
// Всегда кратно 512 МБ
for (const mods of [0, 21, 37, 90, 160]) {
    assert.strictEqual(memory.recommend({totalMb: 12 * gb, modsCount: mods, modded: true}) % 512, 0);
}

// ---------- Скорость и оставшееся время загрузки ----------
let now = 1000;
const downloader = load("RxDownloader.js", "RxDownloader", {
    Date: {now: () => now},
    MESSAGES: {starter: {sec: "с", min: "мин", remaining: "осталось ~{0}"}},
    Set
});
assert.deepStrictEqual({...downloader.measure("a", 0, 100)}, {speed: 0, eta: null});
now = 2000;
const first = downloader.measure("a", 10, 100);
assert.strictEqual(first.speed, 10);
assert.strictEqual(first.eta, 9);
assert.strictEqual(downloader.formatEta(9), "осталось ~9 с");
assert.strictEqual(downloader.formatEta(125), "осталось ~3 мин");
assert.strictEqual(downloader.formatEta(null), "");
// Новый файл — замер с нуля
assert.strictEqual(downloader.measure("b", 5, 100).speed, 0);

// ---------- ForgeOptiFine считается установленным по папке forge-<версия> ----------
const versions = load("RxVersionsManager.js", "RxVersionsManager");
assert.strictEqual(versions.installFolderFor("forgeOptiFine", "1.20.1"), "forge-1.20.1");
assert.strictEqual(versions.installFolderFor("fabric", "1.21.4"), "fabric-1.21.4");

// ---------- Вкладки бокового меню ----------
const config = {};
const tabsModule = load("RxTabs.js", "RxTabs", {
    $: Object.assign(() => ({length: 0, on: () => {}}), {}),
    RxConfig: {read: (key, fallback) => (key in config ? config[key] : fallback), write: (key, value) => { config[key] = value; }},
    document: {querySelectorAll: () => []},
    Array, Set
});
// По умолчанию — только Главная, Настройки, Статистика, Консоль
assert.deepStrictEqual([...tabsModule.getEnabled()], ["content", "settings", "statistics", "console"]);
// Главную и Настройки выключить нельзя, мусорные значения отбрасываются, порядок как в меню
assert.deepStrictEqual([...tabsModule.normalize(["mods", "junk", "console"])], ["content", "settings", "mods", "console"]);
config.enabledTabs = ["mods"];
assert.ok(tabsModule.isEnabled("settings") && tabsModule.isEnabled("mods") && !tabsModule.isEnabled("skins"));
// Неизвестные окна (versions, accounts…) не прячутся
assert.ok(tabsModule.isEnabled("versions"));

console.log("Launcher feature tests passed");
