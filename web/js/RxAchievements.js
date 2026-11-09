// Достижения аккаунта RxLauncher: часы в игре (10 / 100 / 1000), возраст аккаунта (1–8 лет) и награды от админа
// («Благодарность от админа», «Тестер+», «Тестер»). Считает сервер; здесь — карточка в профиле (вкладка «Друзья»),
// уведомление о новом достижении и переключатели наград в админке
class RxAchievements {
    static REFRESH_MS = 15 * 60 * 1000;
    static SEEN_KEY = "achievementsSeen";
    static ICONS = {play: "schedule", age: "cake", admin_thanks: "volunteer_activism", tester_plus: "science", tester: "bug_report"};
    static BADGES = ["admin_thanks", "tester_plus", "tester"];

    static list = [];
    static timer = 0;

    static t = (key, fallback = "") => MESSAGES.achievements?.[key] || fallback;
    static esc = (value) => RxDialog.escape(value);

    static years = (n) => {
        const forms = RxAchievements.t("yearForms", "год|года|лет").split("|");
        const mod10 = n % 10, mod100 = n % 100;
        const form = mod10 === 1 && mod100 !== 11 ? 0 : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 1 : 2;
        return `${n} ${forms[form] || forms[0]}`;
    };

    static number = (id) => Number(String(id).split("_")[1]) || 0;

    static icon = (item) => RxAchievements.ICONS[item.kind === "badge" ? item.id : item.kind] || "emoji_events";

    static name = (item) => {
        if (item.kind === "play") return RxAchievements.t("playName", "{0} часов в игре").replace("{0}", RxAchievements.number(item.id));
        if (item.kind === "age") return RxAchievements.t("ageName", "Аккаунту {0}").replace("{0}", RxAchievements.years(RxAchievements.number(item.id)));
        return RxAchievements.t(item.id, item.id);
    };

    static text = (item) => {
        if (item.kind === "play") return RxAchievements.t("playText", "Наиграть {0} часов с RxLauncher").replace("{0}", RxAchievements.number(item.id));
        if (item.kind === "age") return RxAchievements.t("ageText", "Аккаунту RxLauncher исполнилось {0}").replace("{0}", RxAchievements.years(RxAchievements.number(item.id)));
        return RxAchievements.t(`${item.id}Text`, "");
    };

    // Подпись под значком: коротко, чтобы влезло в плитку
    static short = (item) => {
        if (item.kind === "play") return RxAchievements.t("playShort", "{0} ч").replace("{0}", RxAchievements.number(item.id));
        if (item.kind === "age") return RxAchievements.years(RxAchievements.number(item.id));
        return RxAchievements.t(`${item.id}Short`, RxAchievements.name(item));
    };

    static load = async () => {
        if (typeof RxAccount === "undefined" || !RxAccount.isLoggedIn()) {
            RxAchievements.list = [];
            RxAchievements.render();
            return [];
        }
        try {
            const data = await RxAccount.call("account/achievements");
            RxAchievements.list = Array.isArray(data?.achievements) ? data.achievements : [];
            RxAchievements.render();
            RxAchievements.notifyNew();
        } catch (error) {
            RxCollector.writeLog(`Achievements: Load failed [error=${error?.code || error?.message || error}]`);
        }
        return RxAchievements.list;
    };

    // Новое достижение — уведомление (в первый раз только запоминаем, что уже есть)
    static notifyNew = () => {
        const userId = RxAccount.user?.id;
        if (!userId) return;
        const seenAll = RxConfig.read(RxAchievements.SEEN_KEY, {}) || {};
        const got = RxAchievements.list.filter(item => item.got).map(item => item.id);
        const seen = Array.isArray(seenAll[userId]) ? seenAll[userId] : null;
        if (seen) {
            got.filter(id => !seen.includes(id)).forEach(id => {
                const item = RxAchievements.list.find(entry => entry.id === id);
                RxToasts.create(RxAchievements.t("unlocked", "Новое достижение!"), RxAchievements.icon(item), RxAchievements.name(item), "success");
            });
        }
        RxConfig.write(RxAchievements.SEEN_KEY, {...seenAll, [userId]: got});
    };

