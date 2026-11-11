window.$ = window.jQuery = require("jquery");
const fs = require("fs");
const fsPromises = require("fs/promises");
const fsExtra = require("fs-extra");
const path = require("path");
const {pathToFileURL} = require("url");
const os = require("os");
const {ipcRenderer} = require("electron");
const crypto = require("crypto");
const openExternal = async value => {
    try {
        const {kind, target} = require("../externalTargets").classifyExternalTarget(value);
        const shell = require("electron").shell;
        return kind === "url" ? await shell.openExternal(target) : await shell.openPath(target);
    } catch (error) {
        RxCollector.writeLog("External link rejected: " + error.message);
        return false;
    }
};
const machineUuid = async () => {
    let id = RxConfig.read("anonymousInstallId", "");
    if (!id) { id = crypto.randomUUID(); RxConfig.write("anonymousInstallId", id); }
    return id;
};
const packageJson = require("./../package.json");
const treeKill = require("tree-kill");
const {exec} = require('node:child_process');
let toml = require('toml');

// Тяжёлые модули подключаются при первом обращении, а не при старте лаунчера:
// загрузчик Minecraft, обработка картинок и архивы нужны только при запуске игры или установке
const lazyGlobal = (name, loader) => Object.defineProperty(window, name, {
    configurable: true,
    get() {
        const value = loader();
        Object.defineProperty(window, name, {value, configurable: true, writable: true});
        return value;
    }
});
lazyGlobal("Client", () => require("minecraft-launcher-core").Client);
lazyGlobal("Authenticator", () => require("minecraft-launcher-core").Authenticator);
for (const loaderName of ["forge", "neoforge", "fabric", "quilt", "vanilla", "liner"]) {
    lazyGlobal(loaderName, () => require("tomate-loaders")[loaderName]);
}
lazyGlobal("Jimp", () => require("jimp").Jimp);
lazyGlobal("compressing", () => require("compressing"));
lazyGlobal("NBT", () => require("mcnbt"));

// Версия лаунчера
global.LAUNCHER_VERSION = packageJson.version;

// Ссылки на сайт
global.SITE_URL = "https://rxlauncher.xyz";
// Старые сервисы на rxlauncher.ru (скины, сбор статистики, CDN) больше не существуют, а домен никому не принадлежит:
// туда нельзя отправлять ни данные, ни пароли. Пустой адрес — функция выключена
global.SKINS_API_URL = "";
global.STATS_URL = "";
global.REPO_NAME = "ReflexerFTP/RxLauncher";
// Идентификатор приложения Azure для входа через Microsoft (Application (client) ID). Приложение должно быть
// одобрено для сервисов Minecraft (aka.ms/mce-reviewappid). Пустая строка — вход через Microsoft выключен
global.MICROSOFT_CLIENT_ID = "";

// Ссылка на Java
global.JAVA_LIST_URL = "https://api.adoptium.net/v3/info/available_releases";

// Последние логи лаунчера
global.LAST_LOG = "";

// Лаунчер в dev mode? test mode?
global.IS_APP_IN_DEV = ipcRenderer.sendSync("isAppInDev");
global.IS_APP_IN_TEST = ipcRenderer.sendSync("isAppInTest");

if (IS_APP_IN_DEV) {
    //global.SKINS_API_URL = "http://localhost:58883";
}

// Пути к файлам
global.USERDATA_PATH = path.normalize(ipcRenderer.sendSync("get-userdata-path"));
global.CONFIG_PATH = path.join(global.USERDATA_PATH, "config.json");
if (process.platform === "win32") {
    global.DOT_MC_PATH = path.join(os.homedir(), "AppData", "Roaming", ".minecraft");
} else {
    global.DOT_MC_PATH = path.join(os.homedir(), ".minecraft");
}

const animateCSS = (element, animation, fast = true, prefix = "animate__") => {
    const node = document.querySelector(element);

    return animateCSSNode(node, animation, fast, prefix);
};

const animateCSSNode = (node, animation, fast = true, prefix = "animate__") => {
    return new Promise((resolve) => {
        if (!node || !animation) {
            return resolve("Animation skipped");
        }

        const animationName = `${prefix}${animation}`;
        const animationId = `${Date.now()}-${Math.random()}`;
        let settled = false;

        if (node.dataset.rxAnimationName) {
            node.classList.remove(node.dataset.rxAnimationName);
        }
        node.classList.remove(`${prefix}animated`, `${prefix}faster`);
        node.dataset.rxAnimationName = animationName;
        node.dataset.rxAnimationId = animationId;

        if (fast === true) {
            node.classList.add(`${prefix}animated`, animationName, `${prefix}faster`);
        } else {
            node.classList.add(`${prefix}animated`, animationName);
        }

        function cleanup() {
            if (settled) return;
            settled = true;
            clearTimeout(fallbackTimer);
            node.removeEventListener("animationend", handleAnimationEnd);
            if (node.dataset.rxAnimationId !== animationId) {
                return resolve("Animation superseded");
            }
            node.classList.remove(
                `${prefix}animated`,
                animationName,
                `${prefix}faster`
            );
            delete node.dataset.rxAnimationName;
            delete node.dataset.rxAnimationId;
            resolve("Animation ended");
        }

        function handleAnimationEnd(event) {
            event.stopPropagation();
            cleanup();
        }

        // Страховка: если animationend не сработает (отключённые анимации,
        // прерванная анимация, скрытый узел) — всё равно завершаем,
        // чтобы модалки гарантированно закрывались.
        const fallbackTimer = setTimeout(cleanup, 800);

        node.addEventListener("animationend", handleAnimationEnd, {once: true});
    });
}

// Системные подсказки Windows (атрибут title) в лаунчере не показываем — по просьбе автора они только мешают.
// Подпись переносится в aria-label, чтобы кнопки без текста остались понятны экранному диктору
(() => {
    const strip = (element) => {
        const title = element.getAttribute("title");
        if (title === null) return;
        if (title && !element.hasAttribute("aria-label")) element.setAttribute("aria-label", title);
        element.removeAttribute("title");
    };
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            if (record.type === "attributes") {
                strip(record.target);
                continue;
            }
            record.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                strip(node);
                node.querySelectorAll("[title]").forEach(strip);
            });
        }
    });
    const start = () => {
        document.querySelectorAll("[title]").forEach(strip);
        observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ["title"]});
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once: true});
    else start();
})();
