const {pathToFileURL} = require('node:url');
exports.createTrustedIpc = (ipcMain, getWindow, entryFile) => {
    const trustedUrl = pathToFileURL(entryFile).href;
    const isTrusted = event => {
        const window = getWindow();
        return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
            && event.senderFrame === event.sender.mainFrame
            && event.senderFrame.url.split(/[?#]/)[0] === trustedUrl);
    };
    return {
        onTrusted: (channel, handler) => ipcMain.on(channel, (event, ...args) => {
            if (!isTrusted(event)) { event.returnValue = {ok: false, error: 'Untrusted sender'}; return; }
            return handler(event, ...args);
        }),
        handleTrusted: (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
            if (!isTrusted(event)) throw new Error('Untrusted sender');
            return handler(event, ...args);
        })
    };
};
