// «Остров» над лаунчером (как Dynamic Island на iPhone): если в Spotify играет музыка, по центру шапки — текущая
// строка текста песни, при наведении — название, исполнитель и прогресс. Что играет, ядро узнаёт у Windows
// (media.rs, без входа в Spotify), синхронизированный текст — с открытого сервиса LRCLIB.
// Смену трека, паузу и перемотку ядро сообщает событием (media-changed) — остров обновляется сразу; редкий опрос
// остаётся на случай, если события Windows недоступны. Выключается в настройках («Остров Spotify»).
// Пока окно скрыто (идёт игра), ничего не опрашивается
class RxMediaIsland {
    static CONFIG_KEY = "mediaIsland";
    static POLL_MS = 2000;
    static IDLE_POLL_MS = 5000;   // Spotify не запущен — спрашиваем реже
    static EVENT_DELAY_MS = 120;  // события Windows приходят пачкой — опрашиваем один раз после последнего
    static LYRICS_DELAY_MS = 600; // текст ищем, когда трек продержался — при быстром листании запросов нет
    static LEAD_MS = 250;         // строку показываем чуть раньше — так она совпадает с голосом
    static TICK_MS = 250;
    static LYRICS_API = "https://lrclib.net/api";
    static MAX_CACHE = 60;

    static track = null;          // {key, title, artist, album, durationMs, playing, positionMs, updatedAt}
    static lyrics = new Map();    // key → {lines: [{ms, text}]} | {lines: []} (текста нет)
    static lyricsTimer = 0;
    static lyricsAbort = null;    // запрос текста для текущего трека; при смене трека отменяется
    static pollTimer = 0;
    static eventTimer = 0;
    static polling = false;
    static repoll = false;
    static generation = 0;
    static lastRead = 0;
    static tickTimer = 0;
    static swapTimer = 0;
    static shown = {visible: null, paused: null, pinned: null, title: null, artist: null, progress: -1, text: ""};
    static pinned = false;

    static t = (key, fallback) => MESSAGES.mediaIsland?.[key] || fallback;
    static enabled = () => RxConfig.read(RxMediaIsland.CONFIG_KEY, true) !== false;
    static $island = () => $("[data-media-island]");

    // ---------- что играет ----------
    // Один запрос за раз: событие во время опроса — ещё один опрос сразу после него
    static poll = async () => {
        if (document.hidden || !RxMediaIsland.enabled()) return;
        if (RxMediaIsland.polling) {
            RxMediaIsland.repoll = true;
            return;
        }
        RxMediaIsland.polling = true;
        const generation = RxMediaIsland.generation;
        clearTimeout(RxMediaIsland.pollTimer);
        let next = RxMediaIsland.POLL_MS;
        try {
            const data = await ipcRenderer.invoke("media-now-playing").catch(() => ({unavailable: true}));
            if (generation === RxMediaIsland.generation && !document.hidden && RxMediaIsland.enabled()) {
                if (data?.unavailable) {
                    if (Date.now() - RxMediaIsland.lastRead > 8000) RxMediaIsland.update(null);
                } else {
                    RxMediaIsland.lastRead = Date.now();
                    RxMediaIsland.update(data);
                    if (!data?.found) next = RxMediaIsland.IDLE_POLL_MS;
                }
                RxMediaIsland.render();
            }
        } finally {
            RxMediaIsland.polling = false;
            if (RxMediaIsland.repoll) next = RxMediaIsland.EVENT_DELAY_MS;
            RxMediaIsland.repoll = false;
            if (!document.hidden && RxMediaIsland.enabled()) RxMediaIsland.pollTimer = setTimeout(RxMediaIsland.poll, next);
        }
    };

    static onMediaEvent = () => {
        if (document.hidden || !RxMediaIsland.enabled() || RxMediaIsland.eventTimer) return;
        RxMediaIsland.eventTimer = setTimeout(() => {
            RxMediaIsland.eventTimer = 0;
            RxMediaIsland.poll();
        }, RxMediaIsland.EVENT_DELAY_MS);
    };

