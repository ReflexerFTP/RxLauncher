const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const webRoot = path.join(__dirname, 'web');

// All launcher code lives in Electron's isolated world. The page receives no
// Node globals, IPC bridge, tokens or method for executing arbitrary scripts.
window.require = createRequire(path.join(webRoot, 'index.ejs'));
window.__dirname = webRoot;
window.Buffer = Buffer;
window.process = process;
window.global = window;
const run = (source, filename) => vm.runInThisContext(source, {filename});
window.loadRxLibrary = name => {
    if (name !== 'skinview3d') throw new Error('Unknown library');
    run(fs.readFileSync(path.join(webRoot, 'js', 'skinview3d.bundle.js'), 'utf8'), 'skinview3d.bundle.js');
};

window.addEventListener('DOMContentLoaded', () => {
    try {
        // Parse a fresh render of bundled templates, never scripts/handlers from
        // the live DOM (which contains third-party pack and world metadata).
        const filename = path.join(webRoot, 'index.ejs');
        const html = require('electron').ipcRenderer.sendSync('renderer-template');
        if (typeof html !== 'string') throw new Error('Trusted template unavailable');
        const trusted = new DOMParser().parseFromString(html, 'text/html');
        const events = new Map();
        for (const kind of ['click', 'change', 'input', 'submit', 'keydown']) {
            const attr = `data-rx-on${kind}`;
            const handlers = new Map();
            for (const node of trusted.querySelectorAll(`[${attr}]`)) {
                const code = node.getAttribute(attr);
                if (!code.includes('$1') && !code.includes('$4')) {
                    handlers.set(code, run(`(function(event) { ${code}\n })`, 'trusted-ui-action.js'));
                }
            }
            events.set(kind, handlers);
            document.addEventListener(kind, event => {
                const element = event.target.closest?.(`[${attr}]`);
                if (!element || element.disabled) return;
                const action = handlers.get(element.getAttribute(attr));
                if (action && action.call(element, event) === false) event.preventDefault();
            });
        }
        for (const script of trusted.querySelectorAll('script')) {
            const src = script.getAttribute('src');
            if (src) {
                const file = path.resolve(webRoot, src);
                if (!file.startsWith(webRoot + path.sep) || !file.endsWith('.js')) throw new Error('Invalid bundled script');
                run(fs.readFileSync(file, 'utf8'), file);
            } else if (script.textContent.trim()) run(script.textContent, 'trusted-template.js');
        }
        // Two template actions use data values, never interpolated JavaScript.
        document.addEventListener('click', event => {
            const version = event.target.closest?.('[data-rx-play-version]');
            if (version && /^[\w.-]{1,64}$/.test(version.dataset.rxPlayVersion)) {
                run('(id => RxStarter.simpleStart("vanilla-" + id))', 'version-action.js')(version.dataset.rxPlayVersion);
            }
            const language = event.target.closest?.('[data-rx-language]');
            if (language && ['ru', 'en'].includes(language.dataset.rxLanguage)) {
                run('(id => RxTranslator.setCurrentLanguage(id))', 'language-action.js')(language.dataset.rxLanguage);
            }
        });
    } catch (error) {
        console.error('Launcher bootstrap failed:', error);
        document.documentElement.style.display = 'block';
        document.body.textContent = 'Не удалось запустить интерфейс лаунчера: ' + error.message;
    }
}, {once: true});
