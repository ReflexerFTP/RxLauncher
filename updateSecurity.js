"use strict";

const path = require("path");
const {execFile} = require("child_process");

class UpdateSecurityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "UpdateSecurityError";
        this.code = code;
    }
}

const normalizePublisherNames = (value) => {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .filter(item => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean))];
};

const POWERSHELL_SIGNATURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:RXLAUNCHER_UPDATE_FILE
$result = [pscustomobject]@{
    Status = [string]$signature.Status
    Subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
    Thumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { '' }
    TimestampSubject = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { '' }
}
$result | ConvertTo-Json -Compress
`;

const normalizeSubject = value => String(value || "").trim().toLocaleLowerCase("en-US");
const getWindowsPowerShellPath = (environment = process.env) => {
    const systemRoot = String(environment.SystemRoot || environment.WINDIR || "").trim();
    if (!path.win32.isAbsolute(systemRoot)) return "";
    return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
};

const createStrictWindowsSignatureVerifier = (trustedPublisherNames, executor = execFile) => {
    const trusted = normalizePublisherNames(trustedPublisherNames);
    return async (_publisherNames, updateFile) => {
        try {
            if (trusted.length === 0) return "No trusted update publisher is configured";
            if (typeof updateFile !== "string" || path.extname(updateFile).toLowerCase() !== ".exe" || !path.isAbsolute(updateFile)) {
                return "Update path is not an absolute Windows executable path";
            }
            const powershellPath = getWindowsPowerShellPath();
            if (!powershellPath) return "Trusted system PowerShell path is unavailable";

            const encodedCommand = Buffer.from(POWERSHELL_SIGNATURE_SCRIPT, "utf16le").toString("base64");
            const output = await new Promise((resolve, reject) => {
                executor(powershellPath, [
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy", "Bypass",
                    "-EncodedCommand", encodedCommand
                ], {
                    windowsHide: true,
                    timeout: 20000,
                    env: {...process.env, RXLAUNCHER_UPDATE_FILE: updateFile},
                    maxBuffer: 1024 * 1024
                }, (error, stdout, stderr) => {
                    if (error) return reject(error);
                    if (String(stderr || "").trim()) return reject(new Error(String(stderr).trim()));
                    resolve(String(stdout || "").trim());
                });
            });

            const signature = JSON.parse(output);
            if (signature.Status !== "Valid") return `Authenticode status is ${signature.Status || "missing"}`;
            const actualSubject = normalizeSubject(signature.Subject);
            if (!trusted.some(subject => normalizeSubject(subject) === actualSubject)) {
                return "Authenticode publisher does not match the trusted RxLauncher publisher";
            }
            if (!String(signature.TimestampSubject || "").trim()) return "Trusted Authenticode timestamp is missing";
            return null;
        } catch (error) {
            return `Strict Authenticode verification failed: ${error.message || String(error)}`;
        }
    };
};

const assertSecureWindowsUpdater = async (
    updater,
    platform = process.platform,
    embeddedTrustedPublisherNames = undefined
) => {
    if (platform !== "win32") {
        return {enabled: false, publisherNames: []};
    }
    const embeddedPublishers = normalizePublisherNames(embeddedTrustedPublisherNames);
    if (embeddedPublishers.length === 0) {
        throw new UpdateSecurityError(
            "EMBEDDED_TRUST_ANCHOR_MISSING",
            "Signed application does not contain an embedded trusted update publisher"
        );
    }
    if (!updater || typeof updater.checkForUpdates !== "function") {
        throw new UpdateSecurityError("UPDATER_UNAVAILABLE", "Windows updater is unavailable");
    }
    if (typeof updater.verifyUpdateCodeSignature !== "function") {
        throw new UpdateSecurityError(
            "SIGNATURE_VERIFIER_UNAVAILABLE",
            "Windows update signature verifier is unavailable"
        );
    }

    const configValue = updater.configOnDisk?.value;
    if (!configValue || typeof configValue.then !== "function") {
        throw new UpdateSecurityError(
            "UPDATE_CONFIG_UNAVAILABLE",
            "Packaged update configuration is unavailable"
        );
    }

    const config = await configValue;
    const publisherNames = normalizePublisherNames(config?.publisherName);
    if (publisherNames.length === 0) {
        throw new UpdateSecurityError(
            "TRUSTED_PUBLISHER_MISSING",
            "Signed update publisher is missing from app-update.yml"
        );
    }
    const embeddedSet = new Set(embeddedPublishers.map(normalizeSubject));
    const configSet = new Set(publisherNames.map(normalizeSubject));
    if (embeddedSet.size !== configSet.size || [...embeddedSet].some(subject => !configSet.has(subject))) {
        throw new UpdateSecurityError(
            "PUBLISHER_CONFIG_MISMATCH",
            "app-update.yml publisher does not match the publisher embedded in the signed application"
        );
    }

    return {enabled: true, publisherNames: embeddedPublishers};
};

module.exports = {
    UpdateSecurityError,
    normalizePublisherNames,
    assertSecureWindowsUpdater,
    createStrictWindowsSignatureVerifier,
    getWindowsPowerShellPath
};
