// «Анти-кража» истории команд (порт commandHistoryVault.js, тот же формат хранилища — версии на Electron и Tauri
// читают файлы друг друга). command_history.txt лежит в папке игры только пока игра идёт; в это время пароли
// (/l, /login, /reg …) сразу вычищаются; после игры файл уезжает в зашифрованное хранилище под новым случайным именем
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use sha2::Digest;

const FILE_NAME: &str = "command_history.txt";
const MAX_LINES: usize = 50;
const SENSITIVE: &[&str] = &["l", "log", "login", "logon", "reg", "register", "changepassword", "changepass", "changepw", "cp", "cpw", "passwd",
    "password", "pass", "unregister", "unreg", "2fa", "totp"];

static WATCHED: Mutex<Option<(PathBuf, u64)>> = Mutex::new(None);
static NEXT_WATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn is_sensitive(line: &str) -> bool {
    let line = line.trim();
    let line = line.strip_prefix('/').unwrap_or(line);
    let (word, rest) = match line.find(char::is_whitespace) {
        Some(index) => (&line[..index], &line[index..]),
        None => return false,
    };
    // Необязательный префикс плагина: authme:login
    let command = match word.rsplit_once(':') {
        Some((namespace, command)) if !namespace.is_empty() && namespace.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) => command,
        Some(_) => return false,
        None => word,
    };
    SENSITIVE.iter().any(|s| s.eq_ignore_ascii_case(command)) && rest.trim_start().chars().next().map(|c| !c.is_whitespace()).unwrap_or(false)
}

fn sanitize(lines: Vec<String>) -> Vec<String> {
    lines.into_iter().filter(|l| !is_sensitive(l)).collect()
}

fn read_lines(file: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(file).ok()?;
    Some(text.split('\n').map(|l| l.trim_end_matches('\r').replace('\0', "")).filter(|l| !l.trim().is_empty()).collect())
}

fn merge(old: Vec<String>, new: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for line in old.into_iter().chain(new) {
        if result.last() != Some(&line) {
            result.push(line);
        }
    }
    let skip = result.len().saturating_sub(MAX_LINES);
    result.into_iter().skip(skip).collect()
}

fn write_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = file.with_extension(format!("{:012x}.tmp", rand::random::<u64>() & 0xffff_ffff_ffff));
    let result = std::fs::write(&temp, data).and_then(|_| std::fs::rename(&temp, file));
    let _ = std::fs::remove_file(&temp);
    result
}

