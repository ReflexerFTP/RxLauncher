// Пользовательское соглашение и политика конфиденциальности: спрашиваем один раз при первом запуске
// (и снова, если документы изменятся — тогда увеличивается VERSION). Без согласия лаунчер закрывается
class RxEula {
    static VERSION = 1;
    static KEY = "eulaAccepted";

    static links = () => ({
        eula: `https://github.com/${REPO_NAME}/blob/main/EULA.md`,
        privacy: `https://github.com/${REPO_NAME}/blob/main/PRIVACY_POLICY.md`
    });

    static isAccepted = () => Number(RxConfig.read(RxEula.KEY, 0)) >= RxEula.VERSION;

    static ensure = async () => {
        if (RxEula.isAccepted()) return true;
        const t = MESSAGES.eula || {};
        for (;;) {
            const result = await RxDialog.open({
                icon: "gavel",
                title: t.title || "Пользовательское соглашение",
                text: t.text || "Чтобы пользоваться RxLauncher, примите пользовательское соглашение и политику конфиденциальности. Оба документа открываются кнопками ниже.",
                buttons: [
                    {id: "exit", text: t.exit || "Выйти"},
                    {id: "eula", text: t.eula || "Соглашение", icon: "open_in_new"},
                    {id: "privacy", text: t.privacy || "Конфиденциальность", icon: "open_in_new"},
                    {id: "accept", text: t.accept || "Принимаю", primary: true}
                ]
            });
            if (result.button === "accept") {
                RxConfig.write(RxEula.KEY, RxEula.VERSION);
                RxCollector.writeLog(`Eula: Accepted [version=${RxEula.VERSION}]`);
                return true;
            }
            if (result.button === "exit") {
                RxCollector.writeLog("Eula: Declined, closing");
                ipcRenderer.send("close-main-window");
                return false;
            }
            // Документ открыт в браузере — окно остаётся; Esc и клик мимо его не закрывают
            if (result.button === "eula" || result.button === "privacy") openExternal(RxEula.links()[result.button]);
        }
    };
}
