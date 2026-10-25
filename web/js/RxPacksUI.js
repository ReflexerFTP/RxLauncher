let packs_currentMode = "mods";
let packs_currentOffset = 0;
let packs_scrollIsLoading = false;
let packs_loadRequestId = 0;
let packs_animationTimers = [];
let packs_currentSort = "downloads";
let packs_hasMore = true;
let packs_currentProvider = "modrinth";

const MODRINTH_API_URL = "https://api.modrinth.com/v2";
const MODRINTH_MODS_API_URL = `${MODRINTH_API_URL}/search?`;
const MODRINTH_GAME_VERSIONS_URL = `${MODRINTH_API_URL}/tag/game_version`;
const MODRINTH_LOADERS_URL = `${MODRINTH_API_URL}/tag/loader`;

class RxPacksUI {
    static setProvider = async (provider) => {
        packs_currentProvider = provider === "curseforge" ? "curseforge" : "modrinth";
        RxConfig.write("catalogProvider", packs_currentProvider);
        $("#modal-installMods .catalog-provider").removeClass("active");
        $(`#modal-installMods .catalog-provider[data-provider="${packs_currentProvider}"]`).addClass("active");
        const isCurseForge = packs_currentProvider === "curseforge";
        $("#modal-installMods .catalog-head h1").text(isCurseForge ? MESSAGES.packs.curseforge.title : MESSAGES.packs.catalog.title);
        $("#modal-installMods .catalog-head__subtitle").text(isCurseForge ? MESSAGES.packs.curseforge.subtitle : MESSAGES.packs.catalog.subtitle);
        $("#modal-installMods input.search").attr("placeholder", isCurseForge ? MESSAGES.packs.curseforge.searchPlaceholder : MESSAGES.packs.catalog.searchPlaceholder);
        $("#modal-installMods .catalog-external span:last-child").text(isCurseForge ? "CurseForge" : "Modrinth");
        const $sort = $("#modal-installMods .catalog-sort");
        $sort.find('option[value="follows"]').text(isCurseForge ? MESSAGES.packs.curseforge.sortRating : MESSAGES.packs.catalog.sortFollows);
        $sort.find('option[value="relevance"]').text(isCurseForge ? MESSAGES.packs.curseforge.sortPopularity : MESSAGES.packs.catalog.sortRelevance);
        $("#modal-installMods .catalog-external").off("click.provider").on("click.provider", () => {
            openExternal(isCurseForge ? "https://www.curseforge.com/minecraft" : "https://modrinth.com");
        });
        $("#modal-installMods .curseforge-auth").toggle(isCurseForge);
        if (isCurseForge) await RxCurseForge.refreshAuthPanel();
        return packs_currentProvider;
    }

    static setCatalogStatus = (mode, text = "") => {
        const $status = $("#modal-installMods .catalog-status");
        $status.removeClass("loading error empty").addClass(mode || "");
        $status.find(".catalog-status__icon").text({
            loading: "progress_activity",
            error: "cloud_off",
            empty: "search_off"
        }[mode] || "info");
        $status.find(".catalog-status__text").text(text);
        if (mode) {
            $status.show();
        } else {
            $status.hide();
        }
    }

    static clearListAnimations = () => {
        packs_animationTimers.forEach((timerId) => clearTimeout(timerId));
        packs_animationTimers = [];
        $("#modal-installMods .packs-list .item:not(.placeholder)").each(function () {
            this.classList.remove("animate__animated", "animate__fadeIn", "animate__faster");
            delete this.dataset.rxAnimationName;
            delete this.dataset.rxAnimationId;
            this.style.opacity = "";
        });
    }

    static animateLoadedItems = ($items) => {
        if ($items.length === 0) {
            return;
        }
        if (RxConfig.read("disableAnimations", false) === true) {
            $items.css("opacity", "");
            return;
        }

        $items.each(function (index) {
            const node = this;
            node.style.opacity = "0";
            const timerId = setTimeout(() => {
                packs_animationTimers = packs_animationTimers.filter((item) => item !== timerId);
                if (!node.isConnected) {
                    return;
                }
                animateCSSNode(node, "fadeIn").then(() => {
                    if (node.isConnected) {
                        node.style.opacity = "";
                    }
                });
            }, Math.min(20 * index, 320));
            packs_animationTimers.push(timerId);
        });
    }

