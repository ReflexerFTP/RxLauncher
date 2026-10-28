// Лента с сайта: мусор отбрасывается, рекомендуемые серверы превращаются в карточки, скрытые объявления не показываются
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const config = {};
const toasts = [];
const context = vm.createContext({
    console, Date, Set, JSON, Number, Array, setInterval: () => 0,
    document: {dispatchEvent: () => {}, addEventListener: () => {}},
    CustomEvent: class {},
    MESSAGES: Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "languages", "ru.json"), "utf8"))).find(value => value?.feed),
    RxConfig: {read: (key, fallback) => key in config ? config[key] : fallback, write: (key, value) => { config[key] = value; }},
    RxToasts: {create: (...args) => toasts.push(args)},
    RxDialog: {escape: value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char])},
    $: Object.assign(() => ({length: 0}), {})
});
vm.runInContext(`${fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxFeed.js"), "utf8")}\nthis.RxFeed = RxFeed;`, context, {filename: "RxFeed.js"});
const {RxFeed} = context;

const data = RxFeed.normalize({
    announcements: [{id: 1, kind: "update", title: "Вышла 3.10"}, {id: "x", title: "плохой id"}, {id: 2, kind: "event", title: "Ивент"}],
    servers: [{id: 5, title: "Наш", address: "play.example.ru", category: "survival", version: "fabric-1.21.4", text: "Выживание"},
        {id: 6, title: "Без версии", address: "mc.example.net", version: "evil"}, {title: "Без адреса"}],
    packs: [{id: 7, project: "fabulously-optimized"}, {id: 8, project: "../../etc"}]
});
assert.deepStrictEqual(data.announcements.map(item => item.id), [1, 2]);
assert.strictEqual(data.servers.length, 2);
assert.deepStrictEqual(data.packs.map(item => item.project), ["fabulously-optimized"], "unsafe project ids are dropped");
assert.strictEqual(JSON.stringify(RxFeed.normalize(null)), JSON.stringify({announcements: [], servers: [], packs: []}));

RxFeed.data = data;
const servers = RxFeed.recommendedServers();
assert.deepStrictEqual({...servers[0]}, {id: "rec-5", name: "Наш", address: "play.example.ru", category: "survival", flVersion: "fabric-1.21.4", description: "Выживание", recommended: true});
assert.strictEqual(servers[1].flVersion, "vanilla-1.21.4", "bad version falls back to vanilla");
assert.strictEqual(servers[1].category, "other");

// Уведомление о новых объявлениях — один раз
RxFeed.notify();
assert.strictEqual(toasts.length, 2);
RxFeed.notify();
assert.strictEqual(toasts.length, 2, "no repeat toasts");
assert.strictEqual(toasts[0][0], "Вышла 3.10");

// Скрытое объявление не показывается; в списке скрытых только живые id
config.hiddenAnnouncements = [99];
RxFeed.hide(1);
assert.deepStrictEqual([...RxFeed.visibleAnnouncements()].map(item => item.id), [2]);
assert.deepStrictEqual([...config.hiddenAnnouncements], [1]);
console.log("Feed: OK");
