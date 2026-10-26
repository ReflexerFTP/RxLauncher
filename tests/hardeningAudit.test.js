"use strict";
// 180 named regression/security/reliability cases. All network traffic stays on loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const http = require('node:http');
const zlib = require('node:zlib');
const {getEventListeners} = require('node:events');
const {pathToFileURL} = require('node:url');
const safety = require('../modrinthPackSafety');
const {validateZip} = require('../archiveSafety');
const {createTrustedIpc} = require('../ipcSecurity');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-hardening-'));
const cases = [], results = [];
const test = (group, name, run) => cases.push({group, name, run});
const load = (name, extra = {}) => {
    const context = vm.createContext({console, require, Buffer, URL, AbortController, setTimeout, clearTimeout,
        fs, path, crypto, os, ...extra});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js', name + '.js'), 'utf8') + `\nthis.Subject = ${name};`, context);
    return context.Subject;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = name => path.join(root, name);
const hash = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
const H = load('RxHttp');
const data = Buffer.alloc(256 * 1024, 0x61);
let base, otherBase;
const routes = (req, res) => {
    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/echo') {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => res.end(JSON.stringify({method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString()}))); return;
    }
    if (u.pathname === '/redirect') {res.writeHead(Number(u.searchParams.get('code')) || 302, {location: u.searchParams.get('to') || '/json'});res.end();return;}
    if (u.pathname === '/loop') {res.writeHead(302,{location:'/loop'});res.end();return;}
    if (u.pathname === '/malformed') {res.writeHead(302,{location:'http://['});res.end();return;}
    if (u.pathname === '/status') {res.writeHead(Number(u.searchParams.get('code')));res.end('{}');return;}
    if (u.pathname === '/empty') {res.writeHead(204);res.end();return;}
    if (u.pathname === '/invalid-json') {res.end('{');return;}
    if (u.pathname === '/slow') {res.writeHead(200);res.write('a');return;}
    if (u.pathname === '/truncated') {res.writeHead(200,{'Content-Length':10000});res.write('short');setTimeout(()=>res.destroy(),15);return;}
    if (u.pathname === '/compressed') {
        const kind = u.searchParams.get('kind');
        const bytes = u.searchParams.has('large') ? Buffer.alloc(2 * 1024 * 1024,65) : Buffer.from('{"ok":true}');
        res.writeHead(200,{'Content-Encoding':kind});
        res.end(kind==='br'?zlib.brotliCompressSync(bytes):kind==='deflate'?zlib.deflateSync(bytes):zlib.gzipSync(bytes));return;
    }
    if (u.pathname === '/bad-gzip') {res.writeHead(200,{'Content-Encoding':'gzip'});res.end('not gzip');return;}
    if (u.pathname === '/json') {res.end('{"ok":true}');return;}
    if (u.pathname === '/stream') {res.writeHead(200);res.write(data.subarray(0,65536));res.end(data.subarray(65536));return;}
    res.writeHead(200,{'Content-Length':data.length});res.end(data);
};
const server = http.createServer(routes), otherServer = http.createServer(routes);

// 20 path cases: Windows devices, traversal, alternate streams, protected data.
for (const name of ['../outside','mods/../../outside','/absolute','C:/outside','mods\\x.jar','mods/a:stream','mods/NUL.jar','mods/COM1.jar','mods/LPT9.txt','mods/a.','mods/a ','mods//a','mods/./a','mods/\0a','manifest.json','saves/world/level.dat','options.txt','versions/a.json']) {
    test('pack-path', `reject ${JSON.stringify(name)}`, () => assert.throws(()=>safety.safePackPath(name)));
}
for (const name of ['mods/sodium.jar','config/настройки.json']) test('pack-path', `accept ${name}`,()=>assert.equal(safety.safePackPath(name),name.split('/').join(path.sep)));

// 25 URL cases; IPv4-mapped IPv6 must follow the same private-address policy.
for (const url of ['http://example.org/a','file:///a','javascript:alert(1)','data:text/plain,a','https://localhost/a','https://localhost./a','https://x.local/a','https://127.0.0.1/a','https://2130706433/a','https://10.0.0.1/a','https://169.254.169.254/a','https://172.16.0.1/a','https://192.168.1.1/a','https://0.0.0.0/a','https://[::1]/a','https://[::]/a','https://[fd00::1]/a','https://[febf::1]/a','https://[::ffff:127.0.0.1]/a','https://100.64.0.1/a']) {
    test('download-url',`reject ${url}`,()=>assert.throws(()=>safety.safePackUrl(url)));
}
for(const url of ['https://cdn.modrinth.com/a','https://objects.githubusercontent.com/a','https://8.8.8.8/a','https://[2606:4700:4700::1111]/a','https://172.32.0.1/a']) test('download-url',`accept ${url}`,()=>assert.equal(new URL(safety.safePackUrl(url)).protocol,'https:'));

