"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// RxModMeta — скрипт рендерера; загружаем его в песочницу с нужными глобалами
const context = vm.createContext({
    require, fs, Buffer, console, toml: require("toml"),
    RxTranslator: {getCurrentLanguage: () => "en"}
});
vm.runInContext(`${fs.readFileSync(path.join(__dirname, "..", "web", "js", "RxModMeta.js"), "utf8")}\nthis.RxModMeta = RxModMeta;`, context);
const {RxModMeta} = context;
const v = (text) => RxModMeta.parseVersion(text);

// Семвер-диапазоны Fabric/Quilt
assert.strictEqual(RxModMeta.matchSemver("~1.21.4", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver("~1.21.4", v("1.21.5")), true);
assert.strictEqual(RxModMeta.matchSemver("~1.21.4", v("1.22")), false);
assert.strictEqual(RxModMeta.matchSemver(">=1.21 <1.21.5-", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver(">=1.21 <1.21.5-", v("1.21.5")), false);
assert.strictEqual(RxModMeta.matchSemver("1.21.x", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver("1.20.x", v("1.21.4")), false);
assert.strictEqual(RxModMeta.matchSemver(["1.20.1", "1.21.4"], v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver("*", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver("1.21.4", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchSemver("1.21.3", v("1.21.4")), false);

// Maven-диапазоны Forge/NeoForge
assert.strictEqual(RxModMeta.matchMaven("[1.21.4,1.22)", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchMaven("[1.21.4,1.22)", v("1.22")), false);
assert.strictEqual(RxModMeta.matchMaven("[1.20.1]", v("1.20.1")), true);
assert.strictEqual(RxModMeta.matchMaven("[1.20.1]", v("1.21")), false);
assert.strictEqual(RxModMeta.matchMaven("[1.21,)", v("1.21.4")), true);
assert.strictEqual(RxModMeta.matchMaven("(,1.20]", v("1.21")), false);

// Разбор fabric.mod.json и оценка
const fabricMeta = RxModMeta.fromFabric({
    id: "sodium", name: "Sodium", version: "0.6.5", authors: ["JellySquid", {name: "IMS"}],
    depends: {minecraft: ">=1.21.2 <1.21.5", fabricloader: ">=0.16", "fabric-api": "*", "cloth-config": ">=15"},
    breaks: {optifabric: "*"}, icon: {"16": "a/16.png", "128": "a/128.png"}, jars: [{file: "META-INF/jars/x.jar"}]
});
assert.deepStrictEqual([...fabricMeta.loaders], ["fabric"]);
assert.strictEqual(fabricMeta.icon, "a/128.png");
assert.deepStrictEqual([...fabricMeta.authors], ["JellySquid", "IMS"]);

const target = {loader: "fabric", mcText: "1.21.4", mc: v("1.21.4")};
const entries = [
    {fileName: "sodium.jar", enabled: true, meta: {...fabricMeta, nestedIds: []}},
    {fileName: "fabric-api.jar", enabled: true, meta: {...fabricMeta, id: "fabric-api", provides: ["fabric"], deps: [], breaks: [], nestedIds: ["fabric-networking-api-v1"]}},
    {fileName: "optifabric.jar", enabled: true, meta: {...fabricMeta, id: "optifabric", deps: [], breaks: [], nestedIds: []}}
];
const index = RxModMeta.buildIndex(entries);
const sodium = RxModMeta.evaluate(entries[0], index, target);
assert.strictEqual(sodium.verdict, "error");
assert.ok(sodium.checks.some((check) => check.text.includes("Missing dependency: cloth-config")), "missing dependency must be reported");
assert.ok(sodium.checks.some((check) => check.text.includes("conflict with optifabric")), "declared conflict must be reported");
assert.ok(sodium.checks.some((check) => check.level === "ok" && check.text.includes("fabric-api")), "fabric-api is installed");
// Модули Fabric API, встроенные в fabric-api, считаются установленными
assert.strictEqual(RxModMeta.isProvided("fabric-rendering-v1", index), true);

// Мод для другого загрузчика и версии
const forgeMeta = RxModMeta.fromModsToml({
    mods: [{modId: "create", displayName: "Create", version: "6.0.0"}],
    dependencies: {create: [{modId: "minecraft", mandatory: true, versionRange: "[1.20.1,1.20.2)"}, {modId: "flywheel", mandatory: true, versionRange: "[1.0,)"}]}
}, false, null);
const create = RxModMeta.evaluate({fileName: "create.jar", enabled: true, meta: {...forgeMeta, nestedIds: []}}, index, target);
assert.strictEqual(create.verdict, "error");
assert.ok(create.checks.some((check) => check.text.startsWith("Made for Forge")));
assert.ok(create.checks.some((check) => check.text.startsWith("Requires Minecraft [1.20.1,1.20.2)")));

// Дубликат — два отдельных файла с одним id
const dupEntries = [
    {fileName: "a-1.0.jar", enabled: true, meta: {...fabricMeta, id: "lithium", deps: [], breaks: [], nestedIds: []}},
    {fileName: "a-1.1.jar", enabled: true, meta: {...fabricMeta, id: "lithium", deps: [], breaks: [], nestedIds: []}}
];
const dup = RxModMeta.evaluate(dupEntries[0], RxModMeta.buildIndex(dupEntries), target);
assert.ok(dup.checks.some((check) => check.text.includes("installed more than once: a-1.1.jar")));

console.log("Mod metadata tests passed");
