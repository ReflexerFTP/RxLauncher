// Текущий цвет темы в hex
function currentThemeHex() {
    const rgbMatch = String(currentThemeData?.color || "").match(colorsMatchRegex);
    return rgbMatch ? colors.rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])) : "#e53935";
}

// Отметить активный образец; цвет вне палитры показывается на кружке «свой цвет»
function syncThemeSwatches() {
    const hex = currentThemeHex().toLowerCase();
    const $swatches = $("#modal-settings .theme-swatches .swatch");
    const $preset = $swatches.filter(`[data-color="${hex}"]`);
    const $custom = $("#modal-settings .swatch-custom");
    $swatches.removeClass("active");
    $("#modal-settings .theme-custom-color").val(hex);
    if ($preset.length) {
        $preset.addClass("active");
        $custom.css("background", "");
    } else {
        $custom.addClass("active").css("background", hex);
    }
}

function applyThemeHex(hex) {
    const rgb = colors.hexToRgb(String(hex));
    if (!rgb) return false;
    RxThemes.changeTheme(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
    syncThemeSwatches();
    return true;
}

function loadSettingsUI() {
    $("#modal-settings input[type='checkbox']").each(function () {
        let setting = $(this).parent().data("setting");
        let defaultChecked = (typeof $(this).parent().data("checked") !== "undefined");
        let rdSetting = RxConfig.read(setting, defaultChecked);

        $(this).prop("checked", rdSetting === true);
    })

    updateDiscordRpcSettingsUI();
    RxBranding.init();

    // Загрузка цвета в палитру
    syncThemeSwatches();

    // Загрузка настроек обоев и режима
    $(`#modal-settings .placeholder.${currentThemeData.mode}`).addClass("active");
    let currentWp = RxConfig.read("currentWallpaper", RxThemes.DEFAULT_WALLPAPER);
    $(`#modal-settings .wp-item[data-wp='${currentWp}']`).addClass("active");

    if (currentWp === "custom") {
        let customWpPath = RxConfig.read("customWallpaperPath", "");
        if (customWpPath === "" || !fs.existsSync(customWpPath)) {
            RxThemes.changeWallpaper(RxThemes.DEFAULT_WALLPAPER);
        } else {
            $("#modal-settings .wp-item.placeholder").css("background-image", `url(${customWpPath.replaceAll("\\", "/")})`);
        }
    }

    updateWallpaperAppearanceUI(RxThemes.applyWallpaperAppearance());

    // Директория игры
    $("#gameDirectoryInput").val(GAME_DATA);
}

function updateWallpaperAppearanceUI(appearance) {
    Object.entries(appearance).forEach(([key, value]) => {
        const suffix = key === "blur" ? " px" : "%";
        $(`#modal-settings [data-wallpaper-setting='${key}']`).val(value);
        $(`#modal-settings [data-output='${key}']`).text(`${value}${suffix}`);
    });
}

function updateDiscordRpcSettingsUI() {
    const enabled = RxConfig.read("discordRpcEnabled", true) === true;
    $("#modal-settings .discord-rpc-options").toggleClass("disabled", !enabled);
    $("#modal-settings .discord-rpc-option input[type='checkbox']").prop("disabled", !enabled);
}

async function checkNetworkCompatibility() {
    const $button = $("#modal-settings .network-check");
    const $status = $("#modal-settings .network-check-status");
    const messages = MESSAGES?.startup?.multiplayerFix || {};
    if ($button.prop("disabled")) {
        return false;
    }

    $button.prop("disabled", true);
    $status.removeClass("ok error").text(messages.checking || "Проверяем подключение…");
    try {
        const result = await ipcRenderer.invoke("network-compatibility-check");
        const reachable = Number(result?.reachableCount) || 0;
        const total = Number(result?.total) || 0;
        if (result?.reachable === true) {
            $status.addClass("ok").text(`${messages.online || "Сервисы доступны"} (${reachable}/${total})`);
        } else {
            $status.addClass("error").text(messages.offline || "Нет соединения с сервисами Minecraft");
        }
        return result?.reachable === true;
    } catch (error) {
        RxCollector.writeLog(`Settings: Network preflight failed [error=${error}]`);
        $status.addClass("error").text(messages.offline || "Не удалось проверить соединение");
        return false;
    } finally {
        $button.prop("disabled", false);
    }
}

$(function () {
    // Сохранение настроек при изменении
    $("#modal-settings input[type='checkbox']").on("change", function () {
        let setting = $(this).parent().data("setting");
        let currentValue = $(this).is(":checked");
        RxConfig.write(setting, currentValue);

        if (setting === "disableAnimations") {
            if (currentValue === true) {
                $("html").addClass("noAnimations");
            } else {
                $("html").removeClass("noAnimations");
            }
        }

        if (setting === "disableCssEffects") {
            if (currentValue === true) {
                $("html").addClass("noEffects");
            } else {
                $("html").removeClass("noEffects");
            }
        }

        if (setting === "serverPrivacyMode" && typeof RxServersUI !== "undefined") {
            RxServersUI.refreshServersInfo();
        }

        if (setting.startsWith("discordRpc") || setting === "serverPrivacyMode" || setting === "lessDataCollection") {
            updateDiscordRpcSettingsUI();
            RxDiscordRpc.syncSettings();
        }

        // Режим паранойи меняет источник аватарок — перерисовываем профили
        if (setting === "lessDataCollection") {
            RxAccountsUI.reloadAccountsManager();
            RxAccountsUI.reloadAccountSelect();
        }

    })

    // Смена обоев
    $("#modal-settings .wp-item").click(function () {
        if ($(this).hasClass("active")) {
            return;
        }

        if ($(this).data("wp") === "custom") {
            RxThemes.selectCustomWallpaper().then((result) => {
                if (result !== false) {
                    $("#modal-settings .wp-item.active").removeClass("active");
                    $(this).addClass("active");
                    RxThemes.changeWallpaper($(this).data("wp"));
                }
            });
        } else {
            $("#modal-settings .wp-item.active").removeClass("active");
            $(this).addClass("active");
            RxThemes.changeWallpaper($(this).data("wp"));
        }
    })

    $("#modal-settings [data-wallpaper-setting]").on("input", function () {
        const appearance = RxThemes.getWallpaperAppearance();
        appearance[$(this).data("wallpaper-setting")] = Number($(this).val());
        updateWallpaperAppearanceUI(RxThemes.applyWallpaperAppearance(appearance));
    }).on("change", function () {
        const appearance = {};
        $("#modal-settings [data-wallpaper-setting]").each(function () {
            appearance[$(this).data("wallpaper-setting")] = Number($(this).val());
        });
        updateWallpaperAppearanceUI(RxThemes.saveWallpaperAppearance(appearance));
    });

    $("#modal-settings .wallpaper-appearance-reset").click(function () {
        updateWallpaperAppearanceUI(RxThemes.resetWallpaperAppearance());
    });

    // Смена режима dark mode
    $("#modal-settings .placeholder:not(.wp-item)").click(function () {
        if ($(this).hasClass("active")) {
            return;
        }

        $("#modal-settings .placeholder.active").removeClass("active");
        $(this).addClass("active");
        animateCSSNode($("html")[0], "fadeOut").then(() => {
            $("html").hide();
            RxThemes.changeTheme(false, $(this).data("mode"));
            setTimeout(() => {
                $("html").show();
                animateCSSNode($("html")[0], "fadeIn");
            }, 250);
        })
    })

    // Смена основного цвета
    $("#modal-settings .theme-swatches .swatch[data-color]").each(function () {
        $(this).css("background", $(this).data("color"));
    }).click(function () {
        if ($(this).hasClass("active")) return;
        applyThemeHex($(this).data("color"));
    });

    // Свой цвет: «input» — живой предпросмотр без записи на диск, «change» — сохранение
    $("#modal-settings .theme-custom-color").on("input", function () {
        const rgb = colors.hexToRgb($(this).val());
        if (!rgb) return;
        RxThemes.generateAndLoad(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, currentThemeData.mode);
        $("#modal-settings .theme-swatches .swatch").removeClass("active");
        $("#modal-settings .swatch-custom").addClass("active").css("background", $(this).val());
    }).on("change", function () {
        applyThemeHex($(this).val());
    });

    // Переключение табов
    $("#modal-settings .tabs .tab").click(function () {
        if ($(this).hasClass("active")) {
            return;
        }

        $("#modal-settings .tabs .tab.active").removeClass("active");
        $(this).addClass("active");
        let tabName = $(this).data("tab");
        let tabElem = $(`#modal-settings .layout-tab[data-tab="${tabName}"]`);

        let tabIcon = $(this).find(".material-symbols-outlined").html();
        let tabText = $(this).find("span:not(.material-symbols-outlined)").text();

        $("#settings_currentSection span:not(.material-symbols-outlined)").text(tabText);
        $("#settings_currentSection .material-symbols-outlined").html(tabIcon);
        $("#modal-settings .layout-tab.active").removeClass("active");
        tabElem.addClass("active");
        animateCSSNode(tabElem[0], "fadeIn");

        // Анимация плашки с каждой настройкой
        if (RxConfig.read("disableAnimations", false) !== true) {
            $(tabElem).find(".settings-item:not(#aboutItem)").each(function (index) {
                $(this).css("opacity", 0);
                setTimeout(() => {
                    animateCSSNode($(this)[0], "fadeIn").then(() => {
                        $(this).css("opacity", 1);
                    })
                }, 80 * index)
            })
        }
    })
});