// 10 hashes/version cases.
for(const [algorithm,length] of [['sha1',40],['sha256',64],['sha512',128]]) test('hash-version',algorithm,()=>assert.equal(safety.safePackHashes({[algorithm]:'A'.repeat(length)})[algorithm],'a'.repeat(length)));
for(const bad of [{md5:'a'.repeat(32)},{sha512:'z'.repeat(128)}]) test('hash-version','reject hash '+JSON.stringify(bad),()=>assert.throws(()=>safety.safePackHashes(bad)));
for(const value of ['1.21.4','0.16.10+build.1']) test('hash-version','accept version '+value,()=>assert.equal(safety.safePackVersion(value),value));
for(const value of ['../1.21','1.21.','x'.repeat(82)]) test('hash-version','reject version '+value,()=>assert.throws(()=>safety.safePackVersion(value)));

// Minimal ZIP writer used only for controlled adversarial fixtures.
let zipSequence = 0;
function makeZip(entries) {
    let offset=0; const locals=[],centrals=[];
    for(const entry of entries){const filename=Buffer.from(entry.name),bytes=entry.data||Buffer.from('x');const local=Buffer.alloc(30),central=Buffer.alloc(46);
        const packed=entry.flags&1?Buffer.concat([Buffer.alloc(12),bytes]):bytes;
        local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(entry.flags||0,6);local.writeUInt32LE(zlib.crc32(bytes),14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
        central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(entry.flags||0,8);central.writeUInt32LE(zlib.crc32(bytes),16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(((entry.mode||0)<<16)>>>0,38);central.writeUInt32LE(offset,42);
        local.writeUInt32LE(packed.length,18);central.writeUInt32LE(packed.length,20);
        locals.push(local,filename,packed);centrals.push(central,filename);offset+=local.length+filename.length+packed.length;
    }
    const centralBytes=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
    const file=target(`fixture-${zipSequence++}.zip`);fs.writeFileSync(file,Buffer.concat([...locals,centralBytes,end]));return file;
}
for(const name of ['../escape','/absolute','C:/escape','mods\\x.jar','world/aux.txt','world/file:stream','world/x.','world/x ','world//x']) test('zip',`reject ${name}`,()=>assert.rejects(validateZip(makeZip([{name}]),target('out'))));
test('zip','accept ordinary archive',()=>validateZip(makeZip([{name:'world/level.dat'}]),target('out')));
test('zip','reject symlink',()=>assert.rejects(validateZip(makeZip([{name:'link',mode:0xa1ff}]),target('out')),/symbolic/));
test('zip','reject encrypted entry',()=>assert.rejects(validateZip(makeZip([{name:'secret',flags:1}]),target('out')),/Encrypted/));
test('zip','reject case-insensitive duplicates',()=>assert.rejects(validateZip(makeZip([{name:'mods/A.jar'},{name:'mods/a.jar'}]),target('out')),/Duplicate/));
test('zip','limit extracted bytes',()=>assert.rejects(validateZip(makeZip([{name:'a',data:Buffer.alloc(100)}]),target('out'),{maxBytes:99}),/limit/));
test('zip','limit entry count',()=>assert.rejects(validateZip(makeZip([{name:'a'},{name:'b'}]),target('out'),{maxEntries:1}),/limit/));

// 30 memory-selection cases, including damaged persisted configuration.
const memory = (config={},instance=null,total=16384)=>load('RxMemoryAdvisor',{os:{totalmem:()=>total*1024**2},RxConfig:{read:(k,d)=>k in config?config[k]:d},RxInstancesUI:{activeManifest:()=>instance}});
const M=memory();
for(const [totalMb,modsCount,modded,expected] of [[16384,0,false,2048],[16384,22,true,3072],[32768,200,true,12288],[3072,50,true,1024],[4096,0,false,1536],[8192,100,true,4608],[12288,100,true,7168],[16384,20,true,3072],[16384,0,true,3072],[16384,-1,true,3072],[16384,NaN,true,3072],[NaN,NaN,true,1536],[Infinity,0,false,1536],[0,0,false,1536],[16384,'22',true,3072]]) {
    test('memory',`auto RAM=${totalMb}, mods=${modsCount}, modded=${modded}`,()=>assert.equal(M.recommend({totalMb,modsCount,modded}),expected));
}
for(const [value,expected] of [[Infinity,2048],[NaN,2048],[-512,2048],[0,2048],['4096',4096],[4096.8,4096],[1e9,14336],[1024,1024],[null,2048],['invalid',2048]]) test('memory',`manual ${String(value)}`,()=>assert.equal(memory({}, {memory:{mode:'manual',mb:value}}).launchMemoryMb(),expected));
test('memory','global invalid manual fallback',()=>assert.equal(memory({autoMemory:false,xmxMemory:-10}).launchMemoryMb(),2048));
test('memory','instance auto overrides global manual',()=>assert.equal(memory({autoMemory:false,xmxMemory:4096},{memory:{mode:'auto'}}).launchMemoryMb(),2048));
test('memory','manual leaves space on 4 GiB',()=>assert.equal(memory({}, {memory:{mode:'manual',mb:8192}},4096).launchMemoryMb(),2560));
test('memory','count only enabled jar files',()=>{const dir=target('mods');fs.mkdirSync(dir);for(const n of ['a.jar','b.JAR','c.jar.disabled','readme.txt'])fs.writeFileSync(path.join(dir,n),'');assert.equal(M.countMods(dir),2)});
test('memory','missing mods folder is empty',()=>assert.equal(M.countMods(target('missing')),0));

// 35 real HTTP streaming/error/cancellation tests against two local servers.
test('http','JSON response',async()=>assert.equal((await H.json(base+'/json')).ok,true));
for(const kind of ['gzip','deflate','br'])test('http',`decode ${kind}`,async()=>assert.equal((await H.json(base+'/compressed?kind='+kind)).ok,true));
test('http','relative redirect',async()=>assert.equal((await H.text(base+'/redirect')).url,base+'/json'));
test('http','redirect loop rejects',()=>assert.rejects(H.text(base+'/loop'),/Too many redirects/));
test('http','malformed redirect rejects without crashing',()=>assert.rejects(H.text(base+'/malformed')));
test('http','POST body round-trip',async()=>assert.equal((await H.json(base+'/echo',{method:'POST',body:{a:1}})).body,'{"a":1}'));
test('http','307 preserves method/body',async()=>{const r=await H.json(base+'/redirect?code=307&to=/echo',{method:'POST',body:'hello'});assert.equal(r.method,'POST');assert.equal(r.body,'hello')});
test('http','302 removes stale entity headers',async()=>{const r=await H.json(base+'/redirect?code=302&to=/echo',{method:'POST',body:'hello',headers:{'Content-Length':'5','Content-Type':'text/plain'}});assert.equal(r.method,'GET');assert.equal(r.headers['content-length'],undefined)});
test('http','cross-origin removes credentials',async()=>{const r=await H.json(base+'/redirect?to='+encodeURIComponent(otherBase+'/echo'),{headers:{Authorization:'Bearer dummy',Cookie:'dummy=1'}});assert.equal(r.headers.authorization,undefined);assert.equal(r.headers.cookie,undefined)});
test('http','cross-origin 307 body is blocked',()=>assert.rejects(H.text(base+'/redirect?code=307&to='+encodeURIComponent(otherBase+'/echo'),{method:'POST',body:'dummy'}),/Cross-origin/));
test('http','URL policy on redirect',()=>assert.rejects(H.text(base+'/redirect',{urlPolicy:u=>{if(u.endsWith('/json'))throw Error('policy')}}),/policy/));
test('http','unsupported scheme rejects',()=>assert.rejects(H.text('file:///tmp/test'),/Unsupported protocol/));
test('http','404 keeps status',()=>assert.rejects(H.json(base+'/status?code=404'),e=>e.status===404));
test('http','500 keeps status',()=>assert.rejects(H.json(base+'/status?code=500'),e=>e.status===500));
test('http','204 JSON is null',async()=>assert.equal(await H.json(base+'/empty'),null));
test('http','invalid JSON rejects',()=>assert.rejects(H.json(base+'/invalid-json')));
test('http','invalid gzip rejects',()=>assert.rejects(H.text(base+'/bad-gzip')));
test('http','decompressed body limit',()=>assert.rejects(H.text(base+'/compressed?kind=gzip&large=1',{maxBytes:1024}),/too large/));
test('http','invalid body limit rejects',()=>assert.rejects(H.text(base+'/json',{maxBytes:NaN}),/Invalid response size/));
test('http','truncated response rejects',()=>assert.rejects(H.text(base+'/truncated')));
test('http','inactivity timeout rejects',()=>assert.rejects(H.text(base+'/slow',{timeout:35}),/timed out|aborted/i));
test('http','already-aborted request rejects',()=>{const c=new AbortController();c.abort();return assert.rejects(H.text(base+'/json',{signal:c.signal}),/aborted/) });
test('http','abort ongoing request and release listener',async()=>{const c=new AbortController();const promise=H.text(base+'/slow',{signal:c.signal});setTimeout(()=>c.abort(),25);await assert.rejects(promise,/aborted/);assert.equal(getEventListeners(c.signal,'abort').length,0)});
test('http','300 completed requests do not retain abort listeners',async()=>{const c=new AbortController();for(let i=0;i<300;i++)await H.text(base+'/json',{signal:c.signal});assert.equal(getEventListeners(c.signal,'abort').length,0)});
test('http','file download hash and content',async()=>{const dest=target('valid.bin');await H.download(base+'/data',dest,{hashes:{sha256:hash(data)}});assert.ok(fs.readFileSync(dest).equals(data))});
test('http','checksum mismatch preserves existing file',async()=>{const dest=target('old.bin');fs.writeFileSync(dest,'old');await assert.rejects(H.download(base+'/data',dest,{hashes:{sha256:'0'.repeat(64)}}),/Checksum/);assert.equal(fs.readFileSync(dest,'utf8'),'old')});
test('http','content-length download limit',()=>assert.rejects(H.download(base+'/data',target('oversized'),{maxBytes:1024}),/size limit/));
test('http','chunked download limit',()=>assert.rejects(H.download(base+'/stream',target('oversized-stream'),{maxBytes:1024}),/size limit/));
test('http','download limit must be finite',()=>assert.rejects(H.download(base+'/data',target('invalid'),{maxBytes:Infinity}),/Invalid download size/));
test('http','progress callback failure rejects without crashing',()=>assert.rejects(H.download(base+'/data',target('progress'),{onProgress:()=>{throw Error('progress callback failed')}}),/callback failed/));
test('http','rename failure cleans temporary file',async()=>{const dest=target('directory');fs.mkdirSync(dest);await assert.rejects(H.download(base+'/data',dest));assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('directory.')&&n.endsWith('.rxdownload')).length,0)});
test('http','abort download removes temp and destination',async()=>{const c=new AbortController();const dest=target('cancelled');const promise=H.download(base+'/slow',dest,{signal:c.signal});setTimeout(()=>c.abort(),20);await assert.rejects(promise);assert.equal(fs.existsSync(dest),false);assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('cancelled.')).length,0)});
test('http','all download failure paths leave no temporary files',()=>assert.equal(fs.readdirSync(root).filter(n=>n.endsWith('.rxdownload')).length,0));

