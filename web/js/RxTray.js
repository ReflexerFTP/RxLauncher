// Меню значка в трее на время игры: «Открыть RxLauncher», «Закрыть игру» и запуск ещё одной версии.
// Пункты и подписи сообщает ядру интерфейс (канал tray-menu); выбор приходит обратно событием tray-action
class RxTray {
    static MAX_VERSIONS = 4;

    // Выбранная версия и избранные — то, что игрок запускает чаще всего
    static versions = () => {
        const ids = [RxVersionsManager.getActiveVersion(), ...RxVersionsManager.getFavoriteVersions()]
            .filter((id, index, list) => typeof id === "string" && id !== "none" && id.split("-").length >= 2 && list.indexOf(id) === index);
        return ids.slice(0, RxTray.MAX_VERSIONS).map(id => {
            let title = id;
            try { title = RxVersionsManager.versionToDisplayName(id) || id; } catch (_) {}
            return {id, title: String(title)};
        });
    };

    static sync = () => {
        const t = MESSAGES.tray || {};
        ipcRenderer.send("tray-menu", {
            labels: {open: t.open || "Открыть RxLauncher", stop: t.stop || "Закрыть игру", launch: t.launch || "Запустить"},
            versions: RxTray.versions()
        });
    };

    static onAction = async (payload) => {
        if (payload?.action === "stop") {
            RxStarter.runningList().forEach(starter => starter.stop());
            return true;
        }
        if (payload?.action !== "launch" || !RxTray.versions().some(version => version.id === payload.id)) return false;
        // Запуск идёт как по кнопке «Играть» — с проверками аккаунта и версии; лаунчер показывается, чтобы был виден ход загрузки
        RxUI.appearMainWindow();
        if (RxVersionsManager.getActiveVersion() !== payload.id) {
            RxVersionsManager.setActiveVersion(payload.id);
            RxVersionsUI.loadVersions();
        }
        return RxFlyout.startSelectedVersion();
    };

    static init = () => {
        ipcRenderer.on("tray-action", (_event, payload) => {
            RxTray.onAction(payload).catch(error => RxCollector.writeLog(`Tray: Action failed [error=${error?.message || error}]`));
        });
    };
}
