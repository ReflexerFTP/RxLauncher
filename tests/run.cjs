const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');
const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).sort();
let failures = 0;
for (const file of [...files.map(file => path.join('tests', file)), 'verifyTranslations.js']) {
    const result = spawnSync(process.execPath, [file], {cwd: root, encoding: 'utf8', timeout: 120000});
    const ok = result.status === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${file}`);
    if (!ok) { failures++; console.error(result.error?.message || (result.stdout + result.stderr).slice(-5000)); }
}
console.log(`${files.length + 1 - failures}/${files.length + 1} checks passed`);
process.exitCode = failures ? 1 : 0;
