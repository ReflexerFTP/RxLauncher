global.MESSAGES = {};

class RxTranslator {
    // Поиск и замена значений в HTML
    static translateAllNodes = () => {
        let currentLangData = RxTranslator.getCurrentLanguageData().translations;
        let $selector = $("button,option,strong,small,span:not(.material-symbols-outlined):not(.icon):not(.avatar),p,h1,h2,h3,h4,h5,dt,dd,div.description");
        $selector.each(function () {
            if (this.tagName === "BUTTON") {
                let title = $(this).attr("title");
                if (typeof title === "string" && title !== "") {
                    $(this).attr("title", RxTranslator.translateText(currentLangData, title));
                }
            }
            if ((this.tagName === "BUTTON" && $(this).children().length === 0) || this.tagName !== "BUTTON") {
                let itemText = $(this).html();
                // Переводим текст
                let translated = RxTranslator.translateText(currentLangData, itemText);
                if (translated !== false) {
                    $(this).html(translated);
                }
            }
        })

        // Переводим плейсхолдеры полей ввода
        let $selector2 = document.getElementsByTagName('input');
        for (let index = 0; index < $selector2.length; ++index) {
            let $element = $($selector2[index]);
            let itemText = $element.attr('placeholder');

            if (typeof itemText !== "undefined") {
                // Переводим текст
                let translated = RxTranslator.translateText(currentLangData, itemText);
                if (translated !== false) {
                    $element.attr('placeholder', translated);
                }
            }
        }

        let $selector3 = document.getElementsByTagName('div');
        for (let index = 0; index < $selector3.length; ++index) {
            let $element = $($selector3[index]);
            let itemText = $element.data("text");

            if (typeof itemText !== "undefined") {
                // Переводим текст
                let translated = RxTranslator.translateText(currentLangData, itemText);
                if (translated !== false) {
                    $element.data("text", translated);
                }
            }
        }

        // Доступные подписи не видны как обычный текст, но тоже должны
        // переключаться вместе с языком интерфейса.
        document.querySelectorAll("[aria-label], [alt]").forEach((element) => {
            ["aria-label", "alt"].forEach((attribute) => {
                if (!element.hasAttribute(attribute)) return;
                const translated = RxTranslator.translateText(currentLangData, element.getAttribute(attribute));
                if (translated !== false) element.setAttribute(attribute, translated);
            });
        });
    }

    // Загрузить список языков в UI
    static loadLanguagesList = () => {
        let langData = Object.values(RxTranslator.getAvailableLanguagesDetails());
        // Получаем код placeholder`а
        let placeholder = $("#modal-settings #languages-list .item.placeholder")[0].outerHTML;
        placeholder = placeholder.replaceAll(' placeholder', "").replaceAll(' display: none', "");
        // По placeholder`у добавляем новые элементы
        Object.values(langData).forEach((lang) => {
            let preparedPlaceholder = placeholder.replaceAll("$1", lang.displayName).replaceAll("$2", lang.displayNameEnglish).replaceAll("$4", lang.id);
            $("#modal-settings #languages-list").append(preparedPlaceholder);
        })

        // Помечаем нужные аккаунты в списке активными
        $("#modal-settings #languages-list .item").each(function () {
            if (!$(this).hasClass("placeholder")) {
                if ($(this).data("lang") === RxTranslator.getCurrentLanguage()) {
                    $(this).addClass("active");
                }
                $(this).show();
            }
        })
    }

    // Перевести текст
    static translateText = (languageData, text) => {
        text = text.toString();
        // Ищем все совпадения по тегу {{..]}
        let itemMatches = text.match(/\{{[0-9a-zA-Z\-_.]+\}}/gm);
        if (itemMatches !== null) {
            itemMatches.forEach(match => {
                // Чистим match-и от скобок и делим на категорию и ключ
                let matchClear = match.replaceAll("{", "").replaceAll("}", "");

                // Если нашли перевод в данных - меняем текст
                let messageByKey = RxUtils.parseNestedObjectPath(matchClear, languageData);
                if (messageByKey !== false) {
                    text = text.replaceAll(match, messageByKey);
                }
            })
            return text;
        }
        return false;
    }

    // Получить текущий язык
    static getCurrentLanguage = () => {
        let rdValue = RxConfig.read("language", false);
        // Язык не выбран или удалён из лаунчера (ua/de/cn) — переходим на язык по умолчанию
        if (rdValue === false || !RxTranslator.isLanguageExists(rdValue)) {
            return RxTranslator.setDefaultLanguage();
        }
        return rdValue;
    }

    // Задать стандартный язык лаунчера: английский для англоязычной системы, иначе русский
    static setDefaultLanguage = () => {
        const system = String(RxTranslator.getSystemLanguage() || "").slice(0, 2).toLowerCase();
        const defaultValue = system === "en" && RxTranslator.isLanguageExists("en") ? "en" : "ru";
        RxConfig.write("language", defaultValue);
        return defaultValue;
    }

    // Получить данные для текущего языка
    static getCurrentLanguageData = () => {
        let currentLang = RxTranslator.getCurrentLanguage();
        let langPath = path.join(__dirname, "languages", `${currentLang}.json`);
        return JSON.parse(fs.readFileSync(langPath));
    }

    // Загрузить данные языка в переменную (для JS)
    static loadCurrentLanguageToGlobalVariable = () => {
        global.MESSAGES = RxTranslator.getCurrentLanguageData().translations;
    }

    // Задать текущий язык
    static setCurrentLanguage = (language) => {
        if (RxTranslator.isLanguageExists(language)) {
            RxConfig.write("language", language);
            RxUI.reloadMainWindow();
            return true;
        }
        return false;
    }

    // Получить список доступных языков в деталях
    static getAvailableLanguagesDetails = () => {
        let result = {};
        let languagesList = RxTranslator.getAvailableLanguages();

        languagesList.forEach((item) => {
            let langFile = JSON.parse(fs.readFileSync(path.join(__dirname, "languages", `${item}.json`)));
            if (typeof langFile.info.code !== "undefined" && typeof langFile.info.id !== "undefined" && typeof langFile.info.displayNameEnglish !== "undefined") {
                result[langFile.info.code] = langFile.info;
            }
        })
        return result;
    }

    // Получить список доступных языков
    static getAvailableLanguages = () => {
        let result = [];
        let languagesPath = path.join(__dirname, "languages");
        if (fs.existsSync(languagesPath)) {
            fs.readdirSync(languagesPath).forEach(file => {
                if (path.extname(file) === ".json") {
                    result.push(path.basename(file).split(".")[0]);
                }
            })
            return result;
        }
        return false;
    }

    // Получить язык в системе
    static getSystemLanguage = () => {
        return navigator.language;
    }

    // Существует ли такой язык
    static isLanguageExists = (language) => {
        return RxTranslator.getAvailableLanguages().includes(language);
    }
}
