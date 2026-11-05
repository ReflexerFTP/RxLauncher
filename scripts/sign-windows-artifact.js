'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {execFileSync} = require('node:child_process');
const {getWindowsPowerShellPath} = require('../updateSecurity');

function verify(file) {
    if (!path.isAbsolute(file) || !/\.exe$/i.test(file)) throw new Error('Expected absolute EXE path');
    const publisher = String(process.env.RXLAUNCHER_PUBLISHER_NAME || '').trim();
    if (!publisher) throw new Error('Expected release publisher is required');
    const script = `$ErrorActionPreference='Stop'
$s=Get-AuthenticodeSignature -LiteralPath $env:RX_VERIFY_ARTIFACT
if ($s.Status -ne 'Valid' -or -not $s.SignerCertificate -or -not $s.TimeStamperCertificate -or $s.SignerCertificate.Subject.Trim() -ne $env:RX_VERIFY_PUBLISHER.Trim()) { throw 'Release signature/publisher/timestamp verification failed' }`;
    execFileSync(getWindowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        {windowsHide: true, timeout: 30000, stdio: 'pipe', env: {...process.env, RX_VERIFY_ARTIFACT: file, RX_VERIFY_PUBLISHER: publisher}});
}
function findSignTool() {
    const override = process.env.RX_SIGNTOOL_PATH;
    if (override) {
        if (!path.isAbsolute(override) || !fs.statSync(override).isFile()) throw new Error('RX_SIGNTOOL_PATH must be an absolute executable path');
        return override;
    }
    const base = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
    if (fs.existsSync(base)) {
        for (const version of fs.readdirSync(base).sort().reverse()) {
            const file = path.join(base, version, 'x64', 'signtool.exe');
            if (fs.existsSync(file)) return file;
        }
    }
    throw new Error('Windows SDK signtool.exe is required; set RX_SIGNTOOL_PATH to its absolute path');
}
function sign(file) {
    const publisher = String(process.env.RXLAUNCHER_PUBLISHER_NAME || '').trim();
    if (!publisher || !path.isAbsolute(file) || !/\.exe$/i.test(file)) throw new Error('Missing release publisher or executable');
    const sha1 = String(process.env.RXLAUNCHER_CERTIFICATE_SHA1 || '').replace(/\s/g, '');
    const args = ['sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256'];
    if (/^[a-f0-9]{40}$/i.test(sha1)) args.push('/sha1', sha1);
    else {
        let certificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK || '';
        if (certificate.startsWith('file:')) certificate = fileURLToPath(certificate);
        if (!path.isAbsolute(certificate) || !fs.existsSync(certificate)) throw new Error('Signing custom EXEs requires a local PFX path or certificate store thumbprint');
        args.push('/f', certificate);
        const password = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;
        if (password) args.push('/p', password);
    }
    args.push(file);
    // Do not include signing arguments or credential values in error messages.
    try { execFileSync(findSignTool(), args, {windowsHide: true, timeout: 120000, stdio: 'pipe'}); }
    catch (_) { throw new Error('Windows artifact signing failed; inspect certificate access and timestamp service'); }
    verify(file);
}
module.exports = {sign, verify, findSignTool};
