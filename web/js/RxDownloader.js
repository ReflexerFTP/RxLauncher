let downloadsProcesses = {};

class RxDownloader {
    // Подготовить UI к отображению загрузки файла
    static prepareUIToDownload(displayName) {
        return new Promise(resolve => {
            RxFlyout.setProgress(0);
            RxFlyout.setText(`${MESSAGES.commons.downloading} ${displayName}`, MESSAGES.commons.plsWait);
            RxFlyout.changeMode("progress").then(resolve);
        })
    }

    // Скачивается ли что-то в данный момент
    static isAnythingDownloading = () => {
        return Object.keys(downloadsProcesses).length;
    }

    // Скорость и оставшееся время: сглаженная скорость по замерам не чаще раза в полсекунды
    static rate = {key: "", lastAt: 0, lastValue: 0, speed: 0};

    static measure = (key, current, total) => {
        const rate = RxDownloader.rate;
        const now = Date.now();
        if (rate.key !== key || current < rate.lastValue) {
            RxDownloader.rate = {key, lastAt: now, lastValue: current, speed: 0};
            return {speed: 0, eta: null};
        }
        const seconds = (now - rate.lastAt) / 1000;
        if (seconds >= 0.5) {
            const instant = (current - rate.lastValue) / seconds;
            rate.speed = rate.speed ? rate.speed * 0.7 + instant * 0.3 : instant;
            rate.lastAt = now;
            rate.lastValue = current;
        }
        return {speed: rate.speed, eta: rate.speed > 0 ? (total - current) / rate.speed : null};
    }

    static formatEta = (seconds) => {
        if (seconds === null || !isFinite(seconds) || seconds < 1) return "";
        const value = seconds < 60
            ? `${Math.ceil(seconds)} ${MESSAGES.starter.sec}`
            : `${Math.ceil(seconds / 60)} ${MESSAGES.starter.min}`;
        return MESSAGES.starter.remaining.replace("{0}", value);
    }

    // Обновить UI загрузки
    static updateDownloadUI = (displayName, progress, current, total) => {
        let currentHuman = RxUtils.humanFileSize(current);
        let totalHuman = RxUtils.humanFileSize(total);
        const {speed, eta} = RxDownloader.measure(`bytes:${displayName}`, current, total);
        const parts = [`${currentHuman} / ${totalHuman}`];
        if (speed > 0) parts.push(`${RxUtils.humanFileSize(speed)}/${MESSAGES.starter.sec}`);
        if (RxDownloader.formatEta(eta)) parts.push(RxDownloader.formatEta(eta));

        RxFlyout.setProgress(progress);
        RxFlyout.setText(`${MESSAGES.commons.downloading} ${displayName}`, `${parts.join(" · ")} (${progress}%)`);
        return true;
    }

    // Обновить UI загрузки (использовать текст)
    static updateDownloadUIText = (displayName, progress, current, total) => {
        const {eta} = RxDownloader.measure(`tasks:${displayName}`, current, total);
        const remaining = RxDownloader.formatEta(eta);
        RxFlyout.setProgress(progress);
        RxFlyout.setText(`${MESSAGES.commons.downloading} ${displayName}`, `${current} / ${total}${remaining ? ` · ${remaining}` : ""} (${progress}%)`);
        return true;
    }

    // Прервать загрузки, начатые через downloadFile (кнопка «Отмена» при запуске)
    static activeDownloads = new Set();

    static abortAll = () => {
        RxDownloader.activeDownloads.forEach(abort => abort());
        RxDownloader.activeDownloads.clear();
    }

    // Скачать файл
    static downloadFile = (url, filePath, displayName = null, updateProgress = true) => {
        RxCollector.writeLog(`New download [url=${url}] [displayName=${displayName}]`);
        if (displayName === null) {
            displayName = path.basename(filePath);
        }
        let dirname = path.dirname(filePath);
        if (!fs.existsSync(dirname)) {
            fs.mkdirSync(dirname, {
                recursive: true,
            });
        }

        let received_bytes = 0;
        let total_bytes = 0;
        let percent = "";

        return new Promise((resolve, reject) => {
            RxDownloader.prepareUIToDownload(displayName).then(() => {
                RxCollector.writeLog(`UI prepared for download`);
                let settled = false;
                const fileStream = fs.createWriteStream(filePath);
                const downloadRequest = request.get(url);

                const abort = () => fail(new Error("Download cancelled"));
                RxDownloader.activeDownloads.add(abort);
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    RxDownloader.activeDownloads.delete(abort);
                    downloadRequest.abort();
                    fileStream.destroy();
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                        } catch (_) {
                            fileStream.once("close", () => {
                                if (fs.existsSync(filePath)) {
                                    try { fs.unlinkSync(filePath); } catch (_) {}
                                }
                            });
                        }
                    }
                    reject(error);
                };

                downloadRequest.on("response", function (response) {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        fail(new Error(`Download failed with HTTP ${response.statusCode}`));
                        return;
                    }
                    total_bytes = parseInt(response.headers["content-length"] || "0", 10);
                });
                downloadRequest.on("data", function (chunk) {
                    received_bytes += chunk.length;
                    if (updateProgress && total_bytes > 0) {
                        percent = Math.round((received_bytes * 100) / total_bytes);
                        RxDownloader.updateDownloadUI(displayName, percent, received_bytes, total_bytes);
                    }
                });
                downloadRequest.on("error", fail);
                fileStream.on("error", fail);
                fileStream.on("finish", function () {
                    if (settled) return;
                    settled = true;
                    RxDownloader.activeDownloads.delete(abort);
                    RxCollector.writeLog(`Download completed [displayname=${displayName}]`);
                    RxFlyout.setProgress(0);
                    resolve(true);
                });
                downloadRequest.pipe(fileStream);
            }).catch(reject);
        });
    }

    // Скачать файл в фоновом режиме
    static quietDownloadFile = (url, filePath) => {
        RxCollector.writeLog(`New quiet download [url=${url}]`);
        let dirname = path.dirname(filePath);
        if (!fs.existsSync(dirname)) {
            fs.mkdirSync(dirname, {
                recursive: true,
            });
        }

        let received_bytes = 0;
        let total_bytes = 0;

        return new Promise((resolve, reject) => {
            request
                .get(url)
                .on("error", function (error) {
                    reject(error);
                })
                .on("response", function (data) {
                    total_bytes = parseInt(data.headers["content-length"]);
                    data.pipe(fs.createWriteStream(filePath));
                })
                .on("data", function (chunk) {
                    received_bytes += chunk.length;
                })
                .on("end", function () {
                    RxCollector.writeLog(`Quiet download completed`);
                    resolve(true);
                });
        })
    }
}
