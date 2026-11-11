// Шифрование секретов в формате Electron safeStorage (Windows): ключ AES-256 лежит в «Local State» под защитой DPAPI,
// данные — "v10" + nonce(12) + AES-256-GCM. Так Tauri-версия читает токены, сохранённые версией на Electron, и наоборот.
// Здесь же хранилище аккаунтов (accounts.json) и токен аккаунта RxLauncher (rx-account.bin)
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde_json::{json, Map, Value};

static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);
static TOKEN: Mutex<Option<String>> = Mutex::new(None);
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let success = unsafe {
        if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if success == 0 {
        return Err(format!("DPAPI failed: {}", std::io::Error::last_os_error()));
    }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Ok(result)
}

#[cfg(not(windows))]
fn dpapi(_data: &[u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("Secure storage is only available on Windows".into())
}

fn local_state_path(user_data: &Path) -> PathBuf {
    user_data.join("Local State")
}

// Ключ из Local State; если файла или ключа нет — создаём новый (остальные поля файла сохраняются)
fn master_key(user_data: &Path) -> Result<[u8; 32], String> {
    let mut cached = KEY.lock().map_err(|_| "Key cache poisoned")?;
    if let Some(key) = *cached {
        return Ok(key);
    }
    let file = local_state_path(user_data);
    let mut state: Value = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}));
    let existing = state
        .get("os_crypt")
        .and_then(|o| o.get("encrypted_key"))
        .and_then(Value::as_str)
        .and_then(|b64| B64.decode(b64).ok());
    let key = match existing {
        Some(blob) if blob.starts_with(b"DPAPI") => {
            let raw = dpapi(&blob[5..], false)?;
            <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| "Unexpected key length".to_string())?
        }
        _ => {
            let key: [u8; 32] = rand::random();
            let mut blob = b"DPAPI".to_vec();
            blob.extend(dpapi(&key, true)?);
            if !state.is_object() {
                state = json!({});
            }
            let os_crypt = state.as_object_mut().unwrap().entry("os_crypt").or_insert_with(|| json!({}));
            if let Some(map) = os_crypt.as_object_mut() {
                map.insert("encrypted_key".into(), Value::String(B64.encode(blob)));
            }
            let temp = file.with_extension("rxtmp");
            std::fs::write(&temp, serde_json::to_vec(&state).unwrap_or_default()).map_err(|e| e.to_string())?;
            std::fs::rename(&temp, &file).map_err(|e| e.to_string())?;
            key
        }
    };
    *cached = Some(key);
    Ok(key)
}

pub fn encrypt(user_data: &Path, text: &str) -> Result<Vec<u8>, String> {
    let key = master_key(user_data)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce_bytes: [u8; 12] = rand::random();
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce_bytes), text.as_bytes()).map_err(|_| "Encryption failed".to_string())?;
    let mut out = b"v10".to_vec();
    out.extend_from_slice(&nonce_bytes);
    out.extend(sealed);
    Ok(out)
}

pub fn decrypt(user_data: &Path, data: &[u8]) -> Result<String, String> {
    if data.starts_with(b"v10") && data.len() > 3 + 12 + 16 {
        let key = master_key(user_data)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let plain = cipher.decrypt(Nonce::from_slice(&data[3..15]), &data[15..]).map_err(|_| "Decryption failed".to_string())?;
        return String::from_utf8(plain).map_err(|e| e.to_string());
    }
    // Очень старые данные — просто DPAPI
    String::from_utf8(dpapi(data, false)?).map_err(|e| e.to_string())
}

pub fn available() -> bool {
    cfg!(windows)
}

// ---------- accounts.json (как accountStore.js) ----------
fn accounts_file(user_data: &Path) -> PathBuf {
    user_data.join("accounts.json")
}