// Windows может держать файл после выхода игры
fn retry<T>(mut action: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut attempt = 0;
    loop {
        match action() {
            Ok(value) => return Ok(value),
            Err(error) if attempt < 4 && matches!(error.kind(), std::io::ErrorKind::PermissionDenied) || error.raw_os_error() == Some(32) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(80 * attempt));
                if attempt >= 5 {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

struct Vault {
    root: PathBuf,
    user_data: PathBuf,
}

impl Vault {
    fn new(user_data: &Path) -> Self {
        Self { root: user_data.join("vault"), user_data: user_data.to_path_buf() }
    }

    fn encrypt(&self, text: &str) -> Vec<u8> {
        match crate::secure::encrypt(&self.user_data, text) {
            Ok(sealed) => [vec![1u8], sealed].concat(),
            Err(_) => [vec![0u8], text.as_bytes().to_vec()].concat(),
        }
    }

    fn decrypt(&self, data: &[u8]) -> Option<String> {
        match data.first()? {
            1 => crate::secure::decrypt(&self.user_data, &data[1..]).ok(),
            0 => String::from_utf8(data[1..].to_vec()).ok(),
            _ => None,
        }
    }

    fn key(dir: &Path) -> String {
        let resolved = dunce::simplified(dir).to_string_lossy().to_lowercase();
        hex::encode(sha2::Sha256::digest(resolved.as_bytes()))
    }

    fn read_index(&self) -> Value {
        std::fs::read(self.root.join("index.bin")).ok().and_then(|b| self.decrypt(&b)).and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(|v| v.get("entries").map(Value::is_object).unwrap_or(false))
            .unwrap_or_else(|| json!({"entries": {}}))
    }

    fn write_index(&self, index: &Value) {
        let _ = write_atomic(&self.root.join("index.bin"), &self.encrypt(&index.to_string()));
    }

    // Путь файла из индекса — только «xxxxxxxx\xxxxxxxx\xxxxxxxxxxxxxxxx.dat» внутри хранилища
    fn entry_path(&self, relative: &str) -> Option<PathBuf> {
        let parts: Vec<&str> = relative.split(['/', '\\']).collect();
        let hex = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
        if parts.len() != 3 || !hex(parts[0], 8) || !hex(parts[1], 8) || !parts[2].ends_with(".dat") || !hex(parts[2].trim_end_matches(".dat"), 16) {
            return None;
        }
        Some(self.root.join(parts[0]).join(parts[1]).join(parts[2]))
    }

    fn read_entry(&self, entry: &Value) -> Vec<String> {
        let Some(file) = entry.get("file").and_then(Value::as_str).and_then(|f| self.entry_path(f)) else { return Vec::new() };
        std::fs::read(file).ok().and_then(|b| self.decrypt(&b)).and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("lines").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect()))
            .unwrap_or_default()
    }

    fn remove_entry(&self, entry: &Value) {
        let Some(file) = entry.get("file").and_then(Value::as_str).and_then(|f| self.entry_path(f)) else { return };
        let _ = std::fs::remove_file(&file);
        let mut dir = file.parent().map(Path::to_path_buf);
        while let Some(current) = dir {
            if current == self.root || !current.starts_with(&self.root) || std::fs::remove_dir(&current).is_err() {
                break;
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }

    fn protect(&self, game_dir: &Path, strip: bool) -> (bool, usize) {
        let source = game_dir.join(FILE_NAME);
        let file_lines = read_lines(&source);
        let mut index = self.read_index();
        let key = Self::key(game_dir);
        let previous = index["entries"].get(&key).cloned();
        if file_lines.is_none() && previous.is_none() {
            return (false, 0);
        }
        let mut lines = merge(previous.as_ref().map(|e| self.read_entry(e)).unwrap_or_default(), file_lines.clone().unwrap_or_default());
        if strip {
            lines = sanitize(lines);
        }
        let relative = format!("{:08x}\\{:08x}\\{:016x}.dat", rand::random::<u32>(), rand::random::<u32>(), rand::random::<u64>());
        let saved_at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        if write_atomic(&self.root.join(&relative), &self.encrypt(&json!({"lines": lines, "savedAt": saved_at}).to_string())).is_err() {
            return (false, 0);
        }
        index["entries"][&key] = json!({"dir": game_dir, "file": relative, "savedAt": saved_at});
        self.write_index(&index);
        if let Some(previous) = previous {
            self.remove_entry(&previous);
        }
        if file_lines.is_some() {
            let _ = retry(|| match std::fs::remove_file(&source) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            });
        }
        (true, lines.len())
    }

    fn restore(&self, game_dir: &Path, strip: bool) -> (bool, usize) {
        let mut index = self.read_index();
        let key = Self::key(game_dir);
        let entry = index["entries"].get(&key).cloned();
        let target = game_dir.join(FILE_NAME);
        let file_lines = read_lines(&target);
        if entry.is_none() && !(strip && file_lines.is_some()) {
            return (false, file_lines.map(|l| l.len()).unwrap_or(0));
        }
        let mut lines = merge(entry.as_ref().map(|e| self.read_entry(e)).unwrap_or_default(), file_lines.unwrap_or_default());
        if strip {
            lines = sanitize(lines);
        }
        let text = if lines.is_empty() { String::new() } else { format!("{}\r\n", lines.join("\r\n")) };
        if retry(|| write_atomic(&target, text.as_bytes())).is_err() {
            return (false, 0);
        }
        if let Some(entry) = entry {
            if let Some(map) = index["entries"].as_object_mut() {
                map.remove(&key);
            }
            self.write_index(&index);
            self.remove_entry(&entry);
            return (true, lines.len());
        }
        (false, lines.len())
    }

    fn clean_now(game_dir: &Path) -> bool {
        let file = game_dir.join(FILE_NAME);
        let Some(lines) = read_lines(&file) else { return false };
        let count = lines.len();
        let clean = sanitize(lines);
        if clean.len() == count {
            return false;
        }
        let text = if clean.is_empty() { String::new() } else { format!("{}\r\n", clean.join("\r\n")) };
        std::fs::write(&file, text).is_ok()
    }
}

// ---------- настройки и папки ----------
fn config(user_data: &Path) -> Value {
    std::fs::read(user_data.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

pub fn settings(user_data: &Path) -> (bool, bool) {
    let config = config(user_data);
    let enabled = config.get("antiTheftCommandHistory").and_then(Value::as_bool).unwrap_or(true);
    (enabled, enabled && config.get("stripCommandPasswords").and_then(Value::as_bool).unwrap_or(true))
}

pub fn game_root(user_data: &Path) -> PathBuf {
    config(user_data).get("gameDirectory").and_then(Value::as_str).map(PathBuf::from).filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::paths::appdata().join(".minecraft"))
}

fn known_dirs(user_data: &Path) -> Vec<PathBuf> {
    let root = game_root(user_data);
    let mut result = vec![root.clone()];
    for kind in ["home", "modpacks"] {
        if let Ok(entries) = std::fs::read_dir(root.join(kind)) {
            result.extend(entries.flatten().filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.path()));
        }
    }
    result
}

// Папка игры из интерфейса — только внутри настроенной папки данных
pub fn accepted_dir(user_data: &Path, supplied: &str) -> Option<PathBuf> {
    let target = PathBuf::from(supplied);
    if !target.is_absolute() {
        return None;
    }
    let root = dunce::canonicalize(game_root(user_data)).ok()?;
    if target.exists() {
        let real = dunce::canonicalize(&target).ok()?;
        return (real.starts_with(&root) && real.is_dir()).then_some(real);
    }
    if target.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !target.starts_with(&root) {
        return None;
    }
    std::fs::create_dir_all(&target).ok()?;
    Some(target)
}

pub fn protect_everywhere(user_data: &Path, skip: Option<&Path>) -> usize {
    let (enabled, strip) = settings(user_data);
    if !enabled {
        return 0;
    }
    let vault = Vault::new(user_data);
    known_dirs(user_data).iter()
        .filter(|dir| skip.map(|s| Vault::key(s) != Vault::key(dir)).unwrap_or(true))
        .filter(|dir| dir.join(FILE_NAME).exists())
        .filter(|dir| vault.protect(dir, strip).0)
        .count()
}

// Перед запуском: вернуть историю и следить за паролями, пока идёт игра
pub fn prepare(user_data: &Path, dir: &Path) -> Value {
    let (_, strip) = settings(user_data);
    let (restored, lines) = Vault::new(user_data).restore(dir, strip);
    let id = NEXT_WATCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut watched) = WATCHED.lock() {
        *watched = Some((dir.to_path_buf(), id));
    }
    if strip {
        let dir = dir.to_path_buf();
        std::thread::spawn(move || {
            let file = dir.join(FILE_NAME);
            let mut last = None;
            loop {
                std::thread::sleep(Duration::from_millis(300));
                let current = WATCHED.lock().ok().and_then(|w| w.as_ref().map(|(_, i)| *i));
                if current != Some(id) {
                    break;
                }
                let stamp = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
                if stamp.is_some() && stamp != last {
                    last = stamp;
                    if Vault::clean_now(&dir) {
                        last = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
                    }
                }
            }
        });
    }
    json!({"restored": restored, "lines": lines})
}

// Игра закрылась — спрятать историю этой папки
pub fn finish(user_data: &Path) {
    let dir = WATCHED.lock().ok().and_then(|mut w| w.take()).map(|(d, _)| d);
    let Some(dir) = dir else { return };
    let (enabled, strip) = settings(user_data);
    if !enabled {
        return;
    }
    std::thread::sleep(Duration::from_millis(400));
    let (saved, lines) = Vault::new(user_data).protect(&dir, strip);
    crate::logs::write("info", &format!("CommandHistory: hidden after game [saved={saved}] [lines={lines}]"));
}

// Переключили «Анти-кражу»: спрятать всё или вернуть по местам
pub fn setting_changed(user_data: &Path, game_active: bool) -> Value {
    let (enabled, _) = settings(user_data);
    if enabled {
        let skip = if game_active { WATCHED.lock().ok().and_then(|w| w.as_ref().map(|(d, _)| d.clone())) } else { None };
        return json!({"hidden": protect_everywhere(user_data, skip.as_deref())});
    }
    if let Ok(mut watched) = WATCHED.lock() {
        *watched = None;
    }
    let vault = Vault::new(user_data);
    let index = vault.read_index();
    let mut released = 0;
    for entry in index["entries"].as_object().cloned().unwrap_or_default().values() {
        if let Some(dir) = entry.get("dir").and_then(Value::as_str).map(PathBuf::from).filter(|d| d.is_dir()) {
            if vault.restore(&dir, false).0 {
                released += 1;
            }
        }
    }
    json!({"released": released})
}
