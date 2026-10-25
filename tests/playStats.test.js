const assert = require("assert");
const crypto = require("crypto");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-stats-test-"));
const legacy = {
    "fabric-1.21.4": {starts: 41, inGame: 3658, lastStart: 1785324598953},
    "forge-1.21.4": {starts: 52, inGame: 2821, lastStart: 1784631090467},
    "vanilla-1.21.4": {starts: 3, inGame: 238, lastStart: 1783195981905},
    "vanilla-1.16.5": {starts: 1, inGame: 7, lastStart: 1783859520037},
    "vanilla-1.17.1": {starts: 2, inGame: 31, lastStart: 1783860646274}
};

const context = vm.createContext({
    console,
    Buffer,
    crypto,
    fs,
    path,
    require,
    USERDATA_PATH: tempRoot,
    RxConfig: {read: (key, fallback) => key === "gameStatistics" ? legacy : fallback},
    RxCollector: {writeLog: () => true},
    RxVersionsManager: {
        parseVersionID: (id) => {
            const [type, ...name] = String(id).split("-");
            return {id, type, name: name.join("-")};
        }
    },
    document: {dispatchEvent: () => true},
    CustomEvent: class CustomEvent { constructor(name) { this.type = name; } },
    setInterval: () => 1,
    clearInterval: () => true,
    setTimeout,
    clearTimeout
});

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxPlayStats.js"), "utf8");
vm.runInContext(`${source}\nthis.RxPlayStats = RxPlayStats;`, context, {filename: "RxPlayStats.js"});
const RxPlayStats = context.RxPlayStats;

const migrated = RxPlayStats.getAllStats();
assert.strictEqual(migrated.totals.playSeconds, 6755, "legacy seconds must migrate exactly");
assert.strictEqual(migrated.totals.sessions, 99, "legacy launches must migrate exactly");
assert.strictEqual(migrated.migration.legacyPlaySeconds, 6755, "legacy migration metadata must preserve migrated playtime");
assert.strictEqual(migrated.migration.legacySessions, 99, "legacy migration metadata must preserve migrated launches");
RxPlayStats.migrateLegacyStatistics();
assert.strictEqual(migrated.totals.playSeconds, 6755, "migration must be idempotent");

assert.strictEqual(RxPlayStats.onGameLaunch({
    versionId: "fabric-1.21.4",
    nickname: "Maksim_rrr",
    server: "play.infinitybox.pro",
    gameDirectory: path.join(tempRoot, "game"),
    playerUuid: "cfa57208-7d43-33f6-be2b-c8f3d9afd7dd",
    pid: 1234
}), true);

RxPlayStats.currentSession.pendingServer.detectedAt -= 13_000;
RxPlayStats.checkpoint(false, RxPlayStats.currentSession.lastCheckpointAt);
assert.strictEqual(RxPlayStats.currentSession.currentContext, null, "selected server must not be credited during game startup");
assert.strictEqual(RxPlayStats.currentSession.pendingServer.source, "selected");

RxPlayStats.handleGameLog("[14:31:11] [Render thread/INFO]: Loaded 2 advancements\n");
RxPlayStats.handleGameLog("[14:31:12] [Render thread/INFO]: [System] [CHAT] Connecting to evil.example, 25565\n");
RxPlayStats.handleGameLog("[14:31:13] [Render thread/INFO]: [System] [CHAT] Connection lost; Stopping server\n");
assert.strictEqual(RxPlayStats.currentSession.currentContext.name, "play.infinitybox.pro", "chat text must not spoof server lifecycle events");
const fakeProcess = {stdout: new EventEmitter(), stderr: new EventEmitter()};
assert.strictEqual(RxPlayStats.attachGameProcess(fakeProcess), true);
fakeProcess.stdout.emit("data", "[18:59:59] [Render thread/INFO]: [System] [CHAT] [🗡] Игрок Maksim_");
fakeProcess.stderr.emit("data", "[18:59:59] [Render thread/WARN]: harmless stderr line\n");
fakeProcess.stdout.emit("data", "rrr убил stream_victim!\n");
const utf8KillLine = Buffer.from("[19:00:00] [Render thread/INFO]: [System] [CHAT] [🗡] Игрок Maksim_rrr убил utf_victim!\n", "utf8");
const utf8SplitAt = utf8KillLine.indexOf(Buffer.from("🗡", "utf8")) + 2;
fakeProcess.stdout.emit("data", utf8KillLine.subarray(0, utf8SplitAt));
fakeProcess.stdout.emit("data", utf8KillLine.subarray(utf8SplitAt));
RxPlayStats.handleGameLog("[19:00:01] [Render thread/INFO]: [System] [CHAT] [🗡] Игрок Maksim_");
RxPlayStats.handleGameLog("rrr убил victim_123!\n");
RxPlayStats.handleGameLog("[19:00:02] [Render thread/INFO]: [System] [CHAT] [🗡] Игрок enemy_123 убил Maksim_rrr!\n");
RxPlayStats.handleGameLog("[19:00:02] [Render thread/INFO]: [System] [CHAT] [🗡] Игрок Maksim_rrr погиб!\n");
RxPlayStats.handleGameLog("[19:00:02] [Render thread/INFO]: [System] [CHAT] ▷ Вы погибли на координатах: x:1, y:2, z:3.\n");

