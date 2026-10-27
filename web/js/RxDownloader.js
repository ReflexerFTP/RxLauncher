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

    // Загрузка, которую можно прервать кнопкой «Отмена»
    static abortable = async (task) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        RxDownloader.activeDownloads.add(abort);
        try {
            return await task(controller.signal);
        } finally {
            RxDownloader.activeDownloads.delete(abort);
        }
    }

    // Скачать файл
    static downloadFile = async (url, filePath, displayName = null, updateProgress = true, hashes = {}) => {
        RxCollector.writeLog(`New download [url=${url}] [displayName=${displayName}]`);
        if (displayName === null) {
            displayName = path.basename(filePath);
        }
        await RxDownloader.prepareUIToDownload(displayName);
        await RxDownloader.abortable(signal => RxHttp.download(url, filePath, {
            hashes,
            signal,
            onProgress: (received, total) => {
                if (updateProgress && total > 0) {
                    RxDownloader.updateDownloadUI(displayName, Math.round((received * 100) / total), received, total);
                }
            }
        }));
        RxCollector.writeLog(`Download completed [displayname=${displayName}]`);
        RxFlyout.setProgress(0);
        return true;
    }

    // Скачать файл в фоновом режиме
    static quietDownloadFile = async (url, filePath) => {
        RxCollector.writeLog(`New quiet download [url=${url}]`);
        await RxHttp.download(url, filePath);
        RxCollector.writeLog(`Quiet download completed`);
        return true;
    }

    static RETRIES = 3;

    // Скачать много файлов параллельно (файлы сборки): повтор при обрыве, проверка хеша, общий прогресс.
    // items: [{url, fallbackUrl, path, hashes, size, displayName}]; вторая попытка идёт через fallbackUrl (зеркало), если он есть.
    // Ошибка любого файла после всех попыток — ошибка всей загрузки
    static downloadMany = async (items, title, concurrency = 6) => {
        if (!Array.isArray(items)) throw new TypeError("Download items must be an array");
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid download concurrency");
        concurrency = Math.min(concurrency, 16);
        if (!items.length) return true;
        const totalBytes = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        const received = new Map();
        let receivedBytes = 0;
        let lastPaint = -Infinity;
        const recordBytes = (item, bytes) => {
            receivedBytes += bytes - (received.get(item) || 0);
            received.set(item, bytes);
        };
        let finished = 0;
        let failure = null;
        await RxDownloader.prepareUIToDownload(title);

        const updateUI = (force = false) => {
            const now = Date.now();
            if (!force && now - lastPaint < 100) return;
            lastPaint = now;
            const bytes = receivedBytes;
            if (totalBytes > 0) {
                const percent = Math.min(100, Math.round(bytes * 100 / totalBytes));
                const {speed, eta} = RxDownloader.measure(`many:${title}`, bytes, totalBytes);
                const parts = [`${finished} / ${items.length}`, `${RxUtils.humanFileSize(bytes)} / ${RxUtils.humanFileSize(totalBytes)}`];
                if (speed > 0) parts.push(`${RxUtils.humanFileSize(speed)}/${MESSAGES.starter.sec}`);
                if (RxDownloader.formatEta(eta)) parts.push(RxDownloader.formatEta(eta));
                RxFlyout.setProgress(percent);
                RxFlyout.setText(`${MESSAGES.commons.downloading} ${title}`, `${parts.join(" · ")} (${percent}%)`);
            } else {
                RxDownloader.updateDownloadUIText(title, Math.round(finished * 100 / items.length), finished, items.length);
            }
        };

        const fetchOne = async (item, signal) => {
            for (let attempt = 1; ; attempt++) {
                try {
                    if (signal.aborted) throw new Error("Download aborted");
                    recordBytes(item, 0);
                    const url = item.fallbackUrl && attempt % 2 === 0 ? item.fallbackUrl : item.url;
                    await RxHttp.download(url, item.path, {
                        hashes: item.hashes, signal, urlPolicy: item.urlPolicy, onProgress: (bytes) => {
                            recordBytes(item, bytes);
                            updateUI();
                        }
                    });
                    return;
                } catch (error) {
                    // Отмену и ответ 4xx (файла нет) повторять бесполезно — разве что через ещё не опробованное зеркало
                    const missing = error.status >= 400 && error.status < 500;
                    if (signal.aborted || attempt >= RxDownloader.RETRIES || (missing && (!item.fallbackUrl || attempt >= 2))) throw error;
                    RxCollector.writeLog(`Download retry ${attempt} [file=${item.displayName || path.basename(item.path)}] [error=${error.message}]`);
                    await new Promise((resolve, reject) => {
                        const onAbort = () => {
                            clearTimeout(timer);
                            signal.removeEventListener("abort", onAbort);
                            reject(new Error("Download aborted"));
                        };
                        const timer = setTimeout(() => {
                            signal.removeEventListener("abort", onAbort);
                            resolve();
                        }, 700 * attempt);
                        signal.addEventListener("abort", onAbort, {once: true});
                        if (signal.aborted) onAbort();
                    });
                }
            }
        };

        try { await RxDownloader.abortable(async (signal) => {
            let nextIndex = 0;
            const worker = async () => {
                while (nextIndex < items.length && !failure && !signal.aborted) {
                    const item = items[nextIndex++];
                    try {
                        await fetchOne(item, signal);
                        recordBytes(item, Number(item.size) || received.get(item) || 0);
                        finished++;
                        updateUI(finished === items.length);
                    } catch (error) {
                        failure = failure || Object.assign(error, {file: item.displayName || path.basename(item.path)});
                    }
                }
            };
            await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
            if (signal.aborted) throw new Error("Download aborted");
        }); } finally {
            received.clear();
            RxFlyout.setProgress(0);
        }
        if (failure) throw failure;
        return true;
    }
}
