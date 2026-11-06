// Автообновление без платного сертификата: релиз подписан ключом Ed25519 (секрет RX_UPDATE_SIGNING_KEY в GitHub),
// открытый ключ встроен сюда. Манифест rxlauncher-tauri-update.json: {version, file, url, sha256, size, signature}.
// Подпись — над строкой «rxlauncher-update\n<версия>\n<файл>\n<sha256>\n<размер>», затем установщик сверяется по SHA-256
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://github.com/ReflexerFTP/RxLauncher/releases/latest/download/rxlauncher-tauri-update.json";
const PUBLIC_KEY: &str = "828d75aae2514e0b03f23629f8bd16a3ecc0b57db529e39c3c3ead24cc35bfbf";

static READY: Mutex<Option<PathBuf>> = Mutex::new(None);
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

async fn check(app: &AppHandle) -> Result<(), String> {
    let manifest: Value = serde_json::from_slice(&crate::http::get_bytes(MANIFEST_URL, Duration::from_secs(30), 64 * 1024).await.map_err(|e| e.message)?)
        .map_err(|e| e.to_string())?;
    let (version, file, url, size, sha256) = verify(&manifest)?;
    let current = app.package_info().version.to_string();
    if parse_version(&version) <= parse_version(&current) {
        return Ok(());
    }
    crate::logs::write("info", &format!("Update {version} found, downloading"));
    let _ = app.emit("rx:update-available", Value::Null);
    let data = crate::http::get_bytes(&url, Duration::from_secs(60), size + 1).await.map_err(|e| e.message)?;
    if data.len() as u64 != size || hex::encode(sha2::Sha256::digest(&data)) != sha256 {
        return Err("Downloaded update does not match the signed manifest".into());
    }
    let dir = std::env::temp_dir().join("rxlauncher-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&file);
    std::fs::write(&target, &data).map_err(|e| e.to_string())?;
    if let Ok(mut ready) = READY.lock() {
        *ready = Some(target);
    }
    crate::logs::write("info", &format!("Update {version} downloaded and verified"));
    let _ = app.emit("rx:update-downloaded", Value::Null);
    Ok(())
}

pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) || cfg!(feature = "devui") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        if let Err(error) = check(&app).await {
            crate::logs::write("warn", &format!("Update check: {error}"));
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
