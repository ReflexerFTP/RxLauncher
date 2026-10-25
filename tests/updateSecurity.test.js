const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    normalizePublisherNames,
    assertSecureWindowsUpdater,
    createStrictWindowsSignatureVerifier,
    getWindowsPowerShellPath
} = require("../updateSecurity");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));

const updater = (publisherName, verifier = async () => null) => ({
    checkForUpdates: async () => true,
    verifyUpdateCodeSignature: verifier,
    configOnDisk: {value: Promise.resolve({provider: "generic", publisherName})}
});

(async () => {
    assert.deepStrictEqual(normalizePublisherNames("  CN=MaxRx  "), ["CN=MaxRx"]);
    assert.deepStrictEqual(
        normalizePublisherNames(["CN=MaxRx", "", "CN=MaxRx", "CN=Backup"]),
        ["CN=MaxRx", "CN=Backup"]
    );

    const secure = await assertSecureWindowsUpdater(updater("CN=MaxRx"), "win32", "CN=MaxRx");
    assert.deepStrictEqual(secure, {enabled: true, publisherNames: ["CN=MaxRx"]});
    assert.deepStrictEqual(
        await assertSecureWindowsUpdater(null, "linux"),
        {enabled: false, publisherNames: []}
    );

    await assert.rejects(
        assertSecureWindowsUpdater(updater(undefined), "win32", "CN=MaxRx"),
        error => error.code === "TRUSTED_PUBLISHER_MISSING"
    );

    const validExecutor = (_command, _args, _options, callback) => callback(null, JSON.stringify({
        Status: "Valid",
        Subject: "CN=MaxRx, O=RxLauncher",
        Thumbprint: "ABC123",
        TimestampSubject: "CN=Trusted Timestamp"
    }), "");
    const strictVerifier = createStrictWindowsSignatureVerifier(["CN=MaxRx, O=RxLauncher"], validExecutor);
    assert.strictEqual(await strictVerifier([], "C:\\Temp\\RxLauncher Setup.exe"), null);
    assert.match(getWindowsPowerShellPath({SystemRoot: "C:\\Windows"}), /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.strictEqual(getWindowsPowerShellPath({SystemRoot: "relative"}), "");

    const wrongPublisherExecutor = (_command, _args, _options, callback) => callback(null, JSON.stringify({
        Status: "Valid",
        Subject: "CN=NotRxLauncher",
        Thumbprint: "DEF456",
        TimestampSubject: "CN=Trusted Timestamp"
    }), "");
    assert.match(
        await createStrictWindowsSignatureVerifier(["CN=MaxRx"], wrongPublisherExecutor)([], "C:\\Temp\\Update.exe"),
        /does not match/
    );

    const noTimestampExecutor = (_command, _args, _options, callback) => callback(null, JSON.stringify({
        Status: "Valid",
        Subject: "CN=MaxRx",
        Thumbprint: "ABC123",
        TimestampSubject: ""
    }), "");
    assert.match(
        await createStrictWindowsSignatureVerifier(["CN=MaxRx"], noTimestampExecutor)([], "C:\\Temp\\Update.exe"),
        /timestamp is missing/
    );
    await assert.rejects(
        assertSecureWindowsUpdater(updater("CN=MaxRx", null), "win32", "CN=MaxRx"),
        error => error.code === "SIGNATURE_VERIFIER_UNAVAILABLE"
    );
    await assert.rejects(
        assertSecureWindowsUpdater({checkForUpdates: async () => true}, "win32", "CN=MaxRx"),
        error => error.code === "SIGNATURE_VERIFIER_UNAVAILABLE"
    );
    await assert.rejects(
        assertSecureWindowsUpdater(updater("CN=ChangedPublisher"), "win32", "CN=MaxRx"),
        error => error.code === "PUBLISHER_CONFIG_MISMATCH"
    );
    await assert.rejects(
        assertSecureWindowsUpdater(updater("CN=MaxRx"), "win32"),
        error => error.code === "EMBEDDED_TRUST_ANCHOR_MISSING"
    );

    assert.strictEqual(packageJson.build.win.forceCodeSigning, true);
    assert.strictEqual(packageJson.build.win.verifyUpdateCodeSignature, true);
    assert.deepStrictEqual(packageJson.build.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
    assert.strictEqual(packageJson.scripts["build-win"], "node ./scripts/build-signed-win.js");
    assert.ok(fs.existsSync(path.join(root, "electron-builder.signed.config.js")));
    const signedConfigSource = fs.readFileSync(path.join(root, "electron-builder.signed.config.js"), "utf8");
    assert.match(signedConfigSource, /rxlauncherTrustedUpdatePublisher:\s*publisherName/);
    assert.match(signedConfigSource, /certificateSha1/);

    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert.match(appSource, /assertSecureWindowsUpdater\(autoUpdater, process\.platform, pjson\.rxlauncherTrustedUpdatePublisher\)/);
    assert.match(appSource, /if \(!secureUpdaterEnabled \|\| !verifiedUpdateReady\)/);

    const verifierScript = fs.readFileSync(path.join(root, "scripts", "verify-windows-signatures.ps1"), "utf8");
    assert.match(verifierScript, /Get-AuthenticodeSignature/);
    assert.match(verifierScript, /TimeStamperCertificate/);
    assert.match(verifierScript, /RXLAUNCHER_PUBLISHER_NAME/);

    console.log("Update signing security tests passed");
})().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