// 15 queue cases. UI is mocked; downloads execute the actual queue implementation.
function queue(download=async()=>{}) {
    const state={paints:0,progress:[],logs:[],now:1000};
    const C=load('RxDownloader',{Date:{now:()=>state.now},RxHttp:{download},RxCollector:{writeLog:s=>state.logs.push(s)},
        RxFlyout:{setProgress:v=>state.progress.push(v),setText:()=>state.paints++,changeMode:async()=>{}},RxUtils:{humanFileSize:String},MESSAGES:{commons:{},starter:{remaining:'{0}'}}});
    return {C,state};
}
const items=n=>Array.from({length:n},(_,i)=>({url:'https://example.org/'+i,path:target('q'+i),size:100}));
for(const value of [0,-1,NaN,Infinity,1.5])test('queue',`reject concurrency ${value}`,()=>assert.rejects(queue().C.downloadMany(items(1),'x',value),/concurrency/));
test('queue','empty queue succeeds',async()=>assert.equal(await queue().C.downloadMany([],'x'),true));
test('queue','invalid queue rejects',()=>assert.rejects(queue().C.downloadMany(null,'x'),/array/));
test('queue','concurrency limit respected',async()=>{let active=0,peak=0,count=0;const {C}=queue(async()=>{peak=Math.max(peak,++active);await tick();active--;count++});await C.downloadMany(items(19),'x',3);assert.equal(count,19);assert.ok(peak<=3)});
test('queue','excessive concurrency capped at 16',async()=>{let active=0,peak=0;const {C}=queue(async()=>{peak=Math.max(peak,++active);await tick();active--});await C.downloadMany(items(33),'x',1000);assert.equal(peak,16)});
test('queue','cancelled queue rejects and releases controller',async()=>{const {C}=queue(async()=>C.abortAll());await assert.rejects(C.downloadMany(items(4),'x',1),/aborted/);assert.equal(C.activeDownloads.size,0)});
test('queue','404 is not retried',async()=>{let calls=0;const {C}=queue(async()=>{calls++;throw Object.assign(Error('missing'),{status:404})});await assert.rejects(C.downloadMany(items(1),'x'));assert.equal(calls,1);assert.equal(C.activeDownloads.size,0)});
test('queue','temporary failure retries then succeeds',async()=>{let calls=0;const {C}=queue(async()=>{if(++calls===1)throw Error('temporary')});await C.downloadMany(items(1),'x');assert.equal(calls,2)});
test('queue','abort interrupts retry backoff promptly',async()=>{const {C}=queue(async()=>{throw Error('temporary')});const started=Date.now();const p=C.downloadMany(items(1),'x');setTimeout(()=>C.abortAll(),25);await assert.rejects(p,/aborted/);assert.ok(Date.now()-started<500)});
test('queue','progress rendering is throttled',async()=>{const {C,state}=queue(async(_u,_p,o)=>{for(let i=1;i<=1000;i++)o.onProgress(i)});await C.downloadMany(items(2),'x',1);assert.ok(state.paints<=4,`paints=${state.paints}`);assert.equal(state.progress.at(-1),0)});
test('queue','5000 queued items finish once without retained controllers',async()=>{let count=0;const {C}=queue(async()=>{count++});await C.downloadMany(items(5000),'x',6);assert.equal(count,5000);assert.equal(C.activeDownloads.size,0)});