    // Создать пак из UI
    static createPack = () => {
        let packVersion = RxVersionsManager.getActiveVersion();
        let $packNameInput = $("#modal-createPack input");
        let packName = $packNameInput.val();
        if (packName !== "" && packVersion !== "none") {
            $packNameInput.val("");
            RxPacks.createPack(packVersion, packName);
            RxAlerts.create("Ok!", MESSAGES.packs.created, MESSAGES.commons.close, "check_circle");
            RxModals.hideModal("createPack")
            RxPacksUI.refreshDirectorySelect();
        }
    }

    // Задать режим (mods, modpacks, resourcepacks, shaders, myPacks)
    static setCurrentMode = (mode) => {
        let allowedModes = ["mods", "modpacks", "resourcepacks", "shaders"];
        if (!allowedModes.includes(mode)) {
            return false;
        }
        packs_currentMode = mode;
        return packs_currentMode;
    }

    // Загрузить список установленных
    static loadInstalledList = () => {
        const scanDirectories = ["mods", "shaderpacks", "resourcepacks"];
        let $installedList = $("#modal-installMods .installedList .scroll-wrap");
        $installedList.html("");
        let modpackId = $("#modal-installMods select").val();

        let listResult = {};
        let isModpack = false;

        // Корень пути для сканирования
        let rootScanPath = GAME_DATA;
        if (RxPacks.isModpackExists(modpackId)) {
            isModpack = true;
            rootScanPath = path.join(GAME_DATA, "modpacks", modpackId);
        }

        // Сканируем все нужные директории
        scanDirectories.forEach((dir) => {
            let scanPath = path.join(rootScanPath, dir);
            if (fs.existsSync(scanPath)) {
                let directoryRd = fs.readdirSync(scanPath);
                // Все файлы добавляем в список
                directoryRd.forEach((item) => {
                    listResult[item] = {
                        file: item,
                        displayName: path.parse(item).name,
                        path: path.join(scanPath, item),
                        type: dir,
                        inConfigOf: false
                    };
                })
            }
        })

        // Если это модпак, то ищем DisplayName для каждого
        if (isModpack) {
            let modpackFiles = RxPacks.getModpackManifest(modpackId).files;
            modpackFiles.forEach((file) => {
                if (typeof listResult[file.name] !== "undefined") {
                    listResult[file.name].displayName = file.displayName;
                    listResult[file.name].inConfigOf = modpackId;
                } else {
                    listResult[file.name] = {
                        file: file.name,
                        displayName: file.displayName,
                        path: path.join(rootScanPath, file.name),
                        type: file.name.split("/")[0],
                        inConfigOf: modpackId
                    }
                }
            })
        }

        // Добавляем ресурсы в список
        Object.values(listResult).forEach(mod => {
            let icon;
            switch (mod.type) {
                case "mods":
                    icon = "deployed_code_update";
                    break;
                case "resourcepacks":
                    icon = "landscape";
                    break;
                case "shaderpacks":
                    icon = "light_mode";
                    break;
                default:
                    icon = "archive";
                    break;
            }
            let onClickFunc = `RxPacks.deleteFileFromModpack('${mod.path}')`;
            if (mod.inConfigOf !== false) {
                onClickFunc = `RxPacks.deleteFileFromModpack('${mod.path}', true, '${mod.inConfigOf}')`;
            }
            onClickFunc = onClickFunc.replaceAll("\\", "/");
            $installedList.append(`<div class="item" data-filename="${mod.file}">
                    <span class="icon material-symbols-outlined">${icon}</span>
                    <span class="name">${mod.displayName}</span>
                    <button><span class="material-symbols-outlined" onclick="${onClickFunc}">delete</span></button>
                </div>`);
        })
        return listResult;
    }