fn read_raw(user_data: &Path) -> Result<Map<String, Value>, String> {
    let file = accounts_file(user_data);
    if !file.exists() {
        return Ok(Map::new());
    }
    let data: Value = serde_json::from_slice(&std::fs::read(&file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    match data {
        Value::Object(map) => Ok(map),
        _ => Err("Invalid account storage".into()),
    }
}

// Секреты аккаунта, которые на диске лежат только зашифрованными (refreshToken — у аккаунтов Microsoft)
const SECRET_KEYS: [&str; 3] = ["accessToken", "clientToken", "refreshToken"];

fn valid_nickname(value: &Value) -> bool {
    value.as_str().map(|s| (2..=16).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).unwrap_or(false)
}

pub fn write_accounts(user_data: &Path, accounts: &Value) -> Result<(), String> {
    let accounts = accounts.as_object().ok_or("Invalid accounts")?;
    let mut stored = Map::new();
    for (id, source) in accounts {
        let Some(source) = source.as_object() else { continue };
        let kind = source.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "local" | "elyby" | "microsoft") || !valid_nickname(source.get("nickname").unwrap_or(&Value::Null)) {
            continue;
        }
        let mut account = source.clone();
        account.insert("uuid".into(), Value::String(id.clone()));
        account.remove("needsReauthentication");
        for key in SECRET_KEYS {
            let encrypted_key = format!("{key}Encrypted");
            if kind != "local" {
                if let Some(secret) = account.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    let sealed = encrypt(user_data, secret)?;
                    account.insert(encrypted_key.clone(), Value::String(B64.encode(sealed)));
                }
            } else {
                account.remove(&encrypted_key);
            }
            account.remove(key);
        }
        stored.insert(id.clone(), Value::Object(account));
    }
    std::fs::create_dir_all(user_data).map_err(|e| e.to_string())?;
    let file = accounts_file(user_data);
    let temp = user_data.join(format!("accounts.json.{:016x}.tmp", rand::random::<u64>()));
    let text = serde_json::to_string_pretty(&Value::Object(stored)).map_err(|e| e.to_string())?;
    let result = std::fs::write(&temp, text).and_then(|_| std::fs::rename(&temp, &file)).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&temp);
    result
}

pub fn read_accounts(user_data: &Path) -> Result<Value, String> {
    let raw = read_raw(user_data)?;
    // Незашифрованные токены от старых версий — сразу зашифровать
    if raw.values().any(|a| SECRET_KEYS.iter().any(|key| a.get(*key).is_some())) {
        write_accounts(user_data, &Value::Object(raw.clone()))?;
    }
    let mut result = read_raw(user_data)?;
    for account in result.values_mut() {
        let Some(account) = account.as_object_mut() else { continue };
        for key in SECRET_KEYS {
            let Some(sealed) = account.get(&format!("{key}Encrypted")).and_then(Value::as_str).map(str::to_string) else { continue };
            match B64.decode(sealed).map_err(|e| e.to_string()).and_then(|b| decrypt(user_data, &b)) {
                Ok(secret) => {
                    account.insert(key.into(), Value::String(secret));
                }
                Err(_) => {
                    account.insert("needsReauthentication".into(), Value::Bool(true));
                }
            }
        }
    }
    Ok(Value::Object(result))
}

// ---------- токен аккаунта RxLauncher (rx-account.bin) ----------
fn token_valid(token: &str) -> bool {
    token.len() == 47 && token.starts_with("rx1_") && token[4..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn account_token(user_data: &Path, payload: &Value) -> Value {
    let file = user_data.join("rx-account.bin");
    let mut memory = match TOKEN.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match payload.get("action").and_then(Value::as_str) {
        Some("set") => {
            let token = payload.get("token").and_then(Value::as_str).unwrap_or("");
            if !token_valid(token) {
                return Value::Bool(false);
            }
            *memory = Some(token.to_string());
            if let Ok(sealed) = encrypt(user_data, token) {
                if let Err(error) = std::fs::write(&file, sealed) {
                    crate::logs::write("warn", &format!("RxAccount: token save failed [error={error}]"));
                }
            }
            Value::Bool(true)
        }
        Some("clear") => {
            *memory = None;
            let _ = std::fs::remove_file(&file);
            Value::Bool(true)
        }
        _ => {
            if let Some(token) = memory.as_ref() {
                return Value::String(token.clone());
            }
            let token = std::fs::read(&file).ok().and_then(|data| decrypt(user_data, &data).ok()).map(|t| t.trim().to_string()).unwrap_or_default();
            if !token.is_empty() {
                *memory = Some(token.clone());
            }
            Value::String(token)
        }
    }
}
