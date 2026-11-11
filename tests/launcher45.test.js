// 4.5.0: список папки одним обращением, заметки с сайта, вход через Microsoft, меню трея, соглашение
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rx-45-test-"));
const source = name => fs.readFileSync(path.join(root, "web", "js", `${name}.js`), "utf8");
const load = (name, globals = {}) => {
    const context = vm.createContext({console, Buffer, Date, Math, JSON, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, path, fs, ...globals});
    vm.runInContext(`${source(name)}\nthis.${name} = ${name};`, context, {filename: `${name}.js`});
    return context[name];
};

// То, что ядро отдаёт на fs.list (см. fsops.rs): имя, вид, размер, время и первые байты
const coreList = (dir, {depth = 1, head = 0} = {}) => {
    const out = [];
    const walk = (current, prefix, level) => {
        for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
            const full = path.join(current, entry.name);
            const stat = fs.statSync(full);
            const name = prefix ? `${prefix}\\${entry.name}` : entry.name;
            const item = {name, kind: entry.isDirectory() ? "dir" : "file", size: entry.isDirectory() ? 0 : stat.size, mtimeMs: stat.mtimeMs, head: null};
            if (head && entry.isFile()) item.head = fs.readFileSync(full).subarray(0, head);
            out.push(item);
            if (entry.isDirectory() && level < depth) walk(full, name, level + 1);
        }
    };
    walk(dir, "", 1);
    return out;
};
const withCoreList = () => ({...fs, rxListSync: coreList});
// Объекты из другого контекста vm сравниваем по содержимому
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
    // ---------- моды: один вызов даёт то же, что обход по файлам ----------
    const mods = path.join(temp, "mods");
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, "sodium.jar"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]));
    fs.writeFileSync(path.join(mods, "off.jar.disabled"), Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0]));
    fs.writeFileSync(path.join(mods, "broken.jar"), "not a zip");
    fs.writeFileSync(path.join(mods, "readme.txt"), "x");
    fs.mkdirSync(path.join(mods, "folder.jar"));
    const sortByName = list => [...list].sort((a, b) => a.name.localeCompare(b.name));
    const slow = sortByName(load("RxModsManager", {$: () => ({}), fs}).listJars(mods));
    const fast = sortByName(load("RxModsManager", {$: () => ({}), fs: withCoreList()}).listJars(mods));
    assert.deepEqual(plain(fast), plain(slow));
    assert.deepEqual(fast.map(item => [item.name, item.valid]), [["broken.jar", false], ["off.jar.disabled", true], ["sodium.jar", true]]);

    // ---------- миры: время session.lock / level.dat за один вызов ----------
    const game = path.join(temp, "game");
    for (const [world, files] of [["Alpha", ["session.lock", "level.dat"]], ["Beta", ["level.dat"]], ["Empty", []]]) {
        fs.mkdirSync(path.join(game, "saves", world, "region"), {recursive: true});
        files.forEach((file, index) => {
            const full = path.join(game, "saves", world, file);
            fs.writeFileSync(full, "x");
            fs.utimesSync(full, new Date(1700000000000 + index * 60000), new Date(1700000000000 + index * 60000));
        });
        fs.writeFileSync(path.join(game, "saves", world, "region", "level.dat"), "deeper files do not count");
    }
    fs.writeFileSync(path.join(game, "saves", "level.dat"), "a file next to worlds");
    const statsGlobals = {$: () => ({}), document: {addEventListener() {}}, RxCollector: {writeLog() {}}, RxConfig: {read: (_key, value) => value}};
    const slowLocks = load("RxPlayStats", {...statsGlobals, fs}).scanWorldLocks(game);
    const fastLocks = load("RxPlayStats", {...statsGlobals, fs: withCoreList()}).scanWorldLocks(game);
    assert.deepEqual(plain(fastLocks), plain(slowLocks));
    assert.deepEqual(Object.values(fastLocks).map(world => world.name).sort(), ["Alpha", "Beta"]);
    assert.equal(fastLocks[path.join(game, "saves", "Alpha")].modifiedAt, 1700000000000);

    // ---------- заметки с сайта ----------
    const userData = path.join(temp, "userdata");
    const events = [];
    const remoteFile = {items: []};
    const notes = load("RxPatchNotes", {
        USERDATA_PATH: userData, LAUNCHER_VERSION: "4.5.0", RxCollector: {writeLog() {}}, RxTranslator: {getCurrentLanguage: () => "ru"},
        RxHttp: {json: async () => remoteFile}, CustomEvent: class { constructor(type) { this.type = type; } }, document: {dispatchEvent: event => events.push(event.type)}
    });
    const bundled = notes.ITEMS.length, latest = notes.ITEMS[0];
    assert.equal(latest.version, "4.5.0");
    assert.equal(notes.isNewer("4.10.0", "4.9.9"), true);
    assert.equal(notes.isNewer("4.5.0", "4.5.0"), false);
    remoteFile.items = [
        {id: latest.id, version: latest.version, date: latest.date, title: {ru: "Исправленный заголовок", en: "Fixed title"}, changes: {ru: ["одна строка"], en: ["one line"]}},
        {id: "4.6.0-future", version: "4.6.0", date: "2027-01-01T00:00:00Z", title: {ru: "Ещё не вышло", en: "Not out yet"}},
        {id: "4.4.5-hotfix", version: "4.4.5", date: "2026-11-10T12:00:00Z", title: {ru: "Исправление", en: "Hotfix"}, tag: {ru: "x".repeat(100)}},
        {id: "bad id!", version: "4.4.0", date: "2026-11-10T12:00:00Z", title: {ru: "плохой id"}},
        {id: "no-title", version: "4.4.0", date: "2026-11-10T12:00:00Z"},
        {id: "bad-date", version: "4.4.0", date: "вчера", title: {ru: "плохая дата"}},
        "мусор", null
    ];
    assert.equal(await notes.refreshRemote(), true);
    assert.deepEqual(events, ["rxPatchNotesChanged"]);
    const all = notes.getAll();
    assert.equal(all.length, bundled + 1, "only the fix for a released version is added; the future one and broken ones are dropped");
    assert.equal(all[0].title, "Исправленный заголовок");
    assert.deepEqual(plain(all[0].changes), ["одна строка"]);
    assert.equal(all[0].image, latest.image, "the bundled picture stays");
    assert.equal(all[1].id, "4.4.5-hotfix", "an extra note takes its place by version");
    assert.equal(all[1].tag.length, 24);
    assert.equal(await notes.refreshRemote(), false, "unchanged notes do not redraw the feed");
    // Сохранённая копия читается при следующем запуске без сети
    notes.remote = [];
    notes.initRemote();
    assert.equal(notes.getAll()[0].title, "Исправленный заголовок");
    // Файл для сайта собирается из встроенных заметок
    const exported = path.join(temp, "patchnotes.json");
    require("node:child_process").execFileSync(process.execPath, [path.join(root, "tauri", "export-patchnotes.cjs"), exported]);
    const site = JSON.parse(fs.readFileSync(exported, "utf8"));
    assert.equal(site.items.length, bundled);
    assert.equal(notes.normalizeRemote(site, "4.5.0").length, bundled, "every bundled note passes the launcher's own checks");

    // ---------- вход через Microsoft ----------
    const calls = [];
    const replies = [];
    const accounts = {};
    const toasts = [];
    const microsoftGlobals = {
        MICROSOFT_CLIENT_ID: "", NICKNAME_REGEX: /^[a-zA-Z0-9_]{2,16}$/, MESSAGES: {dialog: {}, commons: {}, accounts: {}},
        RxCollector: {writeLog() {}, addSecrets() {}}, RxToasts: {create: (...args) => toasts.push(args)},
        RxAccountsManager: {getAccounts: () => accounts, getAccount: uuid => accounts[uuid], saveAccounts() {}, setActiveAccount() {}},
        RxHttp: {text: async (url, options) => { calls.push({url, options}); const reply = replies.shift(); return {ok: reply.status < 300, status: reply.status, body: JSON.stringify(reply.body || {})}; }},
        $: () => ({toggle() {}})
    };
    const off = load("RxMicrosoft", microsoftGlobals);
    assert.equal(off.isAvailable(), false, "without an application id the sign-in is off");
    assert.equal(await off.login(), false);
    const ms = load("RxMicrosoft", {...microsoftGlobals, MICROSOFT_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
        setTimeout: (fn) => setTimeout(fn, 0)});
    assert.equal(ms.isAvailable(), true);
    assert.equal(ms.safeLoginPage("https://www.microsoft.com/link"), "https://www.microsoft.com/link");
    assert.equal(ms.safeLoginPage("https://evil.example/microsoft.com"), "https://www.microsoft.com/link");
    assert.equal(ms.safeLoginPage("http://microsoft.com/link"), "https://www.microsoft.com/link");

    // Код устройства и ожидание: «ещё не подтверждено» → «помедленнее» → токены
    replies.push({status: 200, body: {device_code: "dev", user_code: "ABCD-EFGH", verification_uri: "https://www.microsoft.com/link", interval: 1, expires_in: 900}});
    const device = await ms.deviceCode();
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.match(calls[0].options.body, /client_id=11111111-2222-3333-4444-555555555555/);
    assert.match(calls[0].options.body, /scope=XboxLive\.signin\+offline_access/);
    replies.push({status: 400, body: {error: "authorization_pending"}}, {status: 400, body: {error: "slow_down"}}, {status: 200, body: {access_token: "ms-access", refresh_token: "ms-refresh"}});
    assert.deepEqual({...(await ms.pollToken(device))}, {accessToken: "ms-access", refreshToken: "ms-refresh"});
    replies.push({status: 400, body: {error: "authorization_declined"}});
    await assert.rejects(ms.pollToken(device), error => error.code === "declined");
    replies.push({status: 400, body: {error: "expired_token"}});
    await assert.rejects(ms.pollToken(device), error => error.code === "expired");

    // Xbox Live → XSTS → Minecraft → профиль
    const chain = () => [
        {status: 200, body: {Token: "xbl", DisplayClaims: {xui: [{uhs: "hash"}]}}},
        {status: 200, body: {Token: "xsts"}},
        {status: 200, body: {access_token: "mc-token", expires_in: 86400}},
        {status: 200, body: {id: "0123456789abcdef0123456789abcdef", name: "Steve_1"}}
    ];
    calls.length = 0;
    replies.push(...chain());
    const session = await ms.minecraftSession("ms-access");
    assert.equal(session.uuid, "0123456789abcdef0123456789abcdef");
    assert.equal(session.nickname, "Steve_1");
    assert.equal(calls[0].options.body.Properties.RpsTicket, "d=ms-access");
    assert.equal(calls[1].options.body.RelyingParty, "rp://api.minecraftservices.com/");
    assert.equal(calls[2].options.body.identityToken, "XBL3.0 x=hash;xsts");
    assert.equal(calls[3].options.headers.Authorization, "Bearer mc-token");
    assert.equal(calls[3].options.method, "GET");
    // Понятные причины отказа
    replies.push(chain()[0], {status: 401, body: {XErr: 2148916233}});
    await assert.rejects(ms.minecraftSession("t"), error => error.code === "no_xbox");
    replies.push(chain()[0], {status: 401, body: {XErr: 2148916238}});
    await assert.rejects(ms.minecraftSession("t"), error => error.code === "child");
    replies.push(chain()[0], chain()[1], {status: 403, body: {}});
    await assert.rejects(ms.minecraftSession("t"), error => error.code === "app_not_approved");
    replies.push(chain()[0], chain()[1], chain()[2], {status: 404, body: {error: "NOT_FOUND"}});
    await assert.rejects(ms.minecraftSession("t"), error => error.code === "no_game");
    assert.notEqual(ms.errorText("no_game"), ms.errorText("unavailable"));
    assert.equal(ms.errorText("что-то новое"), ms.errorText("unavailable"));

    // Запуск игры: свежий токен — без сети, устаревший — обновляется, отозванный вход — просит войти заново
    const uuid = session.uuid;
    accounts[uuid] = {type: "microsoft", uuid, nickname: "Steve_1", accessToken: "mc-token", refreshToken: "ms-refresh", expiresAt: Date.now() + 3600e3};
    calls.length = 0;
    const auth = await ms.getAccountForAuth(uuid);
    assert.equal(calls.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(auth)), {access_token: "mc-token", client_token: "", uuid, name: "Steve_1", meta: {type: "msa", xuid: "0", clientId: "0"}});
    accounts[uuid].expiresAt = Date.now() - 1000;
    replies.push({status: 200, body: {access_token: "ms-access-2", refresh_token: "ms-refresh-2"}}, ...chain().slice(0, 2), {status: 200, body: {access_token: "mc-token-2", expires_in: 86400}}, chain()[3]);
    const renewed = await ms.getAccountForAuth(uuid);
    assert.equal(renewed.access_token, "mc-token-2");
    assert.equal(accounts[uuid].refreshToken, "ms-refresh-2");
    assert.match(calls[0].options.body, /grant_type=refresh_token/);
    // Сервис лежит, а токен ещё действует (но скоро истечёт) — играем со старым
    accounts[uuid].expiresAt = Date.now() + 5 * 60e3;
    replies.push({status: 503, body: {}});
    assert.equal((await ms.getAccountForAuth(uuid)).access_token, "mc-token-2");
    // Вход отозван — запуска нет, игроку показано, что делать
    accounts[uuid].expiresAt = Date.now() - 1000;
    ms.login = async () => false;
    toasts.length = 0;
    replies.push({status: 400, body: {error: "invalid_grant"}});
    assert.equal(await ms.getAccountForAuth(uuid), false);
    assert.equal(toasts.length, 1);
    assert.equal(replies.length, 0);

    // ---------- меню трея ----------
    const sent = [];
    let active = "fabric-1.21.4", started = 0, stopped = 0, shown = 0;
    const tray = load("RxTray", {
        MESSAGES: {tray: {open: "Open", stop: "Stop", launch: "Launch"}}, ipcRenderer: {send: (...args) => sent.push(args), on() {}}, RxCollector: {writeLog() {}},
        RxVersionsManager: {getActiveVersion: () => active, getFavoriteVersions: () => ["vanilla-1.20.1", "fabric-1.21.4", "broken", "none", "forge-1.12.2", "quilt-1.20.4", "neoforge-1.21.1"],
            versionToDisplayName: id => id === "forge-1.12.2" ? (() => { throw new Error("no name"); })() : id.toUpperCase(), setActiveVersion: id => { active = id; }},
        RxVersionsUI: {loadVersions() {}}, RxUI: {appearMainWindow: () => shown++}, RxFlyout: {startSelectedVersion: async () => ++started},
        RxStarter: {runningList: () => [{stop: () => stopped++}, {stop: () => stopped++}]}
    });
    tray.sync();
    assert.equal(sent[0][0], "tray-menu");
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1].versions)), [
        {id: "fabric-1.21.4", title: "FABRIC-1.21.4"}, {id: "vanilla-1.20.1", title: "VANILLA-1.20.1"}, {id: "forge-1.12.2", title: "forge-1.12.2"}, {id: "quilt-1.20.4", title: "QUILT-1.20.4"}
    ]);
    assert.equal(await tray.onAction({action: "launch", id: "not-in-menu-1.0"}), false, "only versions from the menu can be launched");
    assert.equal(started, 0);
    await tray.onAction({action: "launch", id: "vanilla-1.20.1"});
    assert.deepEqual([active, started, shown], ["vanilla-1.20.1", 1, 1]);
    await tray.onAction({action: "stop"});
    assert.equal(stopped, 2);

    // ---------- соглашение ----------
    const config = {};
    const answers = [null, "eula", "privacy", "accept"];
    const opened = [], ipc = [];
    const eulaGlobals = () => ({
        REPO_NAME: "ReflexerFTP/RxLauncher", MESSAGES: {}, RxCollector: {writeLog() {}}, openExternal: url => opened.push(url), ipcRenderer: {send: channel => ipc.push(channel)},
        RxConfig: {read: (key, value) => key in config ? config[key] : value, write: (key, value) => { config[key] = value; }},
        RxDialog: {open: async () => ({button: answers.shift()})}
    });
    const eula = load("RxEula", eulaGlobals());
    assert.equal(await eula.ensure(), true, "Esc and opening a document keep the question on screen");
    assert.deepEqual(opened, ["https://github.com/ReflexerFTP/RxLauncher/blob/main/EULA.md", "https://github.com/ReflexerFTP/RxLauncher/blob/main/PRIVACY_POLICY.md"]);
    assert.equal(config.eulaAccepted, eula.VERSION);
    assert.equal(await eula.ensure(), true, "asked only once");
    delete config.eulaAccepted;
    answers.push("exit");
    assert.equal(await load("RxEula", eulaGlobals()).ensure(), false);
    assert.deepEqual(ipc, ["close-main-window"]);
    assert.equal(config.eulaAccepted, undefined);

    // ---------- сборка: Rx Client и Electron убраны ----------
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(pkg.dependencies, undefined);
    for (const name of ["electron", "electron-builder", "electron-updater", "minecraft-launcher-core", "discord-rpc"]) assert.equal(pkg.devDependencies[name], undefined, name);
    assert.equal(fs.existsSync(path.join(root, "web", "assets", "rxclient")), false);
    assert.doesNotMatch(source("RxLaunchConfigurator"), /rxclient|fancymenu/i);
    const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
    assert.deepEqual(conf.app.security.assetProtocol.scope.allow, [], "folders for the asset protocol are opened by the core at runtime");

    console.log("RxLauncher 4.5 tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, {recursive: true, force: true}));
