let packs__firstAppear = true;
let packs__searchTimer = false;

function packsReloadFromSearch() {
    if (packs__searchTimer !== false) {
        clearTimeout(packs__searchTimer);
        packs__searchTimer = false;
    }
    RxPacksUI.reloadAll(true, false, true);
}

$(function () {
    $(document).on("showModalEvent", async (e) => {
        if (e.originalEvent.detail.modal === "installMods") {
            await RxPacksUI.setProvider(RxConfig.read("catalogProvider", "modrinth"));
            if (packs__firstAppear === true) {
                packs__firstAppear = false;
                RxPacksUI.reloadAll(true);
            } else {
                RxPacksUI.refreshDirectorySelect();
            }
        }
    })

    $("#modal-installMods input.search").on("input", function () {
        if (packs__searchTimer !== false) {
            clearTimeout(packs__searchTimer);
        }
        packs__searchTimer = setTimeout(packsReloadFromSearch, 350);
    }).on("keydown", function (event) {
        if (event.key === "Enter") {
            packsReloadFromSearch();
        }
    })

    $("#modal-installMods #packs_dirList").on("change", function () {
        RxPacksUI.reloadAll(true);
    })

    $("#modal-installMods .catalog-sort").on("change", function () {
        RxPacksUI.setSort($(this).val());
        RxPacksUI.reloadAll(true, false, true);
    })

    $("#modal-installMods .catalog-provider").on("click", async function () {
        if ($(this).hasClass("active")) return;
        await RxPacksUI.setProvider($(this).data("provider"));
        await RxPacksUI.reloadAll(true, true, true);
    })

    $("#modal-installMods .curseforge-auth__save").on("click", () => RxCurseForge.saveApiKey());
    $("#modal-installMods .curseforge-api-key").on("keydown", function (event) {
        if (event.key === "Enter") RxCurseForge.saveApiKey();
    });
    $("#modal-installMods .curseforge-auth__clear").on("click", () => RxCurseForge.clearApiKey());

    // Прогрузка при скролле
    $("#modal-installMods .packs-wrapper").scroll(function () {
        let wrapper = $(this)[0];
        if (wrapper.offsetHeight >= wrapper.scrollHeight || packs_scrollIsLoading || !packs_hasMore) {
            return false;
        }
        if (wrapper.offsetHeight + wrapper.scrollTop >= wrapper.scrollHeight - 80) {
            packs_scrollIsLoading = true;
            RxPacksUI.loadMore();
            return true;
        }
    });
})

// Переключение табов
$("#modal-installMods .tabs.sub .tab").click(function () {
    if ($(this).hasClass("active")) {
        return;
    }

    $("#modal-installMods .tabs.sub .tab.active").removeClass("active");
    $(this).addClass("active");
    let tabName = $(this).data("tab");

    let tabIcon = $(this).find(".material-symbols-outlined").html();
    let tabText = $(this).find("span:not(.material-symbols-outlined)").text();

    $("#packs_currentSection span:not(.material-symbols-outlined)").text(tabText);
    $("#packs_currentSection .material-symbols-outlined").html(tabIcon);

    RxPacksUI.setCurrentMode(tabName);
    RxPacksUI.reloadAll(true);
})
