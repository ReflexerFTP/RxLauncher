// Мост к Rust-ядру лаунчера через протокол rxsync://
// callSync — синхронный XHR (для fs.*Sync и ipcRenderer.sendSync), call — fetch (не блокирует интерфейс).
// Формат запроса: [u32 LE длина JSON][JSON-аргументы][двоичные данные]; ответа: [u8 0|1][u32 LE длина JSON][JSON][двоичные данные]
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
let baseUrl = "";

const base = () => {
    if (baseUrl) return baseUrl;
    const internals = window.__TAURI_INTERNALS__;
    baseUrl = internals && typeof internals.convertFileSrc === "function" ? internals.convertFileSrc("", "rxsync") : "http://rxsync.localhost/";
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    return baseUrl;
};

const toBytes = data => {
    if (data === undefined || data === null) return null;
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return encoder.encode(String(data));
};

const encodeRequest = (args, payload) => {
    const header = encoder.encode(JSON.stringify(args === undefined ? null : args));
    const bytes = toBytes(payload);
    const body = new Uint8Array(4 + header.length + (bytes ? bytes.length : 0));
    new DataView(body.buffer).setUint32(0, header.length, true);
    body.set(header, 4);
    if (bytes) body.set(bytes, 4 + header.length);
    return body;
};

// Ошибка как в Node: message, code, errno, syscall, path
const makeError = info => {
    const error = new Error(info && info.message ? info.message : "Unknown error");
    if (info && typeof info === "object") {
        for (const key of ["code", "errno", "syscall", "path", "dest", "status"]) if (info[key] !== undefined) error[key] = info[key];
    }
    return error;
};

const decodeResponse = bytes => {
    if (bytes.length < 5) throw makeError({message: "Empty response from launcher core", code: "EBRIDGE"});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const status = bytes[0];
    const length = view.getUint32(1, true);
    const json = length ? JSON.parse(decoder.decode(bytes.subarray(5, 5 + length))) : null;
    const payload = bytes.subarray(5 + length);
    if (status !== 0) throw makeError(json);
    return {value: json, payload};
};

exports.callSync = (op, args, payload) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base() + op, false);
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send(encodeRequest(args, payload));
    if (xhr.status !== 200) throw makeError({message: `Launcher core request failed (${xhr.status}) for ${op}`, code: "EBRIDGE"});
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return decodeResponse(bytes);
};

exports.call = async (op, args, payload, {signal} = {}) => {
    const response = await fetch(base() + op, {method: "POST", body: encodeRequest(args, payload), signal, cache: "no-store"});
    if (response.status !== 200) throw makeError({message: `Launcher core request failed (${response.status}) for ${op}`, code: "EBRIDGE"});
    return decodeResponse(new Uint8Array(await response.arrayBuffer()));
};

exports.syncValue = (op, args, payload) => exports.callSync(op, args, payload).value;
exports.value = async (op, args, payload, options) => (await exports.call(op, args, payload, options)).value;

// События от ядра (Tauri events): listen(name, fn) → функция отписки
const listeners = new Map();
exports.listen = (name, fn) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.transformCallback !== "function") return () => {};
    let entry = listeners.get(name);
    if (!entry) {
        entry = {fns: new Set(), ready: null};
        listeners.set(name, entry);
        const handler = internals.transformCallback(event => {
            for (const listener of [...entry.fns]) {
                try { listener(event && Object.prototype.hasOwnProperty.call(event, "payload") ? event.payload : event); }
                catch (error) { console.error(`Listener for ${name} failed`, error); }
            }
        });
        entry.ready = internals.invoke("plugin:event|listen", {event: name, target: {kind: "Any"}, handler}).catch(error => console.error(`Cannot listen to ${name}`, error));
    }
    entry.fns.add(fn);
    return () => entry.fns.delete(fn);
};

exports.makeError = makeError;
exports.toBytes = toBytes;
