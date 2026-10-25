"use strict";

const packageJson = require("./package.json");

const publisherName = String(process.env.RXLAUNCHER_PUBLISHER_NAME || "").trim();
const certificateSha1 = String(process.env.RXLAUNCHER_CERTIFICATE_SHA1 || "").replace(/\s+/g, "").trim();
if (!publisherName || !/(^|,)\s*CN\s*=\s*[^,]+/i.test(publisherName)) {
    throw new Error("RXLAUNCHER_PUBLISHER_NAME must contain the full certificate Subject DN");
}

module.exports = {
    ...packageJson.build,
    extraMetadata: {
        ...(packageJson.build.extraMetadata || {}),
        rxlauncherTrustedUpdatePublisher: publisherName
    },
    win: {
        ...packageJson.build.win,
        forceCodeSigning: true,
        verifyUpdateCodeSignature: true,
        signtoolOptions: {
            ...packageJson.build.win.signtoolOptions,
            publisherName,
            ...(certificateSha1 ? {certificateSha1} : {})
        }
    }
};
