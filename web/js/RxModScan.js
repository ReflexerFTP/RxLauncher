// Проверка модов на стилеры: Discord-вебхуки и боты, Telegram-боты, кража токенов, паролей и сессии, автозапуск.
// Сам поиск идёт в главном процессе (modScanner.js, worker), результаты кешируются по SHA-1 — повторный запуск мгновенный.
// Перед игрой опасные моды предлагается отключить (foo.jar → foo.jar.disabled), в окне модов — полный отчёт
class RxModScan {
    static TRUST_KEY = "modScanTrusted";
    static MAX_ITEMS = 6;

    static isEnabled = () => RxConfig.read("scanModsForStealers", true) === true;
    static t = (key) => MESSAGES.modScan?.[key] ?? key;
    static trusted = () => new Set(RxConfig.read(RxModScan.TRUST_KEY, []).filter(item => typeof item === "string"));

    static scan = (dir, onlyEnabled = false) => ipcRenderer.invoke("mod-scan", {dir, onlyEnabled});

    // «Похоже на стилер: ищет токены Discord и пароли браузеров, может отправить через Telegram-бота»
    static reasonText = (finding) => {
        const reasons = MESSAGES.modScan.reasons;
        const labels = MESSAGES.modScan.labels;
        const list = ids => [...new Set(ids.map(id => labels[id] || id))].join(", ");
        if (finding.id === "stealer") return reasons.stealer.replace("{0}", list(finding.theft)).replace("{1}", list(finding.exfil));
        if (finding.id === "hiddenStealer") return reasons.hiddenStealer.replace("{0}", list(finding.theft));
        return reasons[finding.id] || finding.id;
    };

    static summary = (file, max = 2) => {
        const shown = file.findings.filter(item => item.severity === file.verdict).slice(0, max).map(RxModScan.reasonText);
        const rest = file.findings.filter(item => item.severity !== "info").length - shown.length;
        return shown.join(" · ") + (rest > 0 ? ` · ${RxModScan.t("more").replace("{0}", rest)}` : "");
    };

    // foo.jar → foo.jar.disabled (как кнопка «выключить» в окне модов)
    static disable = (files) => {
        let disabled = 0;
        for (const file of files) {
            if (!/\.jar$/i.test(file.path)) continue;
            try {
                // Отключённая копия с таким именем уже есть — не трогаем её, берём новое имя
                const target = fs.existsSync(`${file.path}.disabled`) ? `${file.path.slice(0, -4)}-${Date.now()}.jar.disabled` : `${file.path}.disabled`;
                fs.renameSync(file.path, target);
                disabled++;
                RxCollector.writeLog(`ModScan: Disabled ${file.name} [verdict=${file.verdict}] [sha1=${file.sha1}]`);
            } catch (error) {
                RxCollector.writeLog(`ModScan: Could not disable ${file.name} [error=${error?.message || error}]`);
            }
        }
        return disabled;
    };

    static trust = (files) => {
        const trusted = RxModScan.trusted();
        files.forEach(file => file.sha1 && trusted.add(file.sha1));
        RxConfig.write(RxModScan.TRUST_KEY, [...trusted].slice(-500));
        files.forEach(file => RxCollector.writeLog(`ModScan: Trusted by user ${file.name} [sha1=${file.sha1}]`));
    };

    static logReport = (report) => {
        const flagged = report.files.filter(file => file.verdict === "danger" || file.verdict === "warning");
        RxCollector.writeLog(`ModScan: ${report.files.length} mod(s) [scanned=${report.scanned}] [cached=${report.cached}] [flagged=${flagged.length}]${report.timedOut ? " [timeout]" : ""}`);
        flagged.forEach(file => RxCollector.writeLog(`ModScan: ${file.verdict} ${file.name} [${file.findings.map(item => item.id).join(",")}]`));
    };

