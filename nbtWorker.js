'use strict';
const {Worker, isMainThread, workerData, parentPort} = require('node:worker_threads');
if (!isMainThread) {
    try { parentPort.postMessage({root: require('./web/js/RxNbt').readLevelDat(workerData.file)}); }
    catch (error) { parentPort.postMessage({error: error.message}); }
} else {
    if (process.type === 'renderer') {
        exports.readLevelDat = file => require('electron').ipcRenderer.invoke('safe-nbt-read', file);
    } else {
    exports.readLevelDat = file => new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {workerData: {file}, resourceLimits: {maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16}});
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('NBT parsing timed out')), 4000);
        worker.once('message', data => finish(data.error ? new Error(data.error) : null, data.root));
        worker.once('error', error => finish(error));
        worker.once('exit', code => finish(new Error(`NBT worker stopped (${code})`)));
    });
    }
}
