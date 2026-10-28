// Друзья: какой статус уходит на сервер (невидимка, скрытый сервер), сервер из лога игры,
// подписи статуса друга и уведомления о новых заявках
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const config = {};
const toasts = [];
const sent = [];
const context = vm.createContext({
    console, Date, Math, Set, JSON, Promise, setTimeout: () => 0, clearTimeout: () => {},
    document: {dispatchEvent: () => {}, addEventListener: () => {}},
    window: {addEventListener: () => {}},
    CustomEvent: class { constructor(name) { this.name = name; } },
    // Тексты лежат внутри одного из разделов файла языка
    MESSAGES: Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "languages", "ru.json"), "utf8"))).find(value => value?.friends),
    RxConfig: {read: (key, fallback) => key in config ? config[key] : fallback, write: (key, value) => { config[key] = value; }},
    RxPrivacy: {isParanoid: () => config.lessDataCollection === true, remoteAvatar: url => url},
    RxToasts: {create: (...args) => toasts.push(args)},
    $: Object.assign(() => ({}), {fn: {}})
});
const load = file => vm.runInContext(`${fs.readFileSync(path.join(__dirname, "..", "web", "js", file), "utf8")}\nthis.${file.replace(".js", "")} = ${file.replace(".js", "")};`, context, {filename: file});
load("RxDiscordRpc.js");
load("RxAccount.js");
load("RxFriends.js");
load("RxDialog.js");
load("RxFriendsUI.js");
const {RxFriends, RxFriendsUI, RxAccount} = context;
assert.ok(context.MESSAGES?.friends, "locale has friends section");

// Без аккаунта и в режиме паранойи — ничего не отправляем
assert.strictEqual(RxFriends.enabled(), false);
RxAccount.token = "rx1_" + "a".repeat(43);
RxAccount.user = {id: "0123456789abcdef", nick: "Steve"};
assert.strictEqual(RxFriends.enabled(), true);
config.lessDataCollection = true;
assert.strictEqual(RxFriends.enabled(), false, "paranoid mode turns friends off");
config.lessDataCollection = false;

// Что видят друзья
RxAccount.call = async (route, body) => { sent.push([route, JSON.parse(JSON.stringify(body || {}))]); return {friends: [], incoming: [], outgoing: []}; };
assert.deepStrictEqual({...RxFriends.presence()}, {status: "launcher"});
RxFriends.gameStarted({version: "1.21.4", loaderType: "fabric", server: "mc.example.ru"});
assert.deepStrictEqual({...RxFriends.presence()}, {status: "playing", version: "1.21.4", loader: "fabric", title: "", server: "mc.example.ru"});
config.friendsShowServer = false;
assert.strictEqual(RxFriends.presence().server, "", "server hidden by the option");
config.friendsShowServer = true;
config.serverPrivacyMode = true;
assert.strictEqual(RxFriends.presence().server, "", "server privacy mode hides it too");
config.serverPrivacyMode = false;
config.friendsInvisible = true;
assert.deepStrictEqual({...RxFriends.presence()}, {status: "invisible"});
config.friendsInvisible = false;

// Сервер из лога игры
RxFriends.handleGameLog("[12:00:00] [Render thread/INFO]: Connecting to play.other.net, 25570");
assert.strictEqual(RxFriends.game.server, "play.other.net:25570");
RxFriends.handleGameLog("[12:05:00] [Render thread/INFO]: Disconnected from server");
assert.strictEqual(RxFriends.game.server, "");
RxFriends.handleGameLog("<script>Connecting to evil</script>");
assert.strictEqual(RxFriends.game.server, "");
RxFriends.gameStopped();
assert.strictEqual(RxFriends.game, null);
assert.ok(sent.every(([route]) => route === "friends/sync"));

