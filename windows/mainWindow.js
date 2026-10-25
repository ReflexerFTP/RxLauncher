let path = require("path");
const {BrowserWindow} = require("electron");
const ejs = require('ejs-electron');

const MW_OPTIONS = {
    width: 1400,
    height: 900,
    minWidth: 1150,
    minHeight: 750,
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
        nodeIntegration: true,
        contextIsolation: false,
        // Проверка орфографии лаунчеру не нужна, а словари занимают память
        spellcheck: false,
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

    ejs.listen();
    winObj.loadURL("file://" + __dirname + "/../web/index.ejs");

    winObj.once("ready-to-show", () => {
        winObj.show();
        cb(winObj);
    });
};
