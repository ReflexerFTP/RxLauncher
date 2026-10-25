$(function () {
    $(document).on("showModalEvent", (e) => {
        if (e.originalEvent.detail.modal === "packs") {
            RxPacksUI.refreshDirectorySelect();
        }
    })

    $("#modal-packs .item.add button.install").click(async function () {
        RxPacksUI.setCurrentMode("modpacks");
        await RxPacksUI.setProvider(RxConfig.read("catalogProvider", "modrinth"));
        await RxPacksUI.reloadAll(true, true, true);
        RxModals.hideModal("packManager");
        RxModals.switchModal("installMods");
    })

    $("#modal-packs .item.add button.create").click(function () {
        RxPacksUI.setCurrentMode("modpacks");
        RxPacksUI.reloadAll(true, true, true);
        RxModals.showModal("createPack");
    })

    $("#modal-packs .item.add button.import").click(function () {
        RxPacks.importModpack();
    })
})
