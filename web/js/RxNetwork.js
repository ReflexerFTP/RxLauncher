// Офлайн-режим: есть ли интернет. Без сети лаунчер не ждёт ответов серверов, а сразу запускает то, что уже скачано
// (версии, сборки, Java), и пропускает необязательное (проверки Modrinth, обновления модов)
class RxNetwork {
    static offline = false;
    static checkedAt = 0;
    static checking = null;
    static PROBES = ["https://rxlauncher.xyz/api/health", "https://api.modrinth.com/"];

    static t = (key) => MESSAGES.network?.[key] ?? key;

    // Быстрая проверка: без сети Windows сообщает сразу, иначе — короткий запрос (ответ кешируется на минуту)
    static check = async (force = false) => {
        if (navigator.onLine === false) return RxNetwork.set(true);
        if (!force && Date.now() - RxNetwork.checkedAt < 60e3) return !RxNetwork.offline;
        if (RxNetwork.checking) return RxNetwork.checking;
        RxNetwork.checking = (async () => {
            // Оба адреса сразу; на очень медленном интернете рукопожатие долгое, поэтому ждём до 6 секунд
            const probe = url => Promise.race([
                RxHttp.request(url, {timeout: 6000, maxBytes: 64 * 1024}).catch(error => { if (error?.status) return true; throw error; }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000))
            ]);
            try {
                await Promise.any(RxNetwork.PROBES.map(probe));
                return RxNetwork.set(false);
            } catch (_) {
                return RxNetwork.set(true);
            }
        })().finally(() => { RxNetwork.checking = null; });
        return RxNetwork.checking;
    };

    static set = (offline) => {
        const changed = offline !== RxNetwork.offline;
        RxNetwork.offline = offline;
        RxNetwork.checkedAt = Date.now();
        if (changed) {
            RxCollector.writeLog(`Network: ${offline ? "offline mode" : "back online"}`);
            if (offline) RxToasts.create(RxNetwork.t("offlineTitle"), "wifi_off", RxNetwork.t("offlineText"), 7000);
            else RxToasts.create(RxNetwork.t("onlineTitle"), "wifi", "", "success");
        }
        $("html").toggleClass("rx-offline", offline);
        return !offline;
    };

    static init = () => {
        window.addEventListener("offline", () => RxNetwork.set(true));
        window.addEventListener("online", () => RxNetwork.check(true));
        setTimeout(() => RxNetwork.check(true), 3000);
    };
}

$(RxNetwork.init);
