"use strict";

const path = require("path");
const {spawnSync} = require("child_process");

const root = path.resolve(__dirname, "..");
const certificateLink = String(process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
const certificatePassword = String(process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || "");
const certificateSha1 = String(process.env.RXLAUNCHER_CERTIFICATE_SHA1 || "").replace(/\s+/g, "").trim();
const publisherName = String(process.env.RXLAUNCHER_PUBLISHER_NAME || "").trim();
const pfxCredentialsReady = Boolean(certificateLink && certificatePassword);
const certificateStoreReady = /^[a-f0-9]{40}$/i.test(certificateSha1);

if ((!pfxCredentialsReady && !certificateStoreReady) || !publisherName) {
    console.error("Signed Windows build blocked: provide a PFX pair or RXLAUNCHER_CERTIFICATE_SHA1, plus RXLAUNCHER_PUBLISHER_NAME.");
    console.error("Use a trusted RSA code-signing certificate. Self-signed certificates are not release credentials.");
    process.exit(2);
}

const builder = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");
const config = path.join(root, "electron-builder.signed.config.js");
const build = spawnSync(process.execPath, [builder, "build", "--win", "--publish", "never", "--config", config], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

const verifier = path.join(root, "scripts", "verify-windows-signatures.ps1");
const verify = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", verifier
], {cwd: root, stdio: "inherit"});
if (verify.error) throw verify.error;
if (verify.status !== 0) process.exit(verify.status || 1);
