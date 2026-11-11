// Замена Jimp на OffscreenCanvas (WebView): то, что использует лаунчер — чтение PNG, crop, resize (в т. ч. «ближайший
// сосед» для пикселей скина), composite, scan/setPixelColor, запись PNG
const fs = require("fs");
const {Buffer} = require("buffer");

const ResizeStrategy = {NEAREST_NEIGHBOR: "nearestNeighbor", BILINEAR: "bilinearInterpolation", BICUBIC: "bicubicInterpolation"};
const HorizontalAlign = {LEFT: "left", CENTER: "center", RIGHT: "right"};
const VerticalAlign = {TOP: "top", MIDDLE: "middle", BOTTOM: "bottom"};
const rgbaToInt = (r, g, b, a = 255) => (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
const intToRGBA = value => ({r: (value >>> 24) & 255, g: (value >>> 16) & 255, b: (value >>> 8) & 255, a: value & 255});

class Jimp {
    constructor({width = 1, height = 1, color = 0} = {}) {
        const data = new Uint8ClampedArray(width * height * 4);
        if (color) {
            const {r, g, b, a} = intToRGBA(color);
            for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
        }
        this.bitmap = {width, height, data};
    }

    static fromImageData(imageData) {
        const image = new Jimp({width: imageData.width, height: imageData.height});
        image.bitmap.data = new Uint8ClampedArray(imageData.data);
        return image;
    }

    static async read(source) {
        const bytes = typeof source === "string" ? await fs.promises.readFile(source) : Buffer.from(source);
        const bitmap = await createImageBitmap(new Blob([bytes], {type: "image/png"}));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return Jimp.fromImageData(context.getImageData(0, 0, canvas.width, canvas.height));
    }

    get width() { return this.bitmap.width; }
    get height() { return this.bitmap.height; }

    _canvas() {
        const canvas = new OffscreenCanvas(this.bitmap.width, this.bitmap.height);
        canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(this.bitmap.data), this.bitmap.width, this.bitmap.height), 0, 0);
        return canvas;
    }

    _replace(canvas) {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        this.bitmap = {width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(data.data)};
        return this;
    }

    clone() {
        const copy = new Jimp({width: this.bitmap.width, height: this.bitmap.height});
        copy.bitmap.data = new Uint8ClampedArray(this.bitmap.data);
        return copy;
    }

    crop({x, y, w, h}) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const sx = x + col, sy = y + row;
                if (sx < 0 || sy < 0 || sx >= this.bitmap.width || sy >= this.bitmap.height) continue;
                const from = (sy * this.bitmap.width + sx) * 4, to = (row * w + col) * 4;
                out[to] = this.bitmap.data[from]; out[to + 1] = this.bitmap.data[from + 1]; out[to + 2] = this.bitmap.data[from + 2]; out[to + 3] = this.bitmap.data[from + 3];
            }
        }
        this.bitmap = {width: w, height: h, data: out};
        return this;
    }

    resize({w, h, mode}) {
        if (mode === ResizeStrategy.NEAREST_NEIGHBOR) {
            const out = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) {
                const sy = Math.min(this.bitmap.height - 1, Math.floor(y * this.bitmap.height / h));
                for (let x = 0; x < w; x++) {
                    const sx = Math.min(this.bitmap.width - 1, Math.floor(x * this.bitmap.width / w));
                    const from = (sy * this.bitmap.width + sx) * 4, to = (y * w + x) * 4;
                    out[to] = this.bitmap.data[from]; out[to + 1] = this.bitmap.data[from + 1]; out[to + 2] = this.bitmap.data[from + 2]; out[to + 3] = this.bitmap.data[from + 3];
                }
            }
            this.bitmap = {width: w, height: h, data: out};
            return this;
        }
        const target = new OffscreenCanvas(w, h);
        const context = target.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(this._canvas(), 0, 0, w, h);
        return this._replace(target);
    }

    // Наложение с учётом прозрачности (source-over)
    composite(source, x = 0, y = 0) {
        const {width, height, data} = this.bitmap;
        for (let row = 0; row < source.bitmap.height; row++) {
            for (let col = 0; col < source.bitmap.width; col++) {
                const dx = x + col, dy = y + row;
                if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
                const from = (row * source.bitmap.width + col) * 4, to = (dy * width + dx) * 4;
                const alpha = source.bitmap.data[from + 3] / 255;
                if (alpha <= 0) continue;
                const base = data[to + 3] / 255;
                const outAlpha = alpha + base * (1 - alpha);
                for (let c = 0; c < 3; c++) {
                    data[to + c] = outAlpha ? (source.bitmap.data[from + c] * alpha + data[to + c] * base * (1 - alpha)) / outAlpha : 0;
                }
                data[to + 3] = outAlpha * 255;
            }
        }
        return this;
    }

    scan(x, y, w, h, callback) {
        for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) callback.call(this, px, py, (py * this.bitmap.width + px) * 4);
        }
        return this;
    }

    getPixelColor(x, y) {
        const i = (y * this.bitmap.width + x) * 4;
        return rgbaToInt(this.bitmap.data[i], this.bitmap.data[i + 1], this.bitmap.data[i + 2], this.bitmap.data[i + 3]);
    }

    setPixelColor(color, x, y) {
        if (x < 0 || y < 0 || x >= this.bitmap.width || y >= this.bitmap.height) return this;
        const {r, g, b, a} = intToRGBA(color);
        const i = (y * this.bitmap.width + x) * 4;
        this.bitmap.data[i] = r; this.bitmap.data[i + 1] = g; this.bitmap.data[i + 2] = b; this.bitmap.data[i + 3] = a;
        return this;
    }

    async getBuffer(mime = "image/png") {
        const blob = await this._canvas().convertToBlob({type: mime});
        return Buffer.from(new Uint8Array(await blob.arrayBuffer()));
    }

    async getBase64(mime = "image/png") {
        return `data:${mime};base64,${(await this.getBuffer(mime)).toString("base64")}`;
    }

    async write(file) {
        const mime = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
        await fs.promises.writeFile(file, await this.getBuffer(mime));
        return this;
    }
}

module.exports = {Jimp, ResizeStrategy, HorizontalAlign, VerticalAlign, rgbaToInt, intToRGBA};
