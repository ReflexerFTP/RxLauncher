'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-electron-workers-'));
app.setPath('userData', path.join(temp, 'user-data'));
const windows = [];
let trustedWindow;
const timeout = setTimeout(() => { console.error('Worker smoke timed out'); app.exit(1); }, 30000);
const cleanup = () => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    const modules = path.join(temp, 'node_modules');
    if (fs.existsSync(modules)) fs.unlinkSync(modules);
    if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('rx-electron-workers-')) {
        try { fs.rmSync(temp, {recursive: true, force: true}); }
        catch (error) { if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; } // Chromium may still hold userData until process exit.
    }
};
app.whenReady().then(async () => {
    const source = path.join(temp, 'source'); fs.mkdirSync(path.join(source, 'web', 'js'), {recursive: true});
    for (const file of ['nbtWorker.js', 'archiveWorker.js', 'archiveSafety.js', 'tarGuard.js', 'modScanner.js', 'web/js/RxNbt.js']) fs.copyFileSync(path.join(root, file), path.join(source, file));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const asar = path.join(temp, 'workers.asar'); await require('@electron/asar').createPackage(source, asar);
    const entry = path.join(temp, 'index.html'); fs.writeFileSync(entry, '<title>Worker smoke</title>');
    const game = path.join(temp, 'game'), world = path.join(game, 'saves', 'fixture'); fs.mkdirSync(world, {recursive: true});
    const file = path.join(world, 'level.dat');
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from([10,0,0,10,0,4,68,97,116,97,8,0,9,76,101,118,101,108,78,97,109,101,0,4,83,97,102,101,0,0])));
    const zip = new (require('adm-zip'))(); zip.addFile('canary.txt', Buffer.from('SAFE'));
    const archive = path.join(temp, 'chosen.zip'); zip.writeZip(archive);
    const destination = path.join(game, 'unpacked');
    // Мод-стилер для проверки модов (worker из ASAR)
    const mods = path.join(game, 'mods'); fs.mkdirSync(mods);
    const evil = new (require('adm-zip'))(); evil.addFile('a/Send.class', Buffer.from('https://discord.com/api/webhooks/1/2'));
    evil.writeZip(path.join(mods, 'evil.jar'));
    const modScanner = require(path.join(asar, 'modScanner')).createModScanner({cachePath: path.join(temp, 'mod-scan-cache.json')});
    const policy = require('../workerFileSafety').createWorkerFileSafety(() => game); policy.approveDialog([archive]);
    const {handleTrusted} = require('../ipcSecurity').createTrustedIpc(ipcMain, () => trustedWindow, entry);
    handleTrusted('safe-nbt-read', (_event, value) => require(path.join(asar, 'nbtWorker')).readLevelDat(policy.readNbt(value)));
    handleTrusted('mod-scan', (_event, value) => modScanner.scan(value.dir));
    handleTrusted('safe-archive-unpack', (_event, value) => {
        const args = policy.archive(value); return require(path.join(asar, 'archiveWorker')).unpack(args.archive, args.destination, args.type);
    });
    const fromPreload = async (code, trusted) => {
        const channel = `result-${windows.length}`;
        const preload = path.join(temp, `${channel}.js`);
        fs.writeFileSync(preload, `const {ipcRenderer}=require('electron');(async()=>{${code}})().then(result=>ipcRenderer.send(${JSON.stringify(channel)},{result}),error=>ipcRenderer.send(${JSON.stringify(channel)},{error:error.message}));`);
        const win = new BrowserWindow({show: false, webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: false, preload}});
        windows.push(win); if (trusted) trustedWindow = win;
        const result = new Promise(resolve => ipcMain.once(channel, (event, value) => { if (event.sender === win.webContents) resolve(value); }));
        await win.loadFile(entry); return result;
    };
    const result = await fromPreload(`
        const root=await require(${JSON.stringify(path.join(asar, 'nbtWorker'))}).readLevelDat(${JSON.stringify(file)});
        if(root[''].value.Data.value.LevelName.value!=='Safe')throw Error('Invalid world');
        const unpack=require(${JSON.stringify(path.join(asar, 'archiveWorker'))}).unpack;
        await unpack(${JSON.stringify(archive)},${JSON.stringify(destination)},'zip');
        if(require('fs').readFileSync(${JSON.stringify(path.join(destination, 'canary.txt'))},'utf8')!=='SAFE')throw Error('Invalid extraction');
        let denied=false;try{await unpack(${JSON.stringify(archive)},${JSON.stringify(path.join(temp, 'forbidden'))},'zip');}catch(_){denied=true;}
        if(!denied)throw Error('External destination accepted');
        const scan=await ipcRenderer.invoke('mod-scan',{dir:${JSON.stringify(mods)}});
        if(scan.files[0]?.verdict!=='danger'||!scan.files[0].findings.some(item=>item.id==='discordWebhook'))throw Error('Mod scan missed the webhook: '+JSON.stringify(scan));
        return true;`, true);
    if (result.result !== true) throw Error(result.error || 'Trusted worker calls failed');
    const denied = await fromPreload(`try{await ipcRenderer.invoke('safe-nbt-read',${JSON.stringify(file)});return false;}catch(error){return /Untrusted sender/.test(error.message);}`, false);
    if (denied.result !== true) throw Error('Untrusted renderer accepted');
    console.log(JSON.stringify({ok: true, nbtFromAsar: true, archiveFromAsar: true, modScanFromAsar: true, rendererIpc: true, outsideDestinationDenied: true, untrustedWindowDenied: true}));
    clearTimeout(timeout); cleanup(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); cleanup(); app.exit(1); });
