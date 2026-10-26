let packman__currentMode = "mods";
let packman__currentModpack = "";

const packManagerEscape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
$(function () {
    $("#modal-packManager").on("click", "[data-pack-remove]", function () { RxPackManagerUI.removeFile(this); });
    $("#modal-packManager").on("change", "[data-pack-toggle]", function () { RxPackManagerUI.toggleMod(this); });
    $("#modal-packManager .tabs .tab").click(function () {
        if (!$(this).hasClass("active")) {
            $("#modal-packManager .tabs .tab.active").removeClass("active");
            $(this).addClass("active");

            packman__currentMode = $(this).data("tab");

            if (packman__currentMode === "updates" && mods__currentModpackId !== packman__currentModpack.id) {
                RxModsUpdater.checkUpdates();
            }

            let $tab = $(`#modal-packManager .layout-tab[data-tab="${packman__currentMode}"]`);
            $("#modal-packManager .layout-tab.active").removeClass("active");
            $tab.addClass("active");
            animateCSSNode($tab[0], "fadeIn");

            // Анимация плашки с каждой настройкой
            if (RxConfig.read("disableAnimations", false) !== true) {
                $tab.find(".item").each(function (index) {
                    $(this).css("opacity", 0);
                    setTimeout(() => {
                        animateCSSNode($(this)[0], "fadeIn").then(() => {
                            $(this).css("opacity", 1);
                        })
                    }, 45 * index)
                })
            }

            RxPackManagerUI.reloadAll(false);
        }
    })

    // Установить из репозитория
    $("#modal-packManager button.install").click(async function () {
        $("#modal-installMods .search").val("");
        RxPacksUI.refreshDirectorySelect();
        $(`#modal-installMods #packs_dirList`).val(packman__currentModpack.id);
        RxPacksUI.setCurrentMode(packman__currentMode);
        await RxPacksUI.setProvider(RxConfig.read("catalogProvider", "modrinth"));
        await RxPacksUI.reloadAll(true, true, true);
        RxModals.hideModal("packManager");
        RxModals.switchModal("installMods");
    })

    // Выбрать файл
    $("#modal-packManager button.add").click(function () {
        let properties = {
            filters: [{name: "Zip file", extensions: ["zip"]}]
        }
        if (packman__currentMode === "mods") {
            properties = {
                filters: [{name: "Jar file", extensions: ["jar"]}]
            }
        }
        ipcRenderer.invoke("open-dialog", properties).then(result => {
            if (result === false) {
                return;
            }
            let fileName = path.basename(result[0]);
            if (packman__currentMode !== "worlds") {
                let fileNewPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, packman__currentMode, fileName);
                if (!fs.existsSync(path.dirname(fileNewPath))) {
                    fs.mkdirSync(path.dirname(fileNewPath));
                }
                fsExtra.moveSync(result[0], fileNewPath);
                RxToasts.create(fileName, "download_done", MESSAGES.packManager.installed);
                return RxPackManagerUI.reloadAll();
            } else {
                let savesDirectory = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, "saves");
                if (!fs.existsSync(savesDirectory)) {
                    fs.mkdirSync(savesDirectory);
                }
                RxWorldsManager.installFromZip(savesDirectory, result[0]).then(result => {
                    if (!result) {
                        RxToasts.create(fileName, "error", MESSAGES.packManager.failedWorld);
                    } else {
                        RxToasts.create(fileName, "download_done", MESSAGES.packManager.successWorld);
                    }
                    return RxPackManagerUI.loadWorldsList();
                }).catch(error => RxToasts.create(fileName, "error", error.message));
            }
        })
    })
})