    // Включить фильтры по ID модпака
    static loadFiltersByModpackID = () => {
        if ($("#modal-installMods select").val() === "default") {
            // Убираем все отмеченные чекбоксы
            $(`#modal-installMods .filters__scroll-wrapper input[type="checkbox"]`).removeAttr("checked").removeProp("checked");
            return false;
        }
        let modpackId = $("#modal-installMods select").val();
        if (!RxPacks.isModpackExists(modpackId)) {
            return false;
        }
        let packData = RxPacks.getModpackManifest(modpackId);

        // Убираем все отмеченные чекбоксы
        $(`#modal-installMods .filters__scroll-wrapper input[type="checkbox"]`).removeAttr("checked").removeProp("checked");

        // Отмечаем нужные
        $(".filters__scroll-wrapper input").each(function () {
            if ([packData.baseVersion.type, packData.baseVersion.number].includes($(this).val())) {
                $(this).prop("checked", true);
            }
        });
        return true;
    }

    // Загрузить фильтры
    static loadFilters = async () => {
        if (packs_currentProvider === "curseforge") {
            return RxCurseForge.loadFilters();
        }
        const [[versionsSuccess, versions], [loadersSuccess, loaders]] = await Promise.all([
            RxRequests.get(MODRINTH_GAME_VERSIONS_URL),
            RxRequests.get(MODRINTH_LOADERS_URL)
        ]);
        if (!versionsSuccess || !loadersSuccess || !Array.isArray(versions) || !Array.isArray(loaders)) {
            return false;
        }

        let currentProjType = RxPacksUI.currentProjectType();
        // Сохраняем отмеченные чекбоксы
        let selectedCheckboxes = [];
        $(`.filters__scroll-wrapper input[type="checkbox"]:checked`).each(function () {
            selectedCheckboxes.push($(this).attr("value"))
        })

        // Очищаем список
        $(`.filters__scroll-wrapper input[type="checkbox"]`).unbind("click");
        $("#filtersLoaders").html("");
        $("#filtersVersions").html("");

        // Загружаем список версий игры
        versions.filter((versionItem) => versionItem.version_type === "release").forEach((versionItem, index) => {
            const ver = versionItem.version;
            if (!ver) return;
            $("#filtersVersions").append(`
    <input type="checkbox" class="checkbox" id="ver-${index}" value="${ver}">
    <label for="ver-${index}">${RxUtils.capitalizeWord(ver)}</label>`);
        });

        // Загружаем список лоудеров
        loaders.forEach((lod, index) => {
            if (Array.isArray(lod.supported_project_types) && lod.supported_project_types.includes(currentProjType)) {
                $("#filtersLoaders").append(`
    <input type="checkbox" class="checkbox" id="lod-${index}" value="${lod.name}">
    <label for="lod-${index}">${RxUtils.capitalizeWord(lod.name)}</label>`);
            }
        });

        // Восстанавливаем отмеченное
        selectedCheckboxes.forEach(chkId => {
            let $chkbox = $(`.filters__scroll-wrapper input[value="${chkId}"]`);
            if ($chkbox.length > 0) {
                $chkbox.prop("checked", true);
            }
        })

        // Настраиваем фильтры для модпака (если требуется)
        RxPacksUI.loadFiltersByModpackID();

        // Биндим переключение
        $(`.filters__scroll-wrapper input[type="checkbox"]`).on("change", () => {
            RxPacksUI.reloadAll(true, false, true);
        })

        return true;
    }

    // Получить facets из фильтров
    static filtersToFacets = () => {
        const facets = [[`project_type:${RxPacksUI.currentProjectType()}`]];

        let selectedVersions = [];
        let selectedLoaders = [];
        $("#filtersVersions input:checked").each(function () {
            selectedVersions.push($(this).attr("value"));
        })
        $("#filtersLoaders input:checked").each(function () {
            selectedLoaders.push($(this).attr("value"));
        })

        if (selectedVersions.length > 0) {
            facets.push(selectedVersions.map((ver) => `versions:${ver}`));
        }

        if (selectedLoaders.length > 0) {
            facets.push(selectedLoaders.map((loader) => `categories:${loader}`));
        }

        return JSON.stringify(facets);
    }

