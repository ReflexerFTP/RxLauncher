const fs = require("fs");
const http = require("http");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const translations = JSON.parse(fs.readFileSync(path.join(projectRoot, "web", "languages", "ru.json"), "utf8")).translations;

function nestedValue(key) {
    return key.split(".").reduce((value, part) => value && value[part], translations);
}

function statisticsMarkup() {
    return fs.readFileSync(path.join(projectRoot, "web", "modals", "statistics.ejs"), "utf8")
        .replace(/<link[^>]+>/, "")
        .replaceAll("style=\"display: none;\"", "style=\"display: block;\"")
        .replace(/\{\{([0-9a-zA-Z_.-]+)}}/g, (_match, key) => nestedValue(key) || key);
}

function localizedMarkup(relativePath, visible = true) {
    let markup = fs.readFileSync(path.join(projectRoot, ...relativePath), "utf8")
        .replace(/<link[^>]+>\s*/g, "")
        .replace(/<script[^>]+><\/script>\s*/g, "")
        .replace(/\{\{([0-9a-zA-Z_.-]+)}}/g, (_match, key) => nestedValue(key) || key);
    if (visible) markup = markup.replaceAll('style="display: none;"', 'style="display: block;"');
    return markup;
}

function mockData() {
    const now = Date.now();
    const days = {};
    [28, 67, 103, 44, 125, 81, 152, 92, 36, 178, 114, 205, 74, 163].forEach((minutes, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (13 - index));
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        days[key] = {playSeconds: minutes * 60};
    });
    const sessions = Array.from({length: 9}, (_, index) => ({
        id: `demo-${index}`,
        startedAt: now - index * 86400000,
        endedAt: now - index * 86400000 + (5400 + index * 300) * 1000,
        lastCheckpointAt: now - index * 86400000,
        playSeconds: 5400 + index * 300,
        versionId: index % 2 ? "fabric-1.21.4" : "forge-1.21.4",
        nickname: index % 3 === 0 ? "Maksim_rrr" : index % 3 === 1 ? "MaxPvP" : "Builder_2",
        kills: 28 - index,
        deaths: 4 + index,
        bestKillStreak: 12,
        serverSeconds: index % 3 === 2 ? {} : {[index % 2 ? "play.infinitybox.pro" : "hypixel.net"]: 4800},
        worldSeconds: index % 3 === 2 ? {"Neon Survival": 5100} : {},
        dailySeconds: {},
        endReason: index === 4 ? "interrupted" : "closed"
    }));
    return {
        period: "all",
        nickname: "all",
        totals: {playSeconds: 513180, sessions: 87, kills: 1324, deaths: 251, bestKillStreak: 38},
        kd: 5.27,
        rankings: {
            servers: [
                {name: "play.infinitybox.pro", playSeconds: 286000, sessions: 41},
                {name: "hypixel.net", playSeconds: 121400, sessions: 19},
                {name: "mc.example.ru:25566", playSeconds: 48700, sessions: 8}
            ],
            nicknames: [
                {name: "Maksim_rrr", playSeconds: 302300, sessions: 52},
                {name: "MaxPvP", playSeconds: 144000, sessions: 23},
                {name: "Builder_2", playSeconds: 66880, sessions: 12}
            ],
            worlds: [
                {name: "Neon Survival", playSeconds: 76300, sessions: 11},
                {name: "Hardcore 2026", playSeconds: 35100, sessions: 5},
                {name: "Creative Lab", playSeconds: 17400, sessions: 3}
            ],
            versions: []
        },
        days,
        sessions,
        nicknameOptions: ["Maksim_rrr", "MaxPvP", "Builder_2"],
        detailedTrackingSince: now - 1209600000,
        legacyMigrated: true,
        active: true,
        updatedAt: now,
        storagePath: "C:\\Users\\Maksim_\\AppData\\Roaming\\rxclient\\play-statistics.json"
    };
}

