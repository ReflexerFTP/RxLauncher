// Границы доступа интерфейса к диску. Интерфейс показывает данные из сети (описания модов, профили, новости),
// поэтому ядро не принимает от него произвольные пути. Чтение и запись разрешены только:
//   — в папке данных лаунчера, папке игры (.minecraft и та, что выбрана в настройках) и во временной папке;
//   — там, что пользователь сам выбрал в системном окне или перетащил в лаунчер (до закрытия лаунчера).
// Файлы интерфейса и папки других лаунчеров (для переноса) доступны только на чтение.
// Пути сравниваются без обращения к диску: «.» и «..» раскрываются, регистр не важен
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::bridge::BridgeError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Read,
    Write,
}

struct Root {
    key: String,
    path: PathBuf,
    write: bool,
    // Отдельный файл: доступен он сам и его соседи с тем же началом имени (file.zip.part)
    file: bool,
}

struct Scope {
    roots: Vec<Root>,
    // Отказы, уже записанные в журнал (чтобы не повторять)
    denied: Vec<String>,
}

static SCOPE: OnceLock<Mutex<Scope>> = OnceLock::new();
const MAX_ROOTS: usize = 4000;

// Ключ пути для сравнения: абсолютный, без «.» и «..», в нижнем регистре, без точек и пробелов в конце имён
// (Windows их отбрасывает). None — путь относительный или необычный (устройство, поток NTFS): такие не принимаются
pub fn key(path: &str) -> Option<String> {
    let mut prefix = String::new();
    let mut parts: Vec<String> = Vec::new();
    let mut rooted = false;
    for component in Path::new(path).components() {
        match component {
            Component::Prefix(value) => match value.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => prefix = format!("{}:", (letter as char).to_ascii_lowercase()),
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    prefix = format!("\\\\{}\\{}", server.to_string_lossy().to_lowercase(), share.to_string_lossy().to_lowercase())
                }
                _ => return None,
            },
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(name) => {
                let name = name.to_string_lossy().to_lowercase();
                let name = name.trim_end_matches(['.', ' ']);
                if name.is_empty() || name.contains(':') {
                    return None;
                }
                parts.push(name.to_string());
            }
        }
    }
    if prefix.is_empty() || !rooted {
        return None;
    }
    Some(format!("{prefix}\\{}", parts.join("\\")))
}

// Путь — сама папка или что-то внутри неё
fn inside(key: &str, root: &str) -> bool {
    key == root || (key.starts_with(root) && (root.ends_with('\\') || key.as_bytes().get(root.len()) == Some(&b'\\')))
}

impl Root {
    fn matches(&self, key: &str) -> bool {
        inside(key, &self.key) || (self.file && key.starts_with(&self.key) && key.as_bytes().get(self.key.len()) == Some(&b'.'))
    }
}

fn push_root(roots: &mut Vec<Root>, path: &Path, write: bool, file: bool) {
    let mut variants: Vec<(String, PathBuf)> = Vec::new();
    if let Some(key) = key(&path.to_string_lossy()) {
        variants.push((key, path.to_path_buf()));
    }
    // Папка может быть ссылкой (junction) на другой диск: после realpath интерфейс работает с настоящим путём
    if let Ok(real) = dunce::canonicalize(path) {
        if let Some(key) = key(&real.to_string_lossy()) {
            if !variants.iter().any(|(known, _)| *known == key) {
                variants.push((key, real));
            }
        }
    }
    for (key, path) in variants {
        if roots.len() >= MAX_ROOTS || roots.iter().any(|root| root.key == key && root.file == file && (root.write || !write)) {
            continue;
        }
        roots.push(Root { key, path, write, file });
    }
}

// Значение из файла .properties: \\ → \, \: → :, \uXXXX → символ
fn unescape_property(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(decoded) => out.push(decoded),
                    None => out.push_str(&hex),
                }
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

