let path = require("path");
const {BrowserWindow, app} = require("electron");
const ejs = require('ejs-electron');

const MW_OPTIONS = {
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: path.join(__dirname, "../web/assets/icon.png"),
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    frame: false,
    // An opaque surface avoids repainting the entire transparent desktop layer
    // whenever the hero, news or animations change.
    transparent: false,
    backgroundColor: "#091012",
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, "../preload.js"),
        // Проверка орфографии лаунчеру не нужна, а словари занимают память
        spellcheck: false,
        // В установленном лаунчере DevTools нет — только при запуске из исходников
        devTools: !app.isPackaged,
    },
};

exports.create = (options, cb) => {
    if (typeof options === "function") {
        cb = options;
        options = {};
    }
    const safeOptions = options && typeof options === "object" ? options : {};
    const windowOptions = {...MW_OPTIONS};
    if (typeof safeOptions.icon === "string" && safeOptions.icon.length > 0) {
        windowOptions.icon = safeOptions.icon;
    }
    let winObj = new BrowserWindow(windowOptions);

    winObj.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    winObj.webContents.on("will-navigate", event => event.preventDefault());
    winObj.webContents.on("will-attach-webview", event => event.preventDefault());
    winObj.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ejs.listen();
    winObj.loadURL("file://" + __dirname + "/../web/index.ejs");

    winObj.once("ready-to-show", () => {
        winObj.show();
        cb(winObj);
    });
    return winObj;
};
