let javaInstallationDirectory;

class RxJavaManager {
    // Установить версию Java
    static install = async (version, restoreStartMode = false) => {
        if (RxJavaManager.isInstalled(version)) {
            return true;
        }
        // Готовим UI
        RxFlyout.setUIStartMode(true);
        RxFlyout.setText();
        RxFlyout.setProgress(-1);
        await RxFlyout.changeMode("spinner");
        // Получаем информацию
        let info = RxJavaManager.getByVersion(version);
        if (!info) throw new Error("Unsupported Java platform");
        // Скачиваем
        await RxDownloader.downloadFile(info.url, info.downloadPath, `Java ${version}`);
        // Меняем UI
        await RxFlyout.changeMode("spinner");
        RxFlyout.setText(`${MESSAGES.java.unpacking} ${version}`);
        // Publish only a complete runtime. A failed extraction must not look installed.
        const destination = path.resolve(info.unpackPath);
        const staging = fs.mkdtempSync(path.join(javaInstallationDirectory, ".java-install-"));
        const previous = destination + ".previous-" + crypto.randomUUID();
        let installed = false;
        try {
            await RxUtils.unpackArchive(info.downloadPath, staging);
            if (!RxJavaManager.findJava(staging)) throw new Error("Java executable is missing from the archive");
            if (fs.existsSync(destination)) fs.renameSync(destination, previous);
            fs.renameSync(staging, destination);
            installed = true;
        } catch (error) {
            if (fs.existsSync(previous) && !fs.existsSync(destination)) {
                try { fs.renameSync(previous, destination); }
                catch (_) { error.message += `; previous runtime preserved at ${previous}`; }
            }
            throw error;
        } finally {
            await fsPromises.rm(staging, {recursive: true, force: true}).catch(() => {});
            if (installed) await fsPromises.rm(previous, {recursive: true, force: true}).catch(() => {});
        }
        // Удаляем temp файлы
        fs.unlinkSync(info.downloadPath);
        if (restoreStartMode) {
            RxFlyout.setUIStartMode(false);
            RxFlyout.changeMode("idle");
        }
        RxToasts.create(`Java ${version}`, "info", MESSAGES.java.installed);
        return true;
    }

    // Инициализация директории
    static init = () => {
        javaInstallationDirectory = path.join(GAME_DATA, "javaDownloads");
        RxUtils.createMissingDirectories(javaInstallationDirectory);
    };

    // Получить локально установленные версии Java
    static getLocal = () => {
        let rdResult = fs.existsSync(javaInstallationDirectory) ? fs.readdirSync(javaInstallationDirectory) : [];
        rdResult = rdResult.filter(entry => /^\d+$/.test(entry) && RxJavaManager.isInstalled(entry));
        return rdResult;
    }

    // Проверить, скачана ли требуемая версия Java
    static isInstalled = (version) => {
        return Boolean(this.getPath(String(version)));
    }

    // Получить информацию о Java по версии
    static getByVersion = (javaVersion) => {
        let platformName = "";
        let fileExtension = "";
        let platformArch = "";

        if (process.platform === "win32") {
            platformName = "windows";
            fileExtension = ".zip";
        } else if (process.platform === "linux") {
            platformName = "linux";
            fileExtension = ".tar.gz";
        } else {
            return false;
        }

        if (process.arch === "x64") {
            platformArch = "x64";
        } else if (process.arch === "x32") {
            platformArch = "x86";
        } else {
            return false;
        }

        let resultURL;
        if (javaVersion == 8) {
            resultURL =
                "https://api.adoptium.net/v3/binary/version/jdk8u312-b07/" +
                platformName +
                "/" +
                platformArch +
                "/jdk/hotspot/normal/eclipse?project=jdk";
        } else {
            resultURL =
                "https://api.adoptium.net/v3/binary/latest/" +
                javaVersion +
                "/ga/" +
                platformName +
                "/" +
                platformArch +
                "/jdk/hotspot/normal/eclipse?project=jdk";
        }

        let filename = "Java-" + javaVersion + "-" + platformArch + fileExtension;
        return {
            url: resultURL,
            filename: filename,
            version: javaVersion,
            platformArch: platformArch,
            platformName: platformName,
            downloadPath: path.join(javaInstallationDirectory, filename),
            unpackPath: path.join(javaInstallationDirectory, javaVersion) + path.sep
        }
    };

    // Получить список доступных на сервере версий Java
    static getDownloadableVersions = async () => {
        let [isSuccess, data] = await RxRequests.get(JAVA_LIST_URL);
        if (isSuccess && data) {
            let availReleases = data.available_releases;
            availReleases.forEach((release, i) => {
                availReleases[i] = release.toString();
            });
            return availReleases;
        }
        return false;
    };

    // Получить путь к скачанной версии Java (возвращает false, если версия не существует)
    static getPath = (javaVersion) => {
        if (!/^\d+$/.test(String(javaVersion))) return false;
        return this.findJava(path.join(javaInstallationDirectory, String(javaVersion)));
    }

    static findJava = (javaDirPath) => {
        let javaSearchPath1 = path.join(javaDirPath, "bin", "java");
        if (process.platform === "win32") {
            javaSearchPath1 += ".exe";
        }
        if (fs.existsSync(javaDirPath) && fs.lstatSync(javaDirPath).isDirectory()) {
            if (fs.existsSync(javaSearchPath1) && fs.statSync(javaSearchPath1).isFile()) {
                return javaSearchPath1;
            } else {
                let javaReaddir = fs.readdirSync(javaDirPath);
                if (fs.readdirSync(javaDirPath).length === 1) {
                    let javaChkPath = path.join(javaDirPath, javaReaddir[0], "bin", "java");
                    if (process.platform === "win32") {
                        javaChkPath += ".exe";
                    }
                    if (fs.existsSync(javaChkPath) && fs.statSync(javaChkPath).isFile()) {
                        return javaChkPath;
                    }
                }
            }
        }
        return false;
    }

    // Версия игры -> версия Java
    static gameVersionToJavaVersion = async (version) => {
        let manifest = await RxVersionsManager.getVersionManifest(version);
        if (manifest !== false) {
            if ((manifest.id.split(".")[1] <= 6 || manifest.id.match(/-rd/gim)) && typeof manifest.javaVersion === "undefined") {
                return "8";
            } else {
                return manifest.javaVersion.majorVersion.toString();
            }
        } else {
            return false;
        }
    }
}