class RxPackManagerUI {
    // Перезагрузить всё
    static reloadAll = (reloadLists = true) => {
        if (packman__currentMode === "worlds") {
            $("#modal-packManager .tabs button.install").hide();
        } else {
            $("#modal-packManager .tabs button.install").show();
        }
        if (reloadLists) {
            RxPackManagerUI.loadModsList();
            RxPackManagerUI.loadWorldsList();
            RxPackManagerUI.loadShadersList();
            setTimeout(() => {
                RxPackManagerUI.loadRPList();
            }, 250);
        }
    }

    // Загрузить список ресурс-паков в UI
    static loadRPList = () => {
        let $rpList = $("#modal-packManager .layout-tab .rps-list");
        let rpsPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, "resourcepacks");
        if (!fs.existsSync(rpsPath)) {
            return false;
        }
        let rpList = fs.readdirSync(rpsPath);

        let currentRp = -1;

        $rpList.html("");
        loadNextRp();

        function loadNextRp() {
            currentRp++;
            if (typeof rpList[currentRp] !== "undefined") {
                let rpFullPath = path.join(rpsPath, rpList[currentRp]);
                if (fs.existsSync(rpFullPath) && (path.parse(rpFullPath).ext === ".zip")) {
                    RxAssetsParsers.readResourcePackV2(rpFullPath).then(result => {
                        let icon = "assets/modIcon.webp";
                        let description = "";
                        if (result !== false) {
                            icon = "data:image/png;base64," + result.icon;
                            description = RxUtils.removeColorsFromString(result.mcmeta.description);
                        }
                        $rpList.append(`<div data-filename="${packManagerEscape(rpList[currentRp])}" class='item custom-select icon-and-description'>
                    <img class="icon" src="${packManagerEscape(icon)}" />
                    <span class="title">${packManagerEscape(path.parse(rpList[currentRp]).base)}</span>
                    ${description !== "" ? `<span class="description">${packManagerEscape(description)}</span>` : ""}
                    <button class="square small button" data-pack-remove>
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    </div>`);
                        loadNextRp();
                    })
                }
            }
        }
    }

    // Загрузить список модов в UI
    static loadModsList = () => {
        let $modsList = $("#modal-packManager .layout-tab .mods-list");
        let modsPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id);
        if (!fs.existsSync(modsPath)) {
            return false;
        }
        let modList = (packman__currentModpack.files || []).filter(file => file.path?.startsWith("mods/"));
        let modsPathFull = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, "mods");
        if (!fs.existsSync(modsPathFull)) {
            return false;
        }
        let modList2 = fs.readdirSync(modsPathFull);
        modList2.forEach((item) => {
            if (!modList.some(file => file.path === "mods/" + item)) modList.push({path: "mods/" + item});
        })
        let currentMod = -1;

        $modsList.html("");
        loadNextMod();

        function loadNextMod() {
            currentMod++;
            if (typeof modList[currentMod] !== "undefined" && modList[currentMod].path.indexOf("mods/") !== -1) {
                let modFullPath = path.join(modsPath, modList[currentMod].path);
                if (!fs.existsSync(modFullPath)) {
                    $modsList.append(`<div data-filename="${packManagerEscape(modList[currentMod].path)}" class='item custom-select icon-and-description'>
                    <img class="icon" src="assets/modIcon.webp" />
                    <div class="title flex flex-gap-4 flex-align-center">
                        <span>${packManagerEscape(path.basename(modList[currentMod].path))}</span>
                    </div>
                    </div>`);
                    return loadNextMod();
                }
                if (fs.existsSync(modFullPath) && (path.parse(modFullPath).ext === ".jar" || path.parse(modFullPath).ext === ".dis")) {
                    RxAssetsParsers.readModInfo(modFullPath).then(result => {
                        let icon = "assets/modIcon.webp";
                        let description = "";
                        let title = path.parse(modList[currentMod].path).base;
                        let titleChips = "";
                        let $switch = `<label class="switch">
        <input type="checkbox" checked data-pack-toggle>
        <span class="inner"></span>
    </label>`;
                        if (path.parse(modFullPath).ext === ".dis") {
                            $switch = $switch.replace(" checked", "");
                        }
                        if (result !== false) {
                            icon = "data:image/png;base64," + result.icon;
                            if (!result.icon) {
                                icon = "assets/modIcon.webp";
                            }
                            description = RxUtils.removeColorsFromString(result.description);
                            title = result.name;
                            let authorsList = [];
                            if (typeof result.authors === "string") {
                                authorsList = result.authors;
                            } else if (Array.isArray(result.authors)) {
                                result.authors.forEach((author) => {
                                    authorsList.push(author?.name || author);
                                })
                                authorsList = authorsList.join(" ,");
                            }
                            authorsList.length === 0 ? authorsList = "" : authorsList;

                            titleChips = `<div class="chip small">${packManagerEscape(result.version)}</div>
                            <div class="chip small">${packManagerEscape(authorsList)}</div>`;
                        }
                        $modsList.append(`<div data-filename="${packManagerEscape(modList[currentMod].path)}" class='item custom-select icon-and-description'>
                    <img class="icon" src="${packManagerEscape(icon)}" />
                    ${$switch}
                    <div class="title flex flex-gap-4 flex-align-center">
                        <span>${packManagerEscape(title)}</span>
                        ${titleChips}
                    </div>
                    ${description !== "" ? `<span class="description">${packManagerEscape(description)}</span>` : ""}
                    <button class="square small button" data-pack-remove>
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    </div>`);
                        loadNextMod();
                    })
                } else {
                    loadNextMod();
                }
            }
        }
    }

    // Загрузить список миров в UI
    static loadWorldsList = () => {
        let $worldsList = $("#modal-packManager .layout-tab .worlds-list");
        let worldsPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, "saves");
        if (!fs.existsSync(worldsPath)) {
            return false;
        }
        $worldsList.html("");
        RxWorldsManager.savesFromDirectory(worldsPath).then(result => {
            if (result !== false) {
                result.forEach(item => {
                    let icon = "assets/modIcon.webp";
                    if (item.icon !== false) {
                        icon = item.icon;
                    }
                    $worldsList.append(`<div data-filename="${packManagerEscape(item.path)}" class='item custom-select icon-and-description'>
                    <img class="icon" src="${packManagerEscape(icon)}" />
                    <span class="title">${packManagerEscape(item.name)}</span>
                    <div class="description flex flex-align-center flex-gap-8">
                        <span>${packManagerEscape(MESSAGES.packManager.gamemodes[item.gamemode])}</span>
                        <div class="microdot"><div class="dot"></div></div>
                        <span>${packManagerEscape(MESSAGES.packManager.difficulty[item.difficulty])}</span>
                        <div class="microdot"><div class="dot"></div></div>
                        <span>${packManagerEscape(item.version)}</span>
                    </div>
                    <button class="square small button" data-pack-remove>
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    </div>`);
                })
            }
        });
    }

    // Загрузить список шейдеров
    static loadShadersList = () => {
        let $list = $("#modal-packManager .layout-tab .shaders-list");
        let shadersPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, "shaderpacks");
        if (!fs.existsSync(shadersPath)) {
            return false;
        }
        let shadersList = fs.readdirSync(shadersPath);
        $list.html("");
        shadersList.forEach(item => {
            $list.append(`<div data-filename="${packManagerEscape(item)}" class='item custom-select icon-and-description'>
                    <img class="icon" src="assets/modIcon.webp" />
                    <span class="title">${packManagerEscape(path.parse(item).base)}</span>
                    <button class="square small button" data-pack-remove>
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                    </div>`);
        })
    }

    // Загрузить иконку модпака
    static loadModpackIcon = (manifest) => {
        if (manifest.icon === "pack") {
            manifest.icon = path.join(GAME_DATA, "modpacks", manifest.id, "icon.png");
        }
        $("#modal-packManager .title-wrapper img.icon").attr("src", manifest.icon || "assets/icon.png");
        return true;
    }

    // Загрузить пак в модальное окно
    static loadPackByManifest = (manifest) => {
        packman__currentModpack = manifest;
        // Название и иконка
        RxPackManagerUI.loadModpackIcon(manifest);
        let versionDisplayName = RxVersionsManager.versionToDisplayName(manifest.baseVersion.full);
        $("#modal-packManager .title-wrapper .title").text(manifest.displayName);
        $("#modal-packManager .title-wrapper .description").text(versionDisplayName);

        // Бинды кнопок
        $("#modal-packManager .title-wrapper button").off("click");
        $("#modal-packManager .title-wrapper button.delete").click(() => {
            RxModals.hideModal("packManager");
            RxFlyout.setText(MESSAGES.packManager.deleting);
            RxFlyout.changeMode("spinner").then(() => {
                let modpackPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id);
                fsExtra.remove(modpackPath, (err) => {
                    if (err) return console.error(err);
                    RxFlyout.changeMode("idle");
                    RxPacksUI.refreshDirectorySelect();
                    RxToasts.create(MESSAGES.packManager.deleted, "delete", packman__currentModpack.displayName);
                });
            });
        })
        $("#modal-packManager .title-wrapper button.icon").click(() => {
            RxPacks.changePackIcon(packman__currentModpack.id);
        })
        $("#modal-packManager .title-wrapper button.export").click(() => {
            RxPacks.exportModpack(packman__currentModpack.id);
        })
        $("#modal-packManager .title-wrapper button.folder").click(() => {
            let folderPath = path.join(GAME_DATA, "modpacks", manifest.id);
            openExternal(folderPath);
        })
        $("#modal-packManager .title-wrapper button.play").click(() => {
            RxStarter.simpleStart("pack-" + manifest.id);
            RxModals.hideModal("packManager");
        })
        RxPackManagerUI.reloadAll();
        return true;
    }

    // Загрузить пак и показать окно
    static loadAndShow = async (packId) => {
        if (!RxPacks.isModpackExists(packId)) {
            return false;
        }

        let modpackManifest = RxPacks.getModpackManifest(packId);
        RxPackManagerUI.loadPackByManifest(modpackManifest);
        await RxModals.showModal("packManager");
        return true;
    }

    // Удалить файл по кнопке
    static removeFile = (elem) => {
        const filename = String($(elem).parent().data("filename") || "");
        const directory = path.resolve(GAME_DATA, "modpacks", packman__currentModpack.id, packman__currentMode === "worlds" ? "saves" : packman__currentMode);
        const fullPath = path.resolve(directory, packman__currentMode === "worlds" ? filename : path.basename(filename));
        if (!fullPath.startsWith(directory + path.sep)) return false;
        if (packman__currentMode === "worlds") {
            fsExtra.remove(fullPath).then(() => { $(elem).parent().remove(); RxToasts.create(MESSAGES.packManager.worldDeleted, "delete", path.basename(fullPath)); }).catch(error => RxToasts.create(error.message, "error"));
            return;
        }
        let fullPathDis = fullPath + ".dis";
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
        if (fs.existsSync(fullPathDis)) {
            fs.unlinkSync(fullPathDis);
        }
        $(elem).parent().remove();
    }

    // Включить/выключить мод
    static toggleMod = (elem) => {
        let filename = $(elem).parent().parent().data("filename");

        let fullPath = path.join(GAME_DATA, "modpacks", packman__currentModpack.id, packman__currentMode, path.basename(filename).replace(/\.dis$/, ""));
        let fullPathDis = fullPath + ".dis";
        if ($(elem).is(":checked") && fs.existsSync(fullPathDis)) {
            fs.renameSync(fullPathDis, fullPath);
        }
        if (!$(elem).is(":checked") && fs.existsSync(fullPath)) {
            fs.renameSync(fullPath, fullPathDis);
        }
    }
}
