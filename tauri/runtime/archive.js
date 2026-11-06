// Замена compressing (zip): упаковка папки и набора записей — в Rust-ядре (archive.rs)
const bridge = require("./bridge");
const {Buffer} = require("buffer");

// entries: [{data: Buffer, relativePath} | {file: путь, relativePath} | {dir: путь, relativePath}]
const writeEntries = async (target, entries) => {
    const chunks = [];
    let offset = 0;
    const list = entries.map(entry => {
        if (entry.data !== undefined) {
            const bytes = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
            chunks.push(bytes);
            const item = {data: [offset, bytes.length], relativePath: entry.relativePath};
            offset += bytes.length;
            return item;
        }
        return entry.dir ? {dir: entry.dir, relativePath: entry.relativePath} : {file: entry.file, relativePath: entry.relativePath};
    });
    return bridge.value("archive.zipEntries", {target, entries: list}, Buffer.concat(chunks));
};

const unsupported = () => { throw new Error("Use compressing.zip.writeEntries in the Tauri build"); };

module.exports = {
    zip: {
        compressDir: (source, target, options = {}) => bridge.value("archive.zipDir", {source, target, ignoreBase: Boolean(options.ignoreBase)}),
        uncompress: (archive, destination) => bridge.value("archive.unpack", {archive, destination, type: "zip"}),
        writeEntries,
        Stream: class { constructor() { unsupported(); } }
    },
    tar: {uncompress: (archive, destination) => bridge.value("archive.unpack", {archive, destination, type: "tar"})},
    tgz: {uncompress: (archive, destination) => bridge.value("archive.unpack", {archive, destination, type: "tgz"})}
};
