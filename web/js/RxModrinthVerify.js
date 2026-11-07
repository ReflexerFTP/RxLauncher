// Сверка модов с Modrinth по SHA-1: файл, опубликованный на Modrinth, помечается «Проверено Modrinth».
// Один запрос на все моды; ответы кешируются: найденные файлы — на неделю, ненайденные — на сутки.
// Для ненайденных файлов проверка на стилеры строже (RxModScan.flagged)
class RxModrinthVerify {
    static FILE = () => path.join(USERDATA_PATH, "modrinth-hashes.json");
    static KNOWN_MS = 7 * 24 * 3600e3;
    static UNKNOWN_MS = 24 * 3600e3;
    static cache = null;

    static load = () => {
        if (RxModrinthVerify.cache) return RxModrinthVerify.cache;
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(RxModrinthVerify.FILE(), "utf8")); } catch (_) {}
        RxModrinthVerify.cache = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
        return RxModrinthVerify.cache;
    };

    static save = () => {
        const entries = Object.entries(RxModrinthVerify.cache || {}).sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0)).slice(0, 5000);
        try { fs.writeFileSync(RxModrinthVerify.FILE(), JSON.stringify(Object.fromEntries(entries))); } catch (_) {}
    };

    // sha1 → {project, version, number} для файлов, которые есть на Modrinth
    static lookup = async (hashes) => {
        const cache = RxModrinthVerify.load();
        const now = Date.now();
        const wanted = [...new Set(hashes.filter(hash => /^[0-9a-f]{40}$/.test(String(hash))))];
        const stale = wanted.filter(hash => !cache[hash] || now - cache[hash].t > (cache[hash].p ? RxModrinthVerify.KNOWN_MS : RxModrinthVerify.UNKNOWN_MS));
        if (stale.length && !RxPrivacy.isParanoid() && !(typeof RxNetwork !== "undefined" && RxNetwork.offline)) {
            try {
                for (let index = 0; index < stale.length; index += 500) {
                    const part = stale.slice(index, index + 500);
                    const found = await RxHttp.json("https://api.modrinth.com/v2/version_files", {method: "POST", body: {hashes: part, algorithm: "sha1"}, timeout: 15000});
                    part.forEach(hash => {
                        const version = found?.[hash];
                        cache[hash] = typeof version?.project_id === "string"
                            ? {p: version.project_id, v: String(version.id || ""), n: String(version.version_number || "").slice(0, 64), t: now}
                            : {p: "", t: now};
                    });
                }
                RxModrinthVerify.save();
            } catch (error) {
                RxCollector.writeLog(`Modrinth: Verify failed [error=${error?.message || error}]`);
            }
        }
        const result = new Map();
        wanted.forEach(hash => {
            if (cache[hash]?.p) result.set(hash, {project: cache[hash].p, version: cache[hash].v, number: cache[hash].n});
        });
        return result;
    };
}
