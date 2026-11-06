// Управление запущенным RxLauncher Dev через CDP (WebView2 с --remote-debugging-port=9333):
// node tauri/dev/cdp.cjs [--eval=код] [--shot=файл.png] [--wait=мс]
"use strict";
const fs = require("node:fs");
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=") || true]; }));
const port = Number(args.port || 9333);

(async () => {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            target = list.find(item => item.type === "page" && /127\.0\.0\.1:1420|tauri\.localhost/.test(item.url));
        } catch (_) {}
        if (!target) await new Promise(r => setTimeout(r, 500));
    }
    if (!target) throw new Error("No RxLauncher page on the debugging port");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const logs = [];
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
        if (message.method === "Runtime.consoleAPICalled") logs.push(`${message.params.type}: ${message.params.args.map(a => a.value ?? a.description).join(" ")}`);
        if (message.method === "Runtime.exceptionThrown") logs.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
    };
    const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({id: n, method, params})); });
    await send("Runtime.enable");
    if (args.wait) await new Promise(r => setTimeout(r, Number(args.wait)));
    const out = {url: target.url};
    if (args.eval) {
        const result = await send("Runtime.evaluate", {expression: String(args.eval), awaitPromise: true, returnByValue: true});
        out.eval = result.result?.result?.value ?? result.result?.exceptionDetails?.exception?.description ?? result.result;
    }
    if (args.shot) {
        const shot = await send("Page.captureScreenshot", {format: "png"});
        fs.writeFileSync(String(args.shot), Buffer.from(shot.result.data, "base64"));
        out.shot = args.shot;
    }
    out.logs = logs.slice(0, 40);
    console.log(JSON.stringify(out, null, 2));
    socket.close();
    process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
