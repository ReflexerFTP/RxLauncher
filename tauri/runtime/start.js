// Конец rx-runtime.js: глобальные объекты, которые раньше давал preload Electron, и обработчики шаблонов
(function () {
    "use strict";
    const require = window.__rxRequire;
    const bridge = require("../tauri/runtime/bridge");
    const {Buffer} = require("buffer");
    const {process} = require("../tauri/runtime/system");

    window.require = require;
    window.global = window;
    window.Buffer = Buffer;
    window.process = process;
    window.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
    window.clearImmediate = timer => clearTimeout(timer);
    const paths = bridge.syncValue("app.paths");
    window.__dirname = paths.webRoot;
    window.__filename = `${paths.webRoot}\\index.ejs`;
    // Ошибки интерфейса — в журнал ядра
    const report = (kind, error) => {
        try { bridge.value("log", {level: "error", message: `${kind}: ${error && error.stack ? error.stack : error}`}).catch(() => {}); } catch (_) {}
    };
    window.addEventListener("error", event => report("UI error", event.error || event.message));
    window.addEventListener("unhandledrejection", event => report("UI promise", event.reason));

    // data-rx-on*="hN" → функции из rx-handlers.js (сборка вынесла их из шаблона, eval не нужен)
    for (const kind of ["click", "change", "input", "submit", "keydown"]) {
        const attribute = `data-rx-on${kind}`;
        document.addEventListener(kind, event => {
            const element = event.target && event.target.closest ? event.target.closest(`[${attribute}]`) : null;
            if (!element || element.disabled) return;
            const action = (window.__rxHandlers || {})[element.getAttribute(attribute)];
            if (action && action.call(element, event) === false) event.preventDefault();
        });
    }
    // Два действия шаблона с данными, а не кодом
    document.addEventListener("click", event => {
        const target = event.target;
        if (!target || !target.closest) return;
        const version = target.closest("[data-rx-play-version]");
        // Классы интерфейса объявлены через class на верхнем уровне скриптов — это глобальные имена, но не свойства window
        if (version && /^[\w.-]{1,64}$/.test(version.dataset.rxPlayVersion)) RxStarter.simpleStart(`vanilla-${version.dataset.rxPlayVersion}`); // eslint-disable-line no-undef
        const language = target.closest("[data-rx-language]");
        if (language && ["ru", "en"].includes(language.dataset.rxLanguage)) RxTranslator.setCurrentLanguage(language.dataset.rxLanguage); // eslint-disable-line no-undef
    });

    // Перетаскивание файлов: Tauri сообщает пути, интерфейс получает обычные drop-события с File.rxPath
    let dragTarget = null;
    const elementAt = position => {
        const ratio = window.devicePixelRatio || 1;
        return position ? document.elementFromPoint(position.x / ratio, position.y / ratio) : null;
    };
    const fire = (type, target, paths) => {
        if (!target) return;
        const files = (paths || []).map(file => {
            const name = String(file).split(/[\\/]/).pop();
            const item = new File([], name);
            Object.defineProperty(item, "rxPath", {value: String(file)});
            Object.defineProperty(item, "path", {value: String(file)});
            return item;
        });
        const dataTransfer = new DataTransfer();
        for (const file of files) dataTransfer.items.add(file);
        Object.defineProperty(dataTransfer, "files", {value: Object.assign(files, {item: index => files[index]})});
        target.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer}));
    };
    bridge.listen("tauri://drag-enter", payload => { dragTarget = elementAt(payload.position); fire("dragenter", dragTarget, payload.paths); });
    bridge.listen("tauri://drag-over", payload => {
        const next = elementAt(payload.position);
        if (next !== dragTarget) { fire("dragleave", dragTarget, []); fire("dragenter", next, []); dragTarget = next; }
        fire("dragover", next, []);
    });
    bridge.listen("tauri://drag-leave", () => { fire("dragleave", dragTarget, []); dragTarget = null; });
    bridge.listen("tauri://drag-drop", payload => { fire("drop", elementAt(payload.position) || dragTarget, payload.paths); dragTarget = null; });
})();
