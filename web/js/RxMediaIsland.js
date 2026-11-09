// «Остров» над лаунчером (как Dynamic Island на iPhone): если в Spotify играет музыка, по центру шапки — текущая
// строка текста песни, при наведении — название, исполнитель и прогресс. Что играет, ядро узнаёт у Windows
// (media.rs, без входа в Spotify), синхронизированный текст — с открытого сервиса LRCLIB.
// Выключается в настройках («Остров Spotify»). Пока окно скрыто (идёт игра), ничего не опрашивается
class RxMediaIsland {
    static CONFIG_KEY = "mediaIsland";
    static POLL_MS = 1000;
    static IDLE_POLL_MS = 5000;   // Spotify не запущен — спрашиваем реже
    static LEAD_MS = 250;         // строку показываем чуть раньше — так она совпадает с голосом
    static LYRICS_API = "https://lrclib.net/api";
    static MAX_CACHE = 60;

    static track = null;          // {key, title, artist, album, durationMs, playing, positionMs, updatedAt}
    static lyrics = new Map();    // key → {lines: [{ms, text}]} | {lines: []} (текста нет)
    static loading = new Set();
    static pollTimer = 0;
    static tickTimer = 0;
    static shownText = "";
    static pinned = false;

    static t = (key, fallback) => MESSAGES.mediaIsland?.[key] || fallback;
    static enabled = () => RxConfig.read(RxMediaIsland.CONFIG_KEY, true) !== false;
    static $island = () => $("[data-media-island]");

    // ---------- что играет ----------
    static poll = async () => {
        clearTimeout(RxMediaIsland.pollTimer);
        let next = RxMediaIsland.POLL_MS;
        if (!RxMediaIsland.enabled() || document.hidden) {
            RxMediaIsland.track = null;
            next = RxMediaIsland.IDLE_POLL_MS;
        } else {
            try {
                const data = await ipcRenderer.invoke("media-now-playing");
                RxMediaIsland.update(data);
                if (!data?.found) next = RxMediaIsland.IDLE_POLL_MS;
            } catch (_) {
                RxMediaIsland.track = null;
                next = RxMediaIsland.IDLE_POLL_MS;
            }
        }
        RxMediaIsland.render();
        RxMediaIsland.pollTimer = setTimeout(RxMediaIsland.poll, next);
    };

    static update = (data) => {
        if (!data?.found || !data.title) {
            RxMediaIsland.track = null;
            return;
        }
        const key = `${data.artist}\u0000${data.title}`.toLowerCase();
        RxMediaIsland.track = {
            key, title: String(data.title), artist: String(data.artist || ""), album: String(data.album || ""),
            durationMs: Number(data.durationMs) || 0, playing: data.playing === true,
            positionMs: Number(data.positionMs) || 0, updatedAt: Number(data.updatedAt) || Date.now()
        };
        if (!RxMediaIsland.lyrics.has(key) && !RxMediaIsland.loading.has(key)) RxMediaIsland.loadLyrics(RxMediaIsland.track);
    };

    // Позиция сейчас: Windows сообщает её на момент последнего изменения, дальше досчитываем сами
    static position = () => {
        const track = RxMediaIsland.track;
        if (!track) return 0;
        const position = track.playing ? track.positionMs + Math.max(0, Date.now() - track.updatedAt) : track.positionMs;
        return track.durationMs ? Math.min(position, track.durationMs) : position;
    };

