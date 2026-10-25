const MC_ASSETS_URL = "https://resources.download.minecraft.net";
let assetsPromiseResolve;
let assetsPromise;
global.assetsDownloadStatus = {
    total: 0,
    current: 0,
    percent: 0
}
let needToDownload = [];
let currentDownloadingAsset = 0;

class RxAssets {
    // Проверить и скачать недостающие ассеты
    static verifyAndDownload = (version) => {
        return assetsPromise = new Promise((resolve) => {
            assetsPromiseResolve = resolve;
            RxAssets.verifyAssets(version, true).then(result => {
                needToDownload = result;
                if (needToDownload.length === 0) {
                    return resolve(true);
                }
                currentDownloadingAsset = -1;
                this.downloadNextAsset();
            })
        });
    }

    static downloadNextAsset = () => {
        currentDownloadingAsset++;
        if (typeof needToDownload[currentDownloadingAsset] === "undefined") {
            return assetsPromiseResolve(true);
        }
        global.assetsDownloadStatus.current = currentDownloadingAsset;
        global.assetsDownloadStatus.percent = Math.round((global.assetsDownloadStatus.current / global.assetsDownloadStatus.total) * 100);
        let filePath = needToDownload[currentDownloadingAsset].path;
        let url = needToDownload[currentDownloadingAsset].url;
        let displayName = path.basename(filePath);
        RxDownloader.downloadFile(url, filePath, displayName).then(() => {
            RxAssets.downloadNextAsset();
        })
    }

    // Получить полный список файлов, которые нужно скачивать для запуска игры
    static verifyAssets = async (version, changeUI = true) => {
        if (changeUI) {
            RxFlyout.setUIStartMode(true);
            RxFlyout.setText("Проверка ассетов");
            await RxFlyout.changeMode("spinner");
        }
        let downloadsList = [];
        let assetsPath = path.resolve(path.join(GAME_DATA, "assets"));
        let librariesPath = path.resolve(path.join(GAME_DATA, "libraries"));
        let vPkg = await RxVersionsManager.getVersionManifest(version);
        // Создаём все папки, если их нет
        if (!fs.existsSync(assetsPath)) {
            fs.mkdirSync(assetsPath, {recursive: true});
        }
        if (!fs.existsSync(librariesPath)) {
            fs.mkdirSync(librariesPath, {recursive: true});
        }
        let currentOs = os.platform().replace("win32", "windows");
        // Библиотеки
        vPkg.libraries.forEach((library) => {
            if (!library.downloads || !library.downloads.classifiers) return;
            //if (RxAssets.parseLibraryRule(library)) return;

            let libraryArtifact = this.getOS() === 'osx'
                ? library.downloads.classifiers['natives-osx'] || library.downloads.classifiers['natives-macos']
                : library.downloads.classifiers[`natives-${this.getOS()}`];

            let arch = os.arch() === "x64" ? "64" : "32";
            if (typeof libraryArtifact === "undefined" && typeof library.downloads.classifiers[`natives-${this.getOS()}-${arch}`] !== "undefined") {
                libraryArtifact = library.downloads.classifiers[`natives-${this.getOS()}-${arch}`]
            }

            let libraryPath = path.resolve(path.join(librariesPath, libraryArtifact.path));
            let libraryRule, libraryRuleAction;
            if (typeof library.rules !== "undefined" && library.rules.length > 1) {
                library.rules.forEach((rule) => {
                    if (typeof rule.os !== "undefined") {
                        libraryRule = rule;
                        libraryRuleAction = rule.action;
                    }
                })
            }
            if ((typeof library.rules === "undefined") || (typeof library.rules !== "undefined" && libraryRuleAction === "allow" && libraryRule.os.name === currentOs) || (typeof library.rules !== "undefined" && libraryRuleAction === "deny" && libraryRule.os.name !== currentOs)) {
                if (!RxAssets.verifyFile(libraryPath, libraryArtifact.sha1)) {
                    downloadsList.push({
                        url: libraryArtifact.url,
                        path: libraryPath
                    })
                }
            }
        });
        // Ассеты
        let vAssets = await RxRequests.get(vPkg.assetIndex.url);
        Object.values(vAssets.objects).forEach((asset) => {
            let hash = asset.hash;
            let subHash = hash.substring(0, 2);
            let assetPath = path.resolve(path.join(assetsPath, "objects", subHash, hash));
            if (!RxAssets.verifyFile(assetPath, hash)) {
                downloadsList.push({
                    url: MC_ASSETS_URL + "/" + hash + subHash,
                    path: assetPath
                })
            }
        });
        return downloadsList;
    }

    // Проверить файл по хешу SHA-1
    static verifyFile(fullPath, sha1) {
        if (fs.existsSync(fullPath)) {
            let sha1sum = crypto
                .createHash("sha1")
                .update(fs.readFileSync(fullPath))
                .digest("hex");
            if (sha1sum === sha1) {
                return true;
            }
        }
        return false;
    }

