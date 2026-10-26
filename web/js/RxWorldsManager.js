class RxWorldsManager {
    // Получить директории для поиска миров
    static getSavesDirectories = () => {
        // Читаем из корня
        let saves = [path.join(GAME_DATA, "saves")];

        // Читаем из модпаков
        let modpacksList = RxPacks.getPacksList();
        if (modpacksList.length > 0) {
            modpacksList = modpacksList.map((item) => path.join(GAME_DATA, "modpacks", item, "saves"));
        }

        // Читаем из /home
        let homePath = path.join(GAME_DATA, "home");
        let homesList = [];
        if (fs.existsSync(homePath)) {
            homesList = fs.readdirSync(homePath);
            if (homesList.length > 0) {
                homesList = homesList.map((item) => path.join(homePath, item, "saves"));
            }
        }

        saves = saves.concat(modpacksList, homesList);
        return saves;
    }

    // Получить список сейвов из директории с данными о них
    static savesFromDirectory = (directory) => {
        return new Promise(resolve => {
            if (!fs.existsSync(directory)) {
                return resolve(false);
            }

            var saves = fs.readdirSync(directory);
            var result = [];
            var currentWorld = -1;
            var savesResolve = resolve;

            nextWorld();

            function nextWorld() {
                currentWorld++;
                if (typeof saves[currentWorld] !== "undefined") {
                    var fullWorldPath = path.join(directory, saves[currentWorld]);
                    RxWorldsManager.getWorldInfo(fullWorldPath).then(data => {
                        if (data !== false) {
                            data.path = fullWorldPath;
                            result.push(data);
                        }
                        nextWorld();
                    })
                } else {
                    return savesResolve(result);
                }
            }
        })
    }

    // Получить все миры из директории игры
    static getAllWorlds = () => {
        return new Promise(resolve => {
            let savesDirectories = RxWorldsManager.getSavesDirectories();
            if (savesDirectories.length === 0) {
                return resolve([]);
            }

            var result = [];
            var savesResolve = resolve;
            var currentSave = -1;

            nextSave();

            function nextSave() {
                currentSave++;
                if (typeof savesDirectories[currentSave] !== "undefined") {
                    RxWorldsManager.savesFromDirectory(savesDirectories[currentSave]).then(saves => {
                        if (saves === false) {
                            saves = [];
                        }
                        result.push({
                            path: savesDirectories[currentSave],
                            worlds: saves
                        })
                        nextSave();
                    })
                } else {
                    return savesResolve(result);
                }
            }
        })
    }

    // Получить информацию о мире
    static getWorldInfo = (worldPath) => {
        return new Promise(resolve => {
            let levelDat = path.join(worldPath, "level.dat");
            let iconPath = path.join(worldPath, "icon.png");
            if (!fs.existsSync(levelDat)) {
                return resolve(false);
            }
            if (!fs.existsSync(iconPath)) {
                iconPath = "assets/world.webp";
            }

            let nbtData = new NBT();
            nbtData.loadFromZlibCompressedFile(levelDat, function (err) {
                if (err) {
                    console.log(err);
                    return resolve(false);
                }
                // В старых и серверных мирах части полей нет — не роняем весь список
                const data = nbtData.root?.[""]?.value?.Data?.value;
                if (!data) return resolve(false);
                return resolve({
                    icon: iconPath,
                    name: data.LevelName?.value || path.basename(worldPath),
                    dataPacks: data.DataPacks?.value,
                    dataVersion: data.DataVersion?.value,
                    difficulty: data.Difficulty?.value,
                    version: data.Version?.value?.Name?.value || "",
                    gamemode: data.Player?.value?.playerGameType?.value ?? data.GameType?.value
                });
            });
        })
    }

    // Установить мир из zip-архива
    static installFromZip = async (savesDirectory, zipPath) => {
        if (!fs.existsSync(savesDirectory) || !fs.existsSync(zipPath)) return false;
        const target = path.join(savesDirectory, path.parse(zipPath).name);
        if (fs.existsSync(target)) throw new Error("A world with this name already exists");
        const temp = fs.mkdtempSync(path.join(savesDirectory, ".rx-import-"));
        try {
            await RxUtils.unpackArchive(zipPath, temp);
            let source = temp;
            if (!fs.existsSync(path.join(source, "level.dat"))) {
                const worlds = fs.readdirSync(temp).map(name => path.join(temp, name)).filter(dir => fs.existsSync(path.join(dir, "level.dat")));
                if (worlds.length !== 1) throw new Error("Archive must contain exactly one Minecraft world");
                source = worlds[0];
            }
            if (fs.existsSync(target)) throw new Error("Destination already exists");
            fs.renameSync(source, target);
            return true;
        } finally { await fsPromises.rm(temp, {recursive: true, force: true}).catch(() => {}); }
    };
}
