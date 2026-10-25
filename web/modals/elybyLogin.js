class RxElybyLoginUI {
    static login = () => {
        let login = $("#modal-elybyLogin input.login").val();
        let password = $("#modal-elybyLogin input.password").val();
        let totp = $("#modal-elybyLogin input.totp").val();

        let $error = $("#modal-elybyLogin .error");

        if (login !== "" && password !== "") {
            $("#modal-elybyLogin .loginBtn").hide();
            $error.hide();

            RxElybyManager.loginAccount(login, password, totp).then((data) => {
                $("#modal-elybyLogin .loginBtn").show();
                $("#modal-elybyLogin input.totp").val("");

                let isSuccess = data[0];
                let clientToken = data[2];
                data = data[1];

                if (!isSuccess) {
                    $error.show();
                    // Показываем ошибку
                    if (typeof MESSAGES.elyby[data] !== "undefined") {
                        $error.text(MESSAGES.elyby[data]);
                    } else {
                        $error.text(data);
                    }
                    return false;
                } else {
                    if (RxAccountsManager.isAccountExistsByNickname(data.selectedProfile.name, "elyby")) {
                        RxToasts.create(MESSAGES.accounts.alreadyExists);
                        return false;
                    }

                    // Создаём аккаунт
                    let accountData = {
                        type: "elyby",
                        nickname: data.selectedProfile.name,
                        added: Date.now(),
                        clientToken: clientToken,
                        accessToken: data.accessToken,
                        uuid: data.selectedProfile.id,
                    }

                    let accountsList = RxAccountsManager.getAccounts();
                    accountsList[data.selectedProfile.id] = accountData;
                    RxElybyManager.getHeadURLByPlayerNickname(data.selectedProfile.name).then(() => {
                        RxAccountsManager.saveAccounts(accountsList);
                    });

                    $("#modal-elybyLogin input").val("");
                    RxModals.hideModal("elybyLogin").then(() => {
                        RxToasts.create(data.selectedProfile.name, "person", MESSAGES.commons.newAccountAdded);
                    });
                    return true;
                }
            });
        }
    }
}