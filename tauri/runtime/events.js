// EventEmitter как в Node (то, что нужно коду лаунчера)
class EventEmitter {
    constructor() {
        Object.defineProperty(this, "_events", {value: new Map(), writable: true, enumerable: false});
        this._maxListeners = 10;
    }
    _list(name) {
        if (!this._events) Object.defineProperty(this, "_events", {value: new Map(), writable: true, enumerable: false});
        let list = this._events.get(name);
        if (!list) this._events.set(name, list = []);
        return list;
    }
    on(name, listener) {
        this._list(name).push({listener, once: false});
        return this;
    }
    addListener(name, listener) {
        return this.on(name, listener);
    }
    prependListener(name, listener) {
        this._list(name).unshift({listener, once: false});
        return this;
    }
    once(name, listener) {
        this._list(name).push({listener, once: true});
        return this;
    }
    off(name, listener) {
        const list = this._list(name);
        const index = list.findIndex(item => item.listener === listener);
        if (index !== -1) list.splice(index, 1);
        return this;
    }
    removeListener(name, listener) {
        return this.off(name, listener);
    }
    removeAllListeners(name) {
        if (name === undefined) this._events = new Map();
        else this._events.delete(name);
        return this;
    }
    emit(name, ...args) {
        const list = this._events ? this._events.get(name) : null;
        if (!list || !list.length) {
            if (name === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
            return false;
        }
        for (const item of [...list]) {
            if (item.once) this.off(name, item.listener);
            item.listener.apply(this, args);
        }
        return true;
    }
    listenerCount(name) {
        return this._events && this._events.get(name) ? this._events.get(name).length : 0;
    }
    listeners(name) {
        return this._events && this._events.get(name) ? this._events.get(name).map(item => item.listener) : [];
    }
    eventNames() {
        return this._events ? [...this._events.keys()].filter(name => this._events.get(name).length) : [];
    }
    setMaxListeners(count) {
        this._maxListeners = count;
        return this;
    }
    getMaxListeners() {
        return this._maxListeners;
    }
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;
EventEmitter.once = (emitter, name) => new Promise((resolve, reject) => {
    emitter.once(name, (...args) => resolve(args));
    if (name !== "error") emitter.once("error", reject);
});
module.exports = EventEmitter;
