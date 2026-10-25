// Подбор памяти для игры: по объёму ОЗУ компьютера и количеству модов выбранной версии
class RxMemoryAdvisor {
    static MIN_MB = 1024;
    static MAX_MB = 12288;

    static isEnabled = () => RxConfig.read("autoMemory", RxConfig.read("xmxMemory", null) === null) === true;

    static totalMb = () => Math.floor(os.totalmem() / 1024 / 1024);

    // Включённые моды (.jar, без .disabled)
    static countMods = (modsPath) => {
        try {
            return fs.readdirSync(modsPath).filter(name => /\.jar$/i.test(name)).length;
        } catch (_) {
            return 0;
        }
    };

    static recommend = ({totalMb, modsCount = 0, modded = false}) => {
        let target = modded ? 3072 + Math.max(0, modsCount - 20) * 64 : 2048;
        if (modsCount > 150) target += 1024;
        // Системе и лаунчеру оставляем запас: на 8 ГБ — 2.5 ГБ, на больших — 4 ГБ
        const reserve = totalMb <= 8192 ? 2560 : 4096;
        const cap = Math.max(RxMemoryAdvisor.MIN_MB, Math.min(totalMb - reserve, Math.floor(totalMb * 0.6)));
        target = Math.min(target, cap, RxMemoryAdvisor.MAX_MB);
        return Math.max(RxMemoryAdvisor.MIN_MB, Math.floor(target / 512) * 512);
    };

    // Рекомендация для активной версии
    static forActiveVersion = () => {
        const totalMb = RxMemoryAdvisor.totalMb();
        const context = typeof RxModsManager !== "undefined" ? RxModsManager.getContext() : false;
        const modded = Boolean(context && context.loader !== "vanilla");
        const modsCount = context ? RxMemoryAdvisor.countMods(context.modsPath) : 0;
        return {mb: RxMemoryAdvisor.recommend({totalMb, modsCount, modded}), modsCount, totalMb, modded};
    };

    // Сколько памяти дать игре при запуске. У сборки может быть своя настройка
    static launchMemoryMb = () => {
        const instance = typeof RxInstancesUI !== "undefined" ? RxInstancesUI.activeManifest() : null;
        if (instance?.memory?.mode === "manual" && Number(instance.memory.mb) >= 1024) return Number(instance.memory.mb);
        if (instance?.memory?.mode === "auto") return RxMemoryAdvisor.forActiveVersion().mb;
        return RxMemoryAdvisor.isEnabled()
            ? RxMemoryAdvisor.forActiveVersion().mb
            : Number(RxConfig.read("xmxMemory", 2048)) || 2048;
    };
}
