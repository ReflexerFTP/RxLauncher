// Изображает window.__TAURI_INTERNALS__ (то, что Tauri вставляет в страницу) для стенда mock-core.cjs
let next = 1;
const callbacks = new Map();
window.__TAURI_INTERNALS__ = {
    convertFileSrc: (path, protocol = "asset") => `http://${protocol}.localhost/${encodeURIComponent(path)}`,
    transformCallback: (fn) => { const id = next++; callbacks.set(id, fn); return id; },
    invoke: async (cmd) => {
        if (cmd === "plugin:event|listen") return next++;
        throw new Error(`mock invoke: ${cmd}`);
    }
};
