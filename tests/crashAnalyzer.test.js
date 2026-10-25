"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rxlaunch-crash-test-"));
const gameRoot = path.join(tempRoot, "game");
fs.mkdirSync(path.join(gameRoot, "mods"), {recursive: true});
fs.mkdirSync(path.join(gameRoot, "crash-reports"), {recursive: true});

const context = vm.createContext({
    require, fs, path, Buffer, console, Date, Intl, toml: require("toml"),
    USERDATA_PATH: tempRoot,
    RxTranslator: {getCurrentLanguage: () => "en"},
    RxCollector: {writeLog: () => {}},
    RxVersionsManager: {
        getActiveVersion: () => "fabric-1.21.4",
        parseVersionID: (id) => ({type: id.split("-")[0], name: id.split("-").slice(1).join("-")})
    }
});
for (const file of ["RxModMeta.js", "RxCrashAnalyzer.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "web", "js", file), "utf8"), context, {filename: file});
}
vm.runInContext("this.RxCrashAnalyzer = RxCrashAnalyzer;", context);
const {RxCrashAnalyzer} = context;

const run = async (log, files = {}) => {
    RxCrashAnalyzer.beginSession({gameRoot, gameDirectory: gameRoot, versionId: "fabric-1.21.4"});
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(gameRoot, name), content);
    RxCrashAnalyzer.record(log);
    const report = await RxCrashAnalyzer.analyze(1);
    for (const name of Object.keys(files)) fs.rmSync(path.join(gameRoot, name), {force: true});
    return report;
};
const rules = (report) => [...report.findings].map((finding) => finding.rule);

(async () => {
    // Fabric: недостающая зависимость и неверная версия Minecraft
    let report = await run([
        "[main/ERROR]: Incompatible mods found!",
        "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
        "A potential solution has been determined, this may resolve your problem:",
        "\t - Mod 'Sodium Extra' (sodium-extra) 0.6.1 requires any version of mod 'Sodium' (sodium), which is missing!",
        "\t - Mod 'Create Fabric' (create) 0.5.1 requires version 1.20.1 of mod 'Minecraft' (minecraft), but only the wrong version is present: 1.21.4!",
        "\t - Mod 'Mod Menu' (modmenu) 13.0 requires any version of fabric-api, which is missing!",
        "\t - Mod 'Sodium Extra' (sodium-extra) 0.6.1 requires any version of mod 'Reese's Sodium Options' (reeses-sodium-options), which is missing!"
    ].join("\n"));
    assert.ok(report.findings.some((f) => f.rule === "missingDep" && f.dependency === "reeses-sodium-options"), "mod names with an apostrophe");
    assert.ok(report.findings.some((f) => f.rule === "wrongMinecraft" && f.args.mod === "Create Fabric"), "wrong Minecraft version");
    assert.ok(rules(report).includes("missingDep"), "fabric missing dependency");
    assert.ok(report.findings.some((f) => f.rule === "missingDep" && f.dependency === "sodium"));
    assert.ok(report.findings.some((f) => f.rule === "missingDep" && f.dependency === "fabric-api"));
    assert.ok(report.findings.some((f) => f.title.startsWith("Missing dependency mod: Sodium")));

    // Mixin-конфликт
    report = await run("[main/ERROR]: Mixin apply for mod lithium failed lithium.mixins.json:ai.sensor.MixinSensor from mod lithium -> net.minecraft.class_123: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException");
    assert.ok(report.findings.some((f) => f.rule === "mixin" && f.args.mod === "lithium"), "mixin conflict with mod id");

    // Java и память
    report = await run("Exception in thread \"main\" java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0)");
    assert.ok(report.findings.some((f) => f.rule === "javaVersion" && f.title === "Wrong Java version" && f.fix.includes("Java 21")));
    report = await run("java.lang.OutOfMemoryError: Java heap space");
    assert.deepStrictEqual(rules(report), ["outOfMemory"]);

    // Forge: недостающие зависимости
    report = await run("Missing or unsupported mandatory dependencies:\n\tMod ID: 'flywheel', Requested by: 'create', Expected range: '[1.0,)', Actual version: '[MISSING]'");
    assert.ok(report.findings.some((f) => f.rule === "missingDep" && f.dependency === "flywheel"));

    // Нехватка библиотеки по имени класса
    report = await run("java.lang.NoClassDefFoundError: me/shedaniel/clothconfig2/api/ConfigBuilder");
    assert.ok(report.findings.some((f) => f.rule === "missingLibrary" && f.args.library === "Cloth Config"));

    // Видеодрайвер из hs_err
    report = await run("", {"hs_err_pid1234.log": "# EXCEPTION_ACCESS_VIOLATION (0xc0000005)\n# Problematic frame:\n# C  [atio6axx.dll+0x1a2b3]"});
    assert.ok(report.findings.some((f) => f.rule === "gpuDriver" && f.args.dll === "atio6axx.dll"));
    assert.ok(report.hsErrPath.endsWith("hs_err_pid1234.log"));

    // crash-report: путь из лога и подозреваемый мод
    const crashPath = path.join(gameRoot, "crash-reports", "crash-2026-10-24_12.00.00-client.txt");
    fs.writeFileSync(crashPath, "---- Minecraft Crash Report ----\nDescription: Rendering overlay\n\njava.lang.NullPointerException: boom\n\nSuspected Mods: Iris (iris)\n");
    report = await run(`#@!@# Game crashed! Crash report saved to: #@!@# ${crashPath}`);
    assert.strictEqual(report.crashReportPath, crashPath);
    assert.strictEqual(report.description, "Rendering overlay");
    assert.ok(report.findings.some((f) => f.rule === "suspect" && f.args.mod === "Iris (iris)"));

    // Ничего не найдено — честный запасной вариант
    fs.rmSync(crashPath);
    report = await run("[Render thread/INFO]: Stopping!");
    assert.deepStrictEqual(rules(report), ["unknown"]);
    assert.ok(fs.existsSync(path.join(tempRoot, "last-crash.json")), "report must be saved for the Mods tab");

    fs.rmSync(tempRoot, {recursive: true, force: true});
    console.log("Crash analyzer tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
