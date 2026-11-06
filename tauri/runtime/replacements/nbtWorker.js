'use strict';
// level.dat (Tauri): тот же защищённый RxNbt с лимитами (размер, число тегов, глубина), распаковка — в ядре
exports.readLevelDat = async file => require('./web/js/RxNbt').readLevelDat(file);