function previewHtml() {
    const mock = JSON.stringify(mockData()).replace(/</g, "\\u003c");
    const messages = JSON.stringify(translations).replace(/</g, "\\u003c");
    return `<!doctype html>
<html class="dark" lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/css/globals.css"><link rel="stylesheet" href="/web/modals/statistics.css">
<style>
html,body{border-radius:0!important;background:#190706;width:100%;height:100%;}
body{padding:18px;background:radial-gradient(circle at 8% 92%,rgba(229,57,53,.34),transparent 34%),linear-gradient(145deg,#270807,#090505);}
#modal-statistics{--theme-primary:#e53935;--theme-primaryLighter:#ff6d67;--theme-primaryDarker:#a31512;--theme-primaryBg:#180b0b;--theme-primaryBgLight:#2a1515;--theme-primaryBgLighter:#422020;--theme-primaryBgDark:#0e0606;--theme-text:#fff;--theme-hue:2;--rx-stroke:rgba(255,255,255,.09);--rx-stroke-strong:rgba(255,255,255,.17);--rx-glow:rgba(229,57,53,.45);width:100%;height:100%;}
</style></head><body>${statisticsMarkup()}
<script src="/node_modules/jquery/dist/jquery.min.js"></script>
<script>window.MESSAGES=${messages};window.__mockStats=${mock};window.RxTranslator={getCurrentLanguage:()=>"ru"};window.RxPlayStats={getDashboard:()=>window.__mockStats,getStoragePath:()=>window.__mockStats.storagePath,dayKey:(timestamp=Date.now())=>{const d=new Date(timestamp);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")},checkpoint:()=>true};window.RxModals={isModalShown:()=>true};window.RxCollector={writeLog:()=>true};window.RxToasts={create:()=>true};window.ipcRenderer={invoke:async()=>false};window.openExternal=()=>true;window.path={dirname:value=>value.replace(/\\\\[^\\\\]+$/,"")};</script>
<script src="/web/js/RxStatisticsUI.js"></script><script>$(function(){RxStatisticsUI.render(true)});</script>
</body></html>`;
}

function patchesPreviewHtml() {
    const messages = JSON.stringify(translations).replace(/</g, "\\u003c");
    const news = localizedMarkup(["web", "views", "news.ejs"]);
    const changelog = localizedMarkup(["web", "modals", "changelog.ejs"], false);
    return `<!doctype html>
<html class="dark" lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/css/globals.css"><link rel="stylesheet" href="/web/views/news.css"><link rel="stylesheet" href="/web/modals/changelog.css">
<style>
:root{--theme-primary:#e53935;--theme-primaryLighter:#ff6d67;--theme-primaryDarker:#a31512;--theme-primaryBg:#180b0b;--theme-primaryBgLight:#2a1515;--theme-primaryBgLighter:#422020;--theme-primaryBgDark:#0e0606;--theme-text:#fff;--theme-hue:2;--rx-stroke:rgba(255,255,255,.09);--rx-stroke-strong:rgba(255,255,255,.17);--rx-glow:rgba(229,57,53,.45);--text-color:#fff;--text-sub:#bdaaaa}
html,body{border-radius:0!important;background:#120606;width:100%;height:100%;overflow:hidden}.patch-preview-bg{width:100%;height:100%;padding:28px;background:radial-gradient(circle at 8% 92%,rgba(229,57,53,.28),transparent 34%),linear-gradient(145deg,#270807,#090505)}
#modal-content{width:430px;height:650px;padding:18px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--rx-stroke);border-radius:18px;background:rgba(24,11,11,.96);box-shadow:0 25px 80px rgba(0,0,0,.5)}
#modal-changelog{position:absolute;inset:18px;width:auto;height:auto;display:none;border:1px solid var(--rx-stroke);border-radius:18px;background:rgba(24,11,11,.98)}
button{border:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}*{box-sizing:border-box}
</style></head><body><div class="patch-preview-bg"><main id="modal-content">${news}</main>${changelog}</div>
<script src="/node_modules/jquery/dist/jquery.min.js"></script>
<script>window.MESSAGES=${messages};window.RxTranslator={getCurrentLanguage:()=>"ru"};window.__modalName="content";window.RxModals={currentModalName:()=>window.__modalName,switchModal:(name)=>{window.__modalName=name;document.getElementById("modal-content").style.display=name==="content"?"flex":"none";document.getElementById("modal-changelog").style.display=name==="changelog"?"block":"none";document.dispatchEvent(new CustomEvent("showModalEvent",{detail:{modal:name}}));return true}};</script>
<script src="/web/js/RxPatchNotes.js"></script><script src="/web/modals/changelog.js"></script><script src="/web/js/RxPatchFeed.js"></script>
</body></html>`;
}

const server = http.createServer((request, response) => {
    if (request.url === "/" || request.url === "/preview") {
        response.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
        response.end(previewHtml());
        return;
    }
    if (request.url === "/patches") {
        response.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
        response.end(patchesPreviewHtml());
        return;
    }
    const relative = decodeURIComponent(request.url.split("?")[0]).replace(/^\/+/, "");
    const target = path.resolve(projectRoot, relative);
    if (!target.startsWith(projectRoot + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
    }
    const extension = path.extname(target).toLowerCase();
    const contentTypes = {".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp"};
    response.writeHead(200, {"Content-Type": contentTypes[extension] || "application/octet-stream", "Cache-Control": "no-store"});
    fs.createReadStream(target).pipe(response);
});

server.listen(43117, "127.0.0.1", () => console.log("RxLaunch UI preview: http://127.0.0.1:43117/preview"));
