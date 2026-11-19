// Автообновление без платного сертификата: релиз подписан ключом Ed25519 (секрет RX_UPDATE_SIGNING_KEY в GitHub),
// открытый ключ встроен сюда. Манифест rxlauncher-tauri-update.json: {version, file, url, sha256, size, signature, title, summary}.
// Подпись — над строкой «rxlauncher-update\n<версия>\n<файл>\n<sha256>\n<размер>», затем установщик сверяется по SHA-256.
// title и summary (что нового) не подписаны и только показываются игроку.
// Проверка — при каждом запуске и раз в 6 часов; если сеть не ответила — снова через 30 с, 2, 5 и 15 минут.
// Скачивание с докачкой в %APPDATA%\rxclient\updates (временную папку Windows чистит). Когда GitHub не отвечает
// (у части игроков он почти не грузится), манифест и установщик берутся с зеркала rxlauncher.xyz/update/:
// подпись и SHA-256 проверяются те же, поэтому зеркалу доверять не нужно
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://github.com/ReflexerFTP/RxLauncher/releases/latest/download/rxlauncher-tauri-update.json";
const MIRROR_MANIFEST_URL: &str = "https://rxlauncher.xyz/update/rxlauncher-tauri-update.json";
const MIRROR_BASE: &str = "https://rxlauncher.xyz/update/";
// Повторы проверки после ошибки сети (секунды), дальше — раз в час, пока не получится
const CHECK_RETRIES: [u64; 4] = [30, 120, 300, 900];
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
    ready: Option<PathBuf>,
}

static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);
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
    AVAILABLE.lock().ok().is_some_and(|u| u.as_ref().is_some_and(|u| u.ready.is_some()))
}

// Что видит интерфейс: none | available | downloading | ready
pub fn status() -> Value {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone());
    let Some(update) = update else { return json!({"state": "none"}) };
    let state = if update.ready.is_some() { "ready" } else if DOWNLOADING.load(Ordering::SeqCst) { "downloading" } else { "available" };
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

type Verified = (String, String, String, u64, String);

// Манифест с GitHub, а если он не ответил или подпись не сошлась — с зеркала
async fn fetch_manifest() -> Result<(Value, Verified), String> {
    let mut errors = Vec::new();
    for url in [MANIFEST_URL, MIRROR_MANIFEST_URL] {
        let parsed = match crate::http::get_bytes(url, Duration::from_secs(20), 64 * 1024).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()),
            Err(error) => Err(error.message),
        };
        match parsed.and_then(|manifest| verify(&manifest).map(|fields| (manifest, fields))) {
            Ok(result) => return Ok(result),
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(errors.join("; "))
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let (manifest, (version, file, url, size, sha256)) = fetch_manifest().await?;
    let current = app.package_info().version.to_string();
    if parse_version(&version) <= parse_version(&current) {
        return Ok(());
    }
    let known = AVAILABLE.lock().ok().and_then(|u| u.as_ref().map(|u| u.version == version)).unwrap_or(false);
    if !known {
        if let Ok(mut available) = AVAILABLE.lock() {
            *available = Some(Update {
                version: version.clone(), file, url, size, sha256,
                title: text_field(&manifest, "title", 120), summary: text_field(&manifest, "summary", 600), ready: None,
            });
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
                // Сеть пропала надолго — через 10 минут продолжаем с того же места
                if auto_download(&app) {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(600)).await;
                        begin_download(&app);
                    });
                }
            }
        }
    });
}

fn updates_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::state::AppState>().user_data.join("updates")
}

