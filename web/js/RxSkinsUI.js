let skinViewer;

class RxSkinsUI {
    // Перейти к регистрации
    static goRegister() {
        RxModals.hideModal("rxLogin").then(() => {
            RxModals.showModal("rxRegister");
        })
    }

    // Перейти к авторизации
    static goLogin() {
        RxModals.hideModal("rxRegister").then(() => {
            RxModals.showModal("rxLogin");
        })
    }

    // Начать процесс регистрации
    static register = async () => {
        let login = $("#modal-rxRegister input.login").val().trim();
        let password = $("#modal-rxRegister input.password").val().trim();
        let repPassword = $("#modal-rxRegister input.password-repeat").val().trim();
        let $error = $("#modal-rxRegister .error");

        if (login === "" || password === "" || login.match(NICKNAME_REGEX) === null) {
            $error.show();
            $error.text(MESSAGES.rxAuth.fieldsError);
            return false;
        }

        if (password !== repPassword) {
            $error.show();
            $error.text(MESSAGES.rxAuth.passwordsComp);
            return false;
        }

        $("#modal-rxRegister .loginBtn").hide();
        $error.hide();

        let [isSuccess, response] = await RxRequests.get(`${SKINS_API_URL}/register?username=${login}&password=${password}`);
        if (isSuccess && response.success) {
            $("#modal-rxRegister input.login").val("");
            $("#modal-rxRegister input.password").val("");
            $("#modal-rxRegister input.password-repeat").val("");
            RxAlerts.create(MESSAGES.rxAuth.register.success.title,
                MESSAGES.rxAuth.register.success.description,
                MESSAGES.rxAuth.register.success.button,
                "how_to_reg", () => {
                    RxSkinsUI.goLogin()
                });
            await RxModals.hideModal("rxRegister");
            return true;
        }

        // Произошла ошибка
        console.log(response);
        $("#modal-rxRegister .loginBtn").show();
        RxSkinsUI.parseAndShowError(response);
    }

    // Начать процесс входа
    static login = async () => {
        let login = $("#modal-rxLogin input.login").val().trim();
        let password = $("#modal-rxLogin input.password").val().trim();
        let $error = $("#modal-rxLogin .error");

        if (login === "" || password === "" || login.match(NICKNAME_REGEX) === null) {
            $error.show();
            $error.text(MESSAGES.rxAuth.fieldsError);
            return;
        }

        $("#modal-rxLogin .loginBtn").hide();
        $error.hide();

        let [isSuccess, response] = await RxRequests.get(`${SKINS_API_URL}/login?username=${login}&password=${password}`);
        if (isSuccess && response.success) {
            $("#modal-rxLogin input.login").val("");
            $("#modal-rxLogin input.password").val("");
            $("#modal-rxLogin input.password-repeat").val("");

            // Создаём аккаунт
            let accountData = {
                type: "frog",
                nickname: response.username,
                added: Date.now(),
                clientToken: response.profileId,
                accessToken: response.clientId,
                uuid: response.profileUuid,
                secret: response.secret,
                textures: response.textures
            }

            let accountsList = RxAccountsManager.getAccounts();
            accountsList[response.profileUuid] = accountData;
            await RxAccountsManager.saveAccounts(accountsList);

            $("#modal-rxLogin input").val("");
            RxToasts.create(response.username, "person", MESSAGES.commons.newAccountAdded);
            await RxModals.hideModal("rxLogin");
            return true;
        }

        // Произошла ошибка
        console.log(response);
        $("#modal-rxLogin .loginBtn").show();
        RxSkinsUI.parseAndShowError(response);
    }

    // Парсить и показать в UI ошибку
    static parseAndShowError = (response) => {
        let $error = $("#modal-rxLogin .error");
        let errData = response.responseJSON || response.responseText;
        $error.show();

        if (typeof errData.success !== "undefined" && errData.success === false) {
            let errorMessage = errData.error || errData.errorMessage;
            if (typeof MESSAGES.rxAuth.errors[errorMessage] !== "undefined") {
                return $error.text(MESSAGES.rxAuth.errors[errorMessage]);
            }
            $error.text(MESSAGES.rxAuth.errors.UNKNOWN + ": " + errorMessage);
            return false;
        }
        $error.text(MESSAGES.rxAuth.errors.UNKNOWN + ": " + errData.toString());
        return false;
    }