// 15 optimizer lifecycle cases with deterministic visibility and timers.
function optimizer() {
    let id=0;const timers=new Map(),docEvents=new Map(),winEvents=new Map(),classes=new Set();
    const s={cleared:0,gc:0,disposed:0,mounted:0};
    const document={hidden:true,documentElement:{classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),toggle:(n,on)=>on?classes.add(n):classes.delete(n)}},addEventListener:(n,f)=>{const a=docEvents.get(n)||[];a.push(f);docEvents.set(n,a)}};
    const viewer={viewer:{},visible:true,currentProfile:{},disposeViewer(){s.disposed++;this.viewer=null},mountViewer(){s.mounted++;this.viewer={}},createDefaultProfile:()=>({})};
    const cache=new Map([['x',{}]]);
    const C=load('RxOptimizer',{document,window:{gc:()=>s.gc++,addEventListener:(n,f)=>winEvents.set(n,f)},RxSkinBrowserUI:viewer,RxModMeta:{cache},RxCollector:{writeLog(){}},require:()=>({webFrame:{clearCache:()=>s.cleared++}}),setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:n=>timers.delete(n)});
    const runTimers=()=>{const list=[...timers.values()];timers.clear();list.forEach(f=>f())};
    const visibility=hidden=>{document.hidden=hidden;(docEvents.get('visibilitychange')||[]).forEach(f=>f())};
    return {C,s,document,viewer,cache,timers,classes,docEvents,winEvents,runTimers,visibility};
}
test('optimizer','visible window not released',()=>{const o=optimizer();o.document.hidden=false;assert.equal(o.C.releaseHiddenResources(),false)});
test('optimizer','hidden release happens once',()=>{const o=optimizer();o.C.releaseHiddenResources();o.C.releaseHiddenResources();assert.equal(o.s.cleared,1)});
test('optimizer','3D viewer disposed',()=>{const o=optimizer();o.C.releaseHiddenResources();assert.equal(o.s.disposed,1);assert.equal(o.viewer.viewer,null)});
test('optimizer','metadata cache cleared',()=>{const o=optimizer();o.C.releaseHiddenResources();assert.equal(o.cache.size,0)});
test('optimizer','memory-saver CSS class enabled',()=>{const o=optimizer();o.C.releaseHiddenResources();assert.ok(o.classes.has('rx-memory-saver'))});
test('optimizer','restore removes saver CSS',()=>{const o=optimizer();o.C.releaseHiddenResources();o.C.restoreResources();assert.equal(o.classes.has('rx-memory-saver'),false)});
test('optimizer','viewer remounts only once',()=>{const o=optimizer();o.C.releaseHiddenResources();o.C.restoreResources();o.C.restoreResources();assert.equal(o.s.mounted,1)});
test('optimizer','restore cancels deferred GC',()=>{const o=optimizer();o.C.releaseHiddenResources();o.C.restoreResources();assert.equal(o.timers.size,0)});
test('optimizer','hidden GC runs once',()=>{const o=optimizer();o.C.releaseHiddenResources();o.runTimers();assert.equal(o.s.gc,1)});
test('optimizer','viewer disposal error does not stop release',()=>{const o=optimizer();o.viewer.disposeViewer=()=>{throw Error('GPU error')};assert.doesNotThrow(()=>o.C.releaseHiddenResources());assert.equal(o.s.cleared,1)});
test('optimizer','viewer restore error does not crash',()=>{const o=optimizer();o.C.releaseHiddenResources();o.viewer.mountViewer=()=>{throw Error('GPU error')};assert.doesNotThrow(()=>o.C.restoreResources())});
test('optimizer','initialization is idempotent',()=>{const o=optimizer();o.C.init();o.C.init();assert.equal(o.docEvents.get('visibilitychange').length,1)});
test('optimizer','brief minimize cancels release timer',()=>{const o=optimizer();o.C.init();o.visibility(true);o.visibility(false);assert.equal(o.timers.size,0);assert.equal(o.s.cleared,0)});
test('optimizer','unload clears all pending timers',()=>{const o=optimizer();o.C.init();o.C.scheduleFreeMemory(10);o.C.releaseHiddenResources();o.winEvents.get('beforeunload')();assert.equal(o.timers.size,0)});
test('optimizer','1000 hide/restore cycles do not retain timers or listeners',()=>{const o=optimizer();o.C.init();for(let i=0;i<1000;i++){o.C.releaseHiddenResources();o.C.restoreResources()}assert.equal(o.timers.size,0);assert.equal(o.docEvents.get('visibilitychange').length,1);assert.equal(o.s.disposed,1000)});