    static update = (data, now = Date.now()) => {
        const previous = RxMediaIsland.track;
        if (!data?.found || !data.title) {
            RxMediaIsland.track = null;
            RxMediaIsland.cancelLyrics();
            return;
        }
        const key = `${data.artist}\u0000${data.title}`.toLowerCase();
        const samplePosition = Math.max(0, Number(data.positionMs) || 0);
        const sampleTime = Math.max(0, Math.min(now, Number(data.updatedAt) || 0));
        let positionMs = samplePosition;
        let updatedAt = sampleTime || now;
        const sameTrack = previous?.key === key;
        let ignoreThrough = sameTrack ? previous.ignoreThrough : 0;
        // Трек только что сменился, а Windows ещё отдаёт время прошлого — считаем, что новый начался сейчас
        if (previous && !sameTrack && sampleTime && now - sampleTime > 1500) {
            positionMs = 0;
            updatedAt = now;
            ignoreThrough = sampleTime;
        } else if (sameTrack && ((ignoreThrough && sampleTime <= ignoreThrough)
            || (previous.sampleTime === sampleTime && previous.samplePosition === samplePosition))) {
            positionMs = previous.playing === (data.playing === true) ? previous.positionMs : RxMediaIsland.position(now);
            updatedAt = previous.playing === (data.playing === true) ? previous.updatedAt : now;
        }
        RxMediaIsland.track = {
            key, title: String(data.title), artist: String(data.artist || ""), album: String(data.album || ""),
            durationMs: Math.max(0, Number(data.durationMs) || 0), playing: data.playing === true,
            positionMs, updatedAt, sampleTime, samplePosition, ignoreThrough
        };
        if (previous?.key !== key) RxMediaIsland.scheduleLyrics(RxMediaIsland.track);
    };

