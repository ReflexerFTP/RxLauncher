class RxVersionArtwork {
    static RELEASES = {
        "1.18": {
            title: {ru: "Пещеры и скалы", en: "Caves & Cliffs"},
            description: {
                ru: "Глубокие пещеры, высокие горы и новый масштаб мира. Обложка включается автоматически для всей линейки 1.18.",
                en: "Deeper caves, taller mountains and a new sense of scale. This artwork is selected automatically for every 1.18 build."
            },
            accent: "#55d6c2",
            image: "assets/version-heroes/1.18.png"
        },
        "1.19": {
            title: {ru: "Дикое обновление", en: "The Wild Update"},
            description: {
                ru: "Древние города, глубокая тьма и загадочное скалк-свечение для версий 1.19.",
                en: "Ancient cities, the deep dark and mysterious sculk glow for the 1.19 generation."
            },
            accent: "#2fd1c7",
            image: "assets/version-heroes/1.19.png"
        },
        "1.20": {
            title: {ru: "Тропы и истории", en: "Trails & Tales"},
            description: {
                ru: "Вишнёвые рощи, археология и тёплое путешествие — отдельная сцена для линейки 1.20.",
                en: "Cherry groves, archaeology and a warmer journey — a dedicated scene for the 1.20 generation."
            },
            accent: "#ff9eb4",
            image: "assets/version-heroes/1.20.png"
        },
        "1.21": {
            title: {ru: "Сложные испытания", en: "Tricky Trials"},
            description: {
                ru: "Медные залы, хранилища и испытательные камеры в кинематографичной сцене версий 1.21.",
                en: "Copper halls, vaults and trial chambers in a cinematic scene for the 1.21 generation."
            },
            accent: "#36e0cf",
            image: "assets/version-heroes/1.21.png"
        }
    };

    static language = () => String(typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru") === "ru" ? "ru" : "en";

    static resolveVersionNumber = (versionId = null) => {
        const activeId = versionId || (typeof RxVersionsManager !== "undefined" ? RxVersionsManager.getActiveVersion() : "none");
        if (!activeId || activeId === "none") return "1.21";

        const parsed = RxVersionsManager.parseVersionID(activeId);
        let versionNumber = String(parsed.name || "");
        if (parsed.type === "pack" && typeof RxPacks !== "undefined") {
            try {
                versionNumber = String(RxPacks.getModpackManifest(parsed.name)?.baseVersion?.number || versionNumber);
            } catch (_) {}
        }
        const match = versionNumber.match(/^(1\.\d+)/);
        return match ? match[1] : "1.21";
    };

    static resolveArtwork = (versionId = null) => {
        const version = RxVersionArtwork.resolveVersionNumber(versionId);
        if (RxVersionArtwork.RELEASES[version]) return {...RxVersionArtwork.RELEASES[version], version};

        const minor = Number(version.split(".")[1]);
        const posterVersion = Number.isFinite(minor) && minor >= 11 && minor <= 21 ? version : "1.21";
        return {
            version,
            title: {ru: `Эпоха Minecraft ${version}`, en: `Minecraft ${version} era`},
            description: {
                ru: "Локальная обложка подстраивается под выбранную версию и остаётся доступной без интернета.",
                en: "The local artwork follows the selected version and stays available without internet."
            },
            accent: "#48d9cd",
            image: `assets/posters/${posterVersion}.webp`
        };
    };

    static loaderName = (versionId = null) => {
        const activeId = versionId || RxVersionsManager.getActiveVersion();
        if (!activeId || activeId === "none") return "Java Edition";
        const type = RxVersionsManager.parseVersionID(activeId).type;
        return ({vanilla: "Vanilla", forge: "Forge", forgeOptiFine: "Forge + OptiFine", neoforge: "NeoForge", fabric: "Fabric", quilt: "Quilt", pack: "Modpack"})[type] || "Java Edition";
    };

    static update = (versionId = null) => {
        const $hero = $("#modal-content .hero");
        if ($hero.length === 0) return false;

        const artwork = RxVersionArtwork.resolveArtwork(versionId);
        const language = RxVersionArtwork.language();
        const activeId = versionId || RxVersionsManager.getActiveVersion();
        const title = artwork.title?.[language] || artwork.title?.en || artwork.title?.ru || artwork.version;
        const description = artwork.description?.[language] || artwork.description?.en || artwork.description?.ru || "";

        $hero.css("--hero-accent", artwork.accent);
        $hero.attr("data-release", artwork.version);
        $hero.find(".hero-bg").css("background-image", `url(\"${artwork.image}\")`);
        $hero.find("[data-hero-release]").text(`Minecraft ${artwork.version}`);
        $hero.find("[data-hero-title]").text(title);
        $hero.find("[data-hero-description]").text(description);
        $hero.find("[data-hero-loader]").text(RxVersionArtwork.loaderName(activeId));
        $hero.find("[data-hero-version]").text(activeId && activeId !== "none" ? artwork.version : (MESSAGES.commons?.notSelected || "Не выбрано"));
        return true;
    };

    static init = () => {
        RxVersionArtwork.update();
        document.addEventListener("showModalEvent", event => {
            if (event.detail?.modal === "content") RxVersionArtwork.update();
        });
    };
}

$(RxVersionArtwork.init);
