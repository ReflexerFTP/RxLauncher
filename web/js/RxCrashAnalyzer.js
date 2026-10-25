// Анализ вылетов игры: лог, crash-report, hs_err и проверка модов -> понятные причины и шаги решения
class RxCrashAnalyzer {
    static MAX_LINES = 1500;
    static lines = [];
    static session = null;
    static lastReport = null;
    static REPORT_FILE = () => path.join(USERDATA_PATH, "last-crash.json");

    // ---------- сбор данных во время игры ----------
    static beginSession = ({gameRoot, gameDirectory, versionId}) => {
        RxCrashAnalyzer.lines = [];
        RxCrashAnalyzer.session = {gameRoot, gameDirectory: gameDirectory || gameRoot, versionId, startedAt: Date.now()};
    };

    static record = (chunk) => {
        if (!chunk) return;
        const parts = String(chunk).split(/\r?\n/);
        for (const line of parts) if (line.trim()) RxCrashAnalyzer.lines.push(line.length > 2000 ? line.slice(0, 2000) : line);
        const overflow = RxCrashAnalyzer.lines.length - RxCrashAnalyzer.MAX_LINES;
        if (overflow > 0) RxCrashAnalyzer.lines.splice(0, overflow);
    };

    // ---------- вспомогательное ----------
    static lang = () => typeof RxTranslator !== "undefined" ? RxTranslator.getCurrentLanguage() : "ru";

    static t = (rule, field, args = {}) => {
        const dict = RxCrashAnalyzer.TEXTS[RxCrashAnalyzer.lang()] || RxCrashAnalyzer.TEXTS.en;
        const template = dict[rule]?.[field] ?? RxCrashAnalyzer.TEXTS.en[rule]?.[field] ?? "";
        return template.replace(/\{(\w+)}/g, (_, key) => String(args[key] ?? ""));
    };

    static readTail = (filePath, maxBytes = 256 * 1024) => {
        try {
            const stat = fs.statSync(filePath);
            const start = Math.max(0, stat.size - maxBytes);
            const handle = fs.openSync(filePath, "r");
            const buffer = Buffer.alloc(stat.size - start);
            fs.readSync(handle, buffer, 0, buffer.length, start);
            fs.closeSync(handle);
            return buffer.toString("utf8");
        } catch (_) {
            return "";
        }
    };

    static newestFile = (dir, pattern, since) => {
        try {
            return fs.readdirSync(dir)
                .filter((name) => pattern.test(name))
                .map((name) => ({file: path.join(dir, name), time: fs.statSync(path.join(dir, name)).mtimeMs}))
                .filter((item) => item.time >= since - 5000)
                .sort((a, b) => b.time - a.time)[0]?.file || "";
        } catch (_) {
            return "";
        }
    };

    static exitCodeHex = (code) => {
        const value = Number(code);
        if (!Number.isFinite(value)) return "";
        return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
    };

    // Известные пакеты Java -> какой мод-библиотеку поставить
    static LIBRARY_HINTS = [
        [/^net[./]fabricmc[./]fabric[./]/, "Fabric API"],
        [/^me[./]shedaniel[./]clothconfig/, "Cloth Config"],
        [/^dev[./]architectury[./]/, "Architectury API"],
        [/^com[./]terraformersmc[./]modmenu/, "Mod Menu"],
        [/^software[./]bernie[./]geckolib/, "GeckoLib"],
        [/^top[./]theillusivec4[./]curios/, "Curios API"],
        [/^dev[./]isxander[./]yacl/, "YetAnotherConfigLib (YACL)"],
        [/^fuzs[./]puzzleslib/, "Puzzles Lib"],
        [/^com[./]teamresourceful[./]resourcefullib/, "Resourceful Lib"],
        [/^net[./]blay09[./]mods[./]balm/, "Balm"],
        [/^mezz[./]jei/, "JEI"],
        [/^dev[./]emi[./]/, "EMI"],
        [/^com[./]simibubi[./]create/, "Create"],
        [/^dev[./]engine_room[./]flywheel/, "Flywheel"],
        [/^net[./]caffeinemc[./]mods[./]sodium/, "Sodium"],
        [/^net[./]irisshaders[./]/, "Iris"],
        [/^org[./]embeddedt[./]embeddium/, "Embeddium"]
    ];

