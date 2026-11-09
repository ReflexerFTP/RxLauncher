// Каналы ipcRenderer интерфейса (те же имена, что были в главном процессе Electron)
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::bridge::{blocking, ok, BridgeError, BridgeResult};
use crate::state::AppState;

fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}

pub async fn dispatch(app: &AppHandle, input: Value) -> BridgeResult {
    let channel = input.get("channel").and_then(Value::as_str).unwrap_or("").to_string();
    let args: Vec<Value> = input.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    let state = app.state::<AppState>();
    let user_data = state.user_data.clone();
    match channel.as_str() {
        "get-userdata-path" => ok(user_data),
        "isAppInDev" | "isAppInTest" => ok(false),
        "accounts-read" => ok(match crate::secure::read_accounts(&user_data) {
            Ok(accounts) => json!({"ok": true, "accounts": accounts}),
            Err(error) => json!({"ok": false, "error": error}),
        }),
        "accounts-write" => ok(match crate::secure::write_accounts(&user_data, &arg(&args, 0)) {
            Ok(()) => json!({"ok": true}),
            Err(error) => json!({"ok": false, "error": error}),
        }),
        "rx-account-token" => ok(crate::secure::account_token(&user_data, &arg(&args, 0))),

        "close-main-window" | "hide-main-window" | "maximize-main-window" | "reload-main-window" | "disappear-main-window" | "appear-main-window" | "focus-fix" => {
            crate::window::window_command(app, &channel)
        }
        // Интерфейс готов к первому кадру — показываем окно (оно создаётся скрытым)
        "rx-window-show" => {
            crate::window::reveal(app);
            ok(Value::Null)
        }
        "launcher-ready" => {
            crate::logs::write("info", "Launcher UI ready");
            ok(Value::Null)
        }
        "game-process-state" => {
            let payload = arg(&args, 0);
            let pid = payload.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
            if payload.get("active").and_then(Value::as_bool) == Some(true) && pid > 0 {
                state.add_game(pid);
                return ok(Value::Null);
            }
            if payload.get("active").and_then(Value::as_bool) != Some(false) {
                return ok(Value::Null);
            }
            // Закрылся один из клиентов: история команд прячется для его папки; остальное — когда закрыты все
            let none_left = state.remove_game(pid);
            let supplied = payload.get("gameDirectory").and_then(Value::as_str).unwrap_or("").to_string();
            let vault_data = user_data.clone();
            std::thread::spawn(move || {
                let dir = if supplied.is_empty() { None } else { crate::vault::accepted_dir(&vault_data, &supplied) };
                crate::vault::finish(&vault_data, dir.as_deref(), none_left);
            });
            if !none_left {
                return ok(Value::Null);
            }
            crate::updater::game_closed(app);
            let visible = crate::window::main_window(app).and_then(|w| w.is_visible().ok()).unwrap_or(true);
            if !visible {
                crate::window::show_launcher(app);
            }
            ok(Value::Null)
        }

        "safe-create-staging" => {
            let purpose: String = arg(&args, 0).as_str().unwrap_or("staging").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
            let dir = user_data.join("staging").join(format!("{purpose}-{:016x}", rand::random::<u64>()));
            std::fs::create_dir_all(&dir).map_err(|e| crate::fsops::io_error(e, "mkdir", &dir.to_string_lossy(), None))?;
            ok(dir)
        }
        "mod-scan" => {
            let payload = arg(&args, 0);
            let dir = payload.get("dir").and_then(Value::as_str).unwrap_or("").to_string();
            let only_enabled = payload.get("onlyEnabled").and_then(Value::as_bool).unwrap_or(false);
            blocking(move || crate::modscan::scan_dir(&user_data, &dir, only_enabled)).await
        }
        "mod-scan-files" => {
            let files: Vec<String> = arg(&args, 0).get("files").and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            blocking(move || crate::modscan::scan_files(&user_data, &files)).await
        }
        "discord-loopback" => {
            let payload = arg(&args, 0);
            match payload.get("action").and_then(Value::as_str) {
                Some("start") => crate::loopback::start().await,
                Some("wait") => crate::loopback::wait(payload.get("id").and_then(Value::as_u64).unwrap_or(0)).await,
                _ => {
                    crate::loopback::stop();
                    ok(true)
                }
            }
        }
        "command-history-prepare" => {
            let supplied = arg(&args, 0).get("gameDirectory").and_then(Value::as_str).unwrap_or("").to_string();
            blocking(move || match crate::vault::accepted_dir(&user_data, &supplied) {
                Some(dir) => {
                    let result = crate::vault::prepare(&user_data, &dir);
                    crate::logs::write("info", &format!("CommandHistory: ready for game {result}"));
                    ok(true)
                }
                None => ok(false),
            }).await
        }
        "command-history-setting" => {
            let active = state.game_active();
            blocking(move || ok(crate::vault::setting_changed(&user_data, active))).await
        }
        "generate-mclc-config" => crate::loaders::generate_config(arg(&args, 0)).await,
        "open-dialog" => open_dialog(app, arg(&args, 0)).await,
        "save-dialog" => save_dialog(app, arg(&args, 0)).await,

        "trash-instance-folder" => trash_folder(arg(&args, 0), "modpacks", "id", |_id| "manifest.json".to_string()).await,
        "trash-version-folder" => trash_folder(arg(&args, 0), "versions", "name", |name| format!("{name}.json")).await,
        "screenshot-action" => screenshot_action(app, arg(&args, 0)).await,

        "curseforge-key-status" => crate::curseforge::status(&user_data),
        "set-curseforge-api-key" => crate::curseforge::set_key(&user_data, arg(&args, 0).as_str().unwrap_or("")).await,
        "clear-curseforge-api-key" => crate::curseforge::clear_key(&user_data),
        "curseforge-request" => crate::curseforge::api_request(&user_data, &arg(&args, 0)).await,
        "update-status" => ok(crate::updater::status()),
        "media-now-playing" => blocking(|| ok(crate::media::now_playing())).await,
        "update-download" => {
            crate::updater::begin_download(app);
            ok(crate::updater::status())
        }
        "install-update" => {
            crate::updater::install(app);
            ok(Value::Null)
        }

        other => {
            crate::logs::write("warn", &format!("IPC channel not implemented yet: {other}"));
            Err(BridgeError::code(format!("IPC channel is not available yet: {other}"), "ENOSYS"))
        }
    }
}