const startedAt = RxPlayStats.currentSession.startedAt;
RxPlayStats.checkpoint(false, startedAt + 120000);
RxPlayStats.handleGameLog("[19:02:00] [Render thread/WARN]: SkinManager failed: java.net.ConnectException: Connection timed out\n");
assert.strictEqual(RxPlayStats.currentSession.currentContext.name, "play.infinitybox.pro", "unrelated skin timeouts must not clear the server");
RxPlayStats.handleGameLog("[19:02:01] [Render thread/ERROR]: Couldn't connect to server\n");
assert.strictEqual(RxPlayStats.currentSession.currentContext, null, "late connection failures must clear a confirmed server");
RxPlayStats.currentSession.lastCheckpointAt = Date.now();
assert.strictEqual(RxPlayStats.onGameClose({exitCode: 0, reason: "closed"}), true);

const dashboard = RxPlayStats.getDashboard({period: "all", nickname: "all"});
assert.strictEqual(dashboard.totals.playSeconds, 6875, "session playtime must be checkpointed");
assert.strictEqual(dashboard.totals.sessions, 100, "real process must add one session");
assert.strictEqual(dashboard.totals.kills, 3, "split, interleaved and UTF-8 stream lines must count correctly");
assert.strictEqual(dashboard.totals.deaths, 1, "player death must count once");
assert.strictEqual(dashboard.totals.bestKillStreak, 3, "best streak must persist after death");
assert.strictEqual(dashboard.rankings.servers[0].name, "play.infinitybox.pro");
assert.strictEqual(dashboard.rankings.servers[0].playSeconds, 120);
assert.strictEqual(dashboard.rankings.nicknames[0].name, "Maksim_rrr");
assert.strictEqual(dashboard.sessions.length, 1);
assert.ok(fs.existsSync(RxPlayStats.getStoragePath()), "dedicated statistics file must exist");
assert.ok(fs.existsSync(RxPlayStats.getBackupPath()), "rolling backup must exist");

const singleplayerRoot = path.join(tempRoot, "singleplayer");
const worldRoot = path.join(singleplayerRoot, "saves", "My World");
const playerUuid = "cfa57208-7d43-33f6-be2b-c8f3d9afd7dd";
const playerStatsPath = path.join(worldRoot, "stats", `${playerUuid}.json`);
fs.mkdirSync(path.dirname(playerStatsPath), {recursive: true});
fs.writeFileSync(path.join(worldRoot, "session.lock"), "lock", "utf8");
fs.writeFileSync(playerStatsPath, JSON.stringify({stats: {"minecraft:custom": {
    "minecraft:mob_kills": 5,
    "minecraft:player_kills": 0,
    "minecraft:deaths": 2
}}}), "utf8");

RxPlayStats.onGameLaunch({
    versionId: "vanilla-1.21.4",
    nickname: "Builder_2",
    gameDirectory: singleplayerRoot,
    playerUuid,
    pid: 5678
});
RxPlayStats.setContext("server", "stale.example.org");
RxPlayStats.handleGameLog("[19:09:59] [Render thread/INFO]: Starting integrated minecraft server version 1.21.4\n");
assert.strictEqual(RxPlayStats.currentSession.currentContext, null, "single-player startup must clear stale multiplayer context");
RxPlayStats.setContext("world", "My World");
RxPlayStats.handleGameLog("[19:10:00] [Server thread/INFO]: Saving and pausing game...\n");
assert.strictEqual(RxPlayStats.currentSession.currentContext.name, "My World", "pausing single-player must not stop world tracking");
const worldSessionStart = RxPlayStats.currentSession.startedAt;
RxPlayStats.checkpoint(false, worldSessionStart + 30_000);
RxPlayStats.currentSession.lastCheckpointAt = Date.now();
fs.writeFileSync(playerStatsPath, JSON.stringify({stats: {"minecraft:custom": {
    "minecraft:mob_kills": 7,
    "minecraft:player_kills": 1,
    "minecraft:deaths": 3
}}}), "utf8");
RxPlayStats.onGameClose({exitCode: 0, reason: "closed"});