    // Обновить профили у всех аккаунтов
    static refreshAllProfiles = () => {
        let accountsList = RxAccountsManager.getAccounts();
        let keysEachList = Object.keys(accountsList);
        let currentAccount = -1;
        let promiseResolve;
        return new Promise((resolve) => {
            promiseResolve = resolve;
            refreshNext();
        });

        function refreshNext() {
            currentAccount++;
            let accItem = accountsList[keysEachList[currentAccount]];
            if (typeof accItem !== "undefined") {
                if (accItem.type === "frog") {
                    RxRequests.get(`${SKINS_API_URL}/profile?secret=${accItem.secret}`).then(result => {
                        let [isSuccess, response] = result;
                        if(!isSuccess || !response.success){
                            console.log(response);
                            return refreshNext();
                        }
                        accountsList[keysEachList[currentAccount]].textures = response.textures;
                        accountsList[keysEachList[currentAccount]].nickname = response.username;
                        return refreshNext();
                    })
                } else if (accItem.type === "elyby") {
                    RxElybyManager.getHeadURLByPlayerNickname(accountsList[keysEachList[currentAccount]].nickname).then(refreshNext);
                } else {
                    refreshNext();
                }
            } else {
                RxAccountsManager.saveAccounts(accountsList).then(() => {
                    return promiseResolve(true);
                });
            }
        }
    }

    // Обновить UI для работы со скинами/плащами
    static refreshSkinUI = (accountUuid) => {
        let accountData = RxAccountsManager.getAccount(accountUuid);
        global.currentAccountInEditor = accountData;
        $("#modal-rxSkin .error").hide();

        setTimeout(() => {
            renderSkinInUI((accountData.textures.skin || ""), (accountData.textures.cape || ""));
        }, 250);
    }

    // Очистить кэш скинов
    static clearSkinsCache = () => {
        let cachePath = `${GAME_DATA}/assets/skins`;
        if (!fs.existsSync(cachePath)) {
            return true;
        }

        fs.rmSync(cachePath, {recursive: true, force: true});
        if (!fs.existsSync(cachePath)) {
            fs.mkdirSync(cachePath);
        }
        return true;
    }

    // Загрузить текстуру на сервер
    static uploadTexture = async (type, file = "") => {
        let formData;
        if (file === "") {
            formData = new FormData($("#texture-image-form")[0]);
        } else {
            formData = new FormData();
            formData.append('texture-image', file);
        }
        let [isSuccess, response] = await RxRequests.post(`${SKINS_API_URL}/${type}/upload?secret=${currentAccountInEditor.secret}`, formData);
        if(!isSuccess){
            console.log(response);
            return RxSkinsUI.parseAndShowError(response);
        }
        RxSkinsUI.refreshSkinUI(currentAccountInEditor.uuid);
        RxAccountsUI.reloadAccountSelect();
        await RxSkinsUI.refreshAllProfiles();
        return true;
    }
}

function renderSkinInUI(skinPath = "", capePath = "") {
    let $canvas = document.getElementById("skin_container");
    if (skinPath === "" && capePath === "") {
        return false;
    }

    if (skinPath !== "") {
        let canvasSizes = $canvas.getBoundingClientRect();
        skinViewer = new skinview3d.SkinViewer({
            canvas: $canvas,
            width: Math.round(canvasSizes.width),
            height: Math.round(canvasSizes.height)
        });
        skinViewer.autoRotate = true;
        skinViewer.loadSkin(path.normalize(skinPath));
        skinViewer.animation = new skinview3d.WalkingAnimation();
        skinViewer.autoRotate = true;
    }

    if (capePath !== "") {
        skinViewer.loadCape(path.normalize(capePath));
    }
    return true;
}