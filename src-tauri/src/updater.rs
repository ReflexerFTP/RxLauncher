// Автообновление без платного сертификата: релиз подписан ключом Ed25519 (секрет RX_UPDATE_SIGNING_KEY в GitHub),
// открытый ключ встроен сюда. Манифест rxlauncher-tauri-update.json: {version, file, url, sha256, size, signature, title, summary}.
// Подпись — над строкой «rxlauncher-update\n<версия>\n<файл>\n<sha256>\n<размер>», затем установщик сверяется по SHA-256.
// title и summary (что нового) не подписаны и только показываются игроку.
// Проверка — при каждом запуске и раз в 6 часов. Скачивание с докачкой: обрыв на медленном интернете не начинает его заново
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://github.com/ReflexerFTP/RxLauncher/releases/latest/download/rxlauncher-tauri-update.json";
const PUBLIC_KEY: &str = "828d75aae2514e0b03f23629f8bd16a3ecc0b57db529e39c3c3ead24cc35bfbf";

#[derive(Clone)]
struct Update {
    version: String,
    file: String,
    url: String,
    size: u64,
    sha256: String,
    title: String,
    summary: String,
}

static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
static READY: Mutex<Option<PathBuf>> = Mutex::new(None);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static RECEIVED: AtomicU64 = AtomicU64::new(0);
static DEFERRED: AtomicBool = AtomicBool::new(false);

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().trim_start_matches('v').split(['.', '-', '+']).map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

fn verify(manifest: &Value) -> Result<(String, String, String, u64, String), String> {
    let field = |name: &str| manifest.get(name).and_then(Value::as_str).map(str::to_string).ok_or(format!("Update manifest has no {name}"));
    let (version, file, url, sha256, signature) = (field("version")?, field("file")?, field("url")?, field("sha256")?.to_lowercase(), field("signature")?);
    let size = manifest.get("size").and_then(Value::as_u64).ok_or("Update manifest has no size")?;
    if !file.ends_with(".exe") || file.contains(['/', '\\']) || !url.starts_with("https://github.com/ReflexerFTP/RxLauncher/releases/download/") {
        return Err("Unexpected update location".into());
    }
    let key_bytes: [u8; 32] = hex::decode(PUBLIC_KEY).map_err(|e| e.to_string())?.try_into().map_err(|_| "Bad public key")?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| e.to_string())?;
    use base64::Engine;
    let signature_bytes: [u8; 64] = base64::engine::general_purpose::STANDARD.decode(signature.trim()).map_err(|e| e.to_string())?
        .try_into().map_err(|_| "Bad signature length")?;
    let message = format!("rxlauncher-update\n{version}\n{file}\n{sha256}\n{size}");
    key.verify(message.as_bytes(), &Signature::from_bytes(&signature_bytes)).map_err(|_| "Update signature is invalid".to_string())?;
    Ok((version, file, url, size, sha256))
}

fn text_field(manifest: &Value, name: &str, max: usize) -> String {
    manifest.get(name).and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(max).collect()
}

fn is_ready() -> bool {
    READY.lock().ok().map(|r| r.is_some()).unwrap_or(false)
}

// Что видит интерфейс: none | available | downloading | ready
pub fn status() -> Value {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone());
    let Some(update) = update else { return json!({"state": "none"}) };
    let state = if is_ready() { "ready" } else if DOWNLOADING.load(Ordering::SeqCst) { "downloading" } else { "available" };
    json!({
        "state": state, "version": update.version, "size": update.size, "received": RECEIVED.load(Ordering::SeqCst),
        "title": update.title, "summary": update.summary
    })
}

