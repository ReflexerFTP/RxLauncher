let colorsMatchRegex = /rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)/
const bundledWallpaperClasses = Array.from({length: 8}, (_, index) => `img-${index + 1}`);

class RxThemes {
    // Создать тему и сделать её активной
    static generateAndLoad = (color, mode) => {
        let darkMode;
        if (mode !== "light" && mode !== "dark") {
            return false;
        }

        mode === "dark" ? darkMode = true : darkMode = false;

        let genResult = RxThemes.themeFromColor(color, darkMode);
        if (genResult === false) {
            return false;
        }

        RxThemes.loadThemeVariables(genResult);
        RxThemes.applyModeClasses(mode);
        return true;
    }

    // Переключение тёмного и светлого режимов
    static applyModeClasses = (mode) => {
        if (mode !== "light" && mode !== "dark") {
            return false;
        }

        $("html").removeClass("dark light");
        $("html").addClass(mode);
        return true;
    }

    // Изменить тему
    static changeTheme = (color = false, mode = false) => {
        RxCollector.writeLog(`ThemeEngine: Reloading [color=${color}] [mode=${mode}]`);
        let selColor, selMode;

        if (color === false) {
            selColor = currentThemeData.color;
        } else {
            selColor = color;
            currentThemeData.color = color;
        }

        if (mode === false) {
            selMode = currentThemeData.mode;
        } else {
            selMode = mode;
            currentThemeData.mode = mode;
        }

        RxThemes.generateAndLoad(selColor, selMode);
        RxThemes.saveCurrentTheme();
    }

    // Сгенерировать тему из цвета
    static themeFromColor = (color, darkMode = true) => {
        let matched = color.match(colorsMatchRegex);
        if (matched === null || matched.length !== 4) {
            return false;
        }

        let r = matched[1];
        let g = matched[2];
        let b = matched[3];

        let primary = `rgb(${r}, ${g}, ${b})`;
        let hslValue = colors.RGBToHSL(r, g, b);
        let primaryDarker = `hsl(${hslValue.h}, 100%, 35%)`;
        let primaryLighter = `hsl(${hslValue.h}, 100%, 60%)`;
        let primaryBg, primaryBgLight, primaryBgLighter, primaryBgShadow, primaryBgDark;
        if (darkMode === true) {
            // Почти нейтральные поверхности: цвет темы лишь слегка подкрашивает фон,
            // а акцент остаётся только на активных элементах
            primaryBg = `hsl(${hslValue.h}, 8%, 8%)`;
            primaryBgShadow = `hsla(${hslValue.h}, 8%, 8%, 0.3)`;
            primaryBgLight = `hsl(${hslValue.h}, 7%, 12%)`;
            primaryBgLighter = `hsl(${hslValue.h}, 6%, 17%)`;
            primaryBgDark = `hsl(${hslValue.h}, 8%, 5%)`;
        } else {
            primaryBg = `hsl(${hslValue.h}, 100%, 100%)`;
            primaryBgShadow = `hsla(${hslValue.h}, 100%, 100%, 0.3)`;
            primaryBgLight = `hsl(${hslValue.h}, 12%, 96%)`;
            primaryBgLighter = `hsl(${hslValue.h}, 10%, 91%)`;
            primaryBgDark = `hsl(${hslValue.h}, 10%, 86%)`;
        }

        let primaryHex = colors.rgbToHex(r, g, b);
        let textColor;
        colors.isColorLight(primaryHex) ? textColor = "black" : textColor = "white";

        RxCollector.writeLog(`ThemeEngine: Generation of theme completed`);

        return {
            primary: primary,
            primaryDarker: primaryDarker,
            primaryLighter: primaryLighter,
            primaryBg: primaryBg,
            primaryBgLight: primaryBgLight,
            primaryBgLighter: primaryBgLighter,
            primaryBgShadow: primaryBgShadow,
            primaryBgDark: primaryBgDark,
            hue: hslValue.h,
            text: textColor
        }
    }

    // Загрузить параметры активной темы
    static loadThemeVariables = (themeData) => {
        Object.keys(themeData).forEach((key) => {
            loadedThemeData[key] = themeData[key];
            $(":root")[0].style.setProperty("--theme-" + key, themeData[key]);
        });
        return true;
    }

    // Сохранить тему в конфиг
    static saveCurrentTheme = () => {
        return RxConfig.write("theme", currentThemeData);
    }

    // Обои по умолчанию — Скрипун в Бледном саду (8), они же фон сайта
    static DEFAULT_WALLPAPER = "8";

