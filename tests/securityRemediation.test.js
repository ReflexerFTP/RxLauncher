'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {createRequire} = require('node:module');
const req = createRequire(path.join(__dirname, '../web/index.ejs'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-remediation-'));
const game = path.join(fixture, 'game'); fs.mkdirSync(game);
const rows = [];
const test = async (name, run) => {await run(); rows.push(name);};
const load = (name, extra = {}, setup = '') => {
    const ctx = vm.createContext({fs, path, os, crypto, Buffer, URL, process, console, require:req, fsPromises:fs.promises,
        fsExtra:require('fs-extra'), GAME_DATA:game, __dirname:path.join(__dirname,'../web'), setTimeout,clearTimeout,
        RxCollector:{writeLog(){}}, ...extra});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js',name+'.js'),'utf8')+`\n${setup}\nthis.Subject=${name};`,ctx);
    return ctx.Subject;
};
const zip = (name, files) => {
    const archive = new (require('adm-zip'))();
    for (const [file,data] of Object.entries(files)) archive.addFile(file,Buffer.isBuffer(data)?data:Buffer.from(data));
    const target=path.join(fixture,name);archive.writeZip(target);return target;
};
const str = text => {const b=Buffer.from(text);const n=Buffer.alloc(2);n.writeUInt16BE(b.length);return Buffer.concat([n,b]);};
const tag = (type,name,body) => Buffer.concat([Buffer.from([type]),str(name),body]);
const compound = (...tags) => Buffer.concat([...tags,Buffer.from([0])]);
const root = body => tag(10,'',body);
const validWorld = root(compound(tag(10,'Data',compound(tag(8,'LevelName',str('Safe fixture world'))))));

(async()=>{
    const Nbt=require('../web/js/RxNbt');
    await test('NBT valid world remains readable',async()=>{assert.equal(Nbt.read(validWorld)[''].value.Data.value.LevelName.value,'Safe fixture world');});
    const n=Buffer.alloc(4);n.writeUInt32BE(200000000);
    const bomb=root(compound(tag(9,'x',Buffer.concat([Buffer.from([0]),n]))));
    await test('NBT TAG_End list bomb rejected',async()=>assert.throws(()=>Nbt.read(bomb),/large|length|TAG_End/));
    await test('NBT trailing second root rejected',async()=>assert.throws(()=>Nbt.read(Buffer.concat([validWorld,bomb])),/Trailing/));
    await test('NBT excessive depth rejected',async()=>{let body=compound();for(let i=0;i<80;i++)body=compound(tag(10,'x',body));assert.throws(()=>Nbt.read(root(body)),/deep/);});
    await test('NBT gzip expansion rejected without UI parsing',async()=>{
        const file=path.join(fixture,'level-large.dat');fs.writeFileSync(file,zlib.gzipSync(Buffer.alloc(33*1024**2)));
        await assert.rejects(Nbt.readLevelDatAsync(file),/large|size|heap|worker/i);
    });
    await test('World metadata uses bounded worker, bad world skipped',async()=>{
        const world=path.join(game,'saves','safe'),bad=path.join(game,'saves','bad');fs.mkdirSync(world,{recursive:true});fs.mkdirSync(bad,{recursive:true});
        fs.writeFileSync(path.join(world,'level.dat'),zlib.gzipSync(validWorld));fs.writeFileSync(path.join(bad,'level.dat'),zlib.gzipSync(bomb));
        const Worlds=load('RxWorldsManager',{RxPacks:{getPacksList:()=>[]}});
        assert.equal((await Worlds.getWorldInfo(world)).name,'Safe fixture world');
        assert.equal(await Worlds.getWorldInfo(bad),false);
        assert.equal((await Worlds.savesFromDirectory(path.dirname(world))).length,1);
    });
    const Meta=load('RxModMeta',{toml:require('toml')});
    const Parsers=load('RxAssetsParsers',{RxModMeta:Meta});
    await test('Mod icon never reads outside JAR',async()=>{
        fs.writeFileSync(path.join(fixture,'canary.txt'),'PRIVATE_CANARY');
        const jar=zip('icon.jar',{'fabric.mod.json':JSON.stringify({id:'fixture',name:'Fixture',version:'1',icon:'../../../../canary.txt'})});
        const data=await Parsers.readModInfo(jar);assert.equal(data.name,'Fixture');assert.equal(data.icon,false);
        assert.ok(!JSON.stringify(data).includes(Buffer.from('PRIVATE_CANARY').toString('base64')));
    });
    await test('Missing icon resolves with fallback',async()=>{
        const jar=zip('noicon.jar',{'fabric.mod.json':JSON.stringify({id:'fixture',name:'Fixture',icon:'missing.png'})});
        assert.equal((await Parsers.readModInfo(jar)).icon,false);
    });
    await test('Invalid resource JSON settles to false',async()=>assert.equal(await Parsers.readResourcePackV2(zip('broken.zip',{'pack.mcmeta':'{broken'})),false));
    await test('Invalid archive settles to false',async()=>{const f=path.join(fixture,'bad.zip');fs.writeFileSync(f,'not zip');assert.equal(await Parsers.readResourcePackV2(f),false);});
    await test('Resource metadata is read without extraction',async()=>{
        const file=zip('resource.zip',{'pack.mcmeta':JSON.stringify({pack:{description:{text:'Safe ',extra:[{text:'description'}]}}}),'unused.bin':Buffer.alloc(2*1024**2)});
        assert.equal((await Parsers.readResourcePackV2(file)).mcmeta.description,'Safe description');
        assert.equal(fs.existsSync(path.join(game,'cache','unpacked','resource')),false);
    });
    await test('Wrong Quilt/JarJar field types are isolated',async()=>{
        for(const [name,json] of [['quilt.mod.json',{quilt_loader:{id:'x',depends:{},provides:'x',breaks:{}}}],['META-INF/jarjar/metadata.json',{jars:{}}]]) {
            const meta=await Meta.read(zip(name.includes('quilt')?'quilt.jar':'jarjar.jar',{[name]:JSON.stringify(json)}));assert.ok(meta===null||typeof meta==='object');
        }
    });
    await test('Oversized icon entry is not retained',async()=>{
        const jar=zip('bigicon.jar',{'fabric.mod.json':JSON.stringify({id:'fixture',icon:'huge.png'}),'huge.png':Buffer.alloc(7*1024**2)});
        assert.equal((await Meta.read(jar)).iconData,'');
    });
    await test('Malformed dependency fields cannot crash compatibility UI',async()=>{
        const jar=zip('quilt-schema.jar',{'quilt.mod.json':JSON.stringify({quilt_loader:{id:'schema',provides:[{id:{bad:1}},'valid'],depends:[{id:{bad:1}}, {id:'minecraft',versions:{bad:1}}],breaks:[{id:'valid',versions:{bad:1}}]}})});
        const meta=await Meta.read(jar);assert.ok(meta);assert.deepEqual(Array.from(meta.provides),['valid']);
        const entry={fileName:'quilt-schema.jar',enabled:true,meta},index=Meta.buildIndex([entry]);
        assert.ok(Meta.evaluate(entry,index,{loader:'quilt',mcText:'1.21',mc:[1,21,0]}));
    });
    await test('Old cache cleanup does not follow a linked cache directory',async()=>{
        const outside=path.join(fixture,'outside-cache');fs.mkdirSync(path.join(outside,'unpacked'),{recursive:true});
        const canary=path.join(outside,'unpacked','canary');fs.writeFileSync(canary,'KEEP');
        const cache=path.join(game,'cache');fs.symlinkSync(outside,cache,process.platform==='win32'?'junction':'dir');
        try { assert.equal(Parsers.clearAssetsCache(),false);assert.equal(fs.readFileSync(canary,'utf8'),'KEEP'); }
        finally { fs.unlinkSync(cache); }
    });
    await test('Resource list skips README and continues after malformed pack',async()=>{
        const dir=path.join(game,'modpacks','fixture','resourcepacks');fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'0-readme.txt'),'readme');fs.copyFileSync(zip('r1.zip',{'pack.mcmeta':'bad'}),path.join(dir,'1.zip'));
        fs.copyFileSync(zip('r2.zip',{'pack.mcmeta':JSON.stringify({pack:{description:'ok'}})}),path.join(dir,'2.zip'));
        let cards=0;const list={empty(){return this;},append(){cards++;return this;}};
        const UI=load('RxPackManagerUI',{$:()=>list,RxAssetsParsers:Parsers,RxUtils:{removeColorsFromString:x=>x}},'packman__currentModpack={id:"fixture"};');
        assert.equal(await UI.loadRPList(),true);assert.equal(cards,2);
    });
    const Import=load('RxImport');
    const backup=(id,target,parts)=>{const dir=path.join(game,'backups','import',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({version:1,target,parts,restored:{}}));return dir;};
    await test('Forged restore root cannot delete external canary',async()=>{
        const outside=path.join(fixture,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'canary.txt'),'keep');
        backup('outside',outside,{config:{added:['config/canary.txt']}});
        await assert.rejects(Import.restore('outside',['config']),/Unknown import target|leaves/);assert.equal(fs.readFileSync(path.join(outside,'canary.txt'),'utf8'),'keep');
    });
    await test('Restore rejects linked target ancestors',async()=>{
        const outside=path.join(fixture,'outside'),link=path.join(game,'config');fs.symlinkSync(outside,link,'junction');
        backup('linked',game,{config:{added:['config/canary.txt']}});
        await assert.rejects(Import.restore('linked',['config']),/Unsafe/);assert.ok(fs.existsSync(path.join(outside,'canary.txt')));fs.unlinkSync(link);
    });
    await test('Restore preflights paths before deleting valid entries',async()=>{
        fs.mkdirSync(path.join(game,'mods'),{recursive:true});fs.writeFileSync(path.join(game,'mods','keep.jar'),'keep');
        backup('traversal',game,{mods:{added:['mods/keep.jar','../outside.txt']}});
        await assert.rejects(Import.restore('traversal',['mods']),/Unsafe/);assert.ok(fs.existsSync(path.join(game,'mods','keep.jar')));
    });
    const Utils=load('RxUtils',{compressing:require('compressing')});
    await test('Real TAR.GZ is validated and extracted',async()=>{
        const dir=path.join(fixture,'tar-source');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'marker.txt'),'safe');
        const archive=path.join(fixture,'valid.tar.gz');await require('compressing').tgz.compressDir(dir,archive);
        const dest=path.join(fixture,'tar-output');await Utils.unpackArchive(archive,dest);assert.equal(fs.readFileSync(path.join(dest,'tar-source','marker.txt'),'utf8'),'safe');
    });
    const tarHeaders=require('tar-stream/headers');
    const tarHeader=(name,type,size=0,linkname='')=>tarHeaders.encode({name,type,size,linkname,mode:0o644,uid:0,gid:0,mtime:new Date(0)});
    const tarPayload=bytes=>Buffer.concat([bytes,Buffer.alloc((512-bytes.length%512)%512)]);
    await test('TAR oversized extended header rejected before buffering payload',async()=>{
        const archive=path.join(fixture,'pax-bomb.tar.gz');
        fs.writeFileSync(archive,zlib.gzipSync(tarHeader('PaxHeader','pax-header',512*1024*1024)));
        await assert.rejects(require('../archiveSafety').validateTar(archive,path.join(fixture,'unused-pax'),{gzip:true}),/metadata.*large/);
    });
    await test('Normal PAX path remains readable but size overrides are blocked',async()=>{
        const normal=tarHeaders.encodePax({name:'safe/pax.txt'}),size=tarHeaders.encodePax({pax:{size:'400000000'}});
        for(const [name,pax] of [['normal-pax',normal],['size-pax',size]]) {
            const archive=path.join(fixture,name+'.tar');
            fs.writeFileSync(archive,Buffer.concat([tarHeader('PaxHeader','pax-header',pax.length),tarPayload(pax),tarHeader('placeholder','file',1),tarPayload(Buffer.from('x')),Buffer.alloc(1024)]));
            const target=path.join(fixture,name);
            if(name==='size-pax') await assert.rejects(require('../archiveWorker').unpack(archive,target,'tar'),/size overrides/);
            else { await require('../archiveWorker').unpack(archive,target,'tar');assert.equal(fs.readFileSync(path.join(target,'safe/pax.txt'),'utf8'),'x'); }
        }
    });
    await test('TAR traversal and external link rejected before extraction',async()=>{
        for(const [name,type,link] of [['../outside','file',''],['linked','symlink','../outside']]) {
            const archive=path.join(fixture,'unsafe.tar');fs.writeFileSync(archive,Buffer.concat([tarHeader(name,type,0,link),Buffer.alloc(1024)]));
            await assert.rejects(require('../archiveWorker').unpack(archive,path.join(fixture,'tar-scope'),'tar'),/Unsafe TAR/);
        }
    });
    await test('TAR byte budget rejects before extraction',async()=>{
        await assert.rejects(require('../archiveSafety').validateTar(path.join(fixture,'valid.tar.gz'),path.join(fixture,'unused'),{gzip:true,maxBytes:1}),/limit/);
    });
    const integrity=require('../runtimeSecurity');
    const info={version:'8',platformArch:'x64',platformName:'windows'};
    const release={release_name:'jdk8u999-b01',version:{major:8},binary:{os:'windows',architecture:'x64',image_type:'jdk',package:{link:'https://github.com/adoptium/temurin8-binaries/releases/download/test/java.zip',size:100,checksum:'a'.repeat(64)}}};
    await test('Java 8 resolved to current metadata with checksum',async()=>{const r=await integrity.resolveJavaRelease(info,async url=>{assert.ok(url.includes('/assets/latest/8/'));return [release];});assert.equal(r.sha256,'a'.repeat(64));assert.equal(r.release,'jdk8u999-b01');});
    await test('Java metadata without checksum or trusted source rejected',async()=>{
        await assert.rejects(integrity.resolveJavaRelease(info,async()=>[{...release,binary:{...release.binary,package:{...release.binary.package,checksum:''}}}]),/Untrusted/);
        await assert.rejects(integrity.resolveJavaRelease(info,async()=>[{...release,binary:{...release.binary,package:{...release.binary.package,link:'https://attacker.invalid/java.zip'}}}]),/Untrusted/);
    });
    await test('Java receipt detects changed, removed and added files',async()=>{
        const dir=path.join(fixture,'jdk');fs.mkdirSync(path.join(dir,'bin'),{recursive:true});const exe=path.join(dir,'bin','java.exe');fs.writeFileSync(exe,'java');
        integrity.writeRuntimeReceipt(dir,{major:8,release:'jdk8u999-b01',sha256:'a'.repeat(64)});assert.ok(integrity.validateRuntime(dir,8));
        fs.writeFileSync(exe,'evil');assert.equal(integrity.validateRuntime(dir,8),false);fs.writeFileSync(exe,'java');
        fs.writeFileSync(path.join(dir,'evil.dll'),'evil');assert.equal(integrity.validateRuntime(dir,8),false);fs.unlinkSync(path.join(dir,'evil.dll'));
        assert.ok(integrity.validateRuntime(dir,8));fs.unlinkSync(exe);assert.equal(integrity.validateRuntime(dir,8),false);
    });
    await test('Java installation verifies release archive, upgrades cache and supports verified offline use',async()=>{
        const archive=zip('jdk-fixture.zip',{['jdk/bin/'+(process.platform==='win32'?'java.exe':'java')]:'benign executable fixture'});
        const bytes=fs.readFileSync(archive),checksum=crypto.createHash('sha256').update(bytes).digest('hex');let downloads=0,offline=false;
        const vendor={...release,binary:{...release.binary,package:{...release.binary.package,checksum,size:bytes.length}}};
        const Http={json:async()=>{if(offline)throw Error('offline');return [vendor];}};
        const Java=load('RxJavaManager',{RxHttp:Http,RxUtils:Utils,
            RxDownloader:{downloadFile:async(url,file,label,paint,hashes,limits)=>{
                downloads++;assert.equal(hashes.sha256,checksum);assert.equal(limits.expectedSize,bytes.length);fs.copyFileSync(archive,file);
            }},RxFlyout:{setUIStartMode(){},setText(){},setProgress(){},changeMode:async()=>{}},RxToasts:{create(){}},MESSAGES:{java:{}}});
        Java.init();await Java.install('8');assert.ok(Java.isInstalled('8'));assert.equal(downloads,1);
        offline=true;await Java.install('8');assert.equal(downloads,1);
        fs.appendFileSync(Java.getPath('8'),'tamper');await assert.rejects(Java.install('8'),/offline/);
        offline=false;await Java.install('8');assert.equal(downloads,2);assert.ok(Java.isInstalled('8'));
    });
    await test('Forged authlib cache is revalidated and rejected',async()=>{
        const file=path.join(game,'cache','authlib-injector-'+integrity.AUTHLIB.version+'.jar');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'tampered');let requested;
        const Config=load('RxLaunchConfigurator',{IS_APP_IN_DEV:false,RxAccountsManager:{getAccount:()=>({type:'elyby'})},
            RxHttp:{isFileValid:async (f,h)=>fs.existsSync(f)&&crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')===h.sha256},
            RxDownloader:{downloadFile:async(...args)=>{requested=args;}}});
        await assert.rejects(Config.setupAuthlib({customArgs:[]},'x'),/Unverified/);assert.equal(requested[4].sha256,integrity.AUTHLIB.sha256);assert.equal(requested[5].expectedSize,integrity.AUTHLIB.size);
    });
    await test('Windows packaging cannot bypass signing gate',async()=>{
        await assert.rejects(require('../scripts/require-signed-release')({electronPlatformName:'win32',packager:{config:{win:{forceCodeSigning:false}}}}),/Unsigned/);
    });
    console.log(`Security remediation: ${rows.length}/${rows.length} checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
    const resolved=fs.realpathSync(fixture);if(!resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep))throw Error('Unsafe fixture cleanup');fs.rmSync(resolved,{recursive:true,force:true});
});