// 10 JAR/cache cases, using real controlled ZIPs or deterministic metadata reads.
const metadata=()=>load('RxModMeta',{toml:require('toml'),RxTranslator:{getCurrentLanguage:()=> 'en'}});
test('metadata','read selected ZIP entry only',async()=>{const C=metadata(),f=makeZip([{name:'fabric.mod.json',data:Buffer.from('{}')},{name:'unwanted',data:Buffer.alloc(20)}]);const r=await C.readEntries(f,n=>n==='fabric.mod.json');assert.equal(Object.keys(r).length,1);assert.equal(r['fabric.mod.json'].toString(),'{}')});
test('metadata','skip oversized ZIP entry',async()=>{const C=metadata(),f=makeZip([{name:'large',data:Buffer.alloc(20)}]);assert.equal(Object.keys(await C.readEntries(f,()=>true,10)).length,0)});
test('metadata','limit aggregate ZIP metadata',async()=>{const C=metadata(),f=makeZip(Array.from({length:8},(_,i)=>({name:'entry'+i,data:Buffer.alloc(10)})));const r=await C.readEntries(f,()=>true,10);assert.ok(Object.values(r).reduce((n,b)=>n+b.length,0)<=20)});
test('metadata','invalid ZIP returns empty metadata',async()=>{const C=metadata();assert.equal(Object.keys(await C.readEntries(Buffer.from('bad'),()=>true)).length,0)});
test('metadata','invalid JSON returns null',()=>assert.equal(metadata().parseJson(Buffer.from('{invalid')),null));
function cachedMeta(description='') {const C=metadata();const file=target('metadata.jar');fs.writeFileSync(file,'stub');let calls=0;C.readEntries=async()=>{calls++;return {'fabric.mod.json':Buffer.from(JSON.stringify({id:'example',name:'Example',version:'1',description}))}};return {C,file,calls:()=>calls}}
test('metadata','unchanged file reuses cache',async()=>{const {C,file,calls}=cachedMeta();const first=await C.read(file),before=calls();assert.equal(await C.read(file),first);assert.equal(calls(),before)});
test('metadata','changed file invalidates cache',async()=>{const {C,file,calls}=cachedMeta();await C.read(file);const before=calls();fs.appendFileSync(file,'more');await C.read(file);assert.ok(calls()>before)});
test('metadata','deleted file is removed from cache',async()=>{const {C,file}=cachedMeta();await C.read(file);fs.unlinkSync(file);assert.equal(await C.read(file),null);assert.equal(C.cache.size,0)});
test('metadata','cache caps entries after 200 JARs',async()=>{const {C,file}=cachedMeta();for(let i=0;i<200;i++){const next=target('meta-'+i);fs.copyFileSync(file,next);await C.read(next)}assert.equal(C.cache.size,128)});
test('metadata','cache caps retained serialized metadata bytes',async()=>{const {C,file}=cachedMeta('x'.repeat(512*1024));for(let i=0;i<50;i++){const next=target('large-meta-'+i);fs.copyFileSync(file,next);await C.read(next)}assert.ok([...C.cache.values()].reduce((n,e)=>n+e.bytes,0)<=16*1024*1024);assert.ok(C.cache.size<50)});

