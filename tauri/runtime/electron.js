// Замена модуля electron: IPC идёт в Rust-ядро, события ядра приходят как Tauri events «rx:<канал>»
const bridge = require("./bridge");

const subscriptions = new Map(); // listener -> отписка
const ipcRenderer = {
    invoke: (channel, ...args) => bridge.value("ipc", {channel, args}),
    send: (channel, ...args) => {
        bridge.value("ipc", {channel, args}).catch(error => console.warn(`IPC ${channel} failed:`, error && error.message ? error.message : error));
    },
    sendSync: (channel, ...args) => bridge.syncValue("ipc", {channel, args}),
    on(channel, listener) {
        const off = bridge.listen(`rx:${channel}`, payload => listener({sender: ipcRenderer}, ...(Array.isArray(payload) ? payload : [payload])));
        subscriptions.set(listener, off);
        return ipcRenderer;
    },
    once(channel, listener) {
        const off = bridge.listen(`rx:${channel}`, payload => {
            off();
            listener({sender: ipcRenderer}, ...(Array.isArray(payload) ? payload : [payload]));
        });
        subscriptions.set(listener, off);
        return ipcRenderer;
    },
    removeListener(_channel, listener) {
        const off = subscriptions.get(listener);
        if (off) off();
        subscriptions.delete(listener);
        return ipcRenderer;
    },
    off(channel, listener) {
        return ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners() {
        for (const off of subscriptions.values()) off();
        subscriptions.clear();
        return ipcRenderer;
    }
};

const shell = {
    openExternal: url => bridge.value("shell.openExternal", {url: String(url)}),
    openPath: async target => {
        try { await bridge.value("shell.openPath", {path: String(target)}); return ""; } catch (error) { return error.message || "Failed to open"; }
    },
    showItemInFolder: target => bridge.value("shell.showItemInFolder", {path: String(target)}),
    trashItem: target => bridge.value("shell.trash", {path: String(target)})
};

const clipboard = {
    writeText: text => bridge.syncValue("clipboard.writeText", {text: String(text ?? "")}),
    readText: () => bridge.syncValue("clipboard.readText", {}) || ""
};

const webFrame = {
    clearCache: () => {},
    setZoomFactor: () => {},
    getZoomFactor: () => 1
};

// Путь перетащенного файла: Tauri сообщает пути сам (см. dragDrop в core.js), у File в WebView пути нет
const webUtils = {
    getPathForFile: file => (file && (file.rxPath || file.path)) || ""
};

module.exports = {ipcRenderer, shell, clipboard, webFrame, webUtils};
