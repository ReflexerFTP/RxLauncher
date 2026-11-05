'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const RECEIPT = '.rx-runtime.json';
const AUTHLIB = Object.freeze({version: '1.2.8', size: 349681, sha256: '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10',
    url: 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.8/authlib-injector-1.2.8.jar'});
const inside = (root, file) => {
    const rel = path.relative(root, file);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const hash = file => {
    const digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(256 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
        return digest.digest('hex');
    } finally { fs.closeSync(fd); }
};
function runtimeFiles(root) {
    const files = Object.create(null), realRoot = fs.realpathSync(root);
    let count = 0, bytes = 0;
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (++count > 50000) throw new Error('Too many Java runtime files');
            const full = path.join(dir, entry.name), rel = path.relative(root, full).split(path.sep).join('/');
            if (rel === RECEIPT) continue;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) {
                if (!inside(realRoot, fs.realpathSync(full))) throw new Error('Java runtime link leaves its directory');
                files[rel] = {link: fs.readlinkSync(full)};
            } else if (stat.isDirectory()) walk(full);
            else if (stat.isFile()) {
                if ((bytes += stat.size) > 8 * 1024 ** 3) throw new Error('Java runtime is too large');
                files[rel] = {size: stat.size, sha256: hash(full)};
            } else throw new Error('Unsupported Java runtime file');
        }
    };
    walk(root);
    return files;
}
function writeRuntimeReceipt(root, release) {
    const receipt = {schema: 1, release: release.release, major: Number(release.major), packageSha256: release.sha256, files: runtimeFiles(root)};
    if (!/^[a-f0-9]{64}$/i.test(receipt.packageSha256) || !Object.keys(receipt.files).length) throw new Error('Missing verified Java files');
    fs.writeFileSync(path.join(root, RECEIPT), JSON.stringify(receipt));
}
function validateRuntime(root, major, expectedRelease = null) {
    try {
        if (fs.lstatSync(root).isSymbolicLink()) return false;
        const file = path.join(root, RECEIPT), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 12 * 1024 ** 2) return false;
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (receipt.schema !== 1 || receipt.major !== Number(major) || typeof receipt.release !== 'string'
            || (expectedRelease && receipt.release !== expectedRelease) || !/^[a-f0-9]{64}$/i.test(receipt.packageSha256)) return false;
        const actual = runtimeFiles(root);
        return JSON.stringify(actual) === JSON.stringify(receipt.files);
    } catch (_) { return false; }
}
async function resolveJavaRelease(info, getJson) {
    const major = Number(info.version);
    if (!Number.isSafeInteger(major) || major < 8 || major > 99) throw new Error('Unsupported Java version');
    const query = new URLSearchParams({architecture: info.platformArch, image_type: 'jdk', os: info.platformName});
    const data = await getJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query}`, {timeout: 15000, maxBytes: 1024 * 1024});
    const row = Array.isArray(data) ? data.find(item => item.version?.major === major && item.binary?.os === info.platformName
        && item.binary?.architecture === info.platformArch && item.binary?.image_type === 'jdk') : null;
    const pkg = row?.binary?.package;
    const url = new URL(pkg?.link || 'https://invalid.invalid');
    if (!pkg || !/^[a-f0-9]{64}$/i.test(pkg.checksum) || !Number.isSafeInteger(pkg.size) || pkg.size <= 0 || pkg.size > 2 * 1024 ** 3
        || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
        || !url.pathname.startsWith(`/adoptium/temurin${major}-binaries/releases/download/`) || typeof row.release_name !== 'string') {
        throw new Error('Untrusted Java release metadata');
    }
    return {...info, major, release: row.release_name, url: url.href, sha256: pkg.checksum.toLowerCase(), size: pkg.size};
}
module.exports = {AUTHLIB, RECEIPT, runtimeFiles, writeRuntimeReceipt, validateRuntime, resolveJavaRelease};
