'use strict';
// Импорт сборок Prism Launcher / MultiMC / CurseForge: распознавание версии и загрузчика
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-import-'));
const context = vm.createContext({require, fs, fsPromises: fs.promises, path, os, process, console, MESSAGES: {}, GAME_DATA: path.join(root, 'rx'), RxCollector: {writeLog: () => {}}});
vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'RxImport.js'), 'utf8')}\nthis.RxImport = RxImport;`, context);
const {RxImport} = context;
try {
    // Prism: instances/<имя>/{instance.cfg, mmc-pack.json, .minecraft}
    const prism = path.join(root, 'PrismLauncher');
    const inst = path.join(prism, 'instances', 'My Pack');
    fs.mkdirSync(path.join(inst, '.minecraft', 'mods'), {recursive: true});
    fs.writeFileSync(path.join(inst, 'instance.cfg'), 'InstanceType=OneSix\nname=Мои моды\n');
    fs.writeFileSync(path.join(inst, 'mmc-pack.json'), JSON.stringify({components: [{uid: 'net.minecraft', version: '1.21.4'}, {uid: 'net.fabricmc.fabric-loader', version: '0.16.9'}]}));
    const broken = path.join(prism, 'instances', 'Broken');
    fs.mkdirSync(broken, {recursive: true});
    fs.writeFileSync(path.join(broken, 'mmc-pack.json'), '{oops');
    let found = RxImport.instancesIn(prism, 'Prism Launcher', 'prism');
    assert.equal(found.length, 1);
    assert.deepEqual({...found[0].instance}, {name: 'Мои моды', game: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9'});
    assert.equal(found[0].path, path.join(inst, '.minecraft'));
    // Папку самой сборки тоже понимает
    assert.equal(RxImport.instancesIn(inst, 'Prism Launcher', 'prism')[0].instance.loader, 'fabric');

    // CurseForge: Instances/<имя>/minecraftinstance.json, игра в самой папке
    const cf = path.join(root, 'curseforge', 'Instances', 'All The Mods');
    fs.mkdirSync(path.join(cf, 'mods'), {recursive: true});
    fs.writeFileSync(path.join(cf, 'minecraftinstance.json'), JSON.stringify({name: 'All The Mods 9', gameVersion: '1.20.1', baseModLoader: {name: 'forge-47.3.0', minecraftVersion: '1.20.1'}}));
    found = RxImport.instancesIn(path.dirname(cf), 'CurseForge', 'curseforge');
    assert.deepEqual({...found[0].instance}, {name: 'All The Mods 9', game: '1.20.1', loader: 'forge', loaderVersion: '47.3.0'});
    fs.writeFileSync(path.join(cf, 'minecraftinstance.json'), JSON.stringify({name: 'Fab', gameVersion: '1.21.1', baseModLoader: {name: 'fabric-0.16.5-1.21.1'}}));
    assert.equal(RxImport.instancesIn(cf, 'CurseForge', 'curseforge')[0].instance.loaderVersion, '0.16.5');
    console.log('Import instance tests passed');
} finally {
    fs.rmSync(root, {recursive: true, force: true});
}
