class RxChangelogUI {
    static returnModal = "content";
    static selectedPatch = "";

    static init = () => {
        $(document).on("showModalEvent", (event) => {
            if (event.originalEvent?.detail?.modal === "changelog") RxChangelogUI.render();
        });
        $("#modal-changelog .changelog-rail").on("click", ".changelog-rail-item", function () {
            RxChangelogUI.select($(this).attr("data-patch-id"));
        });
        $("#modal-changelog [data-changelog-step]").on("click", function () {
            const target = $(this).attr("data-target");
            if (target) RxChangelogUI.select(target);
        });
        $(document).on("keydown", (e) => {
            if (RxModals.currentModalName() !== "changelog" || $(e.target).is("input, textarea")) return;
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                $(`#modal-changelog [data-changelog-step="${e.key === "ArrowUp" ? "newer" : "older"}"]`).trigger("click");
            }
        });
    };

    static open = (patchId = "") => {
        const current = RxModals.currentModalName();
        if (current !== "changelog") RxChangelogUI.returnModal = current || "content";
        RxChangelogUI.selectedPatch = patchId;
        return RxModals.switchModal("changelog");
    };

    static openPatch = (patchId) => RxChangelogUI.open(patchId);

    static goBack = () => {
        const target = RxChangelogUI.returnModal && RxChangelogUI.returnModal !== "changelog"
            ? RxChangelogUI.returnModal
            : "content";
        RxChangelogUI.selectedPatch = "";
        return RxModals.switchModal(target);
    };

    static select = (patchId) => {
        RxChangelogUI.selectedPatch = patchId;
        RxChangelogUI.render();
        const active = $("#modal-changelog .changelog-rail-item.active")[0];
        if (active) active.scrollIntoView({block: "nearest"});
    };

    static render = () => {
        const items = RxPatchNotes.getAll();
        if (items.length === 0) return;
        let index = items.findIndex(item => item.id === RxChangelogUI.selectedPatch);
        if (index < 0) index = 0;
        const item = items[index];
        RxChangelogUI.selectedPatch = item.id;

        // Лента версий
        const $rail = $("#modal-changelog .changelog-rail").empty();
        items.forEach((patch, patchIndex) => {
            const $row = $("<button>").attr({type: "button", "data-patch-id": patch.id})
                .addClass("changelog-rail-item")
                .toggleClass("active", patchIndex === index);
            const $head = $("<span>").addClass("changelog-rail-head")
                .append($("<span>").addClass("changelog-rail-version").text(`v${patch.version}`));
            if (patchIndex === 0) $head.append($("<span>").addClass("changelog-rail-latest").text(MESSAGES.changelog.current));
            $row.append(
                $("<span>").addClass("changelog-rail-dot"),
                $("<span>").addClass("changelog-rail-copy").append(
                    $head,
                    $("<span>").addClass("changelog-rail-title").text(patch.title),
                    $("<span>").addClass("changelog-rail-date").text(RxPatchNotes.formatDate(patch.date))
                )
            );
            $rail.append($row);
        });

        // Подробности
        const $detail = $("#modal-changelog .changelog-detail");
        $detail.find("[data-changelog-image]").attr("src", item.image);
        $detail.find("[data-changelog-tag]").text(item.tag);
        $detail.find("[data-changelog-version]").text(`v${item.version}`);
        $detail.find("[data-changelog-date]").text(RxPatchNotes.formatDate(item.date));
        $detail.find("[data-changelog-title]").text(item.title);
        $detail.find("[data-changelog-summary]").text(item.summary);
        const $changes = $detail.find("[data-changelog-changes]").empty();
        (Array.isArray(item.changes) ? item.changes : []).forEach(change => {
            $changes.append($("<li>").text(change));
        });

        // Соседние версии
        [["newer", items[index - 1]], ["older", items[index + 1]]].forEach(([step, neighbour]) => {
            const $button = $detail.find(`[data-changelog-step="${step}"]`);
            $button.prop("disabled", !neighbour)
                .attr("data-target", neighbour ? neighbour.id : "")
                .find("[data-step-label]").text(neighbour ? `v${neighbour.version} · ${neighbour.title}` : "—");
        });
        $detail.scrollTop(0);
    };
}

$(RxChangelogUI.init);
