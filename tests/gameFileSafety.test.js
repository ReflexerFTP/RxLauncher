const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createGameFileSafety} = require('../gameFileSafety');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-game-safety-'));
try {
    const root = path.join(fixture, 'game');
    const other = path.join(fixture, 'other');
    const configPath = path.join(fixture, 'config.json');
    fs.mkdirSync(path.join(root, 'modpacks', 'pack1'), {recursive: true});
    fs.mkdirSync(path.join(root, 'versions', '1.20.1'), {recursive: true});
    fs.mkdirSync(path.join(root, 'screenshots'), {recursive: true});
    fs.mkdirSync(path.join(other, 'screenshots'), {recursive: true});
    fs.writeFileSync(configPath, JSON.stringify({gameDirectory: root}));
    fs.writeFileSync(path.join(root, 'modpacks', 'pack1', 'manifest.json'), '{}');
    fs.writeFileSync(path.join(root, 'versions', '1.20.1', '1.20.1.json'), '{}');
    const shot = path.join(root, 'screenshots', 'test.png');
    fs.writeFileSync(shot, 'png');
    fs.writeFileSync(path.join(other, 'screenshots', 'test.png'), 'png');
    const safety = createGameFileSafety(configPath);
    assert.equal(safety.folder(root, 'modpacks', 'pack1', 'manifest.json'), path.join(root, 'modpacks', 'pack1'));
    assert.equal(safety.folder(root, 'versions', '1.20.1', '1.20.1.json'), path.join(root, 'versions', '1.20.1'));
    for (const id of ['.', '..', '../game', 'CON', 'x.', 'x/y', 'x\\y']) {
        assert.equal(safety.folder(root, 'modpacks', id, 'manifest.json'), null, id);
    }
    assert.equal(safety.folder(other, 'modpacks', 'pack1', 'manifest.json'), null);
    assert.equal(safety.screenshot(shot), shot);
    assert.equal(safety.screenshot(path.join(other, 'screenshots', 'test.png')), null);
    assert.equal(safety.screenshot(path.join(root, 'modpacks', 'pack1', 'manifest.json')), null);
    console.log('Game file operation boundary tests passed');
} finally {
    fs.rmSync(fixture, {recursive: true, force: true});
}
