// Оптимизация потребления ОЗУ.
// Пока окно скрыто (обычно — во время игры), интерфейса не видно, поэтому можно
// выгрузить тяжёлое: картинки, 3D-просмотр скинов, кеш ресурсов — и один раз собрать мусор.
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
        try {
            if (typeof RxSkinBrowserUI !== "undefined" && RxSkinBrowserUI.viewer) RxSkinBrowserUI.disposeViewer();
        } catch (_) {}
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
        if (typeof RxSkinBrowserUI !== "undefined" && RxSkinBrowserUI.visible && !RxSkinBrowserUI.viewer) {
            try {
                const mounted = RxSkinBrowserUI.mountViewer(RxSkinBrowserUI.currentProfile || RxSkinBrowserUI.createDefaultProfile());
                mounted?.catch?.(() => {});
            } catch (_) {}
        }
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
    }
}