// 5 IPC boundary cases.
function ipcFixture(){const handlers=new Map(),entry=path.resolve(__dirname,'../web/index.ejs'),frame={url:pathToFileURL(entry).href},sender={mainFrame:null};sender.mainFrame=frame;const win={isDestroyed:()=>false,webContents:sender};const api=createTrustedIpc({on:(n,f)=>handlers.set(n,f),handle:(n,f)=>handlers.set(n,f)},()=>win,entry);api.handleTrusted('check',(_e,v)=>v);return {fn:handlers.get('check'),frame,sender,win,event:{sender,senderFrame:frame}}}
test('ipc','trusted main frame accepted',()=>{const f=ipcFixture();assert.equal(f.fn(f.event,7),7)});
test('ipc','other renderer rejected',()=>{const f=ipcFixture();assert.throws(()=>f.fn({...f.event,sender:{}}),/Untrusted/)});
test('ipc','subframe rejected',()=>{const f=ipcFixture();assert.throws(()=>f.fn({...f.event,senderFrame:{url:f.frame.url}}),/Untrusted/)});
test('ipc','remote navigation rejected',()=>{const f=ipcFixture();f.frame.url='https://example.org';assert.throws(()=>f.fn(f.event),/Untrusted/)});
test('ipc','destroyed window rejected',()=>{const f=ipcFixture();f.win.isDestroyed=()=>true;assert.throws(()=>f.fn(f.event),/Untrusted/)});

