const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {getPinnedLoaderConfig} = require('../pinnedLoader');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-pinned-loader-'));
(async () => {
    const data = {type: 'fabric', version: '1.21.1', loaderVersion: '0.16.9', gameData: root};
    const urls = [];
    const read = async url => {
        urls.push(url);
        return Buffer.from(JSON.stringify({id: 'upstream', inheritsFrom: data.version, libraries: [{name: 'net.fabricmc:fabric-loader:' + data.loaderVersion}]}));
    };
    const config = await getPinnedLoaderConfig(data, read);
    assert.equal(urls[0], 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.9/profile/json');
    assert.equal(config.version.custom, 'fabric-1.21.1-0.16.9');
    assert.deepEqual(await getPinnedLoaderConfig(data, () => { throw Error('offline'); }), config);
    await assert.rejects(getPinnedLoaderConfig({...data, loaderVersion: '../escape'}, read), /Invalid/);
    await assert.rejects(getPinnedLoaderConfig({...data, loaderVersion: '0.16.8'}, read), /does not match/);
    const jar = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.from('fixture')]);
    const hash = crypto.createHash('sha1').update(jar).digest('hex');
    for (const type of ['forge', 'neoforge']) {
        const forge = {...data, type, loaderVersion: type === 'forge' ? '52.0.28' : '21.1.80'};
        const result = await getPinnedLoaderConfig(forge, async url => { urls.push(url); return url.endsWith('.sha1') ? Buffer.from(hash) : jar; });
        assert.deepEqual(fs.readFileSync(result.forge), jar);
        assert.ok(result.root.endsWith(`${type}-${forge.version}-${forge.loaderVersion}`), 'MCLC ForgeWrapper cache must be isolated per loader version');
        assert.deepEqual(await getPinnedLoaderConfig(forge, () => { throw Error('offline'); }), result);
        fs.writeFileSync(result.forge, 'damaged');
        await assert.rejects(getPinnedLoaderConfig(forge, async url => url.endsWith('.sha1') ? Buffer.from(hash) : Buffer.from('wrong')), /checksum/);
    }
    console.log('Pinned profiles, offline cache and installer integrity tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
