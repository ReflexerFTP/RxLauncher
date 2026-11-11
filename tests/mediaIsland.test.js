// Остров Spotify: быстрое листание треков не плодит запросы, позиция нового трека не берётся от прошлого,
// страница перерисовывается только при изменениях
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const timers = [];
const fakeTimers = {
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({id, fn, ms, done: false}); return id; },
    clearTimeout: id => { const timer = timers.find(t => t.id === id); if (timer) timer.done = true; },
    setInterval: () => 0
};
const runTimers = async () => {
    for (const timer of timers.filter(t => !t.done)) { timer.done = true; await timer.fn(); }
};

// Элемент острова: считаем записи в DOM
const writes = [];
const node = name => ({
    text(value) { writes.push(`${name}.text=${value}`); return this; },
    css(key, value) { writes.push(`${name}.css ${key}=${value}`); return this; },
    addClass(value) { writes.push(`${name}+${value}`); return this; },
    removeClass(value) { writes.push(`${name}-${value}`); return this; }
});
const island = {
    length: 1,
    toggleClass(name, on) { writes.push(`island.${name}=${on}`); return this; },
    find: selector => node(selector.replace(/\[data-mi-|\]/g, "")),
    on() { return this; }
};

const requests = [];
const context = vm.createContext({
    console, Date, Math, Map, Set, URLSearchParams, AbortController, Number, String, Boolean, Array, JSON, Promise,
    ...fakeTimers,
    MESSAGES: {mediaIsland: {}},
    RxConfig: {read: (key, value) => value},
    RxCollector: {writeLog() {}},
    document: {hidden: false, addEventListener() {}},
    ipcRenderer: {invoke: async () => ({found: false}), on() {}},
    RxHttp: {json: (url, options) => new Promise((resolve, reject) => {
        requests.push({url, options});
        options.signal.addEventListener("abort", () => reject(new Error("Request aborted")));
        if (url.includes("/get?")) resolve({syncedLyrics: "[00:01.00] first\n[00:05.00] second\n[00:09.00]"});
    })},
    $: value => (typeof value === "function" ? undefined : island)
});
vm.runInContext(`${fs.readFileSync(path.join(__dirname, "../web/js/RxMediaIsland.js"), "utf8")}\nthis.Island = RxMediaIsland;`, context);
const Island = context.Island;

(async () => {
    const track = (n, extra = {}) => ({found: true, title: `Song ${n}`, artist: "Band", album: "", durationMs: 200000, playing: true, positionMs: 0, updatedAt: 1_000_000, ...extra});

    // ---------- быстрое листание: текст ищется только для трека, на котором остановились ----------
    let now = 1_000_000;
    for (let n = 1; n <= 10; n++) {
        now += 300;
        Island.update(track(n, {positionMs: 120000, updatedAt: 1_000_000}), now);
    }
    assert.equal(requests.length, 0, "no lyrics requests while skipping");
    await runTimers();
    assert.equal(requests.length, 1, "one request for the track the player stopped on");
    assert.match(requests[0].url, /track_name=Song\+10/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Island.lyrics.get("band\u0000song 10").lines.length, 3);

    // Трек сменили, пока искался текст — запрос отменяется и в кеш ничего не попадает
    requests.length = 0;
    context.RxHttp.json = (url, options) => new Promise((resolve, reject) => {
        requests.push({url, options});
        options.signal.addEventListener("abort", () => reject(new Error("Request aborted")));
    });
    Island.update(track(11), now += 1000);
    await runTimers();
    assert.equal(requests.length, 1);
    Island.update(track(12), now += 1000);
    assert.equal(requests[0].options.signal.aborted, true, "the old lyrics request is cancelled");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Island.lyrics.has("band\u0000song 11"), false);

    // ---------- позиция: при смене трека Windows ещё отдаёт время прошлого — новый начинается с нуля ----------
    Island.update(track(20, {positionMs: 150000, updatedAt: now - 60000}), now);
    assert.equal(Island.track.positionMs, 0);
    assert.equal(Island.position(now + 2000), 2000);
    // Тот же трек, свежие данные Windows — им верим
    Island.update(track(20, {positionMs: 30000, updatedAt: now + 5000}), now + 5000);
    assert.equal(Island.position(now + 6000), 31000);
    // Первый трек после запуска лаунчера (с середины песни) — позиция от Windows, не ноль
    Island.update(null);
    Island.update(track(21, {positionMs: 90000, updatedAt: now - 30000}), now);
    assert.equal(Island.track.positionMs, 90000);

    // ---------- строка текста: двоичный поиск даёт ту же строку, что и перебор ----------
    Island.lyrics.set(Island.track.key, {lines: Island.parseLrc("[00:01.00] a\n[00:05.00] b\n[00:09.00]\n[01:30.50] c")});
    const lineAt = ms => { Island.track = {...Island.track, playing: false, positionMs: ms}; return Island.currentLine(); };
    assert.equal(lineAt(0), "Song 21 — Band");
    assert.equal(lineAt(1000), "a");
    assert.equal(lineAt(4900), "b", "the lead time shows the line slightly early");
    assert.equal(lineAt(9500), "♪");
    assert.equal(lineAt(95000), "c");

    // ---------- отрисовка: без изменений страница не трогается ----------
    Island.track = {...Island.track, playing: true, positionMs: 0, updatedAt: Date.now()};
    writes.length = 0;
    Island.render();
    assert.ok(writes.length > 0);
    const progress = writes.find(item => item.startsWith("progress.css"));
    assert.match(progress, /transform=scaleX\(/, "progress moves with transform, not width");
    writes.length = 0;
    Island.render();
    Island.render();
    assert.deepEqual(writes, [], "repeated renders with the same state write nothing");

    console.log("Media island tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
