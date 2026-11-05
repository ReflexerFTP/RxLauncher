'use strict';
// Проверка модов на стилеры. В .jar (и во вложенных jar) ищем признаки того, что мод умеет отправлять данные
// в Discord (вебхук, бот), Telegram-бота и другие «почтовые ящики», крадёт токены, пароли браузеров, сессию
// Minecraft, кошельки, закрепляется в автозапуске или запускает скрытые команды.
// Строки ищутся как есть, задом наперёд, в hex и base64, а также в массивах байтов/символов из байткода
// (так прятал адреса fractureiser). Один проход по байтам автоматом Ахо — Корасик, работа — в worker с лимитами.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Worker, isMainThread, workerData, parentPort} = require('node:worker_threads');

// Меняется вместе с сигнатурами: старые результаты из кеша тогда перепроверяются
const VERSION = 1;

// kind: exfil — куда можно отправить данные; theft — что можно украсть; session — доступ к сессии Minecraft;
// exec — скрытый запуск и автозапуск; loader — загрузка кода; obf — запутанный код.
// strong — опасно само по себе; encoded — искать ещё и в base64/hex
const SIGNATURES = [
    // ---- Discord ----
    {id: 'discordWebhook', kind: 'exfil', strong: true, encoded: true, needles: [
        'discord.com/api/webhooks', 'discordapp.com/api/webhooks', 'canary.discord.com/api/webhooks', 'ptb.discord.com/api/webhooks',
        '/api/v6/webhooks/', '/api/v8/webhooks/', '/api/v9/webhooks/', '/api/v10/webhooks/']},
    {id: 'discordWebhookLib', kind: 'exfil', strong: true, needles: [
        'club/minnced/discord/webhook', 'com/mrpowergamerbr/temmiewebhook', 'webhookclientbuilder', 'discordwebhook']},
    {id: 'discordBotApi', kind: 'exfil', strong: true, encoded: true, needles: [
        'discord.com/api/channels', 'discordapp.com/api/channels', '/api/v8/channels/', '/api/v9/channels/', '/api/v10/channels/',
        'gateway.discord.gg', 'discord.com/api/users/@me', 'discordapp.com/api/users/@me', '/api/v9/users/@me', '/api/v10/users/@me']},
    {id: 'discordBotLib', kind: 'exfil', needles: ['net/dv8tion/jda', 'discord4j/core', 'org/javacord/api', 'de/btobastian/javacord']},
    {id: 'discordCdn', kind: 'exfil', needles: ['cdn.discordapp.com/attachments', 'media.discordapp.net/attachments']},
    // ---- Telegram ----
    {id: 'telegramBotApi', kind: 'exfil', strong: true, encoded: true, needles: ['api.telegram.org']},
    {id: 'telegramBotLib', kind: 'exfil', needles: ['org/telegram/telegrambots', 'com/pengrad/telegrambot', 'org/telegram/abilitybots']},
    // ---- Другие места, куда сливают данные или откуда качают вторую часть ----
    {id: 'otherExfil', kind: 'exfil', encoded: true, needles: [
        'hooks.slack.com', 'webhook.site', 'pipedream.net', 'requestbin', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
        'pastebin.com/raw', 'hastebin.com', 'transfer.sh', 'gofile.io', 'anonfiles', 'filebin.net', 'catbox.moe', 'litterbox.catbox']},
    {id: 'ipLookup', kind: 'exfil', needles: [
        'api.ipify.org', 'ipinfo.io', 'ip-api.com', 'checkip.amazonaws.com', 'icanhazip.com', 'ifconfig.me', 'myexternalip.com', 'ipapi.co', 'wtfismyip']},
    {id: 'rawIpUrl', kind: 'exfil', needles: [], regex: /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\//},
    // ---- Что крадут ----
    {id: 'discordToken', kind: 'theft', strong: true, encoded: true, needles: [
        'dqw4w9wgxcq:', 'local storage\\leveldb', 'local storage/leveldb', 'mfa\\.[\\w-]{84}', ']{24}\\.[\\w-]{6}', ']{26}\\.[\\w-]{6}',
        ']{6}\\.[\\w-]{27}', ']{6}\\.[\\w-]{38}']},
    {id: 'discordApps', kind: 'theft', needles: ['discordcanary', 'discordptb', 'lightcord']},
    {id: 'browserData', kind: 'theft', needles: [
        'login data', 'local state', 'encrypted_key', 'os_crypt', 'web data', 'google\\chrome\\user data', 'yandex\\yandexbrowser',
        'opera software', 'bravesoftware', 'microsoft\\edge\\user data', 'mozilla\\firefox\\profiles', 'logins.json', 'key4.db',
        'vivaldi\\user data', 'chromium\\user data', 'cookies.sqlite']},
    {id: 'cryptUnprotect', kind: 'theft', needles: ['cryptunprotectdata']},
    {id: 'rxAccounts', kind: 'theft', strong: true, encoded: true, needles: ['rx_accounts.json', 'rx-account.bin']},
    // Названия лаунчеров встречаются в проверках совместимости (Sodium), поэтому ищем именно пути к файлам аккаунтов
    {id: 'mcAccounts', kind: 'theft', needles: [
        'launcher_accounts.json', 'launcher_accounts_microsoft_store.json', 'launcher_msa_credentials', 'tlauncherprofiles.json',
        'feather/accounts.json', 'feather\\accounts.json', 'microsoft_accounts.json', 'prismlauncher/accounts.json',
        'prismlauncher\\accounts.json', 'polymc/accounts.json', 'polymc\\accounts.json', 'multimc/accounts.json',
        'multimc\\accounts.json', 'settings/game/accounts.json', 'settings\\game\\accounts.json', 'command_history.txt']},
    {id: 'wallets', kind: 'theft', needles: [
        'exodus.wallet', 'exodus\\exodus', 'electrum\\wallets', 'wallet.dat', 'nkbihfbeogaeaoehlefnkodbefgpgknn', 'ethereum\\keystore',
        'coinomi', 'atomic\\local storage', 'metamask']},
    {id: 'telegramSession', kind: 'theft', needles: ['telegram desktop\\tdata', 'telegram desktop/tdata', '\\tdata\\', 'telegram desktop']},
    {id: 'steam', kind: 'theft', needles: ['loginusers.vdf', 'steam\\config\\config.vdf']},
    {id: 'screenCapture', kind: 'theft', needles: ['createscreencapture']},
    // Токен сессии Minecraft: intermediary (Fabric/Quilt), SRG (старый Forge); для Mojang-имён (NeoForge/Forge 1.20.5+)
    // нужны и класс User, и getAccessToken в одном классе — само имя метода есть во многих OAuth-библиотеках
    {id: 'session', kind: 'session', needles: ['method_1674', 'func_148254_d']},
    {id: 'sessionUser', kind: 'probe', needles: ['net/minecraft/client/user']},
    {id: 'sessionGetter', kind: 'probe', needles: ['getaccesstoken']},
    // ---- Скрытый запуск и автозапуск ----
    {id: 'autorun', kind: 'exec', strong: true, encoded: true, needles: [
        'currentversion\\run', 'currentversion/run', 'start menu\\programs\\startup', 'programs\\startup', 'schtasks', 'reg add ']},
    {id: 'hiddenShell', kind: 'exec', strong: true, encoded: true, needles: [
        '-encodedcommand', 'powershell -e ', 'powershell.exe -e ', '-windowstyle hidden', ' -w hidden', 'iex(', 'iex (',
        'invoke-expression', 'downloadstring', 'invoke-webrequest', 'add-mppreference', 'set-mppreference', 'exclusionpath',
        'disablerealtimemonitoring', 'mshta', 'certutil -urlcache', 'certutil.exe -urlcache', 'bitsadmin']},
    {id: 'shell', kind: 'exec', needles: ['powershell', 'cmd.exe', 'cmd /c', 'wscript', 'cscript']},
    {id: 'fractureiser', kind: 'exec', strong: true, encoded: true, needles: [
        '85.217.144.130', '107.189.3.101', 'files-8ie.pages.dev', 'dev/neko/nekoclient', 'dev/neko/nekoinjector', 'skyrage']},
    {id: 'remoteLoader', kind: 'loader', needles: ['urlclassloader', 'defineclass']},
    // ---- Запутанный код (на Modrinth запрещён — так прячут стилеры) ----
    {id: 'obfuscator', kind: 'obf', needles: [
        'skidfuscator', 'branchlock', 'allatori', 'zelix', 'paramorphism', 'superblaubeere', 'bozar', 'obzcure', 'jnic/', 'jnic.']}
];
const BY_ID = Object.fromEntries(SIGNATURES.map(item => [item.id, item]));

// ---------- автомат Ахо — Корасик: все строки и их варианты за один проход ----------
const LOWER = Uint8Array.from({length: 256}, (_, i) => i >= 65 && i <= 90 ? i + 32 : i);

// Варианты строки: как есть, задом наперёд, hex и base64 при трёх сдвигах (края, зависящие от соседних байтов, отрезаны)
const variants = (needle, encoded) => {
    const list = [{text: needle, form: 'plain'}];
    if (needle.length >= 8) list.push({text: [...needle].reverse().join(''), form: 'reversed'});
    if (!encoded) return list;
    list.push({text: Buffer.from(needle, 'latin1').toString('hex'), form: 'hex'});
    for (let shift = 0; shift < 3; shift++) {
        const b64 = Buffer.from('\0'.repeat(shift) + needle, 'latin1').toString('base64').replace(/=+$/, '');
        const core = b64.slice(shift ? 4 : 0, b64.length - 4).toLowerCase();
        if (core.length >= 12) list.push({text: core, form: 'base64'});
    }
    return list;
};

const buildMatcher = () => {
    const patterns = [];
    for (const signature of SIGNATURES) {
        for (const needle of signature.needles) {
            for (const variant of variants(needle.toLowerCase(), signature.encoded)) patterns.push({id: signature.id, needle, form: variant.form, bytes: Buffer.from(variant.text, 'latin1')});
        }
    }
    // https://1… — адрес по IP; точнее проверяется регуляркой rawIpUrl
    for (const digit of '123456789') for (const scheme of ['http://', 'https://']) patterns.push({id: 'rawIpUrl', needle: scheme + digit, form: 'probe', bytes: Buffer.from(scheme + digit)});
    const rows = [new Int32Array(256).fill(-1)];
    const outputs = [[]];
    for (let index = 0; index < patterns.length; index++) {
        let state = 0;
        for (const byte of patterns[index].bytes) {
            const code = LOWER[byte];
            if (rows[state][code] === -1) {
                rows[state][code] = rows.length;
                rows.push(new Int32Array(256).fill(-1));
                outputs.push([]);
            }
            state = rows[state][code];
        }
        outputs[state].push(index);
    }
    const fail = new Int32Array(rows.length);
    const queue = [];
    for (let code = 0; code < 256; code++) {
        const child = rows[0][code];
        if (child === -1) rows[0][code] = 0;
        else { fail[child] = 0; queue.push(child); }
    }
    for (let head = 0; head < queue.length; head++) {
        const state = queue[head];
        for (let code = 0; code < 256; code++) {
            const child = rows[state][code];
            if (child === -1) {
                rows[state][code] = rows[fail[state]][code];
            } else {
                fail[child] = rows[fail[state]][code];
                if (outputs[fail[child]].length) outputs[child] = outputs[child].concat(outputs[fail[child]]);
                queue.push(child);
            }
        }
    }
    const delta = new Int32Array(rows.length * 256);
    rows.forEach((row, state) => delta.set(row, state * 256));
    return {patterns, delta, outputs, hasOutput: Uint8Array.from(outputs, list => list.length ? 1 : 0)};
};

let matcher = null;
const matchBytes = (buffer, onPattern) => {
    matcher ||= buildMatcher();
    const {delta, outputs, hasOutput} = matcher;
    let state = 0;
    for (let i = 0; i < buffer.length; i++) {
        state = delta[(state << 8) | LOWER[buffer[i]]];
        if (hasOutput[state]) for (const index of outputs[state]) onPattern(index);
    }
};

// new byte[]{…} / new char[]{…} в байткоде: dup, индекс, значение, bastore|castore — собираем такие строки
const pushValue = (buffer, i) => {
    const op = buffer[i];
    if (op >= 0x02 && op <= 0x08) return [op - 0x03, 1];
    if (op === 0x10 && i + 1 < buffer.length) return [(buffer[i + 1] << 24) >> 24, 2];
    if (op === 0x11 && i + 2 < buffer.length) return [((buffer[i + 1] << 8 | buffer[i + 2]) << 16) >> 16, 3];
    return null;
};
const arrayStrings = buffer => {
    const found = [];
    let chars = [];
    const flush = () => {
        if (chars.length >= 6) found.push(Buffer.from(chars));
        chars = [];
    };
    for (let i = 0; i < buffer.length - 3;) {
        if (buffer[i] === 0x59) {
            const index = pushValue(buffer, i + 1);
            const value = index && pushValue(buffer, i + 1 + index[1]);
            const store = value && buffer[i + 1 + index[1] + value[1]];
            if (store === 0x54 || store === 0x55) {
                chars.push(value[0] & 0xff);
                i += 2 + index[1] + value[1];
                if (chars.length >= 4096) flush();
                continue;
            }
        }
        if (chars.length) flush();
        i++;
    }
    flush();
    return found;
};

// ---------- чтение jar ----------
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|ico|ogg|wav|mp3|nbt|mca|ttf|otf|woff2?|psd|blend|bbmodel|mcmeta)$/i;
const SCRIPT_FILE = /\.(bat|cmd|ps1|vbs|vbe|hta|scr|wsf|lnk|jse)$/i;
const LIMITS = {entries: 60000, entryBytes: 32 * 1024 ** 2, totalBytes: 768 * 1024 ** 2, depth: 2, timeMs: 30000};

