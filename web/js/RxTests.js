global.TESTS_LOG = "";

let currentTestingVersion = -1;
let testVersionsList = [];

class RxTests {
    static startTest = (medVersionStartValue = -1) => {
        RxVersionsManager.getPreparedVersions().then((prepared) => {
            prepared.forEach((item) => {
                if (item.type === "vanilla" || item.type === "forge" || item.type === "fabric") {
                    if (medVersionStartValue === -1 || item.version.split(".")[1] <= medVersionStartValue) {
                        testVersionsList.push(item);
                    }
                }
            });
            console.log(testVersionsList.length, "vs", prepared.length);
            RxTests.nextTestingVersion();
        });
    }

    static writeToTestLog = (...data) => {
        let logDate = new Date().toISOString();
        let newPart = "\n" + "[" + logDate + "] " + data.join(" ")
        console.log(data.join(" "));
        fs.appendFileSync(path.join(USERDATA_PATH, "testLogs", "FULLTEST.log"), newPart);
    }

    static writeVersionLog = (data, versionId) => {
        fs.appendFileSync(path.join(USERDATA_PATH, "testLogs", versionId + ".log"), "\n" + data);
    }

    static nextTestingVersion = () => {
        currentTestingVersion++;
        if (typeof testVersionsList[currentTestingVersion] === "undefined") {
            RxTests.writeToTestLog("TEST COMPLETED");
            RxFlyout.setText("TEST COMPLETED", "Тестирование завершено");
        }

        let testingId = testVersionsList[currentTestingVersion].id;

        RxTests.testVersion(testingId).then((testResult, exitCode) => {
            if (testResult === true) {
                RxTests.writeToTestLog("✓", testingId, "passed tests");
            } else {
                RxTests.writeToTestLog("X", testingId, "not passed tests, exit code:", exitCode);
            }
            RxTests.nextTestingVersion();
        })
    }

    // Начать тестирование версии
    static testVersion = (versionId) => {
        return new Promise(resolve => {
            RxTests.prepareConfig(versionId).then(config => {
                let parsedVersion = RxVersionsManager.parseVersionID(versionId);
                let starter = new RxStarter(versionId, parsedVersion.type, parsedVersion.name);
                RxTests.writeToTestLog("TEST: Starting version " + versionId);
                let useProgress = false;
                // Готовим UI
                RxFlyout.changeMode("progress").then(() => {
                    RxTests.writeToTestLog(`Starter: UI preparation completed, starting game`);
                    let launcher = new Client();
                    launcher.launch(config);

                    launcher.on('debug', (e) => {
                        RxTests.writeVersionLog(e, versionId);
                    });
                    launcher.on('data', (e) => {
                        RxTests.writeVersionLog(e, versionId);
                        if (e.match(/Sound engine started/gim) !== null || e.match(/OpenAL initialized/gim) !== null || e.match(/Created\: 512x512 textures-atlas/gim) !== null) {
                            RxFlyout.setText("Игра запущена", versionId);
                            setTimeout(() => {
                                exec("taskkill /F /T /IM java.exe");
                            }, 6000);
                        }
                        if (e.match(/Stopping!/gim) !== null || e.match(/SoundSystem shutting down/gim) !== null) {
                            RxFlyout.setText("Игра закрывается", versionId);
                        }
                    });
                    launcher.on('close', (exitCode) => {
                        RxTests.writeToTestLog("Game exit code: " + exitCode);
                        if (exitCode > 0 && exitCode !== 1) {
                            return resolve(false, exitCode);
                        } else {
                            return resolve(true, true);
                        }
                    });
                    launcher.on("arguments", (e) => {
                        gameStarting = true;
                        RxFlyout.changeMode("spinner");
                        RxFlyout.setText("Игра запускается", versionId);
                    });
                    launcher.on('progress', (e) => {
                        if (e.type === "assets") {
                            if (startAssetsInterval === 0) {
                                startAssetsInterval = Date.now();
                            }
                            if (assetsVerifyOffset === 0 && (Date.now() - startAssetsInterval) > 1000) {
                                assetsVerifyOffset = (e.task - 1);
                            }
                        }
                        if (useProgress === true) {
                            let taskOffset = e.task - assetsVerifyOffset;
                            let totalOffset = e.total - assetsVerifyOffset;
                            let percent = Math.round((taskOffset * 100) / totalOffset);
                            RxDownloader.updateDownloadUIText(e.type, percent, taskOffset, totalOffset);
                        }
                    });
                    launcher.on('download-status', (e) => {
                        if ((e.total / 1024 / 1024) >= 4) {
                            useProgress = false;
                            let percent = Math.round((e.current * 100) / e.total);
                            RxDownloader.updateDownloadUI(e.name, percent, e.current, e.total);
                        } else {
                            useProgress = true;
                        }
                    })
                })
            })
        })
    }

    static prepareConfig = (versionId) => {
        return new Promise((resolve, reject) => {
            let parsedVersion = RxVersionsManager.parseVersionID(versionId);
            // Готовим UI
            RxTests.writeToTestLog(`Starter: Preparing UI to start / prepare()`);
            let versionDisplayName = RxVersionsManager.versionToDisplayName();
            // Получаем версию Java
            RxJavaManager.gameVersionToJavaVersion(parsedVersion.name).then((javaVersion) => {
                RxTests.writeToTestLog(`Starter: Using Java ${javaVersion}`);
                if (javaVersion === false) {
                    return reject(false);
                }

                javaVersion = javaVersion.toString();

                RxTests.writeToTestLog(`Starter: Trying to install Java`);
                // Скачиваем, если нужно
                RxJavaManager.install(javaVersion, false).then(() => {
                    // Установка Java завершена, получаем к ней путь
                    let javaPath = RxJavaManager.getPath(javaVersion);
                    if (javaPath === false) {
                        return reject(false);
                    }

                    RxTests.writeToTestLog(`Starter: Java installation completed`);

                    // Получаем конфигурацию
                    RxLaunchConfigurator.createConfigForVersion(versionId, javaVersion).then((configuration) => {
                        RxTests.writeToTestLog(`Starter: Configuration ready`);
                        return resolve(configuration);
                    });
                });
            });
        })
    }
}