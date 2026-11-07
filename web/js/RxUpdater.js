// Обновления лаунчера: ядро проверяет подписанный манифест при каждом запуске и раз в 6 часов.
// Игрок видит окно «Вышла версия …» после каждого перезапуска, пока не обновится; скачивание — в фоне с докачкой
// (сразу, если включено «Скачивать обновления автоматически»), потом «Перезапустить и обновить»
class RxUpdater {
    static status = {state: "none"};
    static announced = false; // окно о новой версии — один раз за запуск
    static readyShown = false;

    static t = (key) => MESSAGES.updater?.[key] ?? key;
    static autoDownload = () => RxConfig.read("autoDownloadUpdates", true) === true;
    static mb = (bytes) => (Number(bytes || 0) / 1024 / 1024).toFixed(1);

    static bindUpdate = () => {
        ipcRenderer.on("update-available", (_event, status) => RxUpdater.apply(status));
        ipcRenderer.on("update-progress", (_event, status) => RxUpdater.apply(status));
        ipcRenderer.on("update-downloaded", (_event, status) => RxUpdater.apply(status));
        ipcRenderer.on("update-error", (_event, data) => {
            RxCollector.writeLog(`Updater: Download failed [error=${data?.message}]`);
            RxUpdater.apply(data?.status, true);
        });
        ipcRenderer.on("update-install-deferred", () => {
            RxCollector.writeLog("Updater: Installation deferred until Minecraft closes");
            RxToasts.create(RxUpdater.t("deferred"), "schedule");
        });
        $("#updateNotify").on("click", "[data-update-action]", function () {
            const action = this.dataset.updateAction;
            if (action === "download") RxUpdater.download();
            if (action === "install") RxUpdater.installUpdate();
            if (action === "details") RxUpdater.showDetails();
        });
        // Проверка могла пройти раньше, чем интерфейс подписался
        ipcRenderer.invoke("update-status").then(status => RxUpdater.apply(status)).catch(() => {});
    };

    static apply = (status, failed = false) => {
        if (!status || !status.state || status.state === "none") return;
        const previous = RxUpdater.status.state;
        RxUpdater.status = status;
        RxUpdater.render(failed);
        if (!RxUpdater.announced) {
            RxUpdater.announced = true;
            RxCollector.writeLog(`Updater: Version ${status.version} available [state=${status.state}]`);
            if (status.state !== "ready") RxUpdater.showDetails();
        }
        if (status.state === "ready" && (previous !== "ready" || !RxUpdater.readyShown)) RxUpdater.showReady();
    };

    // Плашка на главной: версия, полоса скачивания, кнопки
    static render = (failed = false) => {
        const status = RxUpdater.status;
        const $notify = $("#updateNotify");
        if (!$notify.length) return;
        const percent = status.size ? Math.min(100, Math.round(status.received / status.size * 100)) : 0;
        const texts = {
            available: failed ? RxUpdater.t("failed") : RxUpdater.t("availableText").replace("{0}", RxUpdater.mb(status.size)),
            downloading: RxUpdater.t("progress").replace("{0}", RxUpdater.mb(status.received)).replace("{1}", RxUpdater.mb(status.size)).replace("{2}", percent),
            ready: RxUpdater.t("ready")
        };
        $notify.attr("data-state", status.state).show();
        $notify.find("[data-update-title]").text(RxUpdater.t("availableVersion").replace("{0}", status.version));
        $notify.find("[data-update-text]").text(texts[status.state] || "");
        $notify.find("[data-update-bar]").prop("hidden", status.state !== "downloading").find("i").css("width", `${percent}%`);
        $notify.find('[data-update-action="download"]').prop("hidden", status.state !== "available");
        $notify.find('[data-update-action="install"]').prop("hidden", status.state !== "ready");
    };

    // Окно «Вышла версия …»: что нового и кнопка скачать (или уже качается)
    // Окно открывается, только когда не открыт другой диалог (иначе закрыло бы его)
    static whenFree = async () => {
        while (RxDialog.current) await new Promise(resolve => setTimeout(resolve, 1000));
    };

    static showDetails = async () => {
        await RxUpdater.whenFree();
        const status = RxUpdater.status;
        const downloading = status.state === "downloading";
        const items = [{icon: "new_releases", title: status.title || RxUpdater.t("newVersion"), text: `${RxUpdater.t("size")}: ${RxUpdater.mb(status.size)} МБ`}];
        if (downloading) items.push({icon: "downloading", title: RxUpdater.t("inBackground"), text: RxUpdater.t("inBackgroundText")});
        const result = await RxDialog.open({
            icon: "system_update",
            title: RxUpdater.t("dialogTitle").replace("{0}", status.version),
            text: status.summary || RxUpdater.t("dialogText"),
            items,
            checks: [{id: "auto", icon: "download_for_offline", title: RxUpdater.t("autoDownload"), text: RxUpdater.t("autoDownloadText"),
                checked: RxUpdater.autoDownload(), separated: true, optional: true}],
            buttons: status.state === "ready"
                ? [{id: "later", text: RxUpdater.t("later")}, {id: "install", text: RxUpdater.t("restartInstall"), icon: "restart_alt", primary: true}]
                : downloading
                    ? [{id: "ok", text: RxUpdater.t("ok"), primary: true}]
                    : [{id: "later", text: RxUpdater.t("later")}, {id: "download", text: RxUpdater.t("download"), icon: "download", primary: true}]
        });
        if (result?.checks && typeof result.checks.auto === "boolean" && result.checks.auto !== RxUpdater.autoDownload()) {
            RxConfig.write("autoDownloadUpdates", result.checks.auto);
            $('[data-setting="autoDownloadUpdates"] input').prop("checked", result.checks.auto);
        }
        if (result?.button === "download") RxUpdater.download();
        if (result?.button === "install") RxUpdater.installUpdate();
    };

    static showReady = async () => {
        RxUpdater.readyShown = true;
        await RxUpdater.whenFree();
        RxCollector.writeLog(`Updater: Version ${RxUpdater.status.version} downloaded, ready to install`);
        const result = await RxDialog.open({
            icon: "deployed_code_update",
            title: RxUpdater.t("readyTitle").replace("{0}", RxUpdater.status.version),
            text: RxUpdater.t("readyText"),
            buttons: [{id: "later", text: RxUpdater.t("later")}, {id: "install", text: RxUpdater.t("restartInstall"), icon: "restart_alt", primary: true}]
        });
        if (result?.button === "install") RxUpdater.installUpdate();
    };

    static download = () => {
        RxUpdater.status = {...RxUpdater.status, state: "downloading"};
        RxUpdater.render();
        ipcRenderer.invoke("update-download").then(status => RxUpdater.apply(status)).catch(() => {});
    };

    // Установить обновление (во время игры — после её закрытия)
    static installUpdate = () => {
        ipcRenderer.send("install-update");
    };
}
