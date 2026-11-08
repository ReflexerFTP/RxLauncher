// Сборка агента плащей: node agent/rxcapes/build.cjs [путь к JDK 17+]
// Результат — web/assets/agents/rxcapes.jar (байт-код Java 8, работает во всех версиях игры).
// ASM кладётся внутрь под префиксом rxiso/ и не пересекается с ASM игры.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");

const ROOT = __dirname;
const JDK = process.argv[2] || process.env.JAVA_HOME;
if (!JDK) throw new Error("Укажите JDK 17+: node build.cjs <JAVA_HOME>");
const tool = name => path.join(JDK, "bin", process.platform === "win32" ? `${name}.exe` : name);
const ASM = path.join(ROOT, "lib", "asm-9.8.jar");
const ASM_SHA256 = "876eab6a83daecad5ca67eb9fcabb063c97b5aeb8cf1fca7a989ecde17522051";
const OUT = path.join(ROOT, "..", "..", "web", "assets", "agents", "rxcapes.jar");
const BUILD = path.join(ROOT, "build");

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (sha256(ASM) !== ASM_SHA256) throw new Error("lib/asm-9.8.jar не совпадает с ожидаемым SHA-256");
const sources = dir => fs.readdirSync(dir, {withFileTypes: true, recursive: true})
    .filter(entry => entry.isFile() && entry.name.endsWith(".java"))
    .map(entry => path.join(entry.parentPath || entry.path, entry.name));

fs.rmSync(BUILD, {recursive: true, force: true});
const main = path.join(BUILD, "main");
const iso = path.join(BUILD, "iso");
const stage = path.join(BUILD, "stage");
execFileSync(tool("javac"), ["--release", "8", "-nowarn", "-encoding", "UTF-8", "-d", main, ...sources(path.join(ROOT, "src"))], {stdio: "inherit"});
execFileSync(tool("javac"), ["--release", "8", "-nowarn", "-encoding", "UTF-8", "-cp", ASM, "-d", iso, ...sources(path.join(ROOT, "iso"))], {stdio: "inherit"});

fs.cpSync(main, stage, {recursive: true});
fs.cpSync(iso, path.join(stage, "rxiso"), {recursive: true});
// Классы ASM без module-info и META-INF
const asmDir = path.join(BUILD, "asm");
fs.mkdirSync(asmDir, {recursive: true});
execFileSync(tool("jar"), ["--extract", "--file", ASM], {cwd: asmDir});
fs.cpSync(path.join(asmDir, "org"), path.join(stage, "rxiso", "org"), {recursive: true, filter: source => !source.endsWith("module-info.class")});

const manifest = path.join(BUILD, "MANIFEST.MF");
fs.writeFileSync(manifest, "Manifest-Version: 1.0\nPremain-Class: xyz.rxlauncher.capes.Agent\nImplementation-Title: RxCapes\nImplementation-Version: 1.0.0\n");
fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.rmSync(OUT, {force: true});
execFileSync(tool("jar"), ["--create", "--file", OUT, "--manifest", manifest, "--date=2026-11-08T00:00:00Z", "-C", stage, "."], {stdio: "inherit"});
fs.rmSync(BUILD, {recursive: true, force: true});
console.log(`rxcapes.jar: ${fs.statSync(OUT).size} bytes, sha256 ${sha256(OUT)}`);