async fn download(app: &AppHandle) -> Result<(), String> {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone()).ok_or("No update")?;
    let dir = updates_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{}.part", update.file));
    let target = dir.join(&update.file);
    // Файлы других версий больше не нужны
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != part && path != target {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Скачанный в прошлый запуск файл: проверяем его подпись заново, не скачивая
    if target.is_file() && !part.exists() {
        let _ = std::fs::rename(&target, &part);
    }
    let mirror = format!("{MIRROR_BASE}{}", update.file);
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut attempt = 0u64;
    loop {
        // Источники чередуются: GitHub, зеркало, GitHub… Файл докачивается с места обрыва
        let source = if attempt % 2 == 0 { update.url.as_str() } else { mirror.as_str() };
        let progress = |received: u64| {
            RECEIVED.store(received, Ordering::SeqCst);
            if last_emit.elapsed() >= Duration::from_millis(500) {
                last_emit = Instant::now();
                let _ = app.emit("rx:update-progress", status());
            }
        };
        match crate::http::fetch_to_file(source, &part, update.size, progress).await {
            Ok(()) => break,
            Err(error) if attempt < 60 => {
                attempt += 1;
                crate::logs::write("warn", &format!("Update download interrupted (attempt {attempt}, {source}): {}", error.message));
                tokio::time::sleep(Duration::from_secs(3 * attempt.min(10))).await;
            }
            Err(error) => return Err(error.message),
        }
    }
    // Файл целиком сверяется с подписанным манифестом
    if let Err(error) = verified_installer(&part, update.size, &update.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err(error);
    }
    let mut available = AVAILABLE.lock().map_err(|_| "Cannot access update state")?;
    let current = available.as_mut().filter(|u| u.version == update.version && u.sha256 == update.sha256)
        .ok_or("A different update is now available")?;
    std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
    current.ready = Some(target);
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
        let mut failures = 0usize;
        loop {
            let wait = match check(&app).await {
                Ok(()) => {
                    failures = 0;
                    6 * 3600
                }
                Err(error) => {
                    crate::logs::write("warn", &format!("Update check (failure {}): {error}", failures + 1));
                    let wait = CHECK_RETRIES.get(failures).copied().unwrap_or(3600);
                    failures += 1;
                    wait
                }
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

// На Windows файл нельзя изменить или переименовать, пока открыт проверенный дескриптор.
fn verified_installer(path: &std::path::Path, size: u64, sha256: &str) -> Result<std::fs::File, String> {
    let mut options = std::fs::File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != size {
        return Err("Installer size does not match the signed manifest".into());
    }
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    if hex::encode(hasher.finalize()) != sha256 {
        return Err("Installer hash does not match the signed manifest".into());
    }
    Ok(file)
}

pub fn install(app: &AppHandle) {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone());
    let Some((update, path)) = update.and_then(|u| u.ready.clone().map(|p| (u, p))) else {
        crate::logs::write("warn", "Blocked update installation: no verified update is ready");
        return;
    };
    let state = app.state::<crate::state::AppState>();
    if state.game_active() {
        DEFERRED.store(true, Ordering::SeqCst);
        let _ = app.emit("rx:update-install-deferred", Value::Null);
        return;
    }
    if INSTALLING.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = verified_installer(&path, update.size, &update.sha256);
        let Ok(mut available) = AVAILABLE.lock() else { INSTALLING.store(false, Ordering::SeqCst); return };
        let current = available.as_mut().filter(|u| u.version == update.version && u.sha256 == update.sha256 && u.ready.as_ref() == Some(&path));
        let Some(current) = current else { INSTALLING.store(false, Ordering::SeqCst); return };
        let result = match result {
            Ok(_locked) if app.state::<crate::state::AppState>().game_active() => {
                DEFERRED.store(true, Ordering::SeqCst);
                let _ = app.emit("rx:update-install-deferred", Value::Null);
                Ok(false)
            }
            Ok(_locked) => std::process::Command::new(&path).arg("/P").spawn().map(|_| true).map_err(|e| e.to_string()),
            Err(error) => { current.ready = None; Err(error) }
        };
        drop(available);
        if matches!(result, Ok(true)) {
            app.state::<crate::state::AppState>().set_force_close(true);
            app.exit(0);
            return;
        }
        INSTALLING.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            crate::logs::write("warn", &format!("Update installation blocked: {error}"));
            let _ = app.emit("rx:update-error", json!({"message": error, "status": status()}));
        }
    });
}

pub fn game_closed(app: &AppHandle) {
    if DEFERRED.swap(false, Ordering::SeqCst) {
        install(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_file_matches_signed_content_and_stays_locked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.bin");
        let data = b"sample update data";
        std::fs::write(&path, data).unwrap();
        let hash = hex::encode(sha2::Sha256::digest(data));
        let locked = verified_installer(&path, data.len() as u64, &hash).unwrap();
        #[cfg(windows)]
        assert!(std::fs::File::options().write(true).open(&path).is_err());
        drop(locked);
        assert!(verified_installer(&path, 1, &hash).is_err());
        std::fs::write(&path, vec![0; data.len()]).unwrap();
        assert!(verified_installer(&path, data.len() as u64, &hash).is_err());
    }
}
