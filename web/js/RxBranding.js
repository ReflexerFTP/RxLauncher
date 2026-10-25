// Лаунчер использует одну основную иконку; выбор аватарок убран.
class RxBranding {
    static ICON = "assets/icon.png";

    static init = () => {
        $("[data-launcher-avatar]").attr("src", RxBranding.ICON);
        document.documentElement.dataset.launcherAvatar = "classic";
        return true;
    };
}