    // ---------- текст песни ----------
    // «[01:02.50] строка» → {ms, text}; строки без времени отбрасываются
    static parseLrc = (text) => {
        const lines = [];
        for (const raw of String(text || "").split(/\r?\n/)) {
            const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)\]/g)];
            if (!stamps.length) continue;
            const words = raw.replace(/\[[^\]]*\]/g, "").trim();
            for (const stamp of stamps) {
                const ms = Math.round((Number(stamp[1]) * 60 + Number(stamp[2].replace(",", "."))) * 1000);
                if (Number.isFinite(ms)) lines.push({ms, text: words});
            }
        }
        return lines.sort((a, b) => a.ms - b.ms);
    };

    static loadLyrics = async (track) => {
        const key = track.key;
        RxMediaIsland.loading.add(key);
        let lines = [];
        try {
            const params = new URLSearchParams({track_name: track.title, artist_name: track.artist});
            if (track.album) params.set("album_name", track.album);
            if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));
            let data = null;
            try {
                data = await RxHttp.json(`${RxMediaIsland.LYRICS_API}/get?${params}`, {timeout: 8000});
            } catch (error) {
                if (error.status !== 404) throw error;
            }
            if (!data?.syncedLyrics) {
                const search = new URLSearchParams({track_name: track.title, artist_name: track.artist});
                const list = await RxHttp.json(`${RxMediaIsland.LYRICS_API}/search?${search}`, {timeout: 8000});
                data = Array.isArray(list) ? list.find(item => item?.syncedLyrics) || null : null;
            }
            if (data?.syncedLyrics && data.instrumental !== true) lines = RxMediaIsland.parseLrc(data.syncedLyrics);
        } catch (error) {
            RxCollector.writeLog(`MediaIsland: Lyrics failed [error=${error?.message || error}]`);
        } finally {
            RxMediaIsland.loading.delete(key);
        }
        RxMediaIsland.lyrics.set(key, {lines});
        if (RxMediaIsland.lyrics.size > RxMediaIsland.MAX_CACHE) RxMediaIsland.lyrics.delete(RxMediaIsland.lyrics.keys().next().value);
        RxMediaIsland.render();
    };

    // Строка для острова: текущая строка текста, а до первой строки и без текста — «Название — Исполнитель»
    static currentLine = () => {
        const track = RxMediaIsland.track;
        if (!track) return "";
        const fallback = track.artist ? `${track.title} — ${track.artist}` : track.title;
        const lines = RxMediaIsland.lyrics.get(track.key)?.lines || [];
        if (!lines.length) return fallback;
        const position = RxMediaIsland.position() + RxMediaIsland.LEAD_MS;
        let current = null;
        for (const line of lines) {
            if (line.ms > position) break;
            current = line;
        }
        if (!current) return fallback;
        return current.text || "♪";
    };

    // ---------- отрисовка ----------
    static render = () => {
        const $island = RxMediaIsland.$island();
        if (!$island.length) return;
        const track = RxMediaIsland.enabled() ? RxMediaIsland.track : null;
        $island.toggleClass("visible", Boolean(track));
        $island.toggleClass("paused", Boolean(track && !track.playing));
        $island.toggleClass("pinned", RxMediaIsland.pinned);
        if (!track) {
            RxMediaIsland.shownText = "";
            return;
        }
        $island.find("[data-mi-title]").text(track.title);
        $island.find("[data-mi-artist]").text(track.artist);
        const percent = track.durationMs ? Math.min(100, RxMediaIsland.position() / track.durationMs * 100) : 0;
        $island.find("[data-mi-progress]").css("width", `${percent}%`);
        const text = track.playing ? RxMediaIsland.currentLine() : RxMediaIsland.t("paused", "Пауза");
        if (text === RxMediaIsland.shownText) return;
        RxMediaIsland.shownText = text;
        const $line = $island.find("[data-mi-line]");
        // Смена строки — короткое затухание, без рывков
        $line.addClass("swap");
        setTimeout(() => {
            $line.text(text).removeClass("swap");
        }, RxConfig.read("disableAnimations", false) === true ? 0 : 140);
    };

    static init = () => {
        const $island = RxMediaIsland.$island();
        if (!$island.length) return;
        $island.on("click", () => {
            RxMediaIsland.pinned = !RxMediaIsland.pinned;
            RxMediaIsland.render();
        });
        // Тикер — только для строки и полосы, Windows опрашивается раз в секунду
        RxMediaIsland.tickTimer = setInterval(() => {
            if (RxMediaIsland.track && !document.hidden) RxMediaIsland.render();
        }, 200);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) RxMediaIsland.poll(); });
        $(document).on("change", '[data-setting="mediaIsland"] input', () => RxMediaIsland.poll());
        RxMediaIsland.poll();
    };
}

$(RxMediaIsland.init);
