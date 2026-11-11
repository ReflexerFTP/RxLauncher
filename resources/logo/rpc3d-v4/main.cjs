// Рендер 3D-аватарки Discord RPC v4: electron resources/logo/rpc3d-v4/main.cjs
// Всё (кадры, свечение, сборка GIF) делается на странице render.html; см. README.md
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.whenReady().then(async () => {
    const win = new BrowserWindow({width: 1024, height: 1024, show: false,
        webPreferences: {nodeIntegration: true, contextIsolation: false, backgroundThrottling: false}});
    ipcMain.on('log', (_event, message) => console.log(message));
    ipcMain.on('done', (_event, code) => app.exit(code || 0));
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
    win.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(2); });
    await win.loadFile(path.join(__dirname, 'render.html'));
});
