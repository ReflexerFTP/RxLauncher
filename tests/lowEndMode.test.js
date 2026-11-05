// Режим слабого ПК (3.13): options.txt только понижается, новой папке пишутся лёгкие значения, JVM-профиль без конфликтов GC
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {capOptions, applyToGameDirectory, JVM_FLAGS} = require('../lowEndOptions');

// Тяжёлые настройки понижаются, лёгкие и чужие строки не трогаются, CRLF сохраняется
const heavy = ['version:4189', 'renderDistance:16', 'simulationDistance:12', 'graphicsMode:2', 'particles:0', 'entityShadows:true',
    'renderClouds:"true"', 'biomeBlendRadius:5', 'entityDistanceScaling:1.5', 'mipmapLevels:4', 'lang:ru_ru', 'key_key.jump:key.keyboard.space'].join('\r\n');
const capped = capOptions(heavy);
assert.deepEqual(capped.changed.sort(), ['biomeBlendRadius', 'entityDistanceScaling', 'entityShadows', 'graphicsMode', 'mipmapLevels',
    'particles', 'renderClouds', 'renderDistance', 'simulationDistance']);
assert.match(capped.text, /^renderDistance:8\r$/m);
assert.match(capped.text, /^simulationDistance:6\r$/m);
assert.match(capped.text, /^graphicsMode:0\r$/m);
assert.match(capped.text, /^particles:1\r$/m);
assert.match(capped.text, /^renderClouds:"false"\r$/m);
assert.match(capped.text, /^entityDistanceScaling:0\.75\r$/m);
assert.match(capped.text, /^lang:ru_ru\r$/m);
assert.match(capped.text, /^key_key\.jump:key\.keyboard\.space$/m);

// То, что у игрока и так ниже, остаётся; старые версии (fancyGraphics, clouds без кавычек)
const light = capOptions('renderDistance:4\nparticles:2\ngraphicsMode:0\nrenderClouds:"false"\nmipmapLevels:0');
assert.deepEqual(light.changed, []);
const old = capOptions('fancyGraphics:true\nrenderClouds:fast\nrenderDistance:12');
assert.equal(old.text, 'fancyGraphics:false\nrenderClouds:false\nrenderDistance:8');
assert.equal(capOptions('renderDistance:abc').changed.length, 0);

// Папка игры: новая — лёгкие значения, существующая — понижение на месте
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-lowend-'));
try {
    const fresh = path.join(temp, 'fresh');
    assert.deepEqual(applyToGameDirectory(fresh), ['new']);
    assert.match(fs.readFileSync(path.join(fresh, 'options.txt'), 'utf8'), /^renderDistance:8$/m);
    const existing = path.join(temp, 'existing');
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, 'options.txt'), 'renderDistance:20\nlang:ru_ru\n');
    assert.deepEqual(applyToGameDirectory(existing), ['renderDistance']);
    assert.equal(fs.readFileSync(path.join(existing, 'options.txt'), 'utf8'), 'renderDistance:8\nlang:ru_ru\n');
    assert.deepEqual(applyToGameDirectory(existing), []);
    assert.equal(applyToGameDirectory('relative'), null);
} finally {
    fs.rmSync(temp, {recursive: true, force: true});
}

// JVM: G1-профиль; при другом сборщике в параметрах — только безопасные флаги
assert.ok(JVM_FLAGS.includes('-XX:+UseG1GC'));
const root = path.join(__dirname, '..');
const configurator = fs.readFileSync(path.join(root, 'web/js/RxLaunchConfigurator.js'), 'utf8');
assert.match(configurator, /applyLowEndProfile = \(config\)/);
assert.match(configurator, /Use\(\?!G1GC\)/);
assert.ok(configurator.indexOf('applyLowEndProfile(configResult)') < configurator.indexOf('applyRxPerformanceProfile(configResult)'), 'low-end profile wins over performance profile');
assert.match(fs.readFileSync(path.join(root, 'web/js/RxStarter.js'), 'utf8'), /lowEndOptions"\)\.applyToGameDirectory\(gameDirectory\)/);
assert.match(fs.readFileSync(path.join(root, 'web/sections/settings/startup.ejs'), 'utf8'), /data-setting="lowEndMode"/);
console.log('lowEndMode: OK');
