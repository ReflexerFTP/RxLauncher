'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-worker-policy-'));
const game = path.join(temp, 'game');
fs.mkdirSync(path.join(game, 'saves', 'safe'), {recursive: true});
const policy = require('../workerFileSafety').createWorkerFileSafety(() => game);
const file = path.join(game, 'saves', 'safe', 'level.dat'); fs.writeFileSync(file, 'fixture');
let staging;
try {
    assert.equal(policy.readNbt(file), file);
    const external = path.join(temp, 'level.dat'); fs.writeFileSync(external, 'fixture');
    assert.throws(() => policy.readNbt(external), /outside/);
    const arbitrary = path.join(game, 'level.dat'); fs.writeFileSync(arbitrary, 'fixture');
    assert.throws(() => policy.readNbt(arbitrary), /metadata/);
    assert.throws(() => policy.archive({archive: external, destination: path.join(game, 'extract'), type: 'zip'}), /not selected/);
    policy.approveDialog([external]);
    assert.equal(policy.archive({archive: external, destination: path.join(game, 'extract'), type: 'zip'}).archive, external);
    assert.throws(() => policy.archive({archive: external, destination: path.join(temp, 'outside'), type: 'zip'}), /destination/);
    assert.throws(() => policy.archive({archive: external, destination: path.join(game, 'extract'), type: 'exe'}), /Unsupported/);
    assert.throws(() => policy.readNbt(path.join(game, 'saves', 'safe', 'x') + '/../level.dat'), /Unsafe/);
    const linked = path.join(game, 'saves', 'linked');
    fs.symlinkSync(path.join(temp), linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => policy.readNbt(path.join(linked, 'level.dat')), /Linked/);
    assert.throws(() => policy.archive({archive: external, destination: path.join(linked, 'extract'), type: 'zip'}), /Linked/);
    assert.throws(() => policy.createStaging('arbitrary'), /Invalid/);
    staging = policy.createStaging('custom-version');
    assert.equal(policy.archive({archive: external, destination: staging, type: 'zip'}).destination, staging);
    console.log('Worker IPC paths: world scope, native selection, destinations, traversal and junctions checked');
} finally {
    if (staging && path.resolve(staging).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(staging).startsWith('rx-version-')) fs.rmSync(staging, {recursive: true, force: true});
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('rx-worker-policy-')) fs.rmSync(temp, {recursive: true, force: true});
}
