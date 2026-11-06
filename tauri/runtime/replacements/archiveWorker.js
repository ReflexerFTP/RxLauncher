'use strict';
// Распаковка архивов (Tauri): проверка записей и распаковка — в Rust-ядре (archive.rs)
const bridge = require('../tauri/runtime/bridge');
exports.unpack = async (archive, destination, type) => {
    if (!['zip', 'tar', 'tgz'].includes(type)) throw new Error('Unsupported archive type');
    await bridge.value('archive.unpack', {archive, destination, type});
    return true;
};
