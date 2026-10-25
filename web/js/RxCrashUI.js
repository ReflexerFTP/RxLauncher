// Окно разбора вылета: причины, шаги решения и быстрые действия
class RxCrashUI {
    static report = null;

    static message = (key, fallback) => MESSAGES.crash?.[key] || fallback;

    static show = async (report) => {
        if (!report) return false;
        RxCrashUI.report = report;
        RxCrashUI.render();
        await RxModals.showModal("crash");
        return true;
    };

    static hide = () => RxModals.hideModal("crash");

    static render = () => {
        const report = RxCrashUI.report;
        const $modal = $("#modal-crash");
        const time = new Intl.DateTimeFormat(RxPatchNotes.locale(), {hour: "2-digit", minute: "2-digit", day: "numeric", month: "short"}).format(new Date(report.time));
        $modal.find("[data-crash-meta]").text(`${RxCrashUI.message("exitCode", "Код выхода")} ${report.exitCode}${report.exitHex ? ` (${report.exitHex})` : ""} · ${time}`);
        const exception = report.description || report.exceptionLine;
        $modal.find("[data-crash-exception]").prop("hidden", !exception).text(exception || "");
        $modal.find('[data-crash-action="report"]').prop("disabled", !(report.crashReportPath || report.hsErrPath));

        const $list = $modal.find("[data-crash-findings]").empty();
        const ordered = [...report.findings].sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
        ordered.forEach((finding) => $list.append(RxCrashUI.buildFinding(finding)));
    };

    static buildFinding = (finding) => {
        const $card = $("<article>").addClass(`crash-finding ${finding.severity}`);
        $card.append($("<span>").addClass("material-symbols-outlined crash-finding-icon").text(finding.severity === "error" ? "error" : "help"));
        const $body = $("<div>").addClass("crash-finding-body");
        $body.append($("<b>").text(finding.title), $("<p>").text(finding.fix));
        if (finding.detail) $body.append($("<code>").text(finding.detail));

        const $actions = $("<div>").addClass("crash-finding-actions");
        const modsDir = RxCrashUI.report.modsDir;
        if (finding.fileName && modsDir && fs.existsSync(path.join(modsDir, finding.fileName))) {
            $actions.append(RxCrashUI.actionButton("block", RxCrashUI.message("disableMod", "Отключить мод"), function () {
                if (RxCrashAnalyzer.disableMod(RxCrashUI.report, finding.fileName)) {
                    $(this).prop("disabled", true).find("span:last").text(RxCrashUI.message("disabled", "Отключён"));
                    RxToasts.create(RxCrashUI.message("modDisabled", "Мод отключён"), "block", finding.fileName, "success");
                }
            }));
        }
        if (finding.dependency) {
            $actions.append(RxCrashUI.actionButton("search", RxCrashUI.message("findMod", "Найти на Modrinth"), () => {
                openExternal(`https://modrinth.com/mods?q=${encodeURIComponent(finding.dependency)}`);
            }));
        }
        if (["missingDep", "wrongMinecraft", "incompatible", "duplicate", "modProblem", "missingLibrary", "optifineSodium"].includes(finding.rule)) {
            $actions.append(RxCrashUI.actionButton("extension", RxCrashUI.message("openMods", "Открыть моды"), async () => {
                await RxCrashUI.hide();
                RxModals.switchModal("mods");
            }));
        }
        if (["outOfMemory", "reserveMemory", "javaVersion"].includes(finding.rule)) {
            $actions.append(RxCrashUI.actionButton("settings", RxCrashUI.message("openSettings", "Открыть настройки"), async () => {
                await RxCrashUI.hide();
                RxModals.switchModal("settings");
            }));
        }
        if ($actions.children().length) $body.append($actions);
        return $card.append($body);
    };

    static actionButton = (icon, text, handler) => $("<button>").addClass("transparent")
        .append($("<span>").addClass("material-symbols-outlined").text(icon), $("<span>").text(text))
        .on("click", handler);

    // Текстовая версия отчёта — чтобы отправить в чат поддержки
    static asText = () => {
        const report = RxCrashUI.report;
        const lines = [
            `RxLauncher ${LAUNCHER_VERSION} · ${report.versionId} · exit ${report.exitCode} ${report.exitHex}`,
            report.description || report.exceptionLine || "",
            ""
        ];
        report.findings.forEach((finding) => {
            lines.push(`[${finding.severity}] ${finding.title}`, `  ${finding.fix}`);
            if (finding.detail) lines.push(`  ${finding.detail}`);
        });
        return RxPrivacy.maskIfParanoid(lines.join("\n"));
    };

    static bind = () => {
        $("#modal-crash").on("click", "[data-crash-action]", async function () {
            const action = $(this).data("crash-action");
            const report = RxCrashUI.report;
            if (action === "close") return RxCrashUI.hide();
            if (action === "report" && report) openExternal(report.crashReportPath || report.hsErrPath);
            if (action === "console") {
                await RxCrashUI.hide();
                RxModals.switchModal("console");
            }
            if (action === "copy") {
                require("electron").clipboard.writeText(RxCrashUI.asText());
                RxToasts.create(RxCrashUI.message("copied", "Отчёт скопирован"), "content_copy", "", "success");
            }
        });
    };
}

$(RxCrashUI.bind);