    // Перед запуском: true — можно играть (опасные моды отключены или им доверяют)
    static beforeLaunch = async (modsDir) => {
        if (!RxModScan.isEnabled()) return true;
        let report;
        try {
            RxFlyout.setText(RxModScan.t("checking"), "");
            report = await RxModScan.scan(modsDir, true);
        } catch (error) {
            RxCollector.writeLog(`ModScan: Skipped [error=${error?.message || error}]`);
            return true;
        }
        RxModScan.logReport(report);
        const trusted = RxModScan.trusted();
        const dangerous = report.files.filter(file => file.verdict === "danger" && !trusted.has(file.sha1));
        if (!dangerous.length) return true;
        const shown = dangerous.slice(0, RxModScan.MAX_ITEMS);
        const answer = await RxDialog.confirm({
            icon: "gpp_bad",
            title: RxModScan.t("title"),
            text: RxModScan.t("text").replace("{0}", dangerous.length),
            items: shown.map(file => ({icon: "error", level: "error", title: file.name, text: RxModScan.summary(file)}))
                .concat(dangerous.length > shown.length ? [{icon: "more_horiz", title: RxModScan.t("more").replace("{0}", dangerous.length - shown.length)}] : []),
            cancelText: MESSAGES.dialog.cancel,
            extraButton: {text: RxModScan.t("trustAndPlay"), icon: "warning"},
            confirmText: RxModScan.t("disableAndPlay")
        });
        if (answer === "extra") {
            RxModScan.trust(dangerous);
            return true;
        }
        if (answer !== true) return false;
        const disabled = RxModScan.disable(dangerous);
        RxToasts.create(RxModScan.t("disabled"), "gpp_good", String(disabled));
        return true;
    };

    // Кнопка в окне модов: полный отчёт по всем модам версии, включая отключённые
    static showReport = async () => {
        const context = RxModsManager.getContext();
        if (!context) return false;
        const $button = $('#modal-mods [data-mods-action="stealer-scan"]').prop("disabled", true);
        let report;
        try {
            report = await RxModScan.scan(context.modsPath);
        } catch (error) {
            RxCollector.writeLog(`ModScan: Manual scan failed [error=${error?.message || error}]`);
            RxToasts.create(RxModScan.t("failed"), "error");
            return false;
        } finally {
            $button.prop("disabled", false);
        }
        RxModScan.logReport(report);
        if (!report.files.length) {
            RxToasts.create(RxModScan.t("noMods"), "extension");
            return true;
        }
        const trusted = RxModScan.trusted();
        const order = {danger: 0, warning: 1, unknown: 2};
        const flagged = report.files.filter(file => file.verdict === "danger" || file.verdict === "warning")
            .sort((a, b) => order[a.verdict] - order[b.verdict]);
        if (!flagged.length) {
            await RxDialog.open({icon: "verified_user", title: RxModScan.t("cleanTitle"), text: RxModScan.t("cleanText").replace("{0}", report.files.length),
                buttons: [{id: "ok", text: MESSAGES.dialog.ok, primary: true}]});
            return true;
        }
        const dangerousEnabled = flagged.filter(file => file.verdict === "danger" && file.enabled);
        const shown = flagged.slice(0, 10);
        const items = shown.map(file => ({
            icon: file.verdict === "danger" ? "error" : "warning",
            level: file.verdict === "danger" ? "error" : "warn",
            title: [file.name, !file.enabled ? RxModScan.t("off") : "", trusted.has(file.sha1) ? RxModScan.t("trusted") : ""].filter(Boolean).join(" · "),
            text: RxModScan.summary(file, 3)
        })).concat(flagged.length > shown.length ? [{icon: "more_horiz", title: RxModScan.t("more").replace("{0}", flagged.length - shown.length)}] : []);
        const buttons = [{id: "close", text: MESSAGES.dialog.ok}];
        if (dangerousEnabled.length) buttons.push({id: "disable", text: RxModScan.t("disableDangerous"), icon: "block", primary: true, danger: true});
        const result = await RxDialog.open({
            icon: dangerousEnabled.length ? "gpp_bad" : "gpp_maybe",
            title: RxModScan.t("reportTitle"),
            text: RxModScan.t("reportText").replace("{0}", report.files.length).replace("{1}", flagged.filter(file => file.verdict === "danger").length)
                .replace("{2}", flagged.filter(file => file.verdict === "warning").length),
            items, buttons
        });
        if (result.button === "disable") {
            const disabled = RxModScan.disable(dangerousEnabled);
            RxToasts.create(RxModScan.t("disabled"), "gpp_good", String(disabled));
            RxModsManager.refresh();
        }
        return true;
    };

    // Фоном после старта: прогреть кеш для активной версии, чтобы проверка перед игрой была мгновенной
    static warmUp = () => {
        if (!RxModScan.isEnabled()) return;
        setTimeout(() => {
            const context = RxModsManager.getContext();
            if (!context || !fs.existsSync(context.modsPath)) return;
            RxModScan.scan(context.modsPath, true).then(RxModScan.logReport).catch(() => {});
        }, 15000);
    };
}

$(RxModScan.warmUp);