// Папка игры из настроек TLauncher / Legacy Launcher (строка minecraft.gamedir)
pub fn property_game_dir(text: &str) -> Option<PathBuf> {
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix("minecraft.gamedir") else { continue };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':')) else { continue };
        let path = PathBuf::from(unescape_property(value.trim()));
        if path.is_absolute() {
            return Some(path);
        }
    }
    None
}

fn foreign_launchers(appdata: &Path, home: Option<&Path>, local: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![appdata.join(".tlauncher"), appdata.join("PrismLauncher"), appdata.join("PolyMC"), PathBuf::from("C:\\MultiMC"), PathBuf::from("D:\\MultiMC")];
    if let Some(home) = home {
        dirs.push(home.join("MultiMC"));
        dirs.push(home.join("Desktop").join("MultiMC"));
        dirs.push(home.join("Downloads").join("MultiMC"));
        dirs.push(home.join("curseforge").join("minecraft"));
        dirs.push(home.join("Documents").join("Curse").join("Minecraft"));
    }
    if let Some(local) = local {
        dirs.push(local.join("Programs").join("MultiMC"));
    }
    for file in [appdata.join(".tlauncher").join("legacy").join("Minecraft").join("tl.properties"), appdata.join(".minecraft").join("tlauncher-2.0.properties")] {
        let Ok(bytes) = std::fs::read(&file) else { continue };
        if bytes.len() > 1024 * 1024 {
            continue;
        }
        if let Some(dir) = property_game_dir(&String::from_utf8_lossy(&bytes)) {
            dirs.push(dir);
        }
    }
    dirs
}

fn allow_asset(app: &AppHandle, root: &Root) {
    let scope = app.asset_protocol_scope();
    let result = if root.file { scope.allow_file(&root.path) } else { scope.allow_directory(&root.path, true) };
    if let Err(error) = result {
        crate::logs::write("warn", &format!("Scope: asset access not granted for {}: {error}", root.path.display()));
    }
}

