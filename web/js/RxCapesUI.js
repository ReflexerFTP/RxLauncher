// Вкладка «Плащи»: пиксельный редактор (64×32 или HD 128×64…512×256), загрузка PNG, 3D-просмотр на skinview3d
// и сохранение на сервер. Рисовать и загружать может каждый, сохранить — Игрок+ и админы
class RxCapesUI {
    static SIZES = [[64, 32], [128, 64], [256, 128], [512, 256]];
    static PALETTE = ["#000000", "#3b3b3b", "#7a7a7a", "#ffffff", "#e53935", "#ff7a1a", "#ffd34d", "#43a047",
        "#1de9b6", "#1e88e5", "#3949ab", "#7c5cff", "#d81b60", "#8d6e63", "#4e342e", "#263238"];
    static MAX_RECENT = 6;
    static MAX_UNDO = 60;
    // Части текстуры в координатах 64×32: сам плащ и элитры
    static REGIONS = [{x: 0, y: 0, w: 22, h: 17, color: "#ffd34d"}, {x: 22, y: 0, w: 24, h: 22, color: "#6fd3ff"}];
    static DEFAULT_SKIN = "assets/skins/default-steve.png";

    static bound = false;
    static visible = false;
    static width = 64;
    static height = 32;
    static pixels = new Uint8ClampedArray(64 * 32 * 4);
    static tool = "pencil";
    static color = "#7c5cff";
    static recent = [];
    static undo = [];
    static redo = [];
    static stroke = null;
    static dirty = false;
    static state = null;      // ответ capes/me
    static loadedHash = "";   // какой плащ с сервера сейчас в редакторе
    static elytra = false;
    static viewer = null;
    static resizeObserver = null;
    static previewTimer = 0;
    static busy = false;

    static t = (key) => MESSAGES.capes?.[key] ?? key;
    static $modal = () => $("#modal-capes");

