// Замена minecraft-launcher-core: Client.launch(config) запускает игру в Rust-ядре (game.rs),
// события debug / data / progress / download-status / arguments / close — как у MCLC
const bridge = require("./bridge");
const EventEmitter = require("events");
const {Buffer} = require("buffer");

const clients = new Map();
let nextLaunch = 1;
let listening = false;
const listen = () => {
    if (listening) return;
    listening = true;
    bridge.listen("rx:game", message => {
        const client = clients.get(message && message.id);
        if (!client) return;
        client.emit(message.event, message.data);
        if (message.event === "close") clients.delete(message.id);
    });
};

class Client extends EventEmitter {
    async launch(options) {
        listen();
        const launchId = nextLaunch++;
        clients.set(launchId, this);
        try {
            const {pid} = await bridge.value("game.launch", {launchId, config: options});
            const child = new EventEmitter();
            child.pid = pid;
            child.kill = () => bridge.value("process.killTree", {pid}).then(() => true, () => false);
            this.once("close", code => child.emit("close", code));
            return child;
        } catch (error) {
            clients.delete(launchId);
            this.emit("debug", `[RxCore]: ${error.message}`);
            throw error;
        }
    }
}

// Офлайн-аккаунт как в MCLC: UUID v3 от ника в пространстве имён DNS (тот же игрок в одиночных мирах)
const DNS_NAMESPACE = "6ba7b8109dad11d180b400c04fd430c8";
const offlineUuid = name => {
    const crypto = require("crypto");
    const bytes = crypto.createHash("md5").update(Buffer.concat([Buffer.from(DNS_NAMESPACE, "hex"), Buffer.from(String(name), "utf8")])).digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const Authenticator = {
    getAuth: async (username, password) => {
        if (password) throw new Error("Mojang password login is not supported");
        const uuid = offlineUuid(username);
        return {access_token: uuid, client_token: uuid, uuid, name: username, user_properties: "{}"};
    },
    offlineUuid
};

module.exports = {Client, Authenticator};