const readJar = (source, onEntry) => new Promise(resolve => {
    const yauzl = require('yauzl');
    const open = Buffer.isBuffer(source) ? yauzl.fromBuffer : yauzl.open;
    let zip = null, settled = false, count = 0;
    const finish = error => {
        if (settled) return;
        settled = true;
        try { zip?.close(); } catch (_) {}
        resolve(error || null);
    };
    open(source, {lazyEntries: true, validateEntrySizes: true, autoClose: true}, (error, opened) => {
        if (error || !opened) return finish(error || new Error('zip'));
        zip = opened;
        zip.on('error', finish);
        zip.on('end', () => finish(null));
        zip.on('entry', entry => {
            if (settled) return;
            if (++count > LIMITS.entries) return finish(new Error('tooManyEntries'));
            Promise.resolve(onEntry(entry, () => new Promise((done, fail) => {
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError) return fail(streamError);
                    const chunks = [];
                    let size = 0;
                    stream.on('data', chunk => {
                        size += chunk.length;
                        if (size > LIMITS.entryBytes) return stream.destroy(new Error('entryTooLarge'));
                        chunks.push(chunk);
                    });
                    stream.on('error', fail);
                    stream.on('end', () => done(Buffer.concat(chunks)));
                });
            }))).then(() => zip.readEntry(), finish);
        });
        zip.readEntry();
    });
});

