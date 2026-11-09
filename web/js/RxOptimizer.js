// Оптимизация потребления ОЗУ.
// Пока окно скрыто (обычно — во время игры), интерфейса не видно, поэтому можно
// выгрузить тяжёлое: картинки, кеш ресурсов — и один раз собрать мусор.
// Память нужнее Minecraft, а при возвращении лаунчер подгружает всё обратно.
class RxOptimizer {
    static _freeTimer = null;
    static _released = false;
    static _gcTimer = null;
    static _initialized = false;

    // Выгрузить тяжёлое, пока окно скрыто
    static releaseHiddenResources() {
        if (!document.hidden || RxOptimizer._released) return false;
        RxOptimizer._released = true;
        // Картинки обоев и обложки выгружаются CSS-правилом html.rx-memory-saver
        document.documentElement.classList.add("rx-memory-saver");
        if (typeof RxModMeta !== "undefined") RxModMeta.cache.clear();
        try {
            require("electron").webFrame.clearCache();
        } catch (_) {}
        // Сборка мусора доступна благодаря --expose-gc; UI скрыт, так что пауза незаметна
        if (typeof window.gc === "function") {
            RxOptimizer._gcTimer = setTimeout(() => {
                RxOptimizer._gcTimer = null;
                if (document.hidden) window.gc();
            }, 500);
        }
        try {
            RxCollector.writeLog("Optimizer: Hidden window resources released");
        } catch (_) {}
        return true;
    }

    // Вернуть всё, когда окно снова видно
    static restoreResources() {
        if (RxOptimizer._gcTimer !== null) {
            clearTimeout(RxOptimizer._gcTimer);
            RxOptimizer._gcTimer = null;
        }
        if (!RxOptimizer._released) return false;
        RxOptimizer._released = false;
        document.documentElement.classList.remove("rx-memory-saver");
        return true;
    }

    // Совместимость со старыми вызовами
    static freeMemory() {
        return RxOptimizer.releaseHiddenResources();
    }

    static scheduleFreeMemory(delay = 0) {
        if (RxOptimizer._freeTimer !== null) clearTimeout(RxOptimizer._freeTimer);
        RxOptimizer._freeTimer = setTimeout(() => {
            RxOptimizer._freeTimer = null;
            RxOptimizer.releaseHiddenResources();
        }, delay);
    }

    static init() {
        if (RxOptimizer._initialized) return;
        RxOptimizer._initialized = true;
        document.addEventListener("visibilitychange", () => {
            document.documentElement.classList.toggle("rx-in-background", document.hidden);
            if (document.hidden) {
                // Небольшая задержка: при коротком сворачивании ничего не перезагружаем
                RxOptimizer.scheduleFreeMemory(3000);
            } else {
                if (RxOptimizer._freeTimer !== null) {
                    clearTimeout(RxOptimizer._freeTimer);
                    RxOptimizer._freeTimer = null;
                }
                RxOptimizer.restoreResources();
            }
        });

        window.addEventListener("beforeunload", () => {
            if (RxOptimizer._gcTimer !== null) {
                clearTimeout(RxOptimizer._gcTimer);
                RxOptimizer._gcTimer = null;
            }
            if (RxOptimizer._freeTimer !== null) {
                clearTimeout(RxOptimizer._freeTimer);
                RxOptimizer._freeTimer = null;
            }
        });

        try {
            RxCollector.writeLog("Optimizer: RAM optimization initialized");
        } catch (_) {}
        try {
            RxOptimizer.suggestLowEndMode();
        } catch (_) {}
    }

    // Режим слабого ПК: лаунчер без анимаций и эффектов; прежние значения возвращаются при выключении.
    // Игру облегчает запуск: JVM-профиль (RxLaunchConfigurator) и options.txt (lowEndOptions.js)
    static isLowEnd() {
        return typeof RxConfig !== "undefined" && RxConfig.read("lowEndMode", false) === true;
    }

    static setLowEndMode(enabled) {
        const keys = ["disableAnimations", "disableCssEffects"];
        if (enabled) {
            RxConfig.write("lowEndPrevious", Object.fromEntries(keys.map(key => [key, RxConfig.read(key, false) === true])));
            keys.forEach(key => RxOptimizer.setLauncherSetting(key, true));
        } else {
            const previous = RxConfig.read("lowEndPrevious", null) || {};
            keys.forEach(key => RxOptimizer.setLauncherSetting(key, previous[key] === true));
        }
        RxCollector.writeLog(`Optimizer: Low-end mode ${enabled ? "enabled" : "disabled"}`);
        RxToasts.create(enabled ? MESSAGES.settings.startup.lowEndMode.enabled : MESSAGES.settings.startup.lowEndMode.disabled, "speed");
    }

    static setLauncherSetting(key, value) {
        RxConfig.write(key, value);
        document.documentElement.classList.toggle(key === "disableAnimations" ? "noAnimations" : "noEffects", value);
        $(`#modal-settings [data-setting="${key}"] input`).prop("checked", value);
    }

    // Один раз подсказать режим слабого ПК, если памяти мало или ядер немного
    static suggestLowEndMode() {
        if (RxOptimizer.isLowEnd() || RxConfig.read("lowEndSuggested", false) === true) return;
        const weak = os.totalmem() <= 6 * 1024 ** 3 || os.cpus().length <= 2;
        if (!weak) return;
        RxConfig.write("lowEndSuggested", true);
        setTimeout(() => RxToasts.create(MESSAGES.settings.startup.lowEndMode.suggest, "speed"), 8000);
    }
}
