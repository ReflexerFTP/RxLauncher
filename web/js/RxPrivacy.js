// Режим паранойи (настройка lessDataCollection): лаунчер ничего не отправляет о себе
// и не обращается к сторонним сервисам аватарок, а личные пути скрываются в логах.
class RxPrivacy {
    static isParanoid = () => typeof RxConfig !== "undefined" && RxConfig.read("lessDataCollection", false) === true;

    // C:\Users\Имя\... -> C:\Users\***\...
    static maskUserPaths = (text) => String(text).replace(/([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s"'<>|]+)/gi, "$1***");

    static maskIfParanoid = (text) => RxPrivacy.isParanoid() ? RxPrivacy.maskUserPaths(text) : String(text);

    // Внешние головы скинов (minotar.net видит IP и ник) — в режиме паранойи только локальная заглушка
    static remoteAvatar = (url, fallback = "assets/skins/steve-head.png") => RxPrivacy.isParanoid() ? fallback : url;
}
