let javaInstallationDirectory;

class RxJavaManager {
    // Установить версию Java
    static install = async (version, restoreStartMode = false) => {
        const integrity = require('../runtimeSecurity');
        // Нужная Java уже установлена и цела (сверена по квитанции) — ею и пользуемся.
        // Раньше лаунчер при каждом запуске спрашивал Adoptium и качал всю Java (~190 МБ) заново из-за новой патч-сборки
        if (RxJavaManager.isInstalled(version)) return true;
        let info = RxJavaManager.getByVersion(version);
        if (!info) throw new Error('Unsupported Java platform');
        info = await integrity.resolveJavaRelease(info, RxHttp.json);
        // Готовим UI
        RxFlyout.setUIStartMode(true);
        RxFlyout.setText();
        RxFlyout.setProgress(-1);
        await RxFlyout.changeMode("spinner");
        // Получаем информацию
        // Release metadata and checksum have already been validated.
        // Скачиваем
        await RxDownloader.downloadFile(info.url, info.downloadPath, `Java ${version}`, true, {sha256: info.sha256}, {expectedSize: info.size, maxBytes: 2 * 1024 ** 3});
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
            integrity.writeRuntimeReceipt(staging, info);
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
        // Java от старых версий лаунчера без квитанции — не скачиваем заново, а принимаем после проверки
        try {
            fs.readdirSync(javaInstallationDirectory).filter(entry => /^\d+$/.test(entry)).forEach(major => {
                if (require('../runtimeSecurity').adoptLegacyRuntime(path.join(javaInstallationDirectory, major), major)) {
                    RxCollector.writeLog(`Java: Adopted Java ${major} installed by an older launcher`);
                }
            });
        } catch (_) {}
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
        } else if (process.arch === "ia32" || process.arch === "x32") {
            platformArch = "x86";
        } else if (process.arch === 'arm64') {
            platformArch = 'aarch64';
        } else {
            return false;
        }

        if (!/^\d{1,2}$/.test(String(javaVersion))) return false;
        const resultURL = 'https://api.adoptium.net/v3/binary/latest/' + javaVersion + '/ga/'
            + platformName + '/' + platformArch + '/jdk/hotspot/normal/eclipse?project=jdk';

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
    // Проверенная Java запоминается на 5 минут, пока java.exe не менялся: за один запуск игры
    // все файлы не пересчитываются дважды, а подмена исполняемого файла сразу ведёт к полной проверке
    static verified = new Map(); // каталог → {at, stamp}
    static stamp = (file) => {
        try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}`; } catch (_) { return ""; }
    };

    static getPath = (javaVersion) => {
        if (!/^\d+$/.test(String(javaVersion))) return false;
        const dir = path.join(javaInstallationDirectory, String(javaVersion));
        const cached = RxJavaManager.verified.get(dir);
        if (cached && Date.now() - cached.at < 5 * 60e3) {
            const exe = this.findJava(dir);
            if (exe && RxJavaManager.stamp(exe) === cached.stamp) return exe;
        }
        RxJavaManager.verified.delete(dir);
        if (!require('../runtimeSecurity').validateRuntime(dir, javaVersion)) return false;
        const exe = this.findJava(dir);
        if (exe) RxJavaManager.verified.set(dir, {at: Date.now(), stamp: RxJavaManager.stamp(exe)});
        return exe;
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
                let javaReaddir = fs.readdirSync(javaDirPath).filter(name => {
                    const full = path.join(javaDirPath, name);
                    return fs.lstatSync(full).isDirectory() && !fs.lstatSync(full).isSymbolicLink();
                });
                if (javaReaddir.length === 1) {
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
