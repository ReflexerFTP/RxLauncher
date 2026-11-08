// Правила и конфиденциальность при первом запуске. Текст — в самом лаунчере (раньше грузился с rxlauncher.ru,
// которого больше нет), полные документы открываются на GitHub
const EULA_LINKS = {
    eula: "https://github.com/ReflexerFTP/RxLauncher/blob/main/EULA.md",
    privacy: "https://github.com/ReflexerFTP/RxLauncher/blob/main/PRIVACY_POLICY.md"
};

$(document).ready(function () {
    if (RxConfig.read("eulaConfirmed", false) === true) return;
    const t = MESSAGES.eula || {};
    const $data = $("#modal-eula .data").empty();
    $data.append($("<h2>").text(t.title || "Добро пожаловать в RxLauncher"));
    $data.append($("<p>").text(t.text || ""));
    const $list = $("<ul>");
    (t.points || []).forEach(point => $list.append($("<li>").text(point)));
    $data.append($list);
    const $links = $("<p>").addClass("eula-links");
    $links.append($("<a href='#'>").text(t.eulaLink || "Пользовательское соглашение").on("click", event => { event.preventDefault(); openExternal(EULA_LINKS.eula); }));
    $links.append(document.createTextNode(" · "));
    $links.append($("<a href='#'>").text(t.privacyLink || "Политика конфиденциальности").on("click", event => { event.preventDefault(); openExternal(EULA_LINKS.privacy); }));
    $data.append($links);
    $("#modal-eula .confirm").text(t.accept || "Принимаю");
    $("#modal-eula .decline").text(t.decline || "Выйти");
    $("#modal-eula").show();
});

// При подтверждении
$("#modal-eula .confirm").click(() => {
    $("#modal-eula").hide();
    RxConfig.write("eulaConfirmed", true);
});

// При отклонении
$("#modal-eula .decline").click(() => {
    RxUI.closeMainWindow();
});