    // Получить тип проекта для фильтрации (из currentPacksMode)
    static currentProjectType = () => {
        switch (packs_currentMode) {
            case "mods":
                return "mod";
            case "modpacks":
                return "modpack";
            case "resourcepacks":
                return "resourcepack";
            case "shaders":
                return "shader";
            default:
                return "project";
        }
    }

    // Сгенерировать ссылку на Modrinth
    static generateURL(
        urlStart,
        query = "",
        facets = "",
        offset = packs_currentOffset,
        limit = 20,
        sort = "downloads"
    ) {
        let fullUrl = urlStart;
        let urlAddons = "";
        let params = {
            query: query,
            offset: offset,
            limit: limit,
            index: sort,
            facets: facets
        }
        query === "" && delete params.query;
        offset == "" && delete params.offset;
        limit == "" && delete params.limit;
        sort === "" && delete params.index;
        facets === "" && delete params.facets;
        if (query != "") {
            urlAddons = "query=" + query;
        }
        urlAddons = encodeGetParams(params);
        fullUrl = fullUrl + urlAddons;
        return fullUrl;
    }

    // Открыть ссылку на проект в браузере
    static openProjectURL = (id, projectType = RxPacksUI.currentProjectType()) => {
        if (packs_currentProvider === "curseforge") {
            return RxCurseForge.openProjectURL("", id);
        }
        const typePaths = {
            mod: "mod",
            modpack: "modpack",
            resourcepack: "resourcepack",
            shader: "shader"
        };
        return openExternal(`https://modrinth.com/${typePaths[projectType] || "project"}/${encodeURIComponent(id)}`);
    }

    // Прогрузить список далее
    static loadMore = () => {
        if (!packs_hasMore) {
            return false;
        }
        let savedScroll = $("#modal-installMods .packs-wrapper").scrollTop();
        packs_currentOffset += 20;
        RxPacksUI.reloadAll(false, false, false).then(() => {
            $("#modal-installMods .packs-wrapper").scrollTop(savedScroll);
            packs_scrollIsLoading = false;
        });
        return true;
    }

    // Загрузить список версий для проекта
    static loadVersionsList = async (projectId) => {
        if (packs_currentProvider === "curseforge") {
            return RxCurseForge.loadVersionsList(projectId);
        }
        let $versionList = $(`#modal-installMods .packs-list .item[data-id="${projectId}"] .versions-list`);
        let $itemElem = $(`#modal-installMods .packs-list .item[data-id="${projectId}"]`);

        if ($itemElem.hasClass("opened") && $itemElem.data("versions-loaded") === true) {
            $itemElem.removeClass("opened");
            $itemElem.find(".button button.pill").show();
            return true;
        }

        // Показываем UI загрузки
        $itemElem.addClass("opened");
        $itemElem.find(".button button.pill").hide();
        $itemElem.find(".versions-list-preloader").show();

        if ($versionList.length === 0) {
            return false;
        }
        $versionList.html("");
        // Получаем список версий
        let [isSuccess, result] = await RxRequests.get(`${MODRINTH_API_URL}/project/${encodeURIComponent(projectId)}/version`);
        if (!isSuccess) {
            $itemElem.find(".versions-list-preloader").hide();
            $itemElem.find(".button button.pill").show();
            $versionList.append($("<div>").addClass("version-message error").text(MESSAGES.packs.catalog.versionsError));
            return false;
        }

        let selectedVersions = [];
        let selectedLoaders = [];
        $("#filtersVersions input:checked").each(function () {
            selectedVersions.push($(this).attr("value"));
        })
        $("#filtersLoaders input:checked").each(function () {
            selectedLoaders.push($(this).attr("value"));
        })

        let compatibleCount = 0;
        // Загружаем его
        result.forEach((item) => {
            let mappedLoaders = item.loaders.map(function (e) {
                e = RxUtils.capitalizeWord(e);
                return e;
            });

            if ((RxUtils.compareArrays(selectedVersions, item.game_versions).length > 0 || selectedVersions.length === 0) && (RxUtils.compareArrays(selectedLoaders, item.loaders).length > 0 || selectedLoaders.length === 0) && item.files.length > 0) {
                compatibleCount++;
                const fileItem = item.files.find((file) => file.primary === true) || item.files[0];
                const $versionItem = $("<div>").addClass("item");
                $versionItem.append($("<span>").addClass("title").text(item.name));
                $versionItem.append($("<div>").addClass("flex flex-align-center flex-gap-4 versions").text(`${mappedLoaders.join(", ")} • ${item.game_versions.join(", ")}`));
                if (RxPacksUI.isFileInstalled(fileItem.filename)) {
                    $versionItem.append($("<span>").addClass("material-symbols-outlined").attr("title", MESSAGES.packs.catalog.installed).text("download_done"));
                } else {
                    const $installButton = $("<button>").addClass("small pill").text(MESSAGES.commons.install);
                    $installButton.on("click", async function () {
                        if (item.loaders[0] === "datapack") {
                            const worldPath = await RxUI.selectWorld();
                            if (worldPath) {
                                await RxPacks.downloadByVersionID(item.id, this, path.join(worldPath, "datapacks"));
                            }
                            return;
                        }
                        await RxPacks.downloadByVersionID(item.id, this);
                    });
                    $versionItem.append($installButton);
                }
                $versionList.append($versionItem);
            }
        })
        if (compatibleCount === 0) {
            $versionList.append($("<div>").addClass("version-message").text(MESSAGES.packs.catalog.noCompatibleVersions));
        }
        $itemElem.data("versions-loaded", true);
        $itemElem.find(".versions-list-preloader").hide();
        return true;
    }

