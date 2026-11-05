'use strict';
// Режим слабого ПК: облегчённая графика в options.txt перед запуском. Только понижаем — то, что у игрока и так ниже,
// не трогаем. Новой папке игры сразу пишем лёгкие значения (остальное Minecraft заполнит сам)
const fs = require('node:fs');
const path = require('node:path');

const CAPS = {
    renderDistance: {max: 8},
    simulationDistance: {max: 6},
    graphicsMode: {max: 0},          // 0 — быстрая, 1 — детальная, 2 — эффектная
    biomeBlendRadius: {max: 1},
    mipmapLevels: {max: 2},
    entityDistanceScaling: {max: 0.75},
    particles: {min: 1},             // 0 — все, 1 — меньше, 2 — минимум
    fancyGraphics: {value: 'false'}, // до 1.16
    entityShadows: {value: 'false'},
    renderClouds: {value: 'false'}   // "true" / "fast" / "false"
};
const DEFAULTS = ['renderDistance:8', 'simulationDistance:6', 'graphicsMode:0', 'fancyGraphics:false', 'particles:1',
    'entityShadows:false', 'renderClouds:"false"', 'biomeBlendRadius:1', 'entityDistanceScaling:0.75', 'mipmapLevels:2'];

// {text, changed: ['renderDistance', …]}
exports.capOptions = text => {
    const changed = [];
    const lines = String(text).split('\n').map(line => {
        const match = /^([A-Za-z]+):(.*?)(\r?)$/.exec(line);
        const cap = match && CAPS[match[1]];
        if (!cap) return line;
        const [, key, raw, cr] = match;
        let next = raw;
        if (cap.value !== undefined) {
            const quoted = /^".*"$/.test(raw);
            if (raw.replace(/"/g, '') !== cap.value) next = quoted ? `"${cap.value}"` : cap.value;
        } else {
            const value = Number(raw);
            if (!Number.isFinite(value)) return line;
            if (cap.max !== undefined && value > cap.max) next = String(cap.max);
            if (cap.min !== undefined && value < cap.min) next = String(cap.min);
        }
        if (next === raw) return line;
        changed.push(key);
        return `${key}:${next}${cr}`;
    });
    return {text: lines.join('\n'), changed};
};

// Применить к папке игры: [изменённые ключи] или null, если трогать нечего
exports.applyToGameDirectory = gameDirectory => {
    if (typeof gameDirectory !== 'string' || !path.isAbsolute(gameDirectory)) return null;
    const file = path.join(gameDirectory, 'options.txt');
    if (!fs.existsSync(file)) {
        fs.mkdirSync(gameDirectory, {recursive: true});
        fs.writeFileSync(file, DEFAULTS.join('\n') + '\n');
        return ['new'];
    }
    const {text, changed} = exports.capOptions(fs.readFileSync(file, 'utf8'));
    if (!changed.length) return [];
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    return changed;
};

// Java для слабого ПК: меньше пауз сборщика и памяти под строки, без лишней фоновой работы
exports.JVM_FLAGS = ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=100', '-XX:+UseStringDeduplication', '-XX:+ParallelRefProcEnabled',
    '-XX:+DisableExplicitGC', '-XX:+PerfDisableSharedMem'];
