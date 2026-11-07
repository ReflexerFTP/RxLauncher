'use strict';
// Java от старых версий (без квитанции) принимается один раз и дальше проверяется по квитанции
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rs = require('../runtimeSecurity');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-java-'));
const make = (major, implementor = 'Eclipse Adoptium', version = `${major}.0.5`) => {
    const dir = path.join(root, String(major));
    const home = path.join(dir, `jdk-${version}+1`);
    fs.mkdirSync(path.join(home, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(home, 'release'), `IMPLEMENTOR="${implementor}"\nJAVA_VERSION="${version}"\n`);
    fs.writeFileSync(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), 'binary');
    return dir;
};
try {
    const java21 = make(21);
    assert.equal(rs.validateRuntime(java21, 21), false);
    assert.equal(rs.adoptLegacyRuntime(java21, 21), true);
    assert.equal(rs.validateRuntime(java21, 21), true);
    assert.equal(rs.adoptLegacyRuntime(java21, 21), false, 'only once');
    // Подмена после принятия ловится
    fs.writeFileSync(path.join(java21, 'jdk-21.0.5+1', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), 'evil');
    assert.equal(rs.validateRuntime(java21, 21), false);
    // Чужая сборка или не та версия — не принимаем
    assert.equal(rs.adoptLegacyRuntime(make(17, 'Unknown Vendor'), 17), false);
    const wrong = make(8, 'Eclipse Adoptium', '17.0.1');
    assert.equal(rs.adoptLegacyRuntime(wrong, 8), false);
    assert.equal(rs.adoptLegacyRuntime(make(25, 'Eclipse Adoptium', '1.8.0_402').replace('25', '25'), 25), false);
    console.log('Legacy Java adoption tests passed');
} finally {
    fs.rmSync(root, {recursive: true, force: true});
}
