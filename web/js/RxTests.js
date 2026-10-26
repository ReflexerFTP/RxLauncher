global.TESTS_LOG = "";

let currentTestingVersion = -1;
let testVersionsList = [];

class RxTests {
    static startTest = async () => {
        currentTestingVersion = -1;
        try {
            // The diagnostic command tests existing installations only.
            testVersionsList = RxVersionsManager.getInstalledVersionEntries()
                .filter(item => ["vanilla", "forge", "fabric"].includes(item.type));
            RxTests.writeToTestLog(`TEST: ${testVersionsList.length} installed versions selected`);
            await RxTests.nextTestingVersion();
        } catch (error) {
            RxTests.writeToTestLog(`TEST FAILED: ${error.message || error}`);
            RxFlyout.setText("TEST FAILED", String(error.message || error));
        }
    }

    static writeToTestLog = (...data) => {
        const logDir = path.join(USERDATA_PATH, "testLogs");
        fs.mkdirSync(logDir, {recursive: true});
        const line = `[${new Date().toISOString()}] ${data.join(" ")}`;
        console.log(line);
        fs.appendFileSync(path.join(logDir, "FULLTEST.log"), `\n${line}`);
    }

    static writeVersionLog = (data, versionId) => {
        const logDir = path.join(USERDATA_PATH, "testLogs");
        fs.mkdirSync(logDir, {recursive: true});
        const safeId = String(versionId).replace(/[^\w.+-]/g, "_");
        fs.appendFileSync(path.join(logDir, `${safeId}.log`), `\n${data}`);
    }

    static nextTestingVersion = async () => {
        while (++currentTestingVersion < testVersionsList.length) {
            const testingId = testVersionsList[currentTestingVersion].id;
            try {
                const {passed, exitCode} = await RxTests.testVersion(testingId);
                RxTests.writeToTestLog(passed ? "✓" : "X", testingId,
                    passed ? "passed tests" : `not passed tests, exit code: ${exitCode}`);
            } catch (error) {
                RxTests.writeToTestLog("X", testingId, `failed: ${error.message || error}`);
            }
        }
        RxTests.writeToTestLog("TEST COMPLETED");
        RxFlyout.setText("TEST COMPLETED", "Тестирование завершено");
    }

    static testVersion = async (versionId) => {
        const config = await RxTests.prepareConfig(versionId);
        RxTests.writeToTestLog("TEST: Starting version " + versionId);
        await RxFlyout.changeMode("progress");
        return new Promise(resolve => {
            const launcher = new Client();
            let ownedProcess = null;
            let stopTimer = null;
            let settled = false;
            let launched = false;
            let useProgress = false;
            const finish = (passed, exitCode) => {
                if (settled) return;
                settled = true;
                if (stopTimer) clearTimeout(stopTimer);
                resolve({passed, exitCode});
            };
            launcher.on("debug", e => RxTests.writeVersionLog(e, versionId));
            launcher.on("data", e => {
                RxTests.writeVersionLog(e, versionId);
                if (!launched && /Sound engine started|OpenAL initialized|Created: 512x512 textures-atlas/i.test(e)) {
                    launched = true;
                    RxFlyout.setText("Игра запущена", versionId);
                    stopTimer = setTimeout(() => {
                        // Terminate only the child started by this test, never other Java programs.
                        if (Number.isSafeInteger(ownedProcess?.pid) && ownedProcess.pid > 0) treeKill(ownedProcess.pid);
                    }, 6000);
                }
                if (/Stopping!|SoundSystem shutting down/i.test(e)) RxFlyout.setText("Игра закрывается", versionId);
            });
            launcher.on("close", exitCode => {
                RxTests.writeToTestLog("Game exit code: " + exitCode);
                finish(exitCode === 0 || (launched && exitCode === 1), exitCode);
            });
            launcher.on("arguments", () => {
                gameStarting = true;
                RxFlyout.changeMode("spinner");
                RxFlyout.setText("Игра запускается", versionId);
            });
            launcher.on("progress", e => {
                if (e.type === "assets") {
                    if (startAssetsInterval === 0) startAssetsInterval = Date.now();
                    if (assetsVerifyOffset === 0 && Date.now() - startAssetsInterval > 1000) assetsVerifyOffset = e.task - 1;
                }
                if (useProgress) {
                    const taskOffset = e.task - assetsVerifyOffset;
                    const totalOffset = e.total - assetsVerifyOffset;
                    if (totalOffset > 0) RxDownloader.updateDownloadUIText(e.type,
                        Math.round((taskOffset * 100) / totalOffset), taskOffset, totalOffset);
                }
            });
            launcher.on("download-status", e => {
                if (e.total / 1024 / 1024 >= 4) {
                    useProgress = false;
                    RxDownloader.updateDownloadUI(e.name, Math.round((e.current * 100) / e.total), e.current, e.total);
                } else useProgress = true;
            });
            try {
                Promise.resolve(launcher.launch(config)).then(child => { ownedProcess = child; },
                    error => finish(false, error.message || "launch failed"));
            } catch (error) {
                finish(false, error.message || "launch failed");
            }
        });
    }

    static prepareConfig = async versionId => {
        const parsedVersion = RxVersionsManager.parseVersionID(versionId);
        RxTests.writeToTestLog("Starter: Preparing UI to start / prepare()");
        const detectedJava = await RxJavaManager.gameVersionToJavaVersion(parsedVersion.name);
        if (detectedJava === false) throw new Error("Could not determine Java version");
        const javaVersion = String(detectedJava);
        RxTests.writeToTestLog(`Starter: Using Java ${javaVersion}`);
        await RxJavaManager.install(javaVersion, false);
        if (!RxJavaManager.getPath(javaVersion)) throw new Error("Java installation failed");
        const configuration = await RxLaunchConfigurator.createConfigForVersion(versionId, javaVersion);
        RxTests.writeToTestLog("Starter: Configuration ready");
        return configuration;
    }
}
