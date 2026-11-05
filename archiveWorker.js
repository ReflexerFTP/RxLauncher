'use strict';
const {Worker, isMainThread, workerData, parentPort} = require('node:worker_threads');
if (!isMainThread) {
    (async () => {
        const safety = require('./archiveSafety');
        if (workerData.type === 'zip') await safety.validateZip(workerData.archive, workerData.destination);
        else await safety.validateTar(workerData.archive, workerData.destination, {gzip: workerData.type === 'tgz'});
        await require('compressing')[workerData.type].uncompress(workerData.archive, workerData.destination);
    })().then(() => parentPort.postMessage({ok: true}), error => parentPort.postMessage({error: error.message}));
} else {
    if (process.type === 'renderer') {
        exports.unpack = (archive, destination, type) => require('electron').ipcRenderer.invoke('safe-archive-unpack', {archive, destination, type});
    } else {
    exports.unpack = (archive, destination, type) => new Promise((resolve, reject) => {
        if (!['zip', 'tar', 'tgz'].includes(type)) return reject(new Error('Unsupported archive type'));
        const worker = new Worker(__filename, {workerData: {archive, destination, type}, resourceLimits: {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32}});
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            error ? reject(error) : resolve(true);
        };
        const timer = setTimeout(() => finish(new Error('Archive extraction timed out')), 120000);
        worker.once('message', data => finish(data.error ? new Error(data.error) : null));
        worker.once('error', error => finish(error));
        worker.once('exit', code => finish(new Error(`Archive worker stopped (${code})`)));
    });
    }
}
