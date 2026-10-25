$(document).ready(function() {
    if(RxConfig.read("eulaConfirmed", false) !== true){
        $("#modal-eula").show();
        $("#modal-eula .data").load("https://rxlauncher.ru/privacy-policy");
    }
})

// При подтверждении
$("#modal-eula .confirm").click(() => {
    $("#modal-eula").hide();
    RxConfig.write("eulaConfirmed", true);
})

// При отклонении
$("#modal-eula .decline").click(() => {
    RxUI.closeMainWindow();
})