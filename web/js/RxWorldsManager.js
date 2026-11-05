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
    static savesFromDirectory = async directory => {
        let entries;
        try { entries = fs.readdirSync(directory, {withFileTypes: true}); }
        catch (_) { return false; }
        const result = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const full = path.join(directory, entry.name);
            const info = await RxWorldsManager.getWorldInfo(full);
            if (info) result.push({...info, path: full});
        }
        return result;
    };

    static getAllWorlds = async () => {
        const result = [];
        for (const directory of RxWorldsManager.getSavesDirectories()) {
            result.push({path: directory, worlds: await RxWorldsManager.savesFromDirectory(directory) || []});
        }
        return result;
    };

    static getWorldInfo = async worldPath => {
        try {
            const root = await require('./js/RxNbt').readLevelDatAsync(path.join(worldPath, 'level.dat'));
            const data = root?.['']?.value?.Data?.value;
            if (!data) return false;
            const icon = path.join(worldPath, 'icon.png');
            return {icon: fs.existsSync(icon) ? icon : 'assets/world.webp',
                name: typeof data.LevelName?.value === 'string' ? data.LevelName.value : path.basename(worldPath),
                dataPacks: data.DataPacks?.value, dataVersion: data.DataVersion?.value,
                difficulty: data.Difficulty?.value, version: data.Version?.value?.Name?.value || '',
                gamemode: data.Player?.value?.playerGameType?.value ?? data.GameType?.value};
        } catch (_) { return false; }
    };

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