    // Сменить встроенные или пользовательские обои
    static changeWallpaper = (wpId) => {
        let $bgImage = $(".background.img");
        RxCollector.writeLog(`ThemeEngine: Updated wallpaper : ${wpId}`);
        if (wpId === "custom") {
            let customWpPath = RxConfig.read("customWallpaperPath", "");
            if (typeof customWpPath !== "string" || customWpPath === "" || !fs.existsSync(customWpPath)) {
                RxCollector.writeLog("ThemeEngine: Custom wallpaper is missing");
                return false;
            }
            $bgImage.removeClass(bundledWallpaperClasses.join(" "));
            $bgImage.css("background-image", `url("${pathToFileURL(customWpPath).href}")`);
            RxConfig.write("currentWallpaper", "custom");
            return true;
        }

        const parsedWpId = Number(wpId);
        if (Number.isInteger(parsedWpId) && parsedWpId >= 1 && parsedWpId <= bundledWallpaperClasses.length) {
            $bgImage.css("background-image", ``);
            $bgImage.removeClass(bundledWallpaperClasses.join(" "));
            $bgImage.addClass(`img-${parsedWpId}`);
            RxConfig.write("currentWallpaper", String(parsedWpId));
            return true;
        }
        return false;
    }

    // Выбрать кастомные обои
    static selectCustomWallpaper = async () => {
        let result = await ipcRenderer.invoke("open-dialog", {
            properties: ["dontAddToRecent"],
            filters: [{name: "Изображение", extensions: ["png", "jpg", "jpeg", "gif", "webp"]}],
        });
        if (!Array.isArray(result) || typeof result[0] !== "string") {
            return false;
        }

        let imgPath = result[0];
        if (imgPath !== "" && fs.existsSync(imgPath)) {
            let fileExt = path.extname(imgPath).toLowerCase();
            let directoryPath = path.join(USERDATA_PATH, "AppCache");
            if (!fs.existsSync(directoryPath)) {
                fs.mkdirSync(directoryPath, {recursive: true});
            }
            let bgId = crypto.randomUUID();
            fs.copyFileSync(
                imgPath,
                path.join(directoryPath, bgId + fileExt)
            );
            RxConfig.write("currentWallpaper", "custom");
            RxConfig.write("customWallpaperPath", path.join(directoryPath, bgId + fileExt));
            return path.join(directoryPath, bgId + fileExt);
        }
        return false;
    }

    static normalizeWallpaperAppearance = (value = {}) => {
        const clamp = (number, min, max, fallback) => {
            const parsed = Number(number);
            return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
        };

        return {
            blur: clamp(value.blur, 0, 20, 4),
            brightness: clamp(value.brightness, 35, 100, 75),
            scale: clamp(value.scale, 100, 120, 104)
        };
    }

    static getWallpaperAppearance = () => {
        return RxThemes.normalizeWallpaperAppearance(
            RxConfig.read("wallpaperAppearance", {blur: 4, brightness: 75, scale: 104})
        );
    }

    static applyWallpaperAppearance = (value = null) => {
        const appearance = RxThemes.normalizeWallpaperAppearance(value || RxThemes.getWallpaperAppearance());
        const rootStyle = document.documentElement.style;
        rootStyle.setProperty("--wallpaper-blur", `${appearance.blur}px`);
        rootStyle.setProperty("--wallpaper-brightness", `${appearance.brightness}%`);
        rootStyle.setProperty("--wallpaper-scale", appearance.scale / 100);
        return appearance;
    }

    static saveWallpaperAppearance = (value) => {
        const appearance = RxThemes.applyWallpaperAppearance(value);
        RxConfig.write("wallpaperAppearance", appearance);
        return appearance;
    }

    static resetWallpaperAppearance = () => {
        return RxThemes.saveWallpaperAppearance({blur: 4, brightness: 75, scale: 104});
    }

    // Загрузить шрифт из конфигурации
    static loadFont = async () => {
        // Проверяем существование шрифта
        let availableFonts = await RxUI.getFontsAvailable();
        let font = RxConfig.read("fontFamily", "Manrope");
        if(!availableFonts.includes(font)){
            font = "Manrope";
            RxConfig.write("fontFamily", font);
        }

        $(".custom-font-style").remove();
        // Если шрифт нестандартный - устанавливаем
        if(font !== "Manrope") $("html").append(`<style class="custom-font-style">*:not(.console-textarea):not(.material-symbols-outlined):not(.font-preview) {font-family: "${font}" !important} </style>`);

        return font;
    }
}
