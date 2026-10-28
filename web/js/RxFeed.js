// Лента с сайта (rxlauncher.xyz/api/feed): объявления админа и рекомендуемые серверы и сборки.
// Забирается без входа в аккаунт при запуске и раз в 20 минут; последняя лента хранится, чтобы работать без сети
class RxFeed {
    static CACHE_KEY = "feedCache";
    static SEEN_KEY = "seenAnnouncements";
    static HIDDEN_KEY = "hiddenAnnouncements";
    static INTERVAL = 20 * 60e3;
    static data = {announcements: [], servers: [], packs: []};

    static changed = () => document.dispatchEvent(new CustomEvent("rxFeedChanged"));
    static escape = (value) => RxDialog.escape(value);
    static t = (key) => MESSAGES.feed[key];

    static normalize = (raw) => ({
        announcements: (Array.isArray(raw?.announcements) ? raw.announcements : []).filter(item => Number.isInteger(item?.id) && typeof item.title === "string").slice(0, 10),
        servers: (Array.isArray(raw?.servers) ? raw.servers : []).filter(item => typeof item?.address === "string" && typeof item.title === "string").slice(0, 30),
        packs: (Array.isArray(raw?.packs) ? raw.packs : []).filter(item => /^[A-Za-z0-9_-]{2,64}$/.test(item?.project || "")).slice(0, 20)
    });

    static load = async () => {
        try {
            const data = await RxHttp.json(`${SITE_URL}/api/feed`, {timeout: 10000});
            RxFeed.data = RxFeed.normalize(data);
            RxConfig.write(RxFeed.CACHE_KEY, RxFeed.data);
        } catch (error) {
            RxCollector.writeLog(`Feed: Load failed [error=${error?.message || error}]`);
        }
        RxFeed.changed();
        RxFeed.notify();
        try {
            if (RxModals.isModalShown("servers")) RxServersUI.render();
        } catch (_) {}
    };

    // ---------- объявления ----------
    static visibleAnnouncements = () => {
        const hidden = new Set(RxConfig.read(RxFeed.HIDDEN_KEY, []));
        return RxFeed.data.announcements.filter(item => !hidden.has(item.id));
    };

    static hide = (id) => {
        const hidden = new Set(RxConfig.read(RxFeed.HIDDEN_KEY, []));
        hidden.add(id);
        // Храним только id ещё живых объявлений, чтобы список не рос
        const alive = new Set(RxFeed.data.announcements.map(item => item.id));
        RxConfig.write(RxFeed.HIDDEN_KEY, [...hidden].filter(item => alive.has(item)));
        RxFeed.render();
    };

    // Новое объявление — короткое уведомление один раз
    static notify = () => {
        const seen = new Set(RxConfig.read(RxFeed.SEEN_KEY, []));
        const fresh = RxFeed.visibleAnnouncements().filter(item => !seen.has(item.id));
        fresh.slice(0, 2).forEach(item => RxToasts.create(item.title, RxFeed.KIND_ICONS[item.kind] || "campaign", RxFeed.t("kinds")[item.kind] || RxFeed.t("kinds").info, item.kind === "warning" ? "warning" : "success"));
        RxConfig.write(RxFeed.SEEN_KEY, RxFeed.data.announcements.map(item => item.id));
    };

    static KIND_ICONS = {info: "campaign", update: "system_update", event: "celebration", warning: "priority_high"};

    // Карточки объявлений над лентой патчей на главной
    static render = () => {
        const $box = $("#home-announcements");
        if (!$box.length) return;
        const esc = RxFeed.escape;
        const items = RxFeed.visibleAnnouncements();
        $box.prop("hidden", !items.length).html(items.map(item => `<article class="feed-card" data-kind="${esc(item.kind)}" data-feed-id="${item.id}">
            <div class="feed-card-head">
                <span class="feed-kind"><span class="material-symbols-outlined">${RxFeed.KIND_ICONS[item.kind] || "campaign"}</span>${esc(RxFeed.t("kinds")[item.kind] || RxFeed.t("kinds").info)}</span>
                <button class="transparent feed-close" data-feed-hide title="${esc(RxFeed.t("hide"))}"><span class="material-symbols-outlined">close</span></button>
            </div>
            <strong>${esc(item.title)}</strong>
            ${item.text ? `<p>${esc(item.text)}</p>` : ""}
            ${item.link ? `<button class="feed-link" data-feed-link="${esc(item.link)}"><span>${esc(RxFeed.t("more"))}</span><span class="material-symbols-outlined">open_in_new</span></button>` : ""}
        </article>`).join(""));
    };

    // ---------- рекомендации ----------
    static recommendedServers = () => RxFeed.data.servers.map(item => ({
        id: `rec-${item.id}`,
        name: item.title,
        address: item.address,
        category: item.category || "other",
        flVersion: /^(vanilla|fabric|quilt|forge|neoforge)-[0-9]/i.test(item.version || "") ? item.version : "vanilla-1.21.4",
        description: item.text || "",
        recommended: true
    }));

    static recommendedPacks = () => RxFeed.data.packs;

    static init = () => {
        RxFeed.data = RxFeed.normalize(RxConfig.read(RxFeed.CACHE_KEY, null));
        RxFeed.render();
        document.addEventListener("rxFeedChanged", RxFeed.render);
        $(document).on("click", "#home-announcements [data-feed-hide]", function () {
            RxFeed.hide(Number($(this).closest("[data-feed-id]").attr("data-feed-id")));
        });
        $(document).on("click", "#home-announcements [data-feed-link]", function () { openExternal(this.dataset.feedLink); });
        RxFeed.load();
        setInterval(RxFeed.load, RxFeed.INTERVAL);
    };
}

$(RxFeed.init);