pub fn init(app: &AppHandle, user_data: &Path, web_root: &Path) {
    let appdata = crate::paths::appdata();
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(|| home.as_ref().map(|dir| dir.join("AppData").join("Local")));
    let mut roots = Vec::new();
    push_root(&mut roots, user_data, true, false);
    push_root(&mut roots, &std::env::temp_dir(), true, false);
    push_root(&mut roots, &appdata.join(".minecraft"), true, false);
    if let Some(home) = &home {
        push_root(&mut roots, &home.join("AppData").join("Roaming").join(".minecraft"), true, false);
    }
    push_root(&mut roots, web_root, false, false);
    for dir in foreign_launchers(&appdata, home.as_deref(), local.as_deref()) {
        push_root(&mut roots, &dir, false, false);
    }

    // Папка игры, своя Java и свои обои из настроек: их пользователь выбрал в системном окне в прошлые запуски
    let config: Value = std::fs::read(user_data.join("config.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
    let own = key(&user_data.to_string_lossy());
    for (name, file) in [("gameDirectory", false), ("selectedJava", true), ("customWallpaperPath", true)] {
        let Some(path) = config.get(name).and_then(Value::as_str).filter(|path| Path::new(path).is_absolute()) else { continue };
        // Папка, внутри которой лежат данные самого лаунчера (весь диск, профиль Windows), из настроек не принимается
        let holds_launcher = !file && matches!((key(path), &own), (Some(root), Some(own)) if inside(own, &root));
        if holds_launcher {
            crate::logs::write("warn", &format!("Scope: {name} from settings is too broad, ignored: {path}"));
            continue;
        }
        push_root(&mut roots, Path::new(path), !file, file);
    }

    for root in &roots {
        allow_asset(app, root);
    }
    crate::logs::write("info", &format!("Scope: {} folders open to the interface", roots.len()));
    let _ = SCOPE.set(Mutex::new(Scope { roots, denied: Vec::new() }));
}

// Путь, который пользователь выбрал в системном окне или перетащил в лаунчер
pub fn grant(app: &AppHandle, path: &Path) {
    let file = !path.is_dir();
    let Some(scope) = SCOPE.get() else { return };
    let Ok(mut scope) = scope.lock() else { return };
    let before = scope.roots.len();
    push_root(&mut scope.roots, path, true, file);
    for root in &scope.roots[before..] {
        allow_asset(app, root);
    }
}

pub fn permits(path: &str, access: Access) -> bool {
    // До запуска приложения (проверки ядра) границ нет
    let Some(scope) = SCOPE.get() else { return true };
    let Some(key) = key(path) else { return false };
    let Ok(scope) = scope.lock() else { return false };
    scope.roots.iter().any(|root| (root.write || access == Access::Read) && root.matches(&key))
}

fn note_denied(op: &str, path: &str) {
    let Some(scope) = SCOPE.get() else { return };
    let Ok(mut scope) = scope.lock() else { return };
    let line = format!("{op} {path}");
    if scope.denied.len() < 200 && !scope.denied.contains(&line) {
        crate::logs::write("warn", &format!("Scope: denied {line}"));
        scope.denied.push(line);
    }
}

// Ошибка — как у Node при отказе в доступе
pub fn check(path: &str, access: Access, op: &str) -> Result<(), BridgeError> {
    if permits(path, access) {
        return Ok(());
    }
    note_denied(op, path);
    Err(BridgeError {
        message: format!("EPERM: operation not permitted, {op} '{path}'"),
        code: Some("EPERM".into()),
        errno: Some(-4048),
        syscall: Some(op.into()),
        path: Some(path.into()),
        ..Default::default()
    })
}

// Проверка путей в запросе интерфейса перед выполнением. Ok(Some(ответ)) — ответить сразу, не выполняя операцию
pub fn guard(op: &str, args: &Value) -> Result<Option<Value>, BridgeError> {
    use Access::{Read, Write};
    let text = |name: &str| args.get(name).and_then(Value::as_str);
    let need = |name: &str, access: Access| match text(name) {
        Some(path) => check(path, access, op),
        None => Ok(()),
    };
    match op {
        // existsSync в Node не бросает ошибок: чужой путь для интерфейса просто «не существует»
        "fs.exists" => {
            if let Some(path) = text("path") {
                if !permits(path, Read) {
                    note_denied(op, path);
                    return Ok(Some(Value::Bool(false)));
                }
            }
        }
        "fs.stat" | "fs.readFile" | "fs.readdir" | "fs.list" | "fs.realpath" | "fs.access" | "fs.hashFile" => need("path", Read)?,
        "fs.open" => need("path", if text("flags").unwrap_or("r") == "r" { Read } else { Write })?,
        "fs.writeFile" | "fs.mkdir" | "fs.rm" | "fs.rmdir" | "fs.unlink" | "fs.truncate" | "fs.utimes" => need("path", Write)?,
        "fs.mkdtemp" => need("prefix", Write)?,
        "fs.rename" => {
            need("from", Write)?;
            need("to", Write)?;
        }
        "fs.copyFile" | "fs.cp" => {
            need("from", Read)?;
            need("to", Write)?;
        }
        "archive.list" | "archive.read" => need("path", Read)?,
        "archive.unpack" => {
            need("archive", Read)?;
            need("destination", Write)?;
        }
        "archive.zipDir" => {
            need("source", Read)?;
            need("target", Write)?;
        }
        "archive.zipEntries" => {
            need("target", Write)?;
            for entry in args.get("entries").and_then(Value::as_array).into_iter().flatten() {
                for name in ["file", "dir"] {
                    if let Some(path) = entry.get(name).and_then(Value::as_str) {
                        check(path, Read, op)?;
                    }
                }
            }
        }
        "http.download" => need("path", Write)?,
        "shell.trash" => need("path", Write)?,
        "shell.openPath" | "shell.showItemInFolder" => need("path", Read)?,
        _ => {}
    }
    Ok(None)
}