    // ---------- анализ ----------
    static analyze = async (exitCode) => {
        const session = RxCrashAnalyzer.session || {startedAt: Date.now() - 3600000};
        const roots = [...new Set([session.gameDirectory, session.gameRoot].filter(Boolean))];
        const log = RxCrashAnalyzer.lines.join("\n");

        // crash-report: путь печатает сама игра, иначе ищем самый свежий
        let crashReportPath = "";
        const savedMatch = log.match(/Crash report saved to:\s*(?:#@!@#\s*)?(.+?\.txt)/i);
        if (savedMatch && fs.existsSync(savedMatch[1].trim())) crashReportPath = savedMatch[1].trim();
        for (const root of roots) {
            if (!crashReportPath) crashReportPath = RxCrashAnalyzer.newestFile(path.join(root, "crash-reports"), /^crash-.*\.txt$/i, session.startedAt);
        }
        let hsErrPath = "";
        for (const root of roots) if (!hsErrPath) hsErrPath = RxCrashAnalyzer.newestFile(root, /^hs_err_pid\d+\.log$/i, session.startedAt);

        const crashText = crashReportPath ? RxCrashAnalyzer.readTail(crashReportPath, 512 * 1024) : "";
        let latestLog = "";
        if (!log) for (const root of roots) if (!latestLog) latestLog = RxCrashAnalyzer.readTail(path.join(root, "logs", "latest.log"));
        const hsErr = hsErrPath ? RxCrashAnalyzer.readTail(hsErrPath, 128 * 1024) : "";
        const text = [log || latestLog, crashText].join("\n");

        // Моды выбранной версии: метаданные и статическая проверка
        const modsDir = roots.map((root) => path.join(root, "mods")).find((dir) => fs.existsSync(dir)) || "";
        const mods = await RxCrashAnalyzer.loadMods(modsDir);
        const findings = [];
        const seen = new Set();
        const add = (finding) => {
            const key = `${finding.rule}|${finding.detail || ""}|${JSON.stringify(finding.args || {})}`;
            if (seen.has(key)) return;
            seen.add(key);
            findings.push(finding);
        };
        const fileForMod = (idOrName) => {
            const key = String(idOrName || "").toLowerCase();
            return mods.entries.find((entry) => entry.meta?.id?.toLowerCase() === key || entry.meta?.name?.toLowerCase() === key)?.fileName || "";
        };

        // 1. Fabric: не хватает зависимости / неверная версия Minecraft / несовместимость
        // Названия модов могут содержать апостроф (Reese's Sodium Options), поэтому имя ищем «лениво» до ' (id)
        for (const match of text.matchAll(/- Mod '(.+?)' \(([\w.-]+)\)[^\n]*?requires[^\n]*? of (?:mod )?(?:'(.+?)' \(([\w.-]+)\)|([\w.-]+)), which is missing/g)) {
            const dep = match[3] || match[5];
            add({rule: "missingDep", severity: "error", args: {mod: match[1], dep}, dependency: match[4] || match[5], fileName: ""});
        }
        for (const match of text.matchAll(/- Mod '(.+?)' \(([\w.-]+)\)[^\n]*?requires version ([^\n]+?) of (?:mod )?(?:'Minecraft' \(minecraft\)|'?minecraft'?)/gi)) {
            add({rule: "wrongMinecraft", severity: "error", args: {mod: match[1], range: match[3].replace(/,$/, "")}, fileName: fileForMod(match[2])});
        }
        for (const match of text.matchAll(/- Mod '(.+?)' \(([\w.-]+)\)[^\n]*?is incompatible with[^\n]*?(?:mod )?'(.+?)'(?: \(|,|$)/gm)) {
            add({rule: "incompatible", severity: "error", args: {mod: match[1], other: match[3]}, fileName: fileForMod(match[2])});
        }
        // 2. Forge/NeoForge: недостающие или неподходящие зависимости
        for (const match of text.matchAll(/Mod ID: '([\w-]+)', Requested by: '([\w-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/g)) {
            if (/missing/i.test(match[4])) add({rule: "missingDep", severity: "error", args: {mod: match[2], dep: match[1]}, dependency: match[1]});
            else add({rule: "wrongDepVersion", severity: "error", args: {mod: match[2], dep: match[1], range: match[3], actual: match[4]}, fileName: fileForMod(match[1])});
        }
        // 3. Дубликаты
        if (/Duplicate mods? found|Found duplicate mods|provided by multiple|duplicate mod id/i.test(text)) {
            add({rule: "duplicate", severity: "error", args: {}});
        }
        // 4. Mixin — конфликт модов, меняющих один и тот же код
        for (const match of text.matchAll(/Mixin apply (?:for mod ([\w-]+) )?failed ([\w.-]+?)\.(?:mixins?\.)?json/gi)) {
            const modId = match[1] || match[2].replace(/[._-]?mixins?$/i, "").split(".")[0];
            add({rule: "mixin", severity: "error", args: {mod: modId}, fileName: fileForMod(modId)});
        }
        if (!findings.some((item) => item.rule === "mixin") && /MixinApplyError|InvalidInjectionException|MixinTransformerError|Mixin transformation of [\w.$/]+ failed/i.test(text)) {
            const configMatch = text.match(/from mod ([\w-]+)|([\w-]+)\.mixins?\.json/i);
            const modId = configMatch ? (configMatch[1] || configMatch[2]) : "";
            add({rule: "mixin", severity: "error", args: {mod: modId || "?"}, fileName: fileForMod(modId)});
        }
        // 5. Java
        const classVersion = text.match(/class file version (\d+)\.\d+/i);
        if (classVersion || /UnsupportedClassVersionError|compiled by a more recent version of the Java/i.test(text)) {
            const needed = classVersion ? Number(classVersion[1]) - 44 : "";
            add({rule: "javaVersion", severity: "error", args: {java: needed ? `Java ${needed}` : "Java"}});
        }
        if (/java\.lang\.OutOfMemoryError|GC overhead limit exceeded/i.test(text + hsErr)) add({rule: "outOfMemory", severity: "error", args: {}});
        if (/Could not reserve enough space|Invalid maximum heap size|Error occurred during initialization of VM/i.test(text)) add({rule: "reserveMemory", severity: "error", args: {}});
        // 6. Видеодрайвер
        const driver = hsErr.match(/\b(atio6axx|atioglxx|amdxx64|nvoglv(?:64|32)|ig\w*icd(?:64|32)|igxelpicd64)\.dll/i);
        if (driver || /Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL/i.test(text)) {
            add({rule: "gpuDriver", severity: "error", args: {dll: driver ? driver[0] : "OpenGL"}});
        }
        // 7. Повреждённый конфиг
        const config = text.match(/(?:JsonSyntaxException|MalformedJsonException|ParsingException|Failed to (?:load|read) config)[^\n]*?([\w./\\-]+\.(?:json5?|toml|properties|cfg))/i);
        if (config) add({rule: "brokenConfig", severity: "error", args: {file: path.basename(config[1])}});
        // 8. Не найден класс -> не хватает библиотеки
        for (const match of text.matchAll(/(?:NoClassDefFoundError|ClassNotFoundException):\s*([\w./$]+)/g)) {
            const className = match[1];
            const library = RxCrashAnalyzer.LIBRARY_HINTS.find(([pattern]) => pattern.test(className))?.[1];
            if (/com[./]mojang[./]authlib/.test(className)) add({rule: "gameFiles", severity: "error", args: {}});
            else if (library) add({rule: "missingLibrary", severity: "error", args: {library}, dependency: library});
            else add({rule: "missingClass", severity: "warn", args: {className: className.replace(/\//g, ".")}});
            if (findings.length > 12) break;
        }
        if (/java\.lang\.NoSuchMethodError|java\.lang\.NoSuchFieldError|AbstractMethodError/i.test(text)) add({rule: "noSuchMethod", severity: "warn", args: {}});
        // 9. Повреждённые файлы игры и ely.by
        if (/java\.io\.IOException: error reading|at java\.base\/java\.io\.Reader\.<init>|zip file is empty|ZipException/i.test(text)) add({rule: "gameFiles", severity: "error", args: {}});
        if (/\[authlib-injector] \[ERROR] Failed to fetch metadata/i.test(text)) add({rule: "authlib", severity: "warn", args: {}});
        // 10. OptiFine вместе с Sodium/Iris
        const ids = new Set(mods.entries.filter((entry) => entry.enabled).map((entry) => entry.meta?.id?.toLowerCase()).filter(Boolean));
        const hasOptifine = mods.entries.some((entry) => entry.enabled && /optifine|optifabric/i.test(entry.fileName));
        if (hasOptifine && ["sodium", "iris", "embeddium", "rubidium"].some((id) => ids.has(id))) add({rule: "optifineSodium", severity: "error", args: {}});

        // 11. Подозреваемые моды из crash-report
        const suspects = new Set();
        for (const match of crashText.matchAll(/Suspected Mods?:\s*([^\n]+(?:\n\t[^\n]+)*)/g)) {
            match[1].split(/[\n,]/).map((item) => item.replace(/\t/g, "").trim()).filter((item) => item && !/^None$/i.test(item) && !/^Unknown$/i.test(item)).forEach((item) => suspects.add(item));
        }
        [...suspects].slice(0, 3).forEach((suspect) => {
            const id = (suspect.match(/\(([\w.-]+)\)/) || [])[1] || suspect;
            add({rule: "suspect", severity: "warn", args: {mod: suspect}, fileName: fileForMod(id)});
        });

        // 12. Статическая проверка модов (как во вкладке «Моды»)
        mods.entries.filter((entry) => entry.enabled && entry.compat?.verdict === "error").slice(0, 8).forEach((entry) => {
            const problems = entry.compat.checks.filter((check) => check.level === "error").map((check) => check.text);
            add({rule: "modProblem", severity: "warn", args: {mod: entry.meta?.name || entry.fileName}, detail: problems.join(" · "), fileName: entry.fileName,
                dependency: entry.compat.checks.find((check) => check.dependency)?.dependency});
        });

        // Нативный вылет без других зацепок
        const code = Number(exitCode);
        const hex = RxCrashAnalyzer.exitCodeHex(code);
        if (findings.filter((item) => item.severity === "error").length === 0 && (hsErr || ["0xC0000005", "0xC0000409", "0xC0000374"].includes(hex))) {
            add({rule: "nativeCrash", severity: "warn", args: {code: hex}});
        }

        if (findings.length === 0) add({rule: "unknown", severity: "warn", args: {}});

        const description = (crashText.match(/^Description:\s*(.+)$/m) || [])[1] || "";
        const exceptionLine = (crashText || text).split("\n").find((line) => /^(?:\S+\.)+\w*(?:Exception|Error)\b/.test(line.trim()))?.trim() || "";
        const report = {
            exitCode: code,
            exitHex: hex,
            time: Date.now(),
            versionId: session.versionId || "",
            crashReportPath,
            hsErrPath,
            modsDir,
            description,
            exceptionLine: exceptionLine.slice(0, 300),
            findings: findings.map((finding) => ({
                ...finding,
                title: RxCrashAnalyzer.t(finding.rule, "title", finding.args),
                fix: RxCrashAnalyzer.t(finding.rule, "fix", finding.args),
                detail: finding.detail || ""
            }))
        };
        RxCrashAnalyzer.lastReport = report;
        try { fs.writeFileSync(RxCrashAnalyzer.REPORT_FILE(), JSON.stringify(report, null, 2)); } catch (_) {}
        return report;
    };

    static loadMods = async (modsDir) => {
        if (!modsDir || typeof RxModMeta === "undefined") return {entries: []};
        let names = [];
        try { names = fs.readdirSync(modsDir).filter((name) => /\.jar(?:\.disabled)?$/i.test(name)); } catch (_) { return {entries: []}; }
        const entries = [];
        for (const fileName of names) {
            entries.push({fileName, enabled: /\.jar$/i.test(fileName), meta: await RxModMeta.read(path.join(modsDir, fileName))});
        }
        const index = RxModMeta.buildIndex(entries);
        const target = RxModMeta.getTarget();
        entries.forEach((entry) => { entry.compat = entry.meta ? RxModMeta.evaluate(entry, index, target) : null; });
        return {entries, index};
    };

    // ---------- реакция на завершение игры ----------
    static onGameExit = async (exitCode) => {
        const code = Number(exitCode);
        if (!Number.isFinite(code) || code === 0) return null;
        RxCollector.writeLog(`Crash: Exit code ${code} (${RxCrashAnalyzer.exitCodeHex(code)}), analyzing`);
        const report = await RxCrashAnalyzer.analyze(code);
        RxCollector.writeLog(`Crash: ${report.findings.length} finding(s) [${report.findings.map((item) => item.rule).join(", ")}]`);
        if (typeof RxCrashUI !== "undefined") RxCrashUI.show(report);
        return report;
    };

    static loadLastReport = () => {
        if (RxCrashAnalyzer.lastReport) return RxCrashAnalyzer.lastReport;
        try {
            RxCrashAnalyzer.lastReport = JSON.parse(fs.readFileSync(RxCrashAnalyzer.REPORT_FILE(), "utf8"));
        } catch (_) {
            RxCrashAnalyzer.lastReport = null;
        }
        return RxCrashAnalyzer.lastReport;
    };

    // Отключить мод из отчёта (переименование в .jar.disabled внутри папки модов отчёта)
    static disableMod = (report, fileName) => {
        if (!report?.modsDir || path.basename(fileName) !== fileName || !/\.jar$/i.test(fileName)) return false;
        const source = path.join(report.modsDir, fileName);
        const target = `${source}.disabled`;
        if (!fs.existsSync(source) || fs.existsSync(target)) return false;
        fs.renameSync(source, target);
        RxCollector.writeLog(`Crash: Disabled mod from crash report ${fileName}`);
        return true;
    };

    // ---------- тексты правил ----------
    static TEXTS = {
        ru: {
            missingDep: {title: "Не хватает мода-зависимости: {dep}", fix: "Мод «{mod}» не работает без «{dep}». Скачайте «{dep}» для вашей версии игры и загрузчика и добавьте его во вкладке «Моды»."},
            wrongMinecraft: {title: "Мод «{mod}» для другой версии Minecraft", fix: "Ему нужен Minecraft {range}. Скачайте версию мода под вашу версию игры или отключите его."},
            incompatible: {title: "Несовместимые моды: «{mod}» и «{other}»", fix: "Эти моды не работают вместе. Оставьте один из них."},
            wrongDepVersion: {title: "Неподходящая версия «{dep}»", fix: "Моду «{mod}» нужна версия {range}, а установлена {actual}. Обновите или замените «{dep}»."},
            duplicate: {title: "Один и тот же мод установлен дважды", fix: "Удалите старые копии мода: оставьте по одному файлу каждого мода (обычно — самую новую версию)."},
            mixin: {title: "Конфликт модов при загрузке (Mixin): {mod}", fix: "Мод «{mod}» меняет код игры, который уже изменил другой мод. Обновите его или временно отключите и проверьте снова. Часто конфликтуют моды рендера и оптимизации."},
            javaVersion: {title: "Неподходящая версия Java", fix: "Игре или модам нужна {java}. Если в «Параметрах Java» выбрана Java вручную — переключите на автоматический выбор."},
            outOfMemory: {title: "Игре не хватило оперативной памяти", fix: "Увеличьте выделенную память в «Настройки → Параметры запуска». Для сборок с модами обычно нужно 4–6 ГБ."},
            reserveMemory: {title: "Java не смогла выделить память", fix: "Выделено больше памяти, чем доступно системе. Уменьшите объём памяти в настройках и закройте тяжёлые программы."},
            gpuDriver: {title: "Сбой видеодрайвера ({dll})", fix: "Обновите драйвер видеокарты с сайта NVIDIA/AMD/Intel. На ноутбуке запускайте игру на дискретной видеокарте. Если стоят шейдеры — попробуйте без них."},
            brokenConfig: {title: "Повреждён файл настроек {file}", fix: "Удалите {file} из папки config — мод создаст его заново с настройками по умолчанию."},
            missingLibrary: {title: "Не хватает библиотеки: {library}", fix: "Один из модов требует «{library}». Скачайте его для вашей версии и добавьте в моды."},
            missingClass: {title: "Не найден класс {className}", fix: "Обычно это значит, что не хватает мода-зависимости или мод сделан для другой версии игры. Проверьте вкладку «Моды» → «Подробнее»."},
            noSuchMethod: {title: "Моды собраны под разные версии", fix: "Один мод обращается к функции, которой нет в установленной версии игры или другого мода. Обновите моды до версий под вашу версию Minecraft."},
            gameFiles: {title: "Файлы игры повреждены", fix: "Переустановите версию игры. Если не поможет — смените папку игры в настройках и установите начисто."},
            authlib: {title: "Не удалось связаться с системой скинов", fix: "Сервис Ely.by временно недоступен. Попробуйте позже или запустите игру с локальным профилем."},
            optifineSodium: {title: "OptiFine вместе с Sodium/Iris", fix: "OptiFine несовместим с Sodium, Iris и их аналогами. Оставьте что-то одно: Sodium + Iris обычно работают быстрее."},
            suspect: {title: "Вероятный виновник: {mod}", fix: "Игра указала этот мод в отчёте о вылете. Обновите его или временно отключите."},
            modProblem: {title: "Проблема с модом «{mod}»", fix: "Проверка модов нашла проблему, из-за которой игра может вылетать."},
            nativeCrash: {title: "Аварийное завершение Java ({code})", fix: "Чаще всего это видеодрайвер, шейдеры или антивирус. Обновите драйвер видеокарты, отключите шейдеры и моды рендера и попробуйте снова."},
            unknown: {title: "Точную причину определить не удалось", fix: "Откройте отчёт о вылете или консоль. Если вылет начался после добавления модов — отключайте новые моды по одному."}
        },
        en: {
            missingDep: {title: "Missing dependency mod: {dep}", fix: "“{mod}” does not work without “{dep}”. Download “{dep}” for your game version and loader and add it on the Mods tab."},
            wrongMinecraft: {title: "“{mod}” is for another Minecraft version", fix: "It requires Minecraft {range}. Get the build for your game version or disable it."},
            incompatible: {title: "Incompatible mods: “{mod}” and “{other}”", fix: "These mods do not work together. Keep only one of them."},
            wrongDepVersion: {title: "Wrong version of “{dep}”", fix: "“{mod}” needs {range}, but {actual} is installed. Update or replace “{dep}”."},
            duplicate: {title: "The same mod is installed twice", fix: "Remove old copies: keep exactly one file per mod (usually the newest)."},
            mixin: {title: "Mod conflict while loading (Mixin): {mod}", fix: "“{mod}” patches game code already changed by another mod. Update it or temporarily disable it and try again. Rendering and optimization mods conflict most often."},
            javaVersion: {title: "Wrong Java version", fix: "The game or a mod needs {java}. If Java is selected manually in Java settings, switch back to automatic."},
            outOfMemory: {title: "The game ran out of memory", fix: "Increase allocated memory in Settings → Launch options. Modded setups usually need 4–6 GB."},
            reserveMemory: {title: "Java could not allocate memory", fix: "More memory is allocated than the system has available. Lower it in settings and close heavy apps."},
            gpuDriver: {title: "Graphics driver crash ({dll})", fix: "Update your GPU driver from NVIDIA/AMD/Intel. On laptops run the game on the dedicated GPU. If you use shaders, try without them."},
            brokenConfig: {title: "Config file {file} is corrupted", fix: "Delete {file} from the config folder — the mod will recreate it with defaults."},
            missingLibrary: {title: "Missing library: {library}", fix: "One of the mods requires “{library}”. Download it for your version and add it to mods."},
            missingClass: {title: "Class {className} not found", fix: "Usually a dependency mod is missing or a mod targets another game version. Check Mods → More info."},
            noSuchMethod: {title: "Mods built for different versions", fix: "A mod calls code that does not exist in the installed game or library version. Update mods to builds for your Minecraft version."},
            gameFiles: {title: "Game files are corrupted", fix: "Reinstall the game version. If that does not help, change the game folder in settings and install cleanly."},
            authlib: {title: "Could not reach the skin system", fix: "Ely.by is temporarily unavailable. Try later or play with a local profile."},
            optifineSodium: {title: "OptiFine together with Sodium/Iris", fix: "OptiFine is incompatible with Sodium, Iris and similar mods. Keep one: Sodium + Iris is usually faster."},
            suspect: {title: "Likely culprit: {mod}", fix: "The game named this mod in its crash report. Update it or disable it temporarily."},
            modProblem: {title: "Problem with “{mod}”", fix: "The mod check found an issue that can crash the game."},
            nativeCrash: {title: "Java crashed natively ({code})", fix: "Most often it is the graphics driver, shaders or antivirus. Update the GPU driver, disable shaders and rendering mods, and try again."},
            unknown: {title: "Could not determine the exact cause", fix: "Open the crash report or console. If crashes started after adding mods, disable the new ones one by one."}
        }
    };
}