// ---------- диалоги (формат опций и ответа — как dialog.showOpenDialog/showSaveDialog в Electron) ----------
fn apply_common<R: tauri::Runtime>(mut builder: tauri_plugin_dialog::FileDialogBuilder<R>, options: &Value) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    if let Some(title) = options.get("title").and_then(Value::as_str) {
        builder = builder.set_title(title);
    }
    if let Some(filters) = options.get("filters").and_then(Value::as_array) {
        for filter in filters {
            let name = filter.get("name").and_then(Value::as_str).unwrap_or("Files");
            let extensions: Vec<String> = filter.get("extensions").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(name, &refs);
        }
    }
    if let Some(default_path) = options.get("defaultPath").and_then(Value::as_str) {
        let path = Path::new(default_path);
        if path.is_dir() {
            builder = builder.set_directory(path);
        } else {
            if let Some(parent) = path.parent().filter(|p| p.is_dir()) {
                builder = builder.set_directory(parent);
            }
            if let Some(name) = path.file_name() {
                builder = builder.set_file_name(name.to_string_lossy());
            }
        }
    }
    builder
}

fn to_strings(paths: Vec<tauri_plugin_dialog::FilePath>) -> Vec<String> {
    paths.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect()
}

async fn open_dialog(app: &AppHandle, options: Value) -> BridgeResult {
    let app = app.clone();
    blocking(move || {
        let properties: Vec<String> = options.get("properties").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let has = |name: &str| properties.iter().any(|p| p == name);
        let builder = apply_common(app.dialog().file(), &options);
        let picked = match (has("openDirectory"), has("multiSelections")) {
            (true, true) => builder.blocking_pick_folders().map(to_strings),
            (true, false) => builder.blocking_pick_folder().map(|p| to_strings(vec![p])),
            (false, true) => builder.blocking_pick_files().map(to_strings),
            (false, false) => builder.blocking_pick_file().map(|p| to_strings(vec![p])),
        };
        match picked {
            Some(paths) if !paths.is_empty() => ok(paths),
            _ => ok(false),
        }
    })
    .await
}

async fn save_dialog(app: &AppHandle, options: Value) -> BridgeResult {
    let app = app.clone();
    blocking(move || {
        let picked = apply_common(app.dialog().file(), &options).blocking_save_file();
        match picked.and_then(|p| p.into_path().ok()) {
            Some(path) => ok(path.to_string_lossy().to_string()),
            None => ok(false),
        }
    })
    .await
}

// ---------- корзина: только папка <root>/<kind>/<id> с файлом-маркером внутри (как gameFileSafety.folder) ----------
fn safe_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value != "." && value != ".." && !value.contains(['/', '\\', ':', '\0']) && !value.ends_with([' ', '.'])
}

async fn trash_folder(payload: Value, kind: &'static str, key: &'static str, marker: impl Fn(&str) -> String + Send + 'static) -> BridgeResult {
    blocking(move || {
        let root = payload.get("root").and_then(Value::as_str).unwrap_or("");
        let id = payload.get(key).and_then(Value::as_str).unwrap_or("");
        if root.is_empty() || !Path::new(root).is_absolute() || !safe_name(id) {
            return ok(false);
        }
        let parent = match dunce::canonicalize(Path::new(root).join(kind)) {
            Ok(path) => path,
            Err(_) => return ok(false),
        };
        let target = parent.join(id);
        let meta = match std::fs::symlink_metadata(&target) {
            Ok(meta) => meta,
            Err(_) => return ok(false),
        };
        if !meta.is_dir() || meta.file_type().is_symlink() || !target.join(marker(id)).is_file() {
            return ok(false);
        }
        match dunce::canonicalize(&target) {
            Ok(real) if real.parent() == Some(parent.as_path()) => {}
            _ => return ok(false),
        }
        trash::delete(&target).map_err(|e| BridgeError::new(e.to_string()))?;
        ok(true)
    })
    .await
}

// ---------- скриншоты: только картинки внутри папок screenshots ----------
fn screenshot_path(file: &str) -> Option<PathBuf> {
    let path = dunce::canonicalize(file).ok()?;
    let is_image = path.extension().map(|e| ["png", "jpg", "jpeg"].iter().any(|x| e.eq_ignore_ascii_case(x))).unwrap_or(false);
    let in_screenshots = path.parent().and_then(|p| p.file_name()).map(|n| n.eq_ignore_ascii_case("screenshots")).unwrap_or(false);
    (is_image && in_screenshots && path.is_file()).then_some(path)
}

async fn screenshot_action(app: &AppHandle, payload: Value) -> BridgeResult {
    let Some(file) = payload.get("file").and_then(Value::as_str).and_then(screenshot_path) else { return ok(false) };
    match payload.get("action").and_then(Value::as_str) {
        Some("reveal") => {
            crate::window::show_in_folder(app, &file.to_string_lossy())?;
            ok(true)
        }
        Some("delete") => blocking(move || ok(trash::delete(&file).is_ok())).await,
        _ => ok(false),
    }
}
