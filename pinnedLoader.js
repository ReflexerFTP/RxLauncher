const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/.test(value);
const atomicWrite = (file, data) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, data); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
};
const fetchBytes = async (url, limit = 64 * 1024 * 1024) => {
    const response = await fetch(url, {signal: AbortSignal.timeout(60000), redirect: 'error'});
    if (!response.ok) throw new Error(`Loader HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Loader response too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
};

exports.getPinnedLoaderConfig = async ({type, version, loaderVersion, gameData}, read = fetchBytes) => {
    if (!valid(version) || !valid(loaderVersion) || !['fabric', 'quilt', 'forge', 'forgeOptiFine', 'neoforge'].includes(type)) throw new Error('Invalid pinned loader');
    const loader = type === 'forgeOptiFine' ? 'forge' : type;
    const id = `${loader}-${version}-${loaderVersion}`;
    // MCLC caches ForgeWrapper metadata by Minecraft version, ignoring the loader
    // version. Separate its root so two pinned Forge builds cannot reuse that cache.
    const runtimeRoot = ['forge', 'neoforge'].includes(loader) ? path.join(gameData, 'loader-runtimes', id) : gameData;
    const dir = path.join(runtimeRoot, 'versions', id);
    const config = {root: runtimeRoot, version: {number: version, type: 'release', custom: id}};
    if (loader === 'fabric' || loader === 'quilt') {
        const file = path.join(dir, id + '.json');
        const coordinate = loader === 'fabric' ? 'net.fabricmc:fabric-loader:' : 'org.quiltmc:quilt-loader:';
        const check = profile => profile.inheritsFrom === version && profile.libraries?.some(l => l.name === coordinate + loaderVersion);
        try { if (check(JSON.parse(fs.readFileSync(file, 'utf8')))) return config; } catch (_) {}
        const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
        const profile = JSON.parse((await read(`${base}/versions/loader/${version}/${loaderVersion}/profile/json`, 4 * 1024 * 1024)).toString('utf8'));
        if (!check(profile)) throw new Error('Loader profile does not match the pinned version');
        atomicWrite(file, JSON.stringify({...profile, id}));
        return config;
    }
    const artifact = loader === 'forge' ? `${version}-${loaderVersion}` : loaderVersion;
    const base = loader === 'forge' ? 'https://maven.minecraftforge.net/net/minecraftforge/forge' : 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
    const url = `${base}/${artifact}/${loader}-${artifact}-installer.jar`;
    const file = path.join(dir, loader + '.jar');
    const receipt = path.join(dir, 'installer.sha1');
    config.forge = file;
    config.clientPackage = null;
    const hash = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
    try {
        const expected = fs.readFileSync(receipt, 'utf8').trim();
        if (/^[a-f0-9]{40}$/.test(expected) && hash(fs.readFileSync(file)) === expected) return config;
    } catch (_) {}
    const expected = (await read(url + '.sha1', 1024)).toString('utf8').trim().split(/\s/)[0].toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error('Invalid loader checksum');
    const bytes = await read(url);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50 || hash(bytes) !== expected) throw new Error('Loader installer checksum mismatch');
    atomicWrite(file, bytes);
    atomicWrite(receipt, expected);
    return config;
};