(async()=>{
    assert.equal(cases.length,180,'The audit must contain 180 independently named cases');
    await Promise.all([new Promise(r=>server.listen(0,'127.0.0.1',r)),new Promise(r=>otherServer.listen(0,'127.0.0.1',r))]);
    base=`http://127.0.0.1:${server.address().port}`;otherBase=`http://127.0.0.1:${otherServer.address().port}`;
    const started=Date.now();
    for(const item of cases){const at=Date.now();let timer;try{await Promise.race([Promise.resolve().then(item.run),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Test timeout')),10000)})]);results.push({group:item.group,name:item.name,status:'pass',ms:Date.now()-at})}catch(error){results.push({group:item.group,name:item.name,status:'fail',ms:Date.now()-at,error:error.stack});console.error(`FAIL [${item.group}] ${item.name}\n${error.stack}`)}finally{clearTimeout(timer)}}
    const report={generatedAt:new Date().toISOString(),runtime:process.version,platform:process.platform,total:results.length,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,durationMs:Date.now()-started,results};
    if(process.env.RX_AUDIT_REPORT)fs.writeFileSync(process.env.RX_AUDIT_REPORT,JSON.stringify(report,null,2));
    console.log(`Hardening audit: ${report.passed}/${report.total} passed (${report.durationMs} ms)`);
    console.log(JSON.stringify(Object.fromEntries([...new Set(results.map(r=>r.group))].map(group=>[group,results.filter(r=>r.group===group).length]))));
    if(report.failed)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
    server.closeAllConnections();otherServer.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>otherServer.close(r))]);
    if(path.basename(root).startsWith('rx-hardening-')&&path.dirname(root)===os.tmpdir())fs.rmSync(root,{recursive:true,force:true});
});
