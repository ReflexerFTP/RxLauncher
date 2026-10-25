class RxUpdater {
    // Забиндить эвенты обновлений
    static bindUpdate = () => {
        ipcRenderer.once("update-available", () => {
            RxUpdater.onUpdateAvailable();
        });
        ipcRenderer.once("update-downloaded", () => {
            RxUpdater.onUpdateDownloaded();
        });
        ipcRenderer.on("update-install-deferred", () => {
            RxCollector.writeLog("Updater: Installation deferred until Minecraft closes");
            RxToasts.create(MESSAGES.updater.deferred, "schedule");
        });
    }

    // При нахождении обновления - показать уведомление
    static onUpdateAvailable = () => {
        let $notifyElem = $("#updateNotify");
        let $notifyElemBtn = $notifyElem.find("button:not(.transparent)");
        let $notifyElemText = $notifyElem.find(".description");
        RxCollector.writeLog(`Updater: New version found`);
        $notifyElem.show();
        $notifyElem.addClass("animate__animated animate__fadeIn");
        $notifyElemBtn.hide();
        $notifyElemText.text();
        setTimeout(() => {
            $notifyElem.removeClass("animate__animated animate__fadeIn");
        }, 1000);
    }

    // После скачивания обновления - изменить уведомление
    static onUpdateDownloaded = () => {
        let $notifyElem = $("#updateNotify");
        let $notifyElemBtn = $notifyElem.find("button:not(.transparent)");
        let $notifyElemText = $notifyElem.find(".description");
        RxCollector.writeLog(`Updater: New version downloaded, ready to restart`);
        $notifyElemBtn.show();
        $notifyElemText.text(MESSAGES.updater.ready);
    }

    // Установить обновление
    static installUpdate = () => {
        ipcRenderer.send("install-update");
    }
}
