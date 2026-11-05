// Пути лаунчера. Данные — там же, где у версии на Electron (%APPDATA%\rxclient): настройки, аккаунты и статистика
// переходят без переноса
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub fn appdata() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir())
}

pub fn user_data_dir() -> PathBuf {
    appdata().join("rxclient")
}

pub fn logs_dir() -> PathBuf {
    user_data_dir().join("logs")
}

// Папка с файлами интерфейса на диске (языки, шаблоны RxClient, данные OptiFine), которые код читает через fs
pub fn web_root(app: &AppHandle) -> PathBuf {
    #[cfg(feature = "devui")]
    if let Some(dir) = std::env::var_os("RX_WEB_ROOT") {
        return PathBuf::from(dir);
    }
    app.path()
        .resource_dir()
        .map(|dir| dunce::simplified(&dir).join("resources").join("web"))
        .unwrap_or_else(|_| PathBuf::from("resources").join("web"))
}
