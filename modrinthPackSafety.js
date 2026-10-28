const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');

const BLOCKED_TOP_LEVEL = new Set([
    'manifest.json', 'modrinth.index.json', 'saves', 'worlds', 'screenshots',
    'rx-mod-backups', 'versions', 'javadownloads', 'cache', 'logs',
    'options.txt', 'optionsof.txt', 'servers.dat', 'usercache.json', 'usernamecache.json'
]);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const LOCAL_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4]]) {
    LOCAL_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['fec0::',10],['ff00::',8]]) {
    LOCAL_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

function safePackPath(value, {allowBackslashes = false} = {}) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 1024) throw new Error('Invalid pack file path');
    if (!allowBackslashes && value.includes('\\')) throw new Error('Unsafe pack file path');
    const portable = value.replaceAll('\\', '/');
    if (portable.startsWith('/') || path.win32.isAbsolute(value) || /[\x00-\x1f:]/.test(portable)) {
        throw new Error('Unsafe pack file path');
    }
    const parts = portable.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_DEVICE.test(part))) {
        throw new Error('Unsafe pack file path');
    }
    if (BLOCKED_TOP_LEVEL.has(parts[0].toLowerCase())) throw new Error('Pack file targets launcher or player data');
    return parts.join(path.sep);
}

function safePackUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new Error('Invalid pack download URL'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        throw new Error('Invalid pack download URL');
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    const ipVersion = net.isIP(host);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
        || (ipVersion && LOCAL_ADDRESSES.check(host, ipVersion === 4 ? 'ipv4' : 'ipv6'))) {
        throw new Error('Pack download URL points to a local network');
    }
    return parsed.toString();
}

// Адрес из локальной сети (в том числе IPv4 внутри IPv6: ::ffff:127.0.0.1)
function isLocalAddress(address) {
    const host = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mapped) return isLocalAddress(mapped[1]);
    const version = net.isIP(host);
    return !version || LOCAL_ADDRESSES.check(host, version === 4 ? 'ipv4' : 'ipv6');
}

// DNS для загрузок сборки: проверяется каждый адрес, к которому реально будет соединение.
// Обычное имя может указывать на 127.0.0.1 или внутреннюю сеть — такое соединение не открываем.
// Сокет подключается ровно к проверенному адресу, имя остаётся для TLS (SNI и сертификат)
function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const settings = typeof options === 'number' ? {family: options} : {...(options || {})};
    dns.lookup(hostname, {...settings, all: true}, (error, addresses) => {
        if (error) return callback(error);
        const list = Array.isArray(addresses) ? addresses : [];
        if (!list.length || list.some(item => isLocalAddress(item.address))) {
            const blocked = new Error('Pack download URL resolves to a local network');
            blocked.code = 'ELOCALADDRESS';
            return callback(blocked);
        }
        if (settings.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

function safePackHashes(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing pack file hash');
    const hashes = {};
    for (const [name, length] of [['sha512', 128], ['sha256', 64], ['sha1', 40]]) {
        if (typeof value[name] === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value[name])) {
            hashes[name] = value[name].toLowerCase();
        }
    }
    if (!Object.keys(hashes).length) throw new Error('Missing or invalid pack file hash');
    return hashes;
}

function safePackVersion(value) {
    if (typeof value !== 'string' || !VERSION.test(value) || value.endsWith('.')) throw new Error('Invalid pack version');
    return value;
}

module.exports = {safePackPath, safePackUrl, safePackHashes, safePackVersion, safeLookup, isLocalAddress};