// Настройка «Скачивать обновления автоматически» (по умолчанию включена)
fn auto_download(app: &AppHandle) -> bool {
    let user_data = app.state::<crate::state::AppState>().user_data.clone();
    std::fs::read(user_data.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| config.get("autoDownloadUpdates").and_then(Value::as_bool))
        .unwrap_or(true)
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let manifest: Value = serde_json::from_slice(&crate::http::get_bytes(MANIFEST_URL, Duration::from_secs(30), 64 * 1024).await.map_err(|e| e.message)?)
        .map_err(|e| e.to_string())?;
    let (version, file, url, size, sha256) = verify(&manifest)?;
    let current = app.package_info().version.to_string();
    if parse_version(&version) <= parse_version(&current) {
        return Ok(());
    }
    let known = AVAILABLE.lock().ok().and_then(|u| u.as_ref().map(|u| u.version == version)).unwrap_or(false);
    if !known {
        if let Ok(mut available) = AVAILABLE.lock() {
            *available = Some(Update {
                version: version.clone(), file, url, size, sha256,
                title: text_field(&manifest, "title", 120), summary: text_field(&manifest, "summary", 600),
            });
        }
        if let Ok(mut ready) = READY.lock() {
            *ready = None;
        }
        RECEIVED.store(0, Ordering::SeqCst);
        crate::logs::write("info", &format!("Update {version} found"));
    }
    let _ = app.emit("rx:update-available", status());
    if auto_download(app) {
        begin_download(app);
    }
    Ok(())
}

// Скачать в фоне (кнопка «Скачать» или автозагрузка). Повторный вызов во время скачивания ничего не делает
pub fn begin_download(app: &AppHandle) {
    if is_ready() {
        let _ = app.emit("rx:update-downloaded", status());
        return;
    }
    if AVAILABLE.lock().ok().map(|u| u.is_none()).unwrap_or(true) || DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("rx:update-progress", status());
        let result = download(&app).await;
        DOWNLOADING.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                let _ = app.emit("rx:update-downloaded", status());
            }
            Err(error) => {
                crate::logs::write("warn", &format!("Update download: {error}"));
                let _ = app.emit("rx:update-error", json!({"message": error, "status": status()}));
            }
        }
    });
}

async fn download(app: &AppHandle) -> Result<(), String> {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone()).ok_or("No update")?;
    let dir = std::env::temp_dir().join("rxlauncher-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{}.part", update.file));
    let target = dir.join(&update.file);
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut attempt = 0u64;
    loop {
        let progress = |received: u64| {
            RECEIVED.store(received, Ordering::SeqCst);
            if last_emit.elapsed() >= Duration::from_millis(500) {
                last_emit = Instant::now();
                let _ = app.emit("rx:update-progress", status());
            }
        };
        match crate::http::fetch_to_file(&update.url, &part, update.size, progress).await {
            Ok(()) => break,
            Err(error) if attempt < 40 => {
                attempt += 1;
                crate::logs::write("warn", &format!("Update download interrupted (attempt {attempt}): {}", error.message));
                tokio::time::sleep(Duration::from_secs(5 * attempt.min(6))).await;
            }
            Err(error) => return Err(error.message),
        }
    }
    // Файл целиком сверяется с подписанным манифестом
    let digest = {
        let mut file = std::fs::File::open(&part).map_err(|e| e.to_string())?;
        let mut hasher = sha2::Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        hex::encode(hasher.finalize())
    };
    if digest != update.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("Downloaded update does not match the signed manifest".into());
    }
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
    if let Ok(mut ready) = READY.lock() {
        *ready = Some(target);
    }
    crate::logs::write("info", &format!("Update {} downloaded and verified", update.version));
    Ok(())
}

pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) || cfg!(feature = "devui") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(6)).await;
        loop {
            if let Err(error) = check(&app).await {
                crate::logs::write("warn", &format!("Update check: {error}"));
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

// Установить скачанное обновление (во время игры — после её закрытия)
pub fn install(app: &AppHandle) {
    let Some(path) = READY.lock().ok().and_then(|r| r.clone()) else {
        crate::logs::write("warn", "Blocked update installation: no verified update is ready");
        return;
    };
    let state = app.state::<crate::state::AppState>();
    if state.game_active() {
        DEFERRED.store(true, Ordering::SeqCst);
        let _ = app.emit("rx:update-install-deferred", Value::Null);
        return;
    }
    match std::process::Command::new(&path).arg("/P").spawn() {
        Ok(_) => {
            state.set_force_close(true);
            app.exit(0);
        }
        Err(error) => crate::logs::write("warn", &format!("Update installer failed to start: {error}")),
    }
}

pub fn game_closed(app: &AppHandle) {
    if DEFERRED.swap(false, Ordering::SeqCst) {
        install(app);
    }
}
