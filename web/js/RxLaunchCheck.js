// Проверка модов перед запуском: недостающие зависимости, мод под другой загрузчик или версию игры, дубликаты.
// Если что-то точно сломано — предупреждаем до запуска, а не после вылета
class RxLaunchCheck {
    static TIMEOUT = 5000;
    static LOADERS = ["fabric", "quilt", "forge", "forgeOptiFine", "neoforge", "pack"];

    static isEnabled = () => RxConfig.read("checkModsBeforeLaunch", true) === true;

    static problems = async () => {
        const context = RxModsManager.getContext();
        if (!context || !RxLaunchCheck.LOADERS.includes(context.loader) || !fs.existsSync(context.modsPath)) return [];
        // Сборка на ванильной версии — модов в ней не будет
        if (RxModMeta.getTarget()?.loader === "vanilla") return [];
        const {entries} = await RxCrashAnalyzer.loadMods(context.modsPath);
        return entries
            .filter(entry => entry.enabled && entry.compat?.verdict === "error")
            .map(entry => ({
                fileName: entry.fileName,
                name: entry.meta?.name || entry.fileName,
                errors: entry.compat.checks.filter(check => check.level === "error").map(check => check.text)
            }));
    };

    // true — можно запускать
    static run = async () => {
        if (!RxLaunchCheck.isEnabled()) return true;
        let problems = [];
        try {
            problems = await RxUtils.promiseWithTimeout(RxLaunchCheck.problems(), RxLaunchCheck.TIMEOUT);
        } catch (error) {
            RxCollector.writeLog(`LaunchCheck: Skipped [error=${error}]`);
            return true;
        }
        if (!Array.isArray(problems) || problems.length === 0) return true;
        RxCollector.writeLog(`LaunchCheck: ${problems.length} problem mod(s) [${problems.map(item => item.fileName).join(", ")}]`);
        const shown = problems.slice(0, 6);
        const answer = await RxDialog.confirm({
            icon: "report",
            title: MESSAGES.launchCheck.title,
            text: MESSAGES.launchCheck.text.replace("{0}", problems.length),
            items: shown.map(item => ({icon: "error", level: "error", title: item.name, text: item.errors.join(" · ")}))
                .concat(problems.length > shown.length ? [{icon: "more_horiz", title: MESSAGES.launchCheck.more.replace("{0}", problems.length - shown.length)}] : []),
            cancelText: MESSAGES.dialog.cancel,
            extraButton: {text: MESSAGES.launchCheck.openMods, icon: "extension"},
            confirmText: MESSAGES.launchCheck.playAnyway
        });
        if (answer === "extra") {
            await RxModals.switchModal("mods");
            return false;
        }
        return answer === true;
    };
}
