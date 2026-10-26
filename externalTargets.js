const fs = require('node:fs');
const path = require('node:path');
exports.classifyExternalTarget = value => {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid external target');
    if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        if (url.username || url.password) throw new Error('Credentials in external URLs are not allowed');
        return {kind: 'url', target: url.href};
    }
    if (!path.isAbsolute(value)) throw new Error('Unsupported external protocol');
    const target = fs.realpathSync(value);
    const stat = fs.statSync(target);
    if (!stat.isDirectory() && !(stat.isFile() && /\.(txt|log)$/i.test(target))) throw new Error('Unsupported external file');
    return {kind: 'path', target};
};
