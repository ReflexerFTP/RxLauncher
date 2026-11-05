'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rx-api-remediation-'));
let child,port;const passed=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const test=async(name,run)=>{await run();passed.push(name);};
async function stop(){if(child&&child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
async function start(admin=''){
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));
    child=spawn(process.execPath,['--no-warnings',path.join(__dirname,'../server/api/server.js')],{windowsHide:true,
        env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DB_PATH:path.join(root,'rx.db'),NODE_ENV:'test',RX_ADMIN_NICK:admin,
            DISCORD_CLIENT_ID:'123456',DISCORD_CLIENT_SECRET:'test-only'},stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();
    for(let i=0;i<60;i++){if(child.exitCode!==null)return false;try{if((await request('/api/health')).ok)return true;}catch(_){}await pause(50);}throw Error('API startup timeout');
}
async function request(route,body,headers={}){
    const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',redirect:'manual',
        headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    let data={};try{data=await r.json();}catch(_){}return {status:r.status,cookie:r.headers.get('set-cookie'),location:r.headers.get('location'),...data};
}
const auth=token=>({Authorization:'Bearer '+token});
async function flow(mode='login',cookie=''){
    const r=await request('/api/auth/discord/start?mode='+mode,undefined,cookie?{Cookie:cookie}:{});
    assert.equal(r.status,302);const state=new URL(r.location).searchParams.get('state');
    const browser=/rx_oauth_[A-Za-z0-9_-]+=[A-Za-z0-9_-]{32}/.exec(r.cookie||'')?.[0];assert.ok(browser);
    return {state,browser,response:r};
}
const callback=(state,code,cookie)=>request('/api/auth/discord/callback?state='+state+'&code='+encodeURIComponent(code),undefined,cookie?{Cookie:cookie}:{});
(async()=>{
    assert.ok(await start());
    const a=await request('/api/account/register',{nick:'AuditOwner',password:'fixture-pass-1'});assert.ok(a.token);
    await test('Link callback without initiating browser cookie blocked',async()=>{
        const f=await flow('link','rx_session='+a.token);
        assert.match(f.response.cookie,/HttpOnly; Secure; SameSite=Lax/);
        assert.match((await callback(f.state,'test:123456789:OwnerDiscord')).location,/cancel/);
        assert.equal((await request('/api/account/me',{},auth(a.token))).user.discord,'');
        assert.match((await callback(f.state,'test:123456789:OwnerDiscord',f.browser)).location,/linked/);
        assert.equal((await request('/api/account/me',{},auth(a.token))).user.discord,'OwnerDiscord');
    });
    await test('Login state cannot be swapped to another browser',async()=>{
        const f=await flow(),other=await flow();
        const foreign=await callback(f.state,'test:123456789:OwnerDiscord',other.browser);assert.match(foreign.location,/cancel/);assert.equal(foreign.cookie,null);
        const own=await callback(f.state,'test:123456789:OwnerDiscord',f.browser);assert.match(own.location,/discord=ok/);assert.match(own.cookie,/rx_session=rx1_/);
        assert.match((await callback(f.state,'test:123456789:OwnerDiscord',f.browser)).location,/cancel/);
    });
    await test('OAuth signup ticket bound to same browser',async()=>{
        const f=await flow();const result=await callback(f.state,'test:987654321:NewDiscord',f.browser);
        const ticket=/#discord-signup=([A-Za-z0-9_-]+)/.exec(result.location)[1];
        assert.equal((await request('/api/auth/discord/ticket',{ticket})).status,404);
        assert.equal((await request('/api/auth/discord/register',{ticket,nick:'NewDiscord'})).status,404);
        assert.equal((await request('/api/auth/discord/ticket',{ticket},{Cookie:f.browser})).ok,true);
        assert.equal((await request('/api/auth/discord/register',{ticket,nick:'NewDiscord'},{Cookie:f.browser})).ok,true);
    });
    await test('Revoked authenticated session cannot complete link',async()=>{
        const b=await request('/api/account/register',{nick:'RevokedUser',password:'fixture-pass-2'});
        const f=await flow('link','rx_session='+b.token);await request('/api/account/logout',{},auth(b.token));
        assert.match((await callback(f.state,'test:222222222:RevokedDiscord',f.browser)).location,/discord=login/);
    });
    await test('Occupied bootstrap nickname never silently promoted',async()=>{
        await stop();assert.equal(await start('AuditOwner'),false);assert.equal(child.exitCode,1);
        assert.ok(await start());assert.equal((await request('/api/account/me',{},auth(a.token))).user.group,'player');
    });
    console.log(`API security remediation: ${passed.length}/${passed.length} checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
    await stop();const resolved=fs.realpathSync(root);if(!resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');fs.rmSync(resolved,{recursive:true,force:true});
});
