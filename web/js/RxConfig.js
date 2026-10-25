let mainConfig;
let defaultConfig = {
    accounts: [],
    theme: {
        mode: 'dark',
        color: "rgb(229, 57, 53)"
    }
};

class RxConfig {
    static getDefaultConfig() {
        return JSON.parse(JSON.stringify(defaultConfig));
    }

    // Прочитать конфиг-файл
    static readConfig() {
        if (fs.existsSync(CONFIG_PATH)) {
            try {
                const parsedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
                if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
                    throw new Error("Config root must be an object");
                }

                const defaults = this.getDefaultConfig();
                // FrogLauncher называл безопасный режим `multiplayerFix`.
                // Переносим только его совместимую часть (IPv4/тайм-ауты),
                // не перенося подмену серверов авторизации.
                if (typeof parsedConfig.networkCompatibilityMode === "undefined" && parsedConfig.multiplayerFix === true) {
                    parsedConfig.networkCompatibilityMode = true;
                }
                return {
                    ...defaults,
                    ...parsedConfig,
                    theme: {
                        ...defaults.theme,
                        ...(parsedConfig.theme || {})
                    }
                };
            } catch (error) {
                const backupPath = path.join(
                    path.dirname(CONFIG_PATH),
                    `config.corrupt-${Date.now()}.json`
                );
                try {
                    fs.copyFileSync(CONFIG_PATH, backupPath);
                    console.warn(`Corrupted config backed up to ${backupPath}`);
                } catch (backupError) {
                    console.warn("Failed to back up corrupted config", backupError);
                }
            }
        }

        const cleanConfig = this.getDefaultConfig();
        this.writeConfig(cleanConfig);
        return cleanConfig;
    }

    // Записать конфиг-файл
    static writeConfig(config) {
        fs.writeFileSync(
            CONFIG_PATH,
            JSON.stringify(config, null, "\t")
        );
        return true;
    }

    // Прочитать переменную из конфига
    static read = (key, defaultValue = true) => {
        if (!this.isKeyExists(key)) {
            this.write(key, defaultValue);
            return defaultValue;
        }
        return mainConfig[key];
    };

    // Записать переменную в конфиг
    static write = (key, value) => {
        if (!mainConfig || typeof mainConfig !== "object") {
            mainConfig = this.getDefaultConfig();
        }
        mainConfig[key] = value;
        return this.writeConfig(mainConfig);
    }

    // Существует ли ключ в конфиге
    static isKeyExists = (key) => {
        if (typeof mainConfig === "undefined") {
            return false;
        }
        return typeof mainConfig[key] !== "undefined";
    }
}

mainConfig = RxConfig.readConfig();