    // Позиция сейчас: Windows сообщает её на момент последнего изменения, дальше досчитываем сами
    static position = (now = Date.now()) => {
        const track = RxMediaIsland.track;
        if (!track) return 0;
        const position = track.playing ? track.positionMs + Math.max(0, now - track.updatedAt) : track.positionMs;
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

    static cancelLyrics = () => {
        clearTimeout(RxMediaIsland.lyricsTimer);
        RxMediaIsland.lyricsAbort?.abort();
        RxMediaIsland.lyricsAbort = null;
    };

    static scheduleLyrics = (track) => {
        RxMediaIsland.cancelLyrics();
        if (RxMediaIsland.lyrics.has(track.key)) return;
        RxMediaIsland.lyricsTimer = setTimeout(() => {
            if (RxMediaIsland.track?.key === track.key) RxMediaIsland.loadLyrics(track);
        }, RxMediaIsland.LYRICS_DELAY_MS);
    };

    static loadLyrics = async (track) => {
        const key = track.key;
        const abort = new AbortController();
        RxMediaIsland.lyricsAbort = abort;
        const request = (url) => RxHttp.json(url, {timeout: 8000, signal: abort.signal, maxBytes: 2 * 1024 * 1024});
        let lines = [];
        try {
            const params = new URLSearchParams({track_name: track.title, artist_name: track.artist});
            if (track.album) params.set("album_name", track.album);
            if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));
            let data = null;
            try {
                data = await request(`${RxMediaIsland.LYRICS_API}/get?${params}`);
            } catch (error) {
                if (error.status !== 404) throw error;
            }
            if (!data?.syncedLyrics) {
                const search = new URLSearchParams({track_name: track.title, artist_name: track.artist});
                const list = await request(`${RxMediaIsland.LYRICS_API}/search?${search}`);
                data = Array.isArray(list) ? list.find(item => item?.syncedLyrics) || null : null;
            }
            if (data?.syncedLyrics && data.instrumental !== true) lines = RxMediaIsland.parseLrc(data.syncedLyrics);
        } catch (error) {
            // Трек переключили — запрос отменён, ничего не запоминаем: вернутся к треку — поищем снова
            if (abort.signal.aborted) return;
            RxCollector.writeLog(`MediaIsland: Lyrics failed [error=${error?.message || error}]`);
            if (RxMediaIsland.track?.key === key) {
                RxMediaIsland.lyricsTimer = setTimeout(() => {
                    if (RxMediaIsland.track?.key === key) RxMediaIsland.loadLyrics(track);
                }, 30000);
            }
            return;
        } finally {
            if (RxMediaIsland.lyricsAbort === abort) RxMediaIsland.lyricsAbort = null;
        }
        if (abort.signal.aborted) return;
        RxMediaIsland.lyrics.set(key, {lines});
        if (RxMediaIsland.lyrics.size > RxMediaIsland.MAX_CACHE) RxMediaIsland.lyrics.delete(RxMediaIsland.lyrics.keys().next().value);
        if (RxMediaIsland.track?.key === key) RxMediaIsland.render();
    };

    // Строка для острова: текущая строка текста, а до первой строки и без текста — «Название — Исполнитель»
    static currentLine = () => {
        const track = RxMediaIsland.track;
        if (!track) return "";
        const fallback = track.artist ? `${track.title} — ${track.artist}` : track.title;
        const lines = RxMediaIsland.lyrics.get(track.key)?.lines || [];
        if (!lines.length) return fallback;
        const position = RxMediaIsland.position() + RxMediaIsland.LEAD_MS;
        // Строки отсортированы — двоичный поиск последней начавшейся
        let low = 0, high = lines.length - 1, found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (lines[middle].ms <= position) { found = middle; low = middle + 1; } else high = middle - 1;
        }
        if (found < 0) return fallback;
        return lines[found].text || "♪";
    };

    // ---------- отрисовка ----------
    // Страница меняется, только если что-то действительно изменилось: тикер не трогает DOM каждые 250 мс
    static render = () => {
        const $island = RxMediaIsland.$island();
        if (!$island.length) return;
        const shown = RxMediaIsland.shown;
        const track = RxMediaIsland.enabled() ? RxMediaIsland.track : null;
        const set = (name, value, apply) => {
            if (shown[name] === value) return;
            shown[name] = value;
            apply(value);
        };
        set("visible", Boolean(track), value => $island.toggleClass("visible", value));
        set("paused", Boolean(track && !track.playing), value => $island.toggleClass("paused", value));
        set("pinned", RxMediaIsland.pinned, value => $island.toggleClass("pinned", value));
        if (!track) {
            shown.text = "";
            return;
        }
        set("title", track.title, value => $island.find("[data-mi-title]").text(value));
        set("artist", track.artist, value => $island.find("[data-mi-artist]").text(value));
        // Полоса — через transform: без пересчёта раскладки шапки
        const progress = track.durationMs ? Math.round(Math.min(1, RxMediaIsland.position() / track.durationMs) * 1000) / 1000 : 0;
        set("progress", progress, value => $island.find("[data-mi-progress]").css("transform", `scaleX(${value})`));
        const text = track.playing ? RxMediaIsland.currentLine() : RxMediaIsland.t("paused", "Пауза");
        if (text === shown.text) return;
        shown.text = text;
        const $line = $island.find("[data-mi-line]");
        // Смена строки — короткое затухание; новая смена отменяет незаконченную, чтобы строки не путались
        clearTimeout(RxMediaIsland.swapTimer);
        if (RxConfig.read("disableAnimations", false) === true) {
            $line.text(text).removeClass("swap");
            return;
        }
        $line.addClass("swap");
        RxMediaIsland.swapTimer = setTimeout(() => $line.text(shown.text).removeClass("swap"), 140);
    };

    static tick = () => {
        if (RxMediaIsland.track && !document.hidden) RxMediaIsland.render();
    };

    static syncActivity = () => {
        RxMediaIsland.generation++;
        clearTimeout(RxMediaIsland.pollTimer);
        clearTimeout(RxMediaIsland.eventTimer);
        clearInterval(RxMediaIsland.tickTimer);
        RxMediaIsland.eventTimer = 0;
        RxMediaIsland.repoll = false;
        if (document.hidden || !RxMediaIsland.enabled()) {
            RxMediaIsland.update(null);
            RxMediaIsland.render();
            return;
        }
        RxMediaIsland.tickTimer = setInterval(RxMediaIsland.tick, RxMediaIsland.TICK_MS);
        RxMediaIsland.poll();
    };

    static init = () => {
        const $island = RxMediaIsland.$island();
        if (!$island.length) return;
        $island.on("click", () => {
            RxMediaIsland.pinned = !RxMediaIsland.pinned;
            RxMediaIsland.render();
        });
        // Тикер — только для строки и полосы
        ipcRenderer.on("media-changed", RxMediaIsland.onMediaEvent);
        document.addEventListener("visibilitychange", RxMediaIsland.syncActivity);
        $(document).on("change", '[data-setting="mediaIsland"] input', RxMediaIsland.syncActivity);
        RxMediaIsland.syncActivity();
    };
}

$(RxMediaIsland.init);