const classSimpleName = name => path.posix.basename(name, '.class').split('$')[0];
const looksObfuscated = simple => simple.length <= 2 || /[^A-Za-z0-9_$]/.test(simple) || /^[Il1|]{4,}$/.test(simple);

const scanJar = async (source, report, depth = 0, prefix = '') => {
    const started = Date.now();
    let classes = 0, obfuscatedNames = 0, optifine = false, total = 0;
    const hitEntry = (entryName, buffer, form) => matchBytes(buffer, index => report.hit(index, prefix + entryName, form));
    const error = await readJar(source, async (entry, read) => {
        if (Date.now() - started > LIMITS.timeMs) throw new Error('timeout');
        const name = entry.fileName;
        if (name.endsWith('/')) return;
        hitEntry(name, Buffer.from(name, 'utf8'));
        if (/^(net\/)?optifine\//i.test(name)) optifine = true;
        if (SCRIPT_FILE.test(name)) report.add('scriptFile', prefix + name, path.posix.extname(name));
        else if (/\.exe$/i.test(name)) report.add('exeFile', prefix + name, '.exe');
        if (/\.class$/i.test(name)) {
            classes++;
            if (looksObfuscated(classSimpleName(name))) obfuscatedNames++;
        }
        if (MEDIA.test(name) || entry.uncompressedSize > LIMITS.entryBytes || (entry.generalPurposeBitFlag & 1)) return;
        total += entry.uncompressedSize;
        if (total > LIMITS.totalBytes) throw new Error('tooLarge');
        const buffer = await read();
        if (/\.jar$/i.test(name)) {
            if (depth < LIMITS.depth) await scanJar(buffer, report, depth + 1, `${prefix}${name}!/`);
            return;
        }
        hitEntry(name, buffer);
        if (/\.class$/i.test(name)) for (const decoded of arrayStrings(buffer)) hitEntry(name, decoded, 'bytes');
        report.check(prefix + name, buffer);
    });
    if (classes >= 30 && !optifine && obfuscatedNames / classes >= 0.5) report.add('obfNames', prefix || '/', `${obfuscatedNames}/${classes}`);
    return depth === 0 ? error : null;
};

// Итог по одному моду: находки + сочетания «крадёт → отправляет»
const createReport = () => {
    const findings = new Map(); // id -> {samples: [{entry, needle, form}]}
    const regexEntries = new Set();
    const probes = new Map(); // entry -> найденные «половинки» признака
    const add = (id, entry, needle, form = 'plain') => {
        const item = findings.get(id) || {samples: [], needles: new Set()};
        item.needles.add(needle);
        if (item.samples.length < 3 && !item.samples.some(sample => sample.needle === needle)) item.samples.push({entry, needle, form});
        findings.set(id, item);
    };
    return {
        findings,
        add,
        hit: (index, entry, form) => {
            const pattern = matcher.patterns[index];
            if (pattern.id === 'rawIpUrl') return regexEntries.add(entry);
            if (BY_ID[pattern.id].kind === 'probe') {
                const seen = probes.get(entry) || new Set();
                probes.set(entry, seen.add(pattern.id));
                if (seen.has('sessionUser') && seen.has('sessionGetter')) add('session', entry, 'User.getAccessToken');
                return;
            }
            add(pattern.id, entry, pattern.needle, form || pattern.form);
        },
        // Точная проверка «http://1.2.3.4/» только там, где автомат увидел похожее начало
        check: (entry, buffer) => {
            if (!regexEntries.has(entry)) return;
            const match = BY_ID.rawIpUrl.regex.exec(buffer.toString('latin1'));
            if (match && !/^https?:\/\/(127\.|0\.|10\.|192\.168\.)/.test(match[0])) add('rawIpUrl', entry, match[0]);
        }
    };
};

const verdictOf = findings => {
    const result = [];
    const kinds = new Set();
    for (const [id, item] of findings) {
        const signature = BY_ID[id];
        const kind = signature?.kind || (id === 'scriptFile' ? 'exec' : id === 'exeFile' ? 'exec' : 'obf');
        kinds.add(kind);
        let severity = signature?.strong || id === 'scriptFile' ? 'danger' : 'warning';
        if (kind === 'session' || kind === 'loader') severity = 'info';
        if (id === 'browserData' && item.needles.size >= 3) severity = 'danger';
        result.push({id, kind, severity, samples: item.samples});
    }
    const ids = new Set(findings.keys());
    const exfil = result.filter(item => item.kind === 'exfil');
    const theft = result.filter(item => item.kind === 'theft' || item.kind === 'session');
    // Собирает что-то ценное и умеет это отправить — классический стилер
    if (exfil.length && theft.length) {
        result.unshift({id: 'stealer', kind: 'combo', severity: 'danger', samples: [], theft: theft.map(item => item.id), exfil: exfil.map(item => item.id)});
    }
    // Код спрятан обфускатором, а наружу торчит доступ к паролям, токенам, экрану или кошелькам: адреса отправки
    // скрыты шифрованием строк, но сочетание само по себе — признак стилера
    const obfuscated = ids.has('obfuscator') || ids.has('obfNames');
    const hiddenTheft = result.filter(item => item.kind === 'theft');
    if (obfuscated && hiddenTheft.length && !exfil.length) {
        result.unshift({id: 'hiddenStealer', kind: 'combo', severity: 'danger', samples: [], theft: hiddenTheft.map(item => item.id), exfil: []});
    }
    // Качает код из интернета и загружает его — загрузчик второй части
    if (ids.has('remoteLoader') && ['otherExfil', 'discordCdn', 'rawIpUrl'].some(id => ids.has(id))) {
        result.unshift({id: 'dropper', kind: 'combo', severity: 'danger', samples: findings.get('remoteLoader').samples});
    }
    const order = {danger: 0, warning: 1, info: 2};
    result.sort((a, b) => order[a.severity] - order[b.severity]);
    const verdict = result.some(item => item.severity === 'danger') ? 'danger' : result.some(item => item.severity === 'warning') ? 'warning' : 'clean';
    return {verdict, findings: result.filter(item => item.severity !== 'info' || verdict !== 'clean')};
};

const sha1File = file => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

// Проверить один файл (или буфер jar) — для worker и тестов
const scanFile = async source => {
    const report = createReport();
    matcher ||= buildMatcher();
    let error = null;
    try {
        error = await scanJar(source, report);
    } catch (thrown) {
        error = thrown;
    }
    const result = verdictOf(report.findings);
    // Не дочитали (битый архив, слишком большой, долго): найденное всё равно показываем
    if (error) {
        result.error = String(error?.message || error);
        if (result.verdict === 'clean') result.verdict = 'unknown';
    }
    return result;
};

// ---------- worker ----------
if (!isMainThread && workerData?.rxModScan) {
    (async () => {
        for (const file of workerData.files) {
            let sha1 = file.sha1 || '';
            try {
                if (!sha1) sha1 = await sha1File(file.path);
            } catch (error) {
                parentPort.postMessage({path: file.path, result: {verdict: 'unknown', error: String(error?.message || error), findings: []}});
                continue;
            }
            const cached = workerData.cache[sha1];
            parentPort.postMessage({path: file.path, sha1, cached: Boolean(cached), result: cached || await scanFile(file.path)});
        }
        parentPort.postMessage({done: true});
    })().catch(error => parentPort.postMessage({fatal: String(error?.message || error)}));
}

// ---------- главный процесс ----------
const JAR = /\.jar(\.disabled)?$/i;
exports.createModScanner = ({cachePath, timeoutMs = 10 * 60e3} = {}) => {
    let cache = null;
    const loadCache = () => {
        if (cache) return cache;
        try {
            const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (data?.version === VERSION && data.bySha1 && data.byStat) return cache = data;
        } catch (_) {}
        return cache = {version: VERSION, bySha1: {}, byStat: {}};
    };
    const saveCache = () => {
        if (!cachePath) return;
        const entries = Object.entries(cache.bySha1).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 4000);
        cache.bySha1 = Object.fromEntries(entries);
        const known = new Set(Object.keys(cache.bySha1));
        cache.byStat = Object.fromEntries(Object.entries(cache.byStat).filter(([, sha1]) => known.has(sha1)).slice(-6000));
        try {
            fs.mkdirSync(path.dirname(cachePath), {recursive: true});
            fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache));
            fs.renameSync(`${cachePath}.tmp`, cachePath);
        } catch (_) {}
    };

    const listJars = dir => {
        if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.length > 1024) throw new Error('Invalid mods directory');
        if (!fs.existsSync(dir)) return [];
        const real = fs.realpathSync(dir);
        if (!fs.statSync(real).isDirectory()) throw new Error('Invalid mods directory');
        return fs.readdirSync(real, {withFileTypes: true})
            .filter(entry => entry.isFile() && JAR.test(entry.name))
            .slice(0, 2000)
            .map(entry => {
                const file = path.join(real, entry.name);
                const stat = fs.statSync(file);
                return {path: file, name: entry.name, size: stat.size, enabled: !/\.disabled$/i.test(entry.name), statKey: `${stat.size}:${Math.round(stat.mtimeMs)}:${file}`};
            });
    };

    // {files: [{name, path, size, enabled, sha1, verdict, findings, error?}], scanned, cached, timedOut}
    const scan = (dir, {onlyEnabled = false} = {}) => new Promise((resolve, reject) => {
        let files;
        try {
            files = listJars(dir).filter(file => !onlyEnabled || file.enabled);
        } catch (error) {
            return reject(error);
        }
        loadCache();
        if (!files.length) return resolve({files: [], scanned: 0, cached: 0, timedOut: false});
        const byPath = new Map(files.map(file => [file.path, file]));
        const results = new Map();
        let scanned = 0, cachedCount = 0, settled = false;
        const workerFiles = files.map(file => ({path: file.path, sha1: cache.byStat[file.statKey] || ''}));
        const worker = new Worker(__filename, {
            workerData: {rxModScan: true, files: workerFiles, cache: cache.bySha1},
            resourceLimits: {maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 48}
        });
        const finish = (timedOut = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate().catch(() => {});
            saveCache();
            resolve({
                files: files.map(file => ({name: file.name, path: file.path, size: file.size, enabled: file.enabled, ...(results.get(file.path) || {verdict: 'unknown', findings: [], error: 'notScanned'})})),
                scanned, cached: cachedCount, timedOut
            });
        };
        const timer = setTimeout(() => finish(true), timeoutMs);
        worker.on('message', message => {
            if (message.done || message.fatal) return finish(false);
            const file = byPath.get(message.path);
            if (!file) return;
            const result = message.result;
            results.set(file.path, {sha1: message.sha1 || '', ...result});
            if (message.cached) cachedCount++;
            else scanned++;
            if (message.sha1 && result.verdict !== 'unknown') {
                cache.byStat[file.statKey] = message.sha1;
                cache.bySha1[message.sha1] = {...result, at: Date.now()};
            }
        });
        worker.on('error', () => finish(false));
        worker.on('exit', () => finish(false));
    });

    return {scan, listJars};
};

exports.scanFile = scanFile;
exports.SIGNATURES = SIGNATURES;
exports.VERSION = VERSION;
exports._internal = {arrayStrings, variants, verdictOf};
