// Замена tomate-loaders в интерфейсе: списки версий (сеть — через ядро). Установку и конфиг запуска
// делает ядро (generate-mclc-config → loaders.rs)
const bridge = require("./bridge");
const {Buffer} = require("buffer");

const get = async (url, maxBytes = 32 * 1024 * 1024) => {
    const {value, payload} = await bridge.call("http.request", {url, method: "GET", timeout: 45000, maxBytes, compress: true, headers: {"User-Agent": "RxLauncher (https://rxlauncher.xyz)"}});
    if (value.status < 200 || value.status >= 300) throw Object.assign(new Error(`HTTP ${value.status}`), {status: value.status});
    return Buffer.from(payload).toString("utf8");
};
const getJson = async url => JSON.parse(await get(url));
const xmlVersions = xml => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1].trim());
const unique = list => [...new Set(list)].map(version => ({version, stable: true}));
const configViaCore = type => async ({gameVersion, rootPath}) => bridge.value("ipc", {channel: "generate-mclc-config", args: [{type, version: gameVersion, gameData: rootPath}]});

module.exports = {
    vanilla: {
        id: "vanilla",
        getVersionManifest: () => getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"),
        getMCLCLaunchConfig: configViaCore("vanilla")
    },
    fabric: {
        id: "fabric",
        listSupportedVersions: () => getJson("https://meta.fabricmc.net/v2/versions/game"),
        getMCLCLaunchConfig: configViaCore("fabric")
    },
    quilt: {
        id: "quilt",
        listSupportedVersions: () => getJson("https://meta.quiltmc.org/v3/versions/game"),
        getMCLCLaunchConfig: configViaCore("quilt")
    },
    forge: {
        id: "forge",
        listSupportedVersions: async () => unique(xmlVersions(await get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml")).map(version => version.split("-")[0])),
        getMCLCLaunchConfig: configViaCore("forge")
    },
    neoforge: {
        id: "neoforge",
        listSupportedVersions: async () => unique(xmlVersions(await get("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"))
            .filter(version => !version.includes("-beta"))
            .map(version => {
                const [major, minor] = version.split(".");
                return `1.${major}.${minor}`;
            })),
        getMCLCLaunchConfig: configViaCore("neoforge")
    },
    liner: {id: "liner"}
};