    static bind = () => {
        if (RxCapesUI.bound) return;
        const $modal = RxCapesUI.$modal();
        if (!$modal.length) return;
        RxCapesUI.bound = true;
        // Переводчик не трогает title — подсказки кнопок подставляем сами
        $modal.find("[title]").each(function () {
            const match = /^\{\{capes\.(\w+)\}\}$/.exec(this.getAttribute("title"));
            if (match) this.setAttribute("title", RxCapesUI.t(match[1]));
        });
        RxCapesUI.renderPalette();
        $modal.find("[data-cape-ingame]").prop("checked", RxCapes.enabledInGame());

        $modal.on("click", "[data-cape-tool]", function () {
            RxCapesUI.setTool(this.dataset.capeTool);
        });
        $modal.on("click", "[data-cape-action]", function () {
            RxCapesUI.action(this.dataset.capeAction);
        });
        $modal.on("click", "[data-cape-swatch]", function () {
            RxCapesUI.setColor(this.dataset.capeSwatch);
        });
        $modal.on("input change", "[data-cape-color]", function () {
            RxCapesUI.setColor(this.value, false);
        });
        $modal.on("change", "[data-cape-file]", function () {
            const file = this.files?.[0];
            this.value = "";
            if (file) RxCapesUI.importFile(file);
        });
        $modal.on("change", "[data-cape-ingame]", function () {
            RxCapes.setEnabledInGame(this.checked);
        });

        const canvas = $modal.find("[data-cape-editor]")[0];
        canvas.addEventListener("pointerdown", RxCapesUI.pointerDown);
        canvas.addEventListener("pointermove", RxCapesUI.pointerMove);
        canvas.addEventListener("pointerup", RxCapesUI.pointerUp);
        canvas.addEventListener("pointercancel", RxCapesUI.pointerUp);
        canvas.addEventListener("contextmenu", event => event.preventDefault());
        canvas.addEventListener("keydown", (event) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            const key = event.key.toLowerCase();
            if (key === "z" && !event.shiftKey) { event.preventDefault(); RxCapesUI.action("undo"); }
            if (key === "y" || (key === "z" && event.shiftKey)) { event.preventDefault(); RxCapesUI.action("redo"); }
        });
        if (typeof ResizeObserver === "function") {
            new ResizeObserver(() => RxCapesUI.visible && RxCapesUI.render()).observe($modal.find("[data-cape-canvas-wrap]")[0]);
        }
        document.addEventListener("rxAccountChanged", () => {
            if (RxCapesUI.visible) RxCapesUI.refresh();
        });
        RxCapesUI.template();
        RxCapesUI.dirty = false;
    };

    static onShow = () => {
        RxCapesUI.visible = true;
        RxCapesUI.bind();
        RxCapesUI.render();
        RxCapesUI.mountViewer();
        RxCapesUI.refresh();
    };

    static onHide = () => {
        RxCapesUI.visible = false;
        RxCapesUI.disposeViewer();
    };

    // ---------- доступ и состояние с сервера ----------

    static refresh = async () => {
        if (!RxAccount.isLoggedIn()) {
            RxCapesUI.state = null;
            RxCapesUI.renderAccess();
            return;
        }
        RxCapesUI.setStatus("loading", RxCapesUI.t("title"), RxCapesUI.t("loading"), "progress_activity");
        try {
            RxCapesUI.state = await RxCapes.state();
        } catch (error) {
            RxCapesUI.state = null;
            RxCapesUI.renderAccess();
            RxCapesUI.setStatus("error", RxCapesUI.t("loadFailed"), RxAccount.errorText(error), "cloud_off");
            return;
        }
        const cape = RxCapesUI.state.cape;
        // Сохранённый плащ открываем в редакторе, если там нет несохранённого рисунка
        if (cape && cape.hash !== RxCapesUI.loadedHash && !RxCapesUI.dirty) {
            try {
                await RxCapesUI.loadImage(`${cape.url}?v=${cape.hash.slice(0, 8)}`, false);
                RxCapesUI.loadedHash = cape.hash;
                RxCapesUI.dirty = false;
            } catch (_) {}
        }
        RxCapesUI.renderAccess();
    };

    static allowed = () => RxCapesUI.state?.allowed === true;

    static renderAccess = () => {
        const $modal = RxCapesUI.$modal();
        const logged = RxAccount.isLoggedIn();
        const allowed = RxCapesUI.allowed();
        const cape = RxCapesUI.state?.cape;
        $modal.find("[data-cape-access]").toggleClass("is-plus", allowed);
        $modal.find("[data-cape-access-icon]").text(allowed ? "star" : "lock");
        $modal.find("[data-cape-access-label]").text(allowed ? RxCapesUI.t("plusActive") : RxCapesUI.t("plusOnly"));
        $modal.find('[data-cape-action="login"]').prop("hidden", logged);
        $modal.find('[data-cape-action="delete"]').prop("hidden", !cape);
        RxCapesUI.updateButtons();
        const nicks = RxCapesUI.state?.nicks || [];
        $modal.find("[data-cape-nicks]").text(allowed && nicks.length
            ? RxCapesUI.t("visibleOn").replace("{0}", nicks.join(", "))
            : RxCapesUI.t("howItWorks"));
        if (!logged) return RxCapesUI.setStatus("warning", RxCapesUI.t("loginTitle"), RxCapesUI.t("loginHint"), "account_circle");
        if (!allowed) return RxCapesUI.setStatus("warning", RxCapesUI.t("plusTitle"), RxCapesUI.t("plusHint"), "workspace_premium");
        if (RxCapesUI.dirty) return RxCapesUI.setStatus("ready", RxCapesUI.t("unsavedTitle"), RxCapesUI.t("unsavedHint"), "edit_note");
        if (cape) return RxCapesUI.setStatus("success", RxCapesUI.t("activeTitle"), RxCapesUI.t("activeHint"), "verified");
        RxCapesUI.setStatus("ready", RxCapesUI.t("emptyTitle"), RxCapesUI.t("emptyHint"), "brush");
    };

    static updateButtons = () => {
        const $modal = RxCapesUI.$modal();
        $modal.find('[data-cape-action="undo"]').prop("disabled", !RxCapesUI.undo.length);
        $modal.find('[data-cape-action="redo"]').prop("disabled", !RxCapesUI.redo.length);
        $modal.find('[data-cape-action="save"]').prop("disabled", RxCapesUI.busy || !RxCapesUI.allowed() || (!RxCapesUI.dirty && Boolean(RxCapesUI.state?.cape)));
        $modal.find("[data-cape-size]").text(`${RxCapesUI.width}×${RxCapesUI.height}`);
    };

    static setStatus = (kind, title, hint, icon) => {
        const $status = RxCapesUI.$modal().find("[data-cape-status]");
        $status.removeClass("is-ready is-success is-warning is-error is-loading").addClass(`is-${kind}`);
        $status.find("[data-cape-status-icon]").text(icon);
        $status.find("[data-cape-status-title]").text(title);
        $status.find("[data-cape-status-hint]").text(hint);
    };

    // ---------- действия ----------

    static action = async (name) => {
        switch (name) {
            case "undo": return RxCapesUI.history(RxCapesUI.undo, RxCapesUI.redo);
            case "redo": return RxCapesUI.history(RxCapesUI.redo, RxCapesUI.undo);
            case "clear":
                RxCapesUI.remember();
                RxCapesUI.pixels.fill(0);
                return RxCapesUI.changed();
            case "template":
                RxCapesUI.remember();
                RxCapesUI.template();
                return RxCapesUI.changed();
            case "upload": return RxCapesUI.$modal().find("[data-cape-file]").trigger("click");
            case "download": return RxCapesUI.download();
            case "save": return RxCapesUI.save();
            case "delete": return RxCapesUI.remove();
            case "login": return RxFriendsUI.openAccount("login");
            case "elytra":
                RxCapesUI.elytra = !RxCapesUI.elytra;
                RxCapesUI.$modal().find('[data-cape-action="elytra"]').attr("aria-pressed", String(RxCapesUI.elytra));
                RxCapesUI.$modal().find("[data-cape-equipment-label]").text(RxCapesUI.t(RxCapesUI.elytra ? "showCape" : "showElytra"));
                return RxCapesUI.updatePreview(true);
        }
    };

    static setTool = (tool) => {
        if (!["pencil", "eraser", "fill", "picker"].includes(tool)) return;
        RxCapesUI.tool = tool;
        RxCapesUI.$modal().find("[data-cape-tool]").each(function () {
            $(this).toggleClass("is-active", this.dataset.capeTool === tool);
        });
    };

    static setColor = (color, syncInput = true) => {
        if (!/^#[0-9a-f]{6}$/i.test(color)) return;
        RxCapesUI.color = color.toLowerCase();
        if (syncInput) RxCapesUI.$modal().find("[data-cape-color]").val(RxCapesUI.color);
        if (RxCapesUI.tool === "eraser" || RxCapesUI.tool === "picker") RxCapesUI.setTool("pencil");
        RxCapesUI.renderPalette();
    };

    static renderPalette = () => {
        const colors = [...new Set([...RxCapesUI.recent, ...RxCapesUI.PALETTE])].slice(0, 22);
        RxCapesUI.$modal().find("[data-cape-palette]").html(colors.map(color =>
            `<button type="button" class="cape-swatch${color === RxCapesUI.color ? " is-current" : ""}" data-cape-swatch="${color}" style="background:${color}" title="${color}" aria-label="${color}"></button>`).join(""));
    };

    static rememberColor = () => {
        RxCapesUI.recent = [RxCapesUI.color, ...RxCapesUI.recent.filter(color => color !== RxCapesUI.color)].slice(0, RxCapesUI.MAX_RECENT);
        RxCapesUI.renderPalette();
    };

    // ---------- рисование ----------

    static remember = () => {
        RxCapesUI.undo.push({width: RxCapesUI.width, height: RxCapesUI.height, pixels: RxCapesUI.pixels.slice()});
        if (RxCapesUI.undo.length > RxCapesUI.MAX_UNDO) RxCapesUI.undo.shift();
        RxCapesUI.redo = [];
    };

    static history = (from, to) => {
        const snapshot = from.pop();
        if (!snapshot) return;
        to.push({width: RxCapesUI.width, height: RxCapesUI.height, pixels: RxCapesUI.pixels.slice()});
        RxCapesUI.width = snapshot.width;
        RxCapesUI.height = snapshot.height;
        RxCapesUI.pixels = snapshot.pixels;
        RxCapesUI.changed();
    };

    static changed = () => {
        RxCapesUI.dirty = true;
        RxCapesUI.render();
        RxCapesUI.updatePreview();
        RxCapesUI.renderAccess();
    };

    static layout = () => {
        const canvas = RxCapesUI.$modal().find("[data-cape-editor]")[0];
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const cell = Math.max(1, Math.floor(Math.min(rect.width / RxCapesUI.width, rect.height / RxCapesUI.height) * ratio)) / ratio;
        const drawWidth = cell * RxCapesUI.width;
        const drawHeight = cell * RxCapesUI.height;
        return {canvas, rect, ratio, cell, left: (rect.width - drawWidth) / 2, top: (rect.height - drawHeight) / 2};
    };

    static pixelAt = (event) => {
        const {rect, cell, left, top} = RxCapesUI.layout();
        const x = Math.floor((event.clientX - rect.left - left) / cell);
        const y = Math.floor((event.clientY - rect.top - top) / cell);
        return x >= 0 && y >= 0 && x < RxCapesUI.width && y < RxCapesUI.height ? {x, y} : null;
    };

    static rgba = () => {
        const value = parseInt(RxCapesUI.color.slice(1), 16);
        return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
    };

    static setPixel = (x, y, rgba) => {
        const index = (y * RxCapesUI.width + x) * 4;
        RxCapesUI.pixels.set(rgba, index);
    };

    static pointerDown = (event) => {
        const point = RxCapesUI.pixelAt(event);
        if (!point || (event.button !== 0 && event.button !== 2)) return;
        event.preventDefault();
        event.currentTarget.focus();
        const tool = event.button === 2 ? "eraser" : RxCapesUI.tool;
        if (tool === "picker") {
            const index = (point.y * RxCapesUI.width + point.x) * 4;
            const [r, g, b, a] = RxCapesUI.pixels.slice(index, index + 4);
            if (a > 0) RxCapesUI.setColor(`#${[r, g, b].map(value => value.toString(16).padStart(2, "0")).join("")}`);
            return;
        }
        RxCapesUI.remember();
        if (tool === "fill") {
            RxCapesUI.flood(point.x, point.y, RxCapesUI.rgba());
            RxCapesUI.rememberColor();
            return RxCapesUI.changed();
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        RxCapesUI.stroke = {tool, last: point};
        RxCapesUI.setPixel(point.x, point.y, tool === "eraser" ? [0, 0, 0, 0] : RxCapesUI.rgba());
        RxCapesUI.dirty = true;
        RxCapesUI.render();
    };

    static pointerMove = (event) => {
        const stroke = RxCapesUI.stroke;
        if (!stroke) return;
        const point = RxCapesUI.pixelAt(event);
        if (!point) return;
        const rgba = stroke.tool === "eraser" ? [0, 0, 0, 0] : RxCapesUI.rgba();
        // Линия от прошлой точки — быстрый росчерк не оставляет дыр
        let {x, y} = stroke.last;
        const dx = Math.abs(point.x - x), dy = -Math.abs(point.y - y);
        const sx = x < point.x ? 1 : -1, sy = y < point.y ? 1 : -1;
        let error = dx + dy;
        for (;;) {
            RxCapesUI.setPixel(x, y, rgba);
            if (x === point.x && y === point.y) break;
            const twice = 2 * error;
            if (twice >= dy) { error += dy; x += sx; }
            if (twice <= dx) { error += dx; y += sy; }
        }
        stroke.last = point;
        RxCapesUI.render();
    };

    static pointerUp = () => {
        if (!RxCapesUI.stroke) return;
        if (RxCapesUI.stroke.tool !== "eraser") RxCapesUI.rememberColor();
        RxCapesUI.stroke = null;
        RxCapesUI.changed();
    };

    static flood = (startX, startY, rgba) => {
        const {width, height, pixels} = RxCapesUI;
        const start = (startY * width + startX) * 4;
        const target = pixels.slice(start, start + 4);
        if (target.every((value, i) => value === rgba[i])) return;
        const same = (index) => pixels[index] === target[0] && pixels[index + 1] === target[1] && pixels[index + 2] === target[2] && pixels[index + 3] === target[3];
        const stack = [[startX, startY]];
        while (stack.length) {
            const [x, y] = stack.pop();
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const index = (y * width + x) * 4;
            if (!same(index)) continue;
            pixels.set(rgba, index);
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
    };

    // Заготовка: плащ и элитры в текущем цвете с тёмной каймой — от неё проще начать
    static template = () => {
        const scale = RxCapesUI.width / 64;
        const base = RxCapesUI.rgba();
        const dark = base.map((value, i) => i === 3 ? 255 : Math.round(value * .62));
        const light = base.map((value, i) => i === 3 ? 255 : Math.min(255, Math.round(value + (255 - value) * .25)));
        RxCapesUI.pixels.fill(0);
        const box = (x, y, w, h, rgba) => {
            for (let py = Math.round(y * scale); py < Math.round((y + h) * scale); py++) {
                for (let px = Math.round(x * scale); px < Math.round((x + w) * scale); px++) RxCapesUI.setPixel(px, py, rgba);
            }
        };
        box(1, 0, 20, 1, dark);   // верх и низ
        box(0, 1, 22, 16, dark);  // бока, снаружи, внутри
        box(1, 1, 10, 16, base);  // снаружи
        box(2, 2, 8, 14, light);
        box(3, 3, 6, 12, base);
        box(12, 1, 10, 16, base); // со стороны спины
        box(22, 0, 24, 22, dark); // элитры
        box(24, 2, 10, 20, base);
        box(36, 2, 10, 20, base);
    };

    // ---------- отрисовка ----------

    static render = () => {
        if (!RxCapesUI.bound) return;
        const {canvas, rect, ratio, cell, left, top} = RxCapesUI.layout();
        if (!rect.width || !rect.height) return;
        canvas.width = Math.round(rect.width * ratio);
        canvas.height = Math.round(rect.height * ratio);
        const context = canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.imageSmoothingEnabled = false;
        const width = RxCapesUI.width, height = RxCapesUI.height;
        // Шахматка под прозрачными пикселями
        const check = Math.max(cell, 4);
        for (let y = 0; y * check < height * cell; y++) {
            for (let x = 0; x * check < width * cell; x++) {
                context.fillStyle = (x + y) % 2 ? "rgba(255,255,255,.07)" : "rgba(255,255,255,.025)";
                context.fillRect(left + x * check, top + y * check, Math.min(check, width * cell - x * check), Math.min(check, height * cell - y * check));
            }
        }
        context.drawImage(RxCapesUI.bitmap(), left, top, width * cell, height * cell);
        if (cell >= 6) {
            context.strokeStyle = "rgba(255,255,255,.07)";
            context.lineWidth = 1 / ratio;
            context.beginPath();
            for (let x = 0; x <= width; x++) { context.moveTo(left + x * cell, top); context.lineTo(left + x * cell, top + height * cell); }
            for (let y = 0; y <= height; y++) { context.moveTo(left, top + y * cell); context.lineTo(left + width * cell, top + y * cell); }
            context.stroke();
        }
        const unit = cell * width / 64;
        context.lineWidth = Math.max(1.5, 2 / ratio);
        for (const region of RxCapesUI.REGIONS) {
            context.strokeStyle = region.color;
            context.globalAlpha = .75;
            context.strokeRect(left + region.x * unit, top + region.y * unit, region.w * unit, region.h * unit);
        }
        context.globalAlpha = 1;
    };

    static bitmap = () => {
        const canvas = document.createElement("canvas");
        canvas.width = RxCapesUI.width;
        canvas.height = RxCapesUI.height;
        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(RxCapesUI.pixels), RxCapesUI.width, RxCapesUI.height), 0, 0);
        return canvas;
    };

    static dataUrl = () => RxCapesUI.bitmap().toDataURL("image/png");

    // ---------- PNG ----------

    static importFile = (file) => {
        if (file.size > 2 * 1024 * 1024) return RxCapesUI.setStatus("error", RxCapesUI.t("badFile"), RxCapesUI.t("badSize"), "error");
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                RxCapesUI.remember();
                await RxCapesUI.loadImage(reader.result, true);
                RxCapesUI.loadedHash = "";
                RxCapesUI.changed();
            } catch (error) {
                RxCapesUI.undo.pop();
                RxCapesUI.setStatus("error", RxCapesUI.t("badFile"), error?.message === "size" ? RxCapesUI.t("badSize") : RxCapesUI.t("badPng"), "error");
            }
        };
        reader.readAsDataURL(file);
    };

    static loadImage = (src, fromFile) => new Promise((resolve, reject) => {
        const image = new Image();
        if (!fromFile) image.crossOrigin = "anonymous";
        image.onload = () => {
            let width = image.naturalWidth, height = image.naturalHeight;
            // Старый формат 22×17 (и его HD-кратные) — это левый верхний угол обычной текстуры 64×32
            const legacy = width * 17 === height * 22 && width % 22 === 0 && width <= 22 * 8;
            const scale = legacy ? width / 22 : 1;
            if (legacy) { width = 64 * scale; height = 32 * scale; }
            if (!RxCapesUI.SIZES.some(([w, h]) => w === width && h === height)) return reject(new Error("size"));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            context.imageSmoothingEnabled = false;
            context.drawImage(image, 0, 0);
            RxCapesUI.width = width;
            RxCapesUI.height = height;
            RxCapesUI.pixels = context.getImageData(0, 0, width, height).data;
            RxCapesUI.render();
            RxCapesUI.updatePreview(true);
            resolve();
        };
        image.onerror = () => reject(new Error("png"));
        image.src = src;
    });

    static download = async () => {
        try {
            const target = await ipcRenderer.invoke("save-dialog", {title: RxCapesUI.t("download"), defaultPath: "cape.png", filters: [{name: "PNG", extensions: ["png"]}]});
            if (!target) return;
            fs.writeFileSync(String(target), Buffer.from(RxCapesUI.dataUrl().split(",")[1], "base64"));
            RxToasts.create(RxCapesUI.t("downloaded"), "download_done", String(target));
        } catch (error) {
            RxCapesUI.setStatus("error", RxCapesUI.t("saveFailed"), String(error?.message || error), "error");
        }
    };

    static save = async () => {
        if (RxCapesUI.busy || !RxCapesUI.allowed()) return;
        if (!RxCapesUI.pixels.some((value, index) => index % 4 === 3 && value > 0)) {
            return RxCapesUI.setStatus("warning", RxCapesUI.t("emptyCapeTitle"), RxCapesUI.t("emptyCapeHint"), "brush");
        }
        RxCapesUI.busy = true;
        RxCapesUI.updateButtons();
        RxCapesUI.setStatus("loading", RxCapesUI.t("saving"), RxCapesUI.t("savingHint"), "progress_activity");
        try {
            RxCapesUI.state = await RxCapes.save(RxCapesUI.dataUrl().split(",")[1]);
            RxCapesUI.loadedHash = RxCapesUI.state.cape?.hash || "";
            RxCapesUI.dirty = false;
            RxToasts.create(RxCapesUI.t("savedTitle"), "checkroom", RxCapesUI.t("savedHint"));
        } catch (error) {
            RxCapesUI.busy = false;
            RxCapesUI.updateButtons();
            return RxCapesUI.setStatus("error", RxCapesUI.t("saveFailed"), RxCapesUI.t("errors")?.[error?.code] || RxAccount.errorText(error), "error");
        }
        RxCapesUI.busy = false;
        RxCapesUI.renderAccess();
    };

    static remove = async () => {
        if (RxCapesUI.busy || !RxCapesUI.state?.cape) return;
        const ok = await RxDialog.confirm({icon: "delete", title: RxCapesUI.t("deleteTitle"), text: RxCapesUI.t("deleteText"), confirmText: RxCapesUI.t("delete"), danger: true});
        if (!ok) return;
        RxCapesUI.busy = true;
        try {
            RxCapesUI.state = await RxCapes.remove();
            RxCapesUI.loadedHash = "";
            RxCapesUI.dirty = true;
        } catch (error) {
            RxCapesUI.setStatus("error", RxCapesUI.t("saveFailed"), RxAccount.errorText(error), "error");
        }
        RxCapesUI.busy = false;
        RxCapesUI.renderAccess();
    };

    // ---------- 3D ----------

    static mountViewer = async () => {
        RxCapesUI.disposeViewer();
        const $modal = RxCapesUI.$modal();
        if (!(await RxSkinBrowserUI.ensureViewerScript()) || !RxCapesUI.visible || typeof skinview3d?.SkinViewer !== "function") {
            $modal.find("[data-cape-preview-unavailable]").prop("hidden", false);
            return;
        }
        const canvas = $modal.find("[data-cape-viewer-canvas]")[0];
        const stage = $modal.find("[data-cape-preview-stage]")[0];
        const bounds = stage.getBoundingClientRect();
        try {
            const animate = RxConfig.read("disableAnimations", false) !== true;
            const viewer = new skinview3d.SkinViewer({canvas, width: Math.max(220, Math.round(bounds.width)), height: Math.max(260, Math.round(bounds.height)),
                zoom: 0.82, fov: 50, pixelRatio: "match-device"});
            viewer.background = null;
            viewer.autoRotate = animate;
            viewer.autoRotateSpeed = 0.55;
            if (viewer.controls) viewer.controls.enablePan = false;
            RxCapesUI.viewer = viewer;
            await viewer.loadSkin(RxCapesUI.DEFAULT_SKIN);
            // Начальный ракурс — со спины, плащ виден сразу
            viewer.playerObject.rotation.y = Math.PI;
            if (animate && typeof skinview3d.IdleAnimation === "function") viewer.animation = new skinview3d.IdleAnimation();
            $(canvas).addClass("is-visible");
            $modal.find("[data-cape-preview-unavailable]").prop("hidden", true);
            RxCapesUI.updatePreview(true);
            if (typeof ResizeObserver === "function") {
                RxCapesUI.resizeObserver = new ResizeObserver(entries => {
                    const rect = entries[0]?.contentRect;
                    if (RxCapesUI.viewer && rect?.width && rect?.height) RxCapesUI.viewer.setSize(Math.round(rect.width), Math.round(rect.height));
                });
                RxCapesUI.resizeObserver.observe(stage);
            }
        } catch (error) {
            RxCollector.writeLog(`RxCapes: Preview failed [error=${error?.message || error}]`);
            RxCapesUI.disposeViewer();
            $modal.find("[data-cape-preview-unavailable]").prop("hidden", false);
        }
    };

    static disposeViewer = () => {
        RxCapesUI.resizeObserver?.disconnect();
        RxCapesUI.resizeObserver = null;
        if (RxCapesUI.viewer) {
            try { RxCapesUI.viewer.dispose(); } catch (_) {}
        }
        RxCapesUI.viewer = null;
        RxCapesUI.$modal().find("[data-cape-viewer-canvas]").removeClass("is-visible");
    };

    static updatePreview = (now = false) => {
        clearTimeout(RxCapesUI.previewTimer);
        RxCapesUI.previewTimer = setTimeout(() => {
            if (!RxCapesUI.viewer) return;
            Promise.resolve(RxCapesUI.viewer.loadCape(RxCapesUI.dataUrl(), {backEquipment: RxCapesUI.elytra ? "elytra" : "cape"})).catch(() => {});
        }, now ? 0 : 120);
    };
}
