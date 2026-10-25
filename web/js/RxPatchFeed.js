// Лента патчей на главной: свежий патч крупно, остальные — компактным таймлайном
class RxPatchFeed {
    static FEATURED_CHANGES = 3;

    static init = () => {
        $("#news-open-history").on("click", () => RxChangelogUI.open());
        RxPatchFeed.render();
    };

    static render = () => {
        const [latest, ...older] = RxPatchNotes.getAll();
        const $featured = $("#home-patch-featured").empty();
        const $list = $("#home-patch-list").empty();
        if (!latest) return;

        const $meta = $("<div>").addClass("patch-meta").append(
            $("<span>").addClass("patch-version").text(`v${latest.version}`),
            $("<span>").addClass("patch-tag").text(latest.tag),
            $("<span>").addClass("patch-date").text(RxPatchNotes.formatDate(latest.date))
        );
        const $changes = $("<ul>").addClass("patch-changes");
        (latest.changes || []).slice(0, RxPatchFeed.FEATURED_CHANGES).forEach(change => {
            $changes.append($("<li>").text(change));
        });
        const $more = $("<button>").addClass("patch-more transparent")
            .append($("<span>").text(MESSAGES.changelog.open), $("<span>").addClass("material-symbols-outlined").text("arrow_forward"))
            .on("click", () => RxChangelogUI.openPatch(latest.id));
        $featured.attr("data-patch-id", latest.id)
            .append($meta, $("<h3>").addClass("patch-title").text(latest.title), $changes, $more);

        older.forEach(item => {
            const $row = $("<button>").addClass("patch-row").attr({"data-patch-id": item.id, title: item.summary})
                .on("click", () => RxChangelogUI.openPatch(item.id));
            $row.append(
                $("<span>").addClass("patch-dot"),
                $("<span>").addClass("patch-row-version").text(item.version),
                $("<span>").addClass("patch-row-title").text(item.title),
                $("<span>").addClass("patch-row-date").text(RxPatchFeed.shortDate(item.date))
            );
            $list.append($row);
        });
    };

    static shortDate = (value) => new Intl.DateTimeFormat(RxPatchNotes.locale(), {day: "numeric", month: "short"}).format(new Date(value));
}

$(RxPatchFeed.init);