const withWorld = RxPlayStats.getDashboard({period: "all", nickname: "all"});
assert.strictEqual(withWorld.totals.kills, 6, "single-player stat deltas must add mob and player kills");
assert.strictEqual(withWorld.totals.deaths, 2, "single-player stat deltas must add deaths");
assert.strictEqual(withWorld.rankings.worlds[0].name, "My World");
assert.strictEqual(withWorld.rankings.worlds[0].playSeconds, 30);
const builderOnly = RxPlayStats.getDashboard({period: "7d", nickname: "Builder_2"});
assert.strictEqual(builderOnly.totals.sessions, 1, "nickname and period filters must isolate sessions");
assert.strictEqual(builderOnly.totals.playSeconds, 30);

const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const todayKey = RxPlayStats.dayKey(todayStart.getTime());
const yesterdayKey = RxPlayStats.dayKey(todayStart.getTime() - 86_400_000);
const crossMidnight = RxPlayStats.normalizeSession({
    id: "cross-midnight",
    startedAt: todayStart.getTime() - 3_600_000,
    endedAt: todayStart.getTime() + 3_600_000,
    playSeconds: 7200,
    versionId: "fabric-1.21.4",
    nickname: "NightPlayer",
    kills: 7,
    deaths: 2,
    bestKillStreak: 5,
    serverSeconds: {"night.example.org": 7200},
    dailySeconds: {[yesterdayKey]: 3600, [todayKey]: 3600},
    dailyCombat: {
        [yesterdayKey]: {kills: 5, deaths: 1, bestKillStreak: 5},
        [todayKey]: {kills: 2, deaths: 1, bestKillStreak: 2}
    },
    dailyContexts: {
        [yesterdayKey]: {servers: {"night.example.org": 3600}},
        [todayKey]: {servers: {"night.example.org": 3600}}
    }
});
const todayOnly = RxPlayStats.aggregateSessions([crossMidnight], todayKey);
assert.strictEqual(todayOnly.totals.playSeconds, 3600, "today filter must not include time before midnight");
assert.strictEqual(todayOnly.totals.kills, 2, "today filter must use per-day combat counters");
assert.strictEqual(Object.values(todayOnly.dimensions.servers)[0].playSeconds, 3600, "today server ranking must use per-day context time");
const todaySession = RxPlayStats.projectSessionForPeriod(crossMidnight, todayKey);
assert.strictEqual(todaySession.playSeconds, 3600, "period session rows must match filtered KPI time");
assert.strictEqual(todaySession.kills, 2, "period session rows must match filtered combat totals");
assert.strictEqual(todaySession.serverSeconds["night.example.org"], 3600, "period session context must match filtered rankings");

const dangerousMap = Object.create(null);
RxPlayStats.incrementSessionCounter(dangerousMap, "__proto__", 15);
assert.strictEqual(Object.prototype.hasOwnProperty.call(dangerousMap, "__proto__"), true, "external names must not mutate object prototypes");
assert.strictEqual(dangerousMap.__proto__, 15);

const legacyStatsFile = path.join(tempRoot, "legacy-stats.json");
fs.writeFileSync(legacyStatsFile, JSON.stringify({"stat.mobKills": 4, "stat.playerKills": 2, "stat.deaths": 3}), "utf8");
assert.deepStrictEqual({...RxPlayStats.readVanillaStatsFile(legacyStatsFile)}, {kills: 6, deaths: 3}, "legacy Minecraft statistics must be supported");

RxPlayStats.saveStats();
fs.writeFileSync(RxPlayStats.getStoragePath(), "{broken", "utf8");
RxPlayStats.data = null;
const recovered = RxPlayStats.getAllStats();
assert.strictEqual(recovered.totals.playSeconds, 6905, "corrupt primary must restore the latest valid backup");
assert.strictEqual(recovered.totals.kills, 6, "backup recovery must preserve detailed statistics");
assert.strictEqual(recovered.totals.sessions, 101, "backup recovery must not repeat legacy migration");
assert.ok(fs.readdirSync(tempRoot).some(name => name.startsWith("play-statistics.corrupt-")), "corrupt data must be backed up");

fs.rmSync(tempRoot, {recursive: true, force: true});
console.log("RxPlayStats tests passed");