    static tile = (item) => {
        const esc = RxAchievements.esc;
        const progress = item.kind === "play" && !item.got && item.target
            ? `<i class="fx-ach-bar"><i style="width:${Math.max(3, Math.min(100, item.progress / item.target * 100))}%"></i></i>` : "";
        const mark = item.kind === "age" ? `<b>${RxAchievements.number(item.id)}</b>` : "";
        return `<button type="button" class="fx-ach-tile${item.got ? " got" : ""} kind-${esc(item.kind)}" data-achievement="${esc(item.id)}" aria-label="${esc(RxAchievements.name(item))}">
            <span class="fx-ach-icon"><span class="material-symbols-outlined">${RxAchievements.icon(item)}</span>${mark}</span>
            <span class="fx-ach-name">${esc(RxAchievements.short(item))}</span>${progress}
        </button>`;
    };

    static render = () => {
        const $card = $("[data-achievements-card]");
        if (!$card.length) return;
        const list = RxAchievements.list;
        $card.prop("hidden", !list.length);
        $card.find("[data-achievements-count]").text(`${list.filter(item => item.got).length} / ${list.length}`);
        $card.find("[data-achievements]").html(list.map(RxAchievements.tile).join(""));
    };

    // Нажали на значок — что это за достижение и как его получить
    static details = (id) => {
        const item = RxAchievements.list.find(entry => entry.id === id);
        if (!item) return;
        const items = [];
        if (item.got && item.at) items.push({icon: "event", title: RxAchievements.t("gotAt", "Получено"), text: new Date(item.at).toLocaleDateString()});
        if (item.kind === "play" && !item.got) {
            items.push({icon: "hourglass_top", title: RxAchievements.t("progress", "Прогресс"),
                text: RxAchievements.t("progressText", "{0} из {1} ч").replace("{0}", item.progress).replace("{1}", item.target)});
        }
        if (item.kind === "badge" && !item.got) items.push({icon: "shield_person", title: RxAchievements.t("byAdmin", "Выдаёт администратор")});
        RxDialog.open({
            icon: RxAchievements.icon(item),
            title: RxAchievements.name(item),
            text: `${item.got ? RxAchievements.t("got", "Получено") : RxAchievements.t("locked", "Ещё не получено")} · ${RxAchievements.text(item)}`,
            items
        });
    };

    // Админка: награды, которые выдаёт админ (кнопки-переключатели в карточке игрока)
    static adminHtml = (achievements = []) => {
        const esc = RxAchievements.esc;
        const got = achievements.filter(item => item.got && item.kind !== "badge").map(item => RxAchievements.short(item));
        return `<div class="rxad-badges">${RxAchievements.BADGES.map(badge => {
            const item = achievements.find(entry => entry.id === badge) || {id: badge, kind: "badge", got: false, granted: false};
            const auto = item.got && !item.granted;
            return `<button type="button" class="transparent${item.got ? " on" : ""}" data-admin-badge="${esc(badge)}" data-granted="${item.granted ? 1 : 0}"${auto ? " disabled" : ""}>
                <span class="material-symbols-outlined">${RxAchievements.icon(item)}</span><span>${esc(RxAchievements.name(item))}</span>
                <span class="material-symbols-outlined">${item.got ? "check_circle" : "add_circle"}</span>
            </button>`;
        }).join("")}</div>${got.length ? `<div class="rxad-people">${got.map(name => `<span>${esc(name)}</span>`).join("")}</div>` : ""}`;
    };

    static bindAdmin = ($pane, userId, reload) => {
        $pane.find("[data-admin-badge]").on("click", async function () {
            const granted = this.dataset.granted !== "1";
            try {
                await RxAccount.call("admin/badge", {id: userId, badge: this.dataset.adminBadge, granted});
                reload();
            } catch (error) {
                RxToasts.create(RxAccount.errorText(error), "error", "", "error");
            }
        });
    };

    static init = () => {
        $(document).on("click", "[data-achievement]", function () { RxAchievements.details(this.dataset.achievement); });
        document.addEventListener("rxAccountChanged", () => RxAchievements.load());
        document.addEventListener("showModalEvent", event => {
            if (event.detail?.modal === "friends") RxAchievements.load();
        });
        RxAchievements.timer = setInterval(() => { if (!document.hidden || RxStarter.isRunning()) RxAchievements.load(); }, RxAchievements.REFRESH_MS);
        setTimeout(RxAchievements.load, 4000);
    };
}

$(RxAchievements.init);