    // Проверить, установлен ли уже этот файл
    static isFileInstalled = (filename) => {
        if (packs_currentMode === "modpacks") {
            let preparedId = RxPacks.modpackCleanID(filename.replace(".mrpack", ""));
            return RxPacks.isModpackExists(preparedId);
        }
        const modpackId = $("#modal-installMods select").val();
        const installDir = RxPacks.getInstallDirectory(packs_currentMode, modpackId);
        return fs.existsSync(path.join(installDir, path.basename(filename)));
    }

    // Загрузить список модов
    static loadModsList = async (clearBefore = true) => {
        if (packs_currentProvider === "curseforge") {
            return RxCurseForge.loadModsList(clearBefore);
        }
        const requestId = ++packs_loadRequestId;
        const $packsList = $("#modal-installMods .packs-list");
        const $preloader = $("#modal-installMods .preloader");

        if (clearBefore) {
            RxPacksUI.clearListAnimations();
            $packsList.find(".item:not(.placeholder)").remove();
            packs_hasMore = true;
        }
        if (clearBefore) {
            $packsList.hide();
        }
        $preloader.show();
        RxPacksUI.setCatalogStatus("loading", MESSAGES.packs.catalog.loading);
        let query = $("#modal-installMods input.search").val();
        let facets = RxPacksUI.filtersToFacets();
        let modrinthUrl = RxPacksUI.generateURL(MODRINTH_MODS_API_URL, query, facets, packs_currentOffset, 20, packs_currentSort);
        let [isSuccess, result] = await RxRequests.get(modrinthUrl);
        if (!isSuccess) {
            if (requestId === packs_loadRequestId) {
                $packsList.show();
                $preloader.hide();
                RxPacksUI.setCatalogStatus("error", MESSAGES.packs.catalog.loadError);
            }
            packs_scrollIsLoading = false;
            return false;
        }
        if (requestId !== packs_loadRequestId) {
            return false;
        }
        
        let $newItems = $();
        packs_hasMore = packs_currentOffset + result.hits.length < result.total_hits;
        // Создаём карточки из безопасного DOM-шаблона
        result.hits.forEach((item) => {
            const projectId = item.project_id || item.slug;
            const $preparedItem = $("#modal-installMods .item.placeholder").first().clone();
            $preparedItem.removeClass("placeholder").attr("data-id", projectId).removeAttr("style");
            $preparedItem.find("img.icon").attr("src", item.icon_url || "assets/modIcon.webp").on("error", function () {
                $(this).attr("src", "assets/modIcon.webp");
            });
            $preparedItem.find(".title").first().text(item.title);
            $preparedItem.find(".description").text(item.description || MESSAGES.packs.catalog.noDescription);
            $preparedItem.find(".downloads").text(kFormatter(item.downloads || 0));
            $preparedItem.find(".favorite").text(kFormatter(item.follows || 0));
            $preparedItem.find(".catalog-install").on("click", () => RxPacksUI.loadVersionsList(projectId));
            $preparedItem.find(".catalog-open").on("click", (event) => {
                event.preventDefault();
                RxPacksUI.openProjectURL(item.slug || projectId, item.project_type);
            });
            $packsList.append($preparedItem);
            $newItems = $newItems.add($preparedItem);
        })

        // Помечаем нужные аккаунты в списке активными
        // Анимация плашки с каждым модов
        RxPacksUI.animateLoadedItems($newItems);
        $packsList.show();
        $preloader.hide();
        if (clearBefore && result.hits.length === 0) {
            RxPacksUI.setCatalogStatus("empty", MESSAGES.packs.catalog.empty);
        } else {
            RxPacksUI.setCatalogStatus("", "");
        }
        if (clearBefore && typeof RxOptimizer !== "undefined") {
            RxOptimizer.scheduleFreeMemory(1000);
        }
        return true;
    }

