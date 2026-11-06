// Окно лаунчера, значок в трее на время игры, открытие ссылок и папок, буфер обмена
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::bridge::{ok, BridgeError, BridgeResult};

const TRAY_ID: &str = "rx-game";

pub fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

pub fn show_launcher(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.remove_tray_by_id(TRAY_ID);
}

// Первый показ при запуске: окно ещё ни разу не показывали
pub fn reveal(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

// Во время игры: окно скрыто, в трее значок «Открыть RxLauncher»
pub fn hide_launcher(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    if app.tray_by_id(TRAY_ID).is_none() {
        let built = (|| -> tauri::Result<()> {
            let open = MenuItem::with_id(app, "rx-open", "Открыть RxLauncher", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open])?;
            let mut builder = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("RxLauncher — Minecraft запущен")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id() == "rx-open" {
                        show_launcher(app);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } | TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_launcher(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?;
            Ok(())
        })();
        if let Err(error) = built {
            crate::logs::write("warn", &format!("Could not create game tray icon: {error}"));
        }
    }
    let _ = window.set_skip_taskbar(app.tray_by_id(TRAY_ID).is_some());
    let _ = window.hide();
}

pub fn window_command(app: &AppHandle, channel: &str) -> BridgeResult {
    let Some(window) = main_window(app) else { return ok(Value::Null) };
    match channel {
        "close-main-window" => {
            let _ = window.close();
        }
        "hide-main-window" => {
            let _ = window.minimize();
        }
        "maximize-main-window" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
        "reload-main-window" => {
            let _ = window.eval("location.reload()");
        }
        "disappear-main-window" => hide_launcher(app),
        "appear-main-window" => show_launcher(app),
        "focus-fix" => {
            let _ = window.set_focus();
        }
        _ => {}
    }
    ok(Value::Null)
}

// Внешние ссылки: только http(s), без логина в адресе (как externalTargets.js)
pub fn open_external(app: &AppHandle, url: &str) -> BridgeResult {
    let parsed = reqwest::Url::parse(url).map_err(|_| BridgeError::new("Invalid external target"))?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() || url.len() > 8192 {
        return Err("Unsupported external protocol".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| BridgeError::new(e.to_string()))?;
    ok(true)
}

// Папки и текстовые файлы — как externalTargets.js (исполняемые файлы не открываем)
pub fn open_path(app: &AppHandle, target: &str) -> BridgeResult {
    let real = dunce::canonicalize(target).map_err(|e| crate::fsops::io_error(e, "realpath", target, None))?;
    let meta = std::fs::metadata(&real).map_err(|e| crate::fsops::io_error(e, "stat", target, None))?;
    let is_text = real.extension().map(|e| e.eq_ignore_ascii_case("txt") || e.eq_ignore_ascii_case("log")).unwrap_or(false);
    if !meta.is_dir() && !(meta.is_file() && is_text) {
        return Err("Unsupported external file".into());
    }
    app.opener().open_path(real.to_string_lossy(), None::<&str>).map_err(|e| BridgeError::new(e.to_string()))?;
    ok(Value::Null)
}

pub fn show_in_folder(app: &AppHandle, target: &str) -> BridgeResult {
    app.opener().reveal_item_in_dir(target).map_err(|e| BridgeError::new(e.to_string()))?;
    ok(Value::Null)
}

pub fn clipboard_write(text: &str) -> BridgeResult {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| BridgeError::new(e.to_string()))?;
    clipboard.set_text(text.to_string()).map_err(|e| BridgeError::new(e.to_string()))?;
    ok(Value::Null)
}

pub fn clipboard_read() -> BridgeResult {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| BridgeError::new(e.to_string()))?;
    ok(clipboard.get_text().unwrap_or_default())
}
