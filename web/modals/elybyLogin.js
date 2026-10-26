class RxElybyLoginUI {
    static login = async () => {
        const $modal = $("#modal-elybyLogin");
        const login = $modal.find("input.login").val().trim();
        const password = $modal.find("input.password").val();
        if (!login || !password || this.busy) return false;
        this.busy = true;
        $modal.find(".loginBtn").hide();
        $modal.find(".error").hide();
        try {
            const [ok, data, clientToken] = await RxElybyManager.loginAccount(login, password, $modal.find("input.totp").val());
            if (!ok) throw new Error(MESSAGES.elyby[data] || data);
            const accounts = RxAccountsManager.getAccounts();
            const uuid = data.selectedProfile.id;
            accounts[uuid] = {...accounts[uuid], type: "elyby", nickname: data.selectedProfile.name,
                added: accounts[uuid]?.added || Date.now(), clientToken, accessToken: data.accessToken, uuid};
            RxAccountsManager.saveAccounts(accounts);
            // A missing skin must never prevent a successful login from being saved.
            RxElybyManager.getHeadURLByPlayerNickname(data.selectedProfile.name).then(() => RxAccountsUI.reloadAccountsManager()).catch(() => {});
            $modal.find("input").val("");
            await RxModals.hideModal("elybyLogin");
            RxToasts.create(data.selectedProfile.name, "person", MESSAGES.commons.newAccountAdded);
            return true;
        } catch (error) {
            $modal.find(".error").text(error.message).show();
            return false;
        } finally {
            this.busy = false;
            $modal.find(".loginBtn").show();
            $modal.find("input.totp").val("");
        }
    };
}
