class RxAssetsParsers {
    static description = (value, depth = 0) => {
        if (depth > 8) return '';
        if (typeof value === 'string') return value.slice(0, 4096);
        if (Array.isArray(value)) return value.slice(0, 64).map(item => RxAssetsParsers.description(item, depth + 1)).join('').slice(0, 4096);
        if (value && typeof value === 'object') return RxAssetsParsers.description(value.text || value.fallback || '', depth + 1)
            + RxAssetsParsers.description(value.extra, depth + 1);
        return '';
    };
    static readResourcepack = zipFile => RxAssetsParsers.readResourcePackV2(zipFile);
    static readResourcePackV2 = async zipFile => {
        try {
            const reader = require('../archiveMetadata');
            const entries = await reader.readEntries(zipFile, name => name === 'pack.mcmeta' || name === 'pack.png', 512 * 1024);
            if (!entries['pack.mcmeta']) return false;
            const meta = JSON.parse(entries['pack.mcmeta'].toString('utf8')).pack;
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
            return {mcmeta: {description: RxAssetsParsers.description(meta.description).slice(0, 4096), pack_format: meta.pack_format},
                icon: reader.pngBase64(entries['pack.png']) || false};
        } catch (_) { return false; }
    };
    static readModInfo = async jarFile => {
        try {
            const meta = await RxModMeta.read(jarFile);
            if (!meta || !meta.id) return false;
            return {name: meta.name, version: meta.version, description: meta.description, authors: meta.authors,
                icon: meta.iconData ? meta.iconData.slice('data:image/png;base64,'.length) : false};
        } catch (_) { return false; }
    };
    // Compatibility cleanup for cache left by older launcher versions.
    static clearAssetsCache = () => {
        try {
            const cache = path.join(GAME_DATA, 'cache'), dir = path.join(cache, 'unpacked');
            for (const target of [cache, dir]) {
                try { if (fs.lstatSync(target).isSymbolicLink()) return false; }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            fs.rmSync(dir, {recursive: true, force: true});
            fs.mkdirSync(dir, {recursive: true});
            return true;
        } catch (_) { return false; }
    };
}
