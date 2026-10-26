const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.whenReady().then(async () => {
    const win = new BrowserWindow({width: 1024, height: 1024, show: false,
        webPreferences: {nodeIntegration: true, contextIsolation: false, backgroundThrottling: false}});
    const output = process.env.RX_RPC_FRAME_DIR || path.resolve(__dirname, '../../../dist-rpc-frames');
    fs.mkdirSync(output, {recursive: true});
    ipcMain.on('frame', (_event, index, data) => {
        fs.writeFileSync(path.join(output, `${String(index).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
        if (index % 30 === 0) console.log('Frame', index);
        win.webContents.send('saved');
    });
    ipcMain.on('log', (_event, message) => console.log(message));
    ipcMain.on('done', (_event, code) => app.exit(code || 0));
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
    win.webContents.on('render-process-gone', (_event, details) => {console.error(details); app.exit(2);});
    await win.loadFile(path.join(__dirname, 'render.html'));
});
