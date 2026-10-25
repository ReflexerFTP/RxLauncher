const TOOLTIP_PLACEHOLDER = `<div class="flymenu-tooltip chip animate__animated animate__fadeIn animate__faster">$1</div>`;
let tooltipShowed = false;

class RxFlyout {
    // Сменить режим панели
    static changeMode = (mode) => {
        return new Promise((resolve) => {
            if (RxFlyout.getCurrentMode() === mode) {
                return resolve(false);
            }
            if (RxModals.isModalShown("accounts")) {
                RxModals.hideModal("accounts");
            }
            if (RxModals.isModalShown("versions")) {
                RxModals.hideModal("versions");
            }
            RxCollector.writeLog(`Flyout: New mode - "${mode}"`);
            let allowedModes = ["idle", "progress", "spinner"];
            if (!allowedModes.includes(mode)) {
                return resolve(false);
            }

            let visibleFlyoutElems = $(".flyout .flyout-mode:not(.hidden)");
            visibleFlyoutElems.each(function (i, elem) {
                animateCSSNode($(elem)[0], "fadeOut").then(() => {
                    $(`#${$(elem).attr("id")}`).addClass("hidden");
                    let newModeElem = $(`.flyout > div[data-mode="${mode}"]`);
                    newModeElem.removeClass("hidden");
                    animateCSSNode(newModeElem[0], "fadeIn").then(resolve);
                })
            })
        })
    }

    // Получить режим UI в настоящее время
    static getCurrentMode = () => {
        return $(".flyout .flyout-mode:not(.hidden)").data("mode");
    }

    // Перевести UI в режим запуска игры (скрыть/заблокировать ненужные элементы)
    static setUIStartMode = (startMode) => {
        RxModals.switchToContent();
        // Скрываем все кнопки Play в списке версий на главном экране
        startMode ? $(".versionsPosters").addClass("start-mode") : $(".versionsPosters").removeClass("start-mode");
        RxCollector.writeLog(`Flyout: UI in start mode: ${startMode}`);
        startMode ? $(".flyout").addClass("start-mode") : $(".flyout").removeClass("start-mode");
    }

    // Задать текст (задаётся во всех режимах сразу)
    static setText = (text = "", description = "") => {
        if (text !== "") {
            $(".flyout .flyout-mode:not(#versionSelect) .title").text(text);
        }
        if (description !== "") {
            $(".flyout .flyout-mode:not(#versionSelect) .description").show().text(description);
        } else {
            $(".flyout .flyout-mode:not(#versionSelect) .description").hide();
        }
    };

    // Задать значение прогресс бара (-1 - бесконечный)
    static setProgress = (progress) => {
        let progressElem = $(".flyout .progress-pill .inner");
        if (progress < -1 || progress > 100) {
            return false;
        }

        if (progress === -1) {
            progressElem.addClass("indeterminate");
            return true;
        }

        progressElem.removeClass("indeterminate");
        progressElem.css("width", `${progress}%`);
        return true;
    }

    // Показать tooltip
    static showTooltip = (menuElement, text) => {
        if (tooltipShowed === true) {
            return false;
        }

        tooltipShowed = true;
        let elementPos = $(menuElement)[0].getBoundingClientRect();
        $("html").append(TOOLTIP_PLACEHOLDER.replaceAll("$1", text))
        let tooltipElement = $(".flymenu-tooltip");
        let tooltipPos = $(tooltipElement)[0].getBoundingClientRect();

        let left = elementPos.left + elementPos.width + 18;
        let top = elementPos.top + (elementPos.height / 2 - tooltipPos.height / 2);

        $(tooltipElement).css("top", top);
        $(tooltipElement).css("left", left);
        return true;
    }

    // Скрыть tooltip
    static hideTooltip = () => {
        tooltipShowed = false;
        return $(".flymenu-tooltip").remove();
    }

    // Заблокировать для взаимодействия FlyMenu
    static lockFlymenu = () => {
        $(".flymenu").css("pointer-events", "none");
    }

    // Разблокировать для взаимодействия FlyMenu
    static unlockFlymenu = () => {
        $(".flymenu").css("pointer-events", "initial");
    }

    // Запустить выбранную версию
    static startSelectedVersion = async () => {
        if (RxAccountsManager.getActiveAccount() === "none") {
            RxToasts.create(MESSAGES.flyout.selectAccount, "manage_accounts");
            RxAccountsUI.open();
            return false;
        }

        if (RxConfig.read("rxClientLobbyMode", false) === true) {
            const rxVersionResolved = await RxLaunchConfigurator.enforceRxClientCompatibleActiveVersion(true);
            if (rxVersionResolved !== true) {
                return false;
            }
        }

        let activeVersion = RxVersionsManager.getActiveVersion();
        if (activeVersion === "none") {
            RxToasts.create(MESSAGES.flyout.selectVersion, "deployed_code");
            RxVersionsUI.open();
            return false;
        }

        if (!(await RxLaunchCheck.run())) {
            return false;
        }

        return RxStarter.simpleStart(activeVersion);
    }
}
