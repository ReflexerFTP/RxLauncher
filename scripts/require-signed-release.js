'use strict';
module.exports = async context => {
    if (context.electronPlatformName !== 'win32') return;
    const config = context.packager.config;
    const publisher = config.extraMetadata?.rxlauncherTrustedUpdatePublisher;
    if (config.win?.forceCodeSigning !== true || config.win?.verifyUpdateCodeSignature !== true
        || typeof publisher !== 'string' || !/(^|,)\s*CN\s*=\s*[^,]+/i.test(publisher)
        || publisher !== String(process.env.RXLAUNCHER_PUBLISHER_NAME || '').trim()) {
        throw new Error('Unsigned Windows release blocked: use npm run build-win with the trusted signing configuration');
    }
    require('./sign-windows-artifact').verify(require('node:path').resolve(__dirname, '../resources/installer/build/RxUninstall.exe'));
};
