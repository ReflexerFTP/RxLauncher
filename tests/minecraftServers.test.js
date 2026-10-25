const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const NBT = require("mcnbt");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-servers-test-"));
const gameRoot = path.join(tempRoot, "game");
const versionRoot = path.join(tempRoot, "version-game");
const config = Object.create(null);

const RxConfig = {
    read: (key, fallback) => Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback,
    write: (key, value) => {
        config[key] = JSON.parse(JSON.stringify(value));
        return true;
    }
};

const context = vm.createContext({
    console,
    Buffer,
    fs,
    path,
    require,
    NBT,
    RxConfig,
    GAME_DATA: gameRoot,
    RxVersionsManager: {
        getActiveVersion: () => "forge-1.21.4",
        parseVersionID: (id) => {
            const [type, ...rest] = id.split("-");
            return {id, type, name: rest.join("-")};
        }
    },
    RxUtils: {getGameRoot: () => versionRoot}
});

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxMinecraftServers.js"), "utf8");
vm.runInContext(`${source}\nthis.RxMinecraftServers = RxMinecraftServers;`, context, {filename: "RxMinecraftServers.js"});
const RxMinecraftServers = context.RxMinecraftServers;

assert.strictEqual(RxMinecraftServers.normalizeAddress(" Play.InfinityBox.pro:25565 "), "play.infinitybox.pro:25565");
assert.strictEqual(RxMinecraftServers.normalizeAddress("127.000.000.001:25565"), "127.0.0.1:25565");
assert.strictEqual(RxMinecraftServers.normalizeAddress("[2001:0DB8:0:0:0:0:0:1]:25565"), "[2001:db8::1]:25565");
assert.strictEqual(RxMinecraftServers.normalizeAddress("пример.рф"), "xn--e1afmkfd.xn--p1ai");
assert.throws(() => RxMinecraftServers.normalizeAddress("https://example.org"));
assert.throws(() => RxMinecraftServers.normalizeAddress("example.\u00a0org"));
assert.throws(() => RxMinecraftServers.normalizeAddress("999.1.1.1"));
assert.throws(() => RxMinecraftServers.normalizeAddress("2001:db8::1"));
assert.throws(() => RxMinecraftServers.normalizeAddress("example.org:65536"));

assert.strictEqual(RxMinecraftServers.add({name: " Infinity Box ", ip: "Play.InfinityBox.pro"}), true);
assert.strictEqual(RxMinecraftServers.add({name: "Duplicate", ip: "play.infinitybox.pro."}), false);
assert.strictEqual(RxMinecraftServers.isSaved("PLAY.INFINITYBOX.PRO"), true);
assert.deepStrictEqual(
    JSON.parse(JSON.stringify(RxMinecraftServers.getSavedServers())),
    [{name: "Infinity Box", ip: "play.infinitybox.pro"}]
);
assert.strictEqual(RxMinecraftServers.add({name: "Already in Minecraft", ip: "example.org:25565"}), true);

const stringTag = (value) => {
    const tag = new NBT.Tags.TAGString();
    tag.setValue(value);
    return tag;
};
const byteTag = (value) => {
    const tag = new NBT.Tags.TAGByte();
    tag.setValue(value);
    return tag;
};
const existingServer = new NBT.Tags.TAGCompound();
existingServer.setValue({
    name: stringTag("Existing favorite"),
    ip: stringTag("EXAMPLE.ORG:25565"),
    hidden: byteTag(1),
    acceptTextures: byteTag(0),
    icon: stringTag("data:image/png;base64,existing-icon")
});
const existingList = new NBT.Tags.TAGList();
existingList.setValue([existingServer]);
const existingRoot = new NBT.Tags.TAGCompound();
existingRoot.setValue({servers: existingList, customRootField: stringTag("keep-me")});
existingRoot.id = "";
const existingDocument = new NBT();
existingDocument.root[""] = existingRoot;
fs.mkdirSync(gameRoot, {recursive: true});
const serversPath = path.join(gameRoot, "servers.dat");
const originalBuffer = existingDocument.writeToBuffer();
fs.writeFileSync(serversPath, originalBuffer);

const firstSync = RxMinecraftServers.syncToDirectory(gameRoot);
assert.strictEqual(firstSync.changed, true);
assert.strictEqual(firstSync.added, 1);
assert.deepStrictEqual(fs.readFileSync(`${serversPath}.rxlaunch-backup`), originalBuffer, "backup must contain the exact original file");

const readDocument = (filePath) => {
    const document = new NBT();
    let error = null;
    document.loadFromBuffer(fs.readFileSync(filePath), (parseError) => { error = parseError || null; });
    if (error) throw error;
    return document;
};
const syncedDocument = readDocument(serversPath);
const syncedRoot = syncedDocument.select("");
const syncedList = syncedRoot.select("servers");
assert.strictEqual(syncedRoot.select("customRootField").getValue(), "keep-me", "unrelated root tags must survive");
assert.strictEqual(syncedList.count(), 2, "the saved catalog server must be appended");
assert.strictEqual(syncedList.selectAt(0).select("icon").getValue(), "data:image/png;base64,existing-icon", "existing server fields must survive");
assert.strictEqual(syncedList.selectAt(0).select("hidden").getValue(), 1, "existing values must not be rewritten");
const addedServer = syncedList.selectAt(1);
assert.strictEqual(addedServer.select("name").getValue(), "Infinity Box");
assert.strictEqual(addedServer.select("ip").getValue(), "play.infinitybox.pro");
assert.strictEqual(addedServer.select("hidden").getValue(), 0);
assert.strictEqual(addedServer.select("acceptTextures").getValue(), 1);

const secondSync = RxMinecraftServers.syncToDirectory(gameRoot);
assert.strictEqual(secondSync.changed, false);
assert.strictEqual(secondSync.added, 0);
assert.strictEqual(readDocument(serversPath).select("").select("servers").count(), 2, "repeated sync must not duplicate IPs");
assert.strictEqual(fs.readdirSync(gameRoot).some((name) => name.includes("rxlaunch-tmp") || name.includes("rxlaunch-replace")), false, "temporary files must be cleaned up");

assert.strictEqual(RxMinecraftServers.add({name: "SureBox", address: "play.surebox.pro"}), true);
const currentVersionSync = RxMinecraftServers.syncForCurrentVersion();
assert.strictEqual(currentVersionSync.added, 3);
const versionList = readDocument(path.join(versionRoot, "servers.dat")).select("").select("servers");
assert.strictEqual(versionList.count(), 3, "current-version sync must use the resolved game directory");

const corruptRoot = path.join(tempRoot, "corrupt-game");
fs.mkdirSync(corruptRoot, {recursive: true});
const corruptPath = path.join(corruptRoot, "servers.dat");
const corruptBytes = Buffer.from("not-nbt");
fs.writeFileSync(corruptPath, corruptBytes);
assert.throws(() => RxMinecraftServers.syncToDirectory(corruptRoot), "a corrupt servers.dat must not be overwritten");
assert.deepStrictEqual(fs.readFileSync(corruptPath), corruptBytes);
assert.strictEqual(fs.existsSync(`${corruptPath}.rxlaunch-backup`), false, "a corrupt file must not produce a misleading backup");

fs.rmSync(tempRoot, {recursive: true, force: true});
console.log("RxMinecraftServers tests passed");