    // Перезагрузить всё
    static reloadAll = async (resetPacksOffset = false, reloadFilters = true, clearBefore = true) => {
        if (resetPacksOffset === true) {
            packs_currentOffset = 0;
            packs_hasMore = true;
        }
        RxPacksUI.refreshDirectorySelect();
        if (reloadFilters) {
            await RxPacksUI.loadFilters();
        }
        RxPacksUI.loadInstalledList();
        await RxPacksUI.loadModsList(clearBefore);
        return true;
    }

    static setSort = (sort) => {
        const allowedSorts = ["downloads", "follows", "newest", "updated", "relevance"];
        packs_currentSort = allowedSorts.includes(sort) ? sort : "downloads";
        return packs_currentSort;
    }

    // Обновить список папок для выбора места установки
    static refreshDirectorySelect = () => {
        let $select = $("#packs_dirList");
        let $packsList = $("#modal-packs .grid");
        let selectedOption = $select.val();
        $select.html("");
        $("#modal-packs .grid .item:not(.add)").remove();
        $select.append(`<option value="default">${MESSAGES.packs.defaultDir}</option>`);
        let myPacks = RxPacks.getPacksList();
        let isAnyActiveSet = false;
        $("#modal-packs .grid .item:not(.add)").off("click");
        myPacks.forEach((pack) => {
            let packData = RxPacks.getModpackManifest(pack);
            if (packData.id === selectedOption) {
                isAnyActiveSet = true;
            }
            $select.append(`<option value="${packData.id}" ${packData.id === selectedOption ? "selected" : ""}>${packData.displayName}</option>`);
            if (packData.icon === "pack") {
                packData.icon = path.join(GAME_DATA, "modpacks", packData.id, "icon.png");
            }
            $packsList.append(`
                        <div class="item" data-id="${packData.id}">
                <div class="img-wrap">
                    <img src="${packData.icon || "assets/icon.png"}" />
                </div>
                <h2>${packData.displayName}</h2>
                <span class="version">${RxVersionsManager.versionToDisplayName(packData.baseVersion.full)}</span>
            </div>`)
        });
        $("#modal-packs .grid .item:not(.add)").click(function () {
            RxPackManagerUI.loadAndShow($(this).data("id"));
        })
        if (!isAnyActiveSet) {
            $select.val("default");
        }
    }
}

function kFormatter(num) {
    return Math.abs(num) > 999 ? Math.sign(num) * ((Math.abs(num) / 1000).toFixed(1)) + 'k' : Math.sign(num) * Math.abs(num)
}

const encodeGetParams = p =>
    Object.entries(p).map(kv => kv.map(encodeURIComponent).join("=")).join("&");