// Подписи статуса
const now = Date.now();
assert.strictEqual(RxFriendsUI.statusText({online: false}), "Не в сети");
assert.strictEqual(RxFriendsUI.statusText({online: true, status: "launcher"}), "В лаунчере");
assert.strictEqual(RxFriendsUI.statusText({online: true, status: "playing", loader: "fabric", version: "1.21.4", server: "mc.example.ru", since: now - 25 * 60000}),
    "Играет · Fabric 1.21.4 · mc.example.ru · 25 мин");
assert.strictEqual(RxFriendsUI.statusText({online: true, status: "playing", loader: "", version: "", server: "", since: now - 125 * 60000}), "Играет · 2 ч 5 мин");

// Красивый статус: не в сети — когда был и во что играл последний раз
const offline = RxFriendsUI.statusHtml({online: false, seen: now - 3 * 3600e3, last: {version: "1.21.4", loader: "fabric", server: "mc.example.ru", title: "", at: now - 3 * 3600e3}});
assert.ok(offline.includes("Не в сети") && offline.includes("был(а) 3 ч назад") && offline.includes("играл"), offline);
assert.ok(offline.includes("assets/versions/fabric.webp") && offline.includes("Fabric 1.21.4") && offline.includes("mc.example.ru"));
assert.ok(!RxFriendsUI.statusHtml({online: false}).includes("играл"), "no last game — no chips");
const playing = RxFriendsUI.statusHtml({online: true, status: "playing", loader: "neoforge", version: "1.21.1", title: "<Сборка>", server: "", since: now - 5 * 60000});
assert.ok(playing.includes("fr-state playing") && playing.includes("NeoForge 1.21.1") && playing.includes("&lt;Сборка&gt;") && playing.includes("5 мин"));
assert.strictEqual(RxFriendsUI.ago(now - 30 * 3600e3), "вчера");
// Значки групп с иконкой; у обычного игрока значка нет
assert.ok(RxFriendsUI.groupBadge("tester").includes("science") && RxFriendsUI.groupBadge("tester").includes("Тестер"));
assert.ok(RxFriendsUI.groupBadge("player_plus").includes("Игрок+"));
assert.strictEqual(RxFriendsUI.groupBadge("player"), "");
// Кнопка «Скопировать сборку» — только если друг разрешил
assert.ok(RxFriendsUI.row({id: "0123456789abcdef", nick: "A", online: false, canCopy: true, packName: "Pack"}, "friend").includes('data-friend-action="pack"'));
assert.ok(!RxFriendsUI.row({id: "0123456789abcdef", nick: "A", online: false, canCopy: false}, "friend").includes('data-friend-action="pack"'));

// Боковое меню: вкладка «Друзья» есть и включена по умолчанию, меню разворачивается
load("RxTabs.js");
const {RxTabs} = context;
assert.ok(RxTabs.ALL.includes("friends") && RxTabs.DEFAULT.includes("friends"));
assert.strictEqual(RxTabs.ICONS.friends, "diversity_3");
assert.strictEqual(RxTabs.isExpanded(), false);

// Ник в строке экранируется
assert.ok(!RxFriendsUI.row({id: "0123456789abcdef", nick: "<b>x</b>", online: false}, "friend").includes("<b>x</b>"));

// Уведомления: первая загрузка молча, потом — о новой заявке и о принятой нашей
RxFriends.apply({friends: [], incoming: [{id: "1111111111111111", nick: "Alex"}], outgoing: [{id: "2222222222222222", nick: "Herobrine"}]});
assert.strictEqual(toasts.length, 0, "no toasts on the first load");
RxFriends.apply({friends: [{id: "2222222222222222", nick: "Herobrine", online: false}], incoming: [{id: "1111111111111111", nick: "Alex"}, {id: "3333333333333333", nick: "Notch"}], outgoing: []});
assert.deepStrictEqual(toasts.map(toast => toast[2]), ["Notch", "Herobrine"]);
assert.strictEqual(toasts[0][0], "Новая заявка в друзья");
assert.strictEqual(toasts[1][0], "Теперь вы друзья");
console.log("Friends: OK");
