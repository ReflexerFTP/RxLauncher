// Защищённый читатель NBT для метаданных мира (level.dat). Заменяет mcnbt в этом месте:
// библиотека доверяла длине TAG_List из файла и для дочернего типа TAG_End добавляла элементы,
// не читая их байты — крошечный файл раздувал память (DoS). Здесь жёсткие лимиты:
// размер после распаковки, число тегов, глубина, а длины списков и массивов сверяются с остатком буфера.
const zlib = require("zlib");
const fs = require("fs");

const MAX_OUTPUT = 32 * 1024 * 1024; // распакованный level.dat столько не весит
const MAX_TAGS = 400000;             // потолок на суммарное число тегов (защита от списков-бомб)
const MAX_DEPTH = 64;

class RxNbt {
    static TAG_END = 0;

    static read = (buffer) => {
        if (!Buffer.isBuffer(buffer) || buffer.length > MAX_OUTPUT) throw new Error("Invalid NBT size");
        const reader = new RxNbt(buffer);
        const type = reader.u1();
        if (type !== 10) throw new Error("NBT root must be a compound");
        const name = reader.str();
        const result = {[name]: {value: reader.compound(1)}};
        if (reader.pos !== buffer.length) throw new Error("Trailing NBT data");
        return result;
    };

    // level.dat сжат gzip (Java Edition). Распаковка ограничена по размеру — защита от «zlib-бомбы».
    static readLevelDat = (filePath) => {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_OUTPUT) throw new Error("level.dat is too large");
        const raw = fs.readFileSync(filePath);
        let data;
        try {
            data = zlib.unzipSync(raw, {maxOutputLength: MAX_OUTPUT});
        } catch (error) {
            if (error.code === "ERR_BUFFER_TOO_LARGE") throw new Error("level.dat is too large");
            // На всякий случай — несжатый NBT
            data = raw;
        }
        if (data.length > MAX_OUTPUT) throw new Error("level.dat is too large");
        return RxNbt.read(data);
    };

    static readLevelDatAsync = filePath => require('../../nbtWorker').readLevelDat(filePath);

    constructor(buffer) { this.buf = buffer; this.pos = 0; this.tags = 0; }

    need(n) { if (n < 0 || this.pos + n > this.buf.length) throw new Error("NBT truncated"); }
    count() { if (++this.tags > MAX_TAGS) throw new Error("NBT has too many tags"); }

    u1() { this.need(1); return this.buf[this.pos++]; }
    i1() { this.need(1); return this.buf.readInt8(this.pos++); }
    i2() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
    i4() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
    i8() { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
    f4() { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
    f8() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }

    str() {
        this.need(2);
        const length = this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        this.need(length);
        const value = this.buf.toString("utf8", this.pos, this.pos + length);
        this.pos += length;
        return value;
    }

    // Длина массива/списка: не меньше нуля и не больше остатка буфера (каждый элемент — хотя бы 1 байт)
    length(minPerItem) {
        const length = this.i4();
        if (length < 0) throw new Error("NBT negative length");
        if (length > MAX_TAGS) throw new Error("NBT collection is too large");
        if (length > (this.buf.length - this.pos) / Math.max(1, minPerItem)) throw new Error("NBT length exceeds data");
        return length;
    }

    payload(type, depth) {
        if (depth > MAX_DEPTH) throw new Error("NBT nested too deep");
        this.count();
        switch (type) {
            case 1: return {value: this.i1()};
            case 2: return {value: this.i2()};
            case 3: return {value: this.i4()};
            case 4: return {value: Number(this.i8())};
            case 5: return {value: this.f4()};
            case 6: return {value: this.f8()};
            case 7: { const n = this.arrayLength(1); this.pos += n; return {value: null}; }       // byte array — содержимое не нужно
            case 8: return {value: this.str()};
            case 9: {
                const childType = this.u1();
                const length = this.length(1);
                // Список элементов типа TAG_End допустим только пустой — иначе это была бы бомба
                if (childType === RxNbt.TAG_END) {
                    if (length !== 0) throw new Error("NBT list of TAG_End must be empty");
                    return {type: childType, value: []};
                }
                const value = [];
                for (let i = 0; i < length; i++) value.push(this.payload(childType, depth + 1));
                return {type: childType, value};
            }
            case 10: return {value: this.compound(depth + 1)};
            case 11: { const n = this.arrayLength(4); this.pos += n * 4; return {value: null}; }    // int array
            case 12: { const n = this.arrayLength(8); this.pos += n * 8; return {value: null}; }    // long array
            default: throw new Error(`NBT unknown tag type ${type}`);
        }
    }

    arrayLength(bytes) {
        const n = this.length(bytes);
        this.tags += n;
        if (this.tags > MAX_TAGS) throw new Error("NBT has too many array elements");
        return n;
    }

    compound(depth) {
        if (depth > MAX_DEPTH) throw new Error("NBT nested too deep");
        const map = Object.create(null);
        for (;;) {
            const type = this.u1();
            if (type === RxNbt.TAG_END) return map;
            const name = this.str();
            map[name] = this.payload(type, depth);
        }
    }
}

module.exports = RxNbt;