    static parseLibraryRule(lib) {
        if (lib.rules) {
            if (lib.rules.length > 1) {
                if (lib.rules[0].action === 'allow' && lib.rules[1].action === 'disallow' && lib.rules[1].os.name === 'osx') {
                    return this.getOS() === 'osx'
                }
                return true
            } else {
                if (lib.rules[0].action === 'allow' && lib.rules[0].os) return lib.rules[0].os.name !== this.getOS()
            }
        } else {
            return false
        }
    }

    static getOS = () => {
        switch (process.platform) {
            case 'win32':
                return 'windows';
            case 'darwin':
                return 'osx';
            default:
                return 'linux';
        }
    }

    // Скачать/перенести нужный файл OptiFine
    static isValidOptiFineJar = (filePath) => {
        let descriptor;
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size < 100 * 1024) return false;

            const header = Buffer.alloc(4);
            descriptor = fs.openSync(filePath, "r");
            if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
            if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) return false;

            const tailLength = Math.min(stat.size, 65557);
            const tail = Buffer.alloc(tailLength);
            if (fs.readSync(descriptor, tail, 0, tailLength, stat.size - tailLength) !== tailLength) return false;
            return tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
        } catch (_) {
            return false;
        } finally {
            if (typeof descriptor === "number") {
                try { fs.closeSync(descriptor); } catch (_) {}
            }
        }
    }

    static removeFileQuietly = (filePath) => {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
    }

    static setupOptiFine = async (ofVersion, gamePath) => {
        let temporaryPath = false;
        try {
            const entry = await RxVersionsManager.getOptiFineEntry(ofVersion);
            if (!entry) {
                RxCollector.writeLog(`OF: No supported OptiFine release [version=${ofVersion}]`);
                return false;
            }

            const ofCacheDirname = path.join(GAME_DATA, "cache", "of");
            const ofCachePath = path.join(ofCacheDirname, entry.file);
            const ofPathDirname = path.join(gamePath, "mods");
            const ofPath = path.join(ofPathDirname, entry.file);

            fs.mkdirSync(ofCacheDirname, {recursive: true});
            fs.mkdirSync(ofPathDirname, {recursive: true});

            if (RxAssets.isValidOptiFineJar(ofCachePath)) {
                RxAssets.removeFileQuietly(ofPath);
                fs.copyFileSync(ofCachePath, ofPath);
                const copied = RxAssets.isValidOptiFineJar(ofPath);
                RxCollector.writeLog(`OF: Using verified cached file [success=${copied}]`);
                return copied;
            }

            RxAssets.removeFileQuietly(ofCachePath);
            const resolved = await RxVersionsManager.resolveOptiFineDownload(ofVersion);
            if (!resolved?.url || resolved.file !== entry.file) {
                RxCollector.writeLog(`OF: Failed to resolve official download [version=${ofVersion}]`);
                return false;
            }

            temporaryPath = `${ofCachePath}.${typeof process !== "undefined" ? process.pid : "rx"}.part`;
            RxAssets.removeFileQuietly(temporaryPath);
            RxCollector.writeLog(`OF: Starting official file download [url=${resolved.url}]`);

            const dlResult = await RxDownloader.downloadFile(
                resolved.url,
                temporaryPath,
                `OptiFine ${ofVersion}`,
                true
            );
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!dlResult || !RxAssets.isValidOptiFineJar(temporaryPath)) {
                RxCollector.writeLog(`OF: Downloaded file is missing or is not a valid JAR`);
                return false;
            }

            fs.renameSync(temporaryPath, ofCachePath);
            temporaryPath = false;
            fs.copyFileSync(ofCachePath, ofPath);
            if (!RxAssets.isValidOptiFineJar(ofPath)) {
                RxAssets.removeFileQuietly(ofPath);
                RxCollector.writeLog(`OF: Failed to verify copied mod file`);
                return false;
            }

            RxCollector.writeLog(`OF: Copying verified JAR to mods done`);
            return true;
        } catch (error) {
            RxCollector.writeLog(`OF: Setup failed [error=${error.message}]`);
            return false;
        } finally {
            if (temporaryPath) RxAssets.removeFileQuietly(temporaryPath);
        }
    }

    // Удалить OptiFine (после завершения игры)
    static removeOptiFine = (ofVersion, gamePath) => {
        const entry = RxVersionsManager.getCachedOptiFineEntry(ofVersion);
        if (!entry) return false;
        const ofPath = path.join(gamePath, "mods", entry.file);

        if(fs.existsSync(ofPath)){
            RxCollector.writeLog(`OF: OptiFine found in mods, removing...`);
            try {
                fs.unlinkSync(ofPath);
            } catch (error) {
                RxCollector.writeLog(`OF: Failed to remove OptiFine [error=${error.message}]`);
                return false;
            }
        }
        return true;
    }
}
