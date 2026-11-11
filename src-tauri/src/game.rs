// Запуск Minecraft (замена minecraft-launcher-core): версия и её родитель (inheritsFrom), правила ОС, загрузка
// недостающих файлов, classpath, аргументы JVM и игры, процесс Java. События для интерфейса — «rx:game»:
// {id, event: debug|data|progress|download-status|arguments|close, data}
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::bridge::{ok, BridgeError, BridgeResult};
use crate::gamefiles::{self, Download};
use crate::state::AppState;

const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

pub struct Events {
    app: AppHandle,
    id: u64,
}

impl Events {
    fn emit(&self, event: &str, data: Value) {
        let _ = self.app.emit("rx:game", json!({"id": self.id, "event": event, "data": data}));
    }
    fn debug(&self, message: impl AsRef<str>) {
        self.emit("debug", Value::String(format!("[RxCore]: {}", message.as_ref())));
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) && id != "." && id != ".."
}

// ---------- правила ----------
fn os_matches(os: &Value) -> bool {
    if let Some(name) = str_of(os, "name") {
        if name != "windows" {
            return false;
        }
    }
    if let Some(arch) = str_of(os, "arch") {
        let current = if cfg!(target_pointer_width = "64") { "x64" } else { "x86" };
        if arch != current && !(arch == "x86" && current == "x86") {
            return false;
        }
    }
    true
}

pub fn rules_allow(rules: Option<&Value>, features: &HashMap<String, bool>) -> bool {
    let Some(rules) = rules.and_then(Value::as_array) else { return true };
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        let mut matches = rule.get("os").map(os_matches).unwrap_or(true);
        if let Some(required) = rule.get("features").and_then(Value::as_object) {
            for (name, value) in required {
                if features.get(name).copied().unwrap_or(false) != value.as_bool().unwrap_or(false) {
                    matches = false;
                }
            }
        }
        if matches {
            allowed = str_of(rule, "action") == Some("allow");
        }
    }
    allowed
}

// ---------- версии ----------
async fn read_or_fetch_version(root: &Path, id: &str, child: Option<&str>, source: &str, events: &Events) -> Result<Value, BridgeError> {
    if !valid_id(id) {
        return Err(BridgeError::new(format!("Invalid version id: {id}")));
    }
    let file = root.join("versions").join(id).join(format!("{id}.json"));
    // Версия на Electron (minecraft-launcher-core) хранила JSON родителя в папке дочерней версии
    let mut candidates = vec![file.clone()];
    if let Some(child) = child.filter(|c| valid_id(c)) {
        candidates.push(root.join("versions").join(child).join(format!("{id}.json")));
    }
    for candidate in &candidates {
        if let Ok(bytes) = std::fs::read(candidate) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                return Ok(value);
            }
        }
    }
    events.debug(format!("Downloading version manifest for {id}"));
    let manifest: Value = serde_json::from_slice(&crate::http::get_bytes(MANIFEST, Duration::from_secs(45), 32 * 1024 * 1024).await?)
        .map_err(|e| BridgeError::new(format!("Bad version manifest: {e}")))?;
    let entry = manifest
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|v| str_of(v, "id") == Some(id)))
        .ok_or_else(|| BridgeError::new(format!("Version {id} not found in the Mojang manifest")))?;
    let item = Download {
        url: str_of(entry, "url").unwrap_or("").to_string(),
        path: file.clone(),
        sha1: str_of(entry, "sha1").map(str::to_string),
        size: None,
    };
    gamefiles::fetch(&item, source).await?;
    serde_json::from_slice(&std::fs::read(&file).map_err(|e| crate::fsops::io_error(e, "open", &file.to_string_lossy(), None))?)
        .map_err(|e| BridgeError::new(format!("Bad version json {id}: {e}")))
}

// Версия с родителем: аргументы и библиотеки складываются (свои первыми), остальное — своё или родителя
fn merge(child: Value, parent: Value) -> Value {
    let mut out = parent.as_object().cloned().unwrap_or_default();
    let child_map = child.as_object().cloned().unwrap_or_default();
    let mut libraries: Vec<Value> = child_map.get("libraries").and_then(Value::as_array).cloned().unwrap_or_default();
    libraries.extend(out.get("libraries").and_then(Value::as_array).cloned().unwrap_or_default());
    let mut arguments = out.get("arguments").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(child_args) = child_map.get("arguments").and_then(Value::as_object) {
        for kind in ["game", "jvm"] {
            let mut list = arguments.get(kind).and_then(Value::as_array).cloned().unwrap_or_default();
            list.extend(child_args.get(kind).and_then(Value::as_array).cloned().unwrap_or_default());
            arguments.insert(kind.into(), Value::Array(list));
        }
    }
    let parent_id = str_of(&parent, "id").unwrap_or("").to_string();
    for (key, value) in child_map {
        if !matches!(key.as_str(), "libraries" | "arguments" | "inheritsFrom") {
            out.insert(key, value);
        }
    }
    out.insert("libraries".into(), Value::Array(libraries));
    if !arguments.is_empty() {
        out.insert("arguments".into(), Value::Object(arguments));
    }
    // Клиентский jar — родителя, если у версии нет своего
    if !out.contains_key("jar") || out.get("jar").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) {
        out.insert("jar".into(), Value::String(parent_id));
    }
    Value::Object(out)
}

async fn resolve_version(root: &Path, id: &str, source: &str, events: &Events) -> Result<Value, BridgeError> {
    let mut chain = vec![read_or_fetch_version(root, id, None, source, events).await?];
    while let Some(parent) = chain.last().and_then(|v| str_of(v, "inheritsFrom")).map(str::to_string) {
        if chain.len() > 4 || chain.iter().any(|v| str_of(v, "id") == Some(parent.as_str())) {
            return Err(BridgeError::new("Version inheritance loop"));
        }
        chain.push(read_or_fetch_version(root, &parent, Some(id), source, events).await?);
    }
    let mut merged = chain.pop().unwrap();
    while let Some(child) = chain.pop() {
        merged = merge(child, merged);
    }
    Ok(merged)
}

// ---------- библиотеки ----------
struct Library {
    key: String,
    path: PathBuf,
    download: Option<Download>,
    natives: bool,
    exclude: Vec<String>,
}

fn library_key(name: &str) -> String {
    // group:artifact[:classifier] — одна библиотека на classpath (своя версия загрузчика важнее ванильной)
    let parts: Vec<&str> = name.split('@').next().unwrap_or("").split(':').collect();
    match parts.len() {
        0..=2 => name.to_string(),
        3 => format!("{}:{}", parts[0], parts[1]),
        _ => format!("{}:{}:{}", parts[0], parts[1], parts[3]),
    }
}

fn libraries(version: &Value, libraries_dir: &Path, features: &HashMap<String, bool>) -> Vec<Library> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for lib in version.get("libraries").and_then(Value::as_array).cloned().unwrap_or_default() {
        if !rules_allow(lib.get("rules"), features) {
            continue;
        }
        if lib.get("clientreq").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let name = str_of(&lib, "name").unwrap_or("").to_string();
        let exclude: Vec<String> = lib.get("extract").and_then(|e| e.get("exclude")).and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        // Старый формат нативных библиотек: natives.windows = "natives-windows[-${arch}]"
        if let Some(classifier) = lib.get("natives").and_then(|n| n.get("windows")).and_then(Value::as_str) {
            let classifier = classifier.replace("${arch}", if cfg!(target_pointer_width = "64") { "64" } else { "32" });
            let info = lib.get("downloads").and_then(|d| d.get("classifiers")).and_then(|c| c.get(&classifier));
            let relative = info.and_then(|i| str_of(i, "path")).map(str::to_string)
                .or_else(|| gamefiles::maven_path(&format!("{name}:{classifier}")));
            if let Some(relative) = relative {
                let path = libraries_dir.join(&relative);
                let url = info.and_then(|i| str_of(i, "url")).map(str::to_string)
                    .unwrap_or_else(|| format!("{}{relative}", str_of(&lib, "url").unwrap_or(gamefiles::LIBRARIES)));
                out.push(Library {
                    key: format!("{}:natives", library_key(&name)),
                    download: Some(Download { url, path: path.clone(), sha1: info.and_then(|i| str_of(i, "sha1")).map(str::to_string), size: info.and_then(|i| i.get("size")).and_then(Value::as_u64) }),
                    path,
                    natives: true,
                    exclude: exclude.clone(),
                });
            }
        }
        let artifact = lib.get("downloads").and_then(|d| d.get("artifact"));
        let has_classifiers_only = artifact.is_none() && lib.get("natives").is_some();
        if has_classifiers_only {
            continue;
        }
        let relative = artifact.and_then(|a| str_of(a, "path")).map(str::to_string).or_else(|| gamefiles::maven_path(&name));
        let Some(relative) = relative else { continue };
        let key = library_key(&name);
        if !name.is_empty() && !seen.insert(key.clone()) {
            continue;
        }
        let path = libraries_dir.join(&relative);
        let url = match artifact.and_then(|a| str_of(a, "url")) {
            Some(url) => url.to_string(),
            None => {
                let base = str_of(&lib, "url").unwrap_or(gamefiles::LIBRARIES);
                let base = base.replace("http://files.minecraftforge.net/maven/", "https://maven.minecraftforge.net/");
                format!("{}{}{relative}", base, if base.ends_with('/') { "" } else { "/" })
            }
        };
        let download = (!url.ends_with('/') && artifact.and_then(|a| str_of(a, "url")) != Some("")).then(|| Download {
            url,
            path: path.clone(),
            sha1: artifact.and_then(|a| str_of(a, "sha1")).or_else(|| str_of(&lib, "sha1")).map(str::to_string),
            size: artifact.and_then(|a| a.get("size")).or_else(|| lib.get("size")).and_then(Value::as_u64),
        });
        // Библиотеки вида :natives-windows (1.19+) идут в classpath и тоже распаковываются
        let natives = name.contains(":natives-windows");
        out.push(Library { key, path, download, natives, exclude });
    }
    out
}

// ---------- аргументы ----------
fn substitute(text: &str, values: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                match values.get(key) {
                    Some(value) => out.push_str(value),
                    None => {
                        out.push_str("${");
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn collect_args(list: Option<&Value>, features: &HashMap<String, bool>, values: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for item in list.and_then(Value::as_array).cloned().unwrap_or_default() {
        match &item {
            Value::String(text) => out.push(substitute(text, values)),
            Value::Object(_) => {
                if !rules_allow(item.get("rules"), features) {
                    continue;
                }
                match item.get("value") {
                    Some(Value::String(text)) => out.push(substitute(text, values)),
                    Some(Value::Array(texts)) => out.extend(texts.iter().filter_map(Value::as_str).map(|t| substitute(t, values))),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

fn memory_arg(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::Number(n)) => format!("{}M", n.as_u64().unwrap_or(2048)),
        Some(Value::String(s)) if s.chars().last().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) => s.clone(),
        Some(Value::String(s)) if !s.is_empty() => format!("{s}M"),
        _ => fallback.to_string(),
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|list| list.iter().filter_map(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }).collect()).unwrap_or_default()
}

// ---------- запуск ----------
pub async fn launch(app: &AppHandle, args: Value) -> BridgeResult {
    let id = args.get("launchId").and_then(Value::as_u64).unwrap_or(0);
    let events = Events { app: app.clone(), id };
    let config = args.get("config").cloned().unwrap_or(Value::Null);
    match prepare_and_spawn(app, &events, config).await {
        Ok(pid) => ok(json!({"pid": pid})),
        Err(error) => {
            events.debug(format!("Launch failed: {}", error.message));
            Err(error)
        }
    }
}

async fn prepare_and_spawn(app: &AppHandle, events: &Events, config: Value) -> Result<u32, BridgeError> {
    let state = app.state::<AppState>();
    let source = gamefiles::download_source(&state.user_data);
    let root = PathBuf::from(str_of(&config, "root").ok_or("Launch config has no root")?);
    let java = PathBuf::from(str_of(&config, "javaPath").ok_or("Launch config has no Java path")?);
    crate::scope::check(&root.to_string_lossy(), crate::scope::Access::Write, "launch")?;
    crate::scope::check(&java.to_string_lossy(), crate::scope::Access::Read, "launch")?;
    if !java.is_file() {
        return Err(BridgeError::new(format!("Java not found: {}", java.display())));
    }
    let version_cfg = config.get("version").cloned().unwrap_or(Value::Null);
    let number = str_of(&version_cfg, "number").unwrap_or("").to_string();
    let mut version_id = str_of(&version_cfg, "custom").filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| number.clone());

    // Forge/NeoForge: установщик ставит версию, дальше она запускается как обычная
    if let Some(installer) = str_of(&config, "forge").filter(|s| !s.is_empty()) {
        version_id = crate::loaders::install_forge(app, events_sink(events), &root, Path::new(installer), &java, &number).await?;
    }

    events.debug(format!("Preparing {version_id}"));
    let version = resolve_version(&root, &version_id, &source, events).await?;
    let overrides = config.get("overrides").cloned().unwrap_or(Value::Null);
    let game_dir = str_of(&overrides, "gameDirectory").map(PathBuf::from).unwrap_or_else(|| root.clone());
    crate::scope::check(&game_dir.to_string_lossy(), crate::scope::Access::Write, "launch")?;
    std::fs::create_dir_all(&game_dir).map_err(|e| crate::fsops::io_error(e, "mkdir", &game_dir.to_string_lossy(), None))?;
    let libraries_dir = root.join("libraries");
    let natives_dir = root.join("versions").join(&version_id).join("natives");
    let window = config.get("window").cloned().unwrap_or(Value::Null);
    let width = window.get("width").and_then(Value::as_u64);
    let height = window.get("height").and_then(Value::as_u64);
    let mut features: HashMap<String, bool> = HashMap::new();
    features.insert("is_demo_user".into(), false);
    features.insert("has_custom_resolution".into(), width.is_some() && height.is_some());

    // Клиентский jar
    let jar_id = str_of(&version, "jar").filter(|s| !s.is_empty()).unwrap_or(version_id.as_str()).to_string();
    let mut client_jar = root.join("versions").join(&jar_id).join(format!("{jar_id}.jar"));
    let mut downloads: Vec<Download> = Vec::new();
    if let Some(client) = version.get("downloads").and_then(|d| d.get("client")) {
        let mut item = Download {
            url: str_of(client, "url").unwrap_or("").to_string(),
            path: client_jar.clone(),
            sha1: str_of(client, "sha1").map(str::to_string),
            size: client.get("size").and_then(Value::as_u64),
        };
        // Раскладка версии на Electron: клиент лежал как versions/<сборка>/<сборка>.jar
        let legacy = root.join("versions").join(&version_id).join(format!("{version_id}.jar"));
        if !gamefiles::present(&item, true) && legacy != client_jar {
            let candidate = Download { path: legacy.clone(), ..item.clone() };
            if gamefiles::present(&candidate, true) {
                client_jar = legacy;
                item = candidate;
            }
        }
        if !gamefiles::present(&item, true) {
            events.emit("download-status", json!({"name": format!("{jar_id}.jar"), "type": "version-jar", "current": 0, "total": item.size.unwrap_or(0)}));
            gamefiles::fetch(&item, &source).await?;
            events.emit("download-status", json!({"name": format!("{jar_id}.jar"), "type": "version-jar", "current": item.size.unwrap_or(0), "total": item.size.unwrap_or(0)}));
        }
    }

    // Библиотеки
    let libs = libraries(&version, &libraries_dir, &features);
    downloads.extend(libs.iter().filter_map(|lib| lib.download.clone()).filter(|d| !gamefiles::present(d, false)));
    // Конфиг логов (защита от Log4Shell на старых версиях)
    let mut logging_arg: Option<String> = None;
    if let Some(logging) = version.get("logging").and_then(|l| l.get("client")) {
        if let (Some(file), Some(argument)) = (logging.get("file"), str_of(logging, "argument")) {
            let file_id = str_of(file, "id").unwrap_or("client.xml");
            if valid_id(file_id) {
                let path = root.join("assets").join("log_configs").join(file_id);
                let item = Download { url: str_of(file, "url").unwrap_or("").to_string(), path: path.clone(), sha1: str_of(file, "sha1").map(str::to_string), size: file.get("size").and_then(Value::as_u64) };
                if !gamefiles::present(&item, false) {
                    downloads.push(item);
                }
                logging_arg = Some(argument.replace("${path}", &path.to_string_lossy()));
            }
        }
    }
    if !downloads.is_empty() {
        events.debug(format!("Downloading {} libraries", downloads.len()));
        let sink = events_sink(events);
        gamefiles::fetch_all(downloads, &source, 16, move |task, total| sink("progress", json!({"type": "classes", "task": task, "total": total}))).await?;
    }

    // Нативные библиотеки
    std::fs::create_dir_all(&natives_dir).map_err(|e| crate::fsops::io_error(e, "mkdir", &natives_dir.to_string_lossy(), None))?;
    for lib in libs.iter().filter(|l| l.natives && l.path.is_file()) {
        if let Err(error) = gamefiles::extract_natives(&lib.path, &natives_dir, &lib.exclude) {
            events.debug(format!("Natives skipped: {}", error.message));
        }
    }

    // Ассеты
    let (assets_root, asset_index_id, game_assets) = prepare_assets(&root, &game_dir, &version, &version_id, &source, events).await?;

    // Classpath: библиотеки (без чисто нативных старого формата) + клиент
    let mut classpath: Vec<String> = libs.iter()
        .filter(|l| !(l.natives && l.key.ends_with(":natives")))
        .filter(|l| l.path.is_file())
        .map(|l| l.path.to_string_lossy().to_string())
        .collect();
    if client_jar.is_file() {
        classpath.push(client_jar.to_string_lossy().to_string());
    }
    let classpath = classpath.join(";");

    // Подстановки
    let auth = config.get("authorization").cloned().unwrap_or(Value::Null);
    let meta = auth.get("meta").cloned().unwrap_or(Value::Null);
    let user_properties = match auth.get("user_properties") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        Some(Value::Object(o)) => Value::Object(o.clone()).to_string(),
        _ => "{}".into(),
    };
    let launcher_version = app.package_info().version.to_string();
    let mut values: HashMap<&str, String> = HashMap::new();
    values.insert("auth_player_name", str_of(&auth, "name").unwrap_or("Player").to_string());
    values.insert("auth_uuid", str_of(&auth, "uuid").unwrap_or("").to_string());
    values.insert("auth_access_token", str_of(&auth, "access_token").unwrap_or("0").to_string());
    values.insert("auth_session", str_of(&auth, "access_token").unwrap_or("0").to_string());
    values.insert("auth_xuid", str_of(&meta, "xuid").unwrap_or("0").to_string());
    values.insert("clientid", str_of(&meta, "clientId").unwrap_or("0").to_string());
    values.insert("user_type", str_of(&meta, "type").unwrap_or("mojang").to_string());
    values.insert("user_properties", user_properties);
    values.insert("version_name", version_id.clone());
    values.insert("version_type", str_of(&version_cfg, "type").unwrap_or("release").to_string());
    values.insert("game_directory", game_dir.to_string_lossy().to_string());
    values.insert("assets_root", assets_root.to_string_lossy().to_string());
    values.insert("game_assets", game_assets.to_string_lossy().to_string());
    values.insert("assets_index_name", asset_index_id);
    values.insert("natives_directory", natives_dir.to_string_lossy().to_string());
    values.insert("library_directory", libraries_dir.to_string_lossy().to_string());
    values.insert("classpath_separator", ";".into());
    values.insert("classpath", classpath.clone());
    values.insert("launcher_name", "RxLauncher".into());
    values.insert("launcher_version", launcher_version);
    values.insert("resolution_width", width.unwrap_or(854).to_string());
    values.insert("resolution_height", height.unwrap_or(480).to_string());
    values.insert("primary_jar", client_jar.to_string_lossy().to_string());
    values.insert("version", number.clone());

    let memory = config.get("memory").cloned().unwrap_or(Value::Null);
    let mut jvm: Vec<String> = vec![format!("-Xmx{}", memory_arg(memory.get("max"), "2048M")), format!("-Xms{}", memory_arg(memory.get("min"), "1024M"))];
    match version.get("arguments").and_then(|a| a.get("jvm")) {
        Some(list) => jvm.extend(collect_args(Some(list), &features, &values)),
        None => {
            jvm.push("-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump".into());
            jvm.push(format!("-Djava.library.path={}", natives_dir.to_string_lossy()));
            jvm.push("-Dminecraft.launcher.brand=RxLauncher".into());
            jvm.push(format!("-Dminecraft.launcher.version={}", values["launcher_version"]));
            jvm.push("-cp".into());
            jvm.push(classpath.clone());
        }
    }
    if let Some(argument) = logging_arg {
        jvm.push(argument);
    }
    jvm.extend(string_list(config.get("customArgs")));
    let main_class = str_of(&version, "mainClass").ok_or("Version has no main class")?.to_string();
    let mut game: Vec<String> = match (version.get("arguments").and_then(|a| a.get("game")), str_of(&version, "minecraftArguments")) {
        (_, Some(legacy)) => legacy.split_whitespace().map(|part| substitute(part, &values)).collect(),
        (Some(list), None) => collect_args(Some(list), &features, &values),
        _ => Vec::new(),
    };
    if window.get("fullscreen").and_then(Value::as_bool) == Some(true) {
        game.push("--fullscreen".into());
    } else if !features["has_custom_resolution"] {
        if let (Some(w), Some(h)) = (width, height) {
            game.extend(["--width".into(), w.to_string(), "--height".into(), h.to_string()]);
        }
    }
    game.extend(string_list(config.get("customLaunchArgs")));

    let mut command_args = jvm;
    command_args.push(main_class);
    command_args.extend(game);
    events.emit("arguments", Value::Null);
    events.debug(format!("Launching {version_id} with Java {}", java.display()));

    let cwd = str_of(&overrides, "cwd").map(PathBuf::from).unwrap_or_else(|| root.clone());
    let mut command = tokio::process::Command::new(&java);
    command.args(&command_args).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| BridgeError::new(format!("Cannot start Java: {e}")))?;
    let pid = child.id().unwrap_or(0);
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
        let sink = events_sink(events);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            let mut log = Log4jText::default();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(text) = log.push(&line) {
                    sink("data", Value::String(text));
                }
            }
        });
    }
    let sink = events_sink(events);
    tauri::async_runtime::spawn(async move {
        let code = match child.wait().await {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        // Дать дочитать последние строки вывода
        tokio::time::sleep(Duration::from_millis(300)).await;
        sink("close", json!(code));
    });
    Ok(pid)
}

pub type Sink = std::sync::Arc<dyn Fn(&str, Value) + Send + Sync>;

// Конфиг логов из JSON версии (защита от Log4Shell) пишет события log4j в XML — как официальный лаунчер,
// превращаем их в обычные строки «[время] [поток/уровень]: сообщение»
#[cfg(test)]
pub type Log4jTextForTest = Log4jText;

#[derive(Default)]
pub struct Log4jText {
    event: Option<(String, String, String)>, // время, поток, уровень
    field: Option<&'static str>,
    message: String,
    throwable: String,
}

fn xml_attribute(line: &str, name: &str) -> String {
    let key = format!("{name}=\"");
    line.find(&key).map(|start| {
        let rest = &line[start + key.len()..];
        rest[..rest.find('"').unwrap_or(rest.len())].to_string()
    }).unwrap_or_default()
}

impl Log4jText {
    pub fn push(&mut self, line: &str) -> Option<String> {
        let trimmed = line.trim();
        if self.event.is_none() {
            if trimmed.starts_with("<log4j:Event") {
                let millis: i64 = xml_attribute(trimmed, "timestamp").parse().unwrap_or(0);
                let seconds = (millis / 1000).rem_euclid(86_400);
                // Время по часовому поясу системы: только смещение, без внешних зависимостей
                let offset = local_offset_seconds();
                let local = (seconds + offset).rem_euclid(86_400);
                let time = format!("{:02}:{:02}:{:02}", local / 3600, (local / 60) % 60, local % 60);
                self.event = Some((time, xml_attribute(trimmed, "thread"), xml_attribute(trimmed, "level")));
                self.message.clear();
                self.throwable.clear();
                return None;
            }
            return Some(format!("{line}\n"));
        }
        let mut rest = line.to_string();
        loop {
            if let Some(field) = self.field {
                match rest.find("]]>") {
                    Some(end) => {
                        let target = if field == "message" { &mut self.message } else { &mut self.throwable };
                        target.push_str(&rest[..end]);
                        self.field = None;
                        rest = rest[end + 3..].to_string();
                    }
                    None => {
                        let target = if field == "message" { &mut self.message } else { &mut self.throwable };
                        target.push_str(&rest);
                        target.push('\n');
                        return None;
                    }
                }
            } else if let Some(start) = rest.find("<log4j:Message><![CDATA[") {
                self.field = Some("message");
                rest = rest[start + "<log4j:Message><![CDATA[".len()..].to_string();
            } else if let Some(start) = rest.find("<log4j:Throwable><![CDATA[") {
                self.field = Some("throwable");
                rest = rest[start + "<log4j:Throwable><![CDATA[".len()..].to_string();
            } else if rest.contains("</log4j:Event>") {
                let (time, thread, level) = self.event.take().unwrap_or_default();
                let mut text = format!("[{time}] [{thread}/{level}]: {}\n", self.message.trim_end());
                if !self.throwable.trim().is_empty() {
                    text.push_str(self.throwable.trim_end());
                    text.push('\n');
                }
                return Some(text);
            } else {
                return None;
            }
        }
    }
}

#[cfg(windows)]
fn local_offset_seconds() -> i64 {
    use std::sync::OnceLock;
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        #[repr(C)]
        struct SystemTime { year: u16, month: u16, dow: u16, day: u16, hour: u16, minute: u16, second: u16, ms: u16 }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLocalTime(time: *mut SystemTime);
            fn GetSystemTime(time: *mut SystemTime);
        }
        let mut local = SystemTime { year: 0, month: 0, dow: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };
        let mut utc = SystemTime { year: 0, month: 0, dow: 0, day: 0, hour: 0, minute: 0, second: 0, ms: 0 };
        unsafe {
            GetLocalTime(&mut local);
            GetSystemTime(&mut utc);
        }
        let to_minutes = |t: &SystemTime| (t.day as i64) * 1440 + (t.hour as i64) * 60 + t.minute as i64;
        let mut diff = to_minutes(&local) - to_minutes(&utc);
        // Переход через границу месяца
        if diff > 14 * 60 { diff -= 1440 * ((diff + 720) / 1440); }
        if diff < -14 * 60 { diff += 1440 * ((-diff + 720) / 1440); }
        diff * 60
    })
}

#[cfg(not(windows))]
fn local_offset_seconds() -> i64 {
    0
}

pub fn events_sink(events: &Events) -> Sink {
    let app = events.app.clone();
    let id = events.id;
    std::sync::Arc::new(move |event: &str, data: Value| {
        let _ = app.emit("rx:game", json!({"id": id, "event": event, "data": data}));
    })
}

async fn prepare_assets(root: &Path, game_dir: &Path, version: &Value, version_id: &str, source: &str, events: &Events) -> Result<(PathBuf, String, PathBuf), BridgeError> {
    let assets_root = root.join("assets");
    let Some(index) = version.get("assetIndex") else {
        return Ok((assets_root.clone(), str_of(version, "assets").unwrap_or("legacy").to_string(), assets_root));
    };
    let index_id = str_of(index, "id").unwrap_or("legacy").to_string();
    if !valid_id(&index_id) {
        return Err(BridgeError::new("Invalid asset index id"));
    }
    let mut index_path = assets_root.join("indexes").join(format!("{index_id}.json"));
    // Имя индекса, которое получит игра (--assetIndex): она сама открывает indexes/<имя>.json
    let mut index_name = index_id.clone();
    let index_item = Download { url: str_of(index, "url").unwrap_or("").to_string(), path: index_path.clone(), sha1: str_of(index, "sha1").map(str::to_string), size: index.get("size").and_then(Value::as_u64) };
    if !gamefiles::present(&index_item, true) {
        // Версия на Electron называла индекс по имени сборки (fabric-1.21.4.json). Игре нужен файл
        // под тем же именем, что и в --assetIndex, иначе она стартует без языков, звуков и фона меню
        let legacy = Download { path: assets_root.join("indexes").join(format!("{version_id}.json")), ..index_item.clone() };
        if valid_id(version_id) && gamefiles::present(&legacy, true) {
            if std::fs::copy(&legacy.path, &index_path).is_err() {
                index_path = legacy.path;
                index_name = version_id.to_string();
            }
        } else {
            gamefiles::fetch(&index_item, source).await?;
        }
    }
    let data: Value = serde_json::from_slice(&std::fs::read(&index_path).map_err(|e| crate::fsops::io_error(e, "open", &index_path.to_string_lossy(), None))?)
        .map_err(|e| BridgeError::new(format!("Bad asset index: {e}")))?;
    let objects: Map<String, Value> = data.get("objects").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut missing = Vec::new();
    for object in objects.values() {
        let Some(hash) = str_of(object, "hash").filter(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit())) else { continue };
        let item = Download {
            url: format!("{}{}/{hash}", gamefiles::RESOURCES, &hash[..2]),
            path: assets_root.join("objects").join(&hash[..2]).join(hash),
            sha1: Some(hash.to_string()),
            size: object.get("size").and_then(Value::as_u64),
        };
        if !gamefiles::present(&item, false) {
            missing.push(item);
        }
    }
    if !missing.is_empty() {
        events.debug(format!("Downloading {} assets", missing.len()));
        let sink = events_sink(events);
        gamefiles::fetch_all(missing, source, 16, move |task, total| sink("progress", json!({"type": "assets", "task": task, "total": total}))).await?;
    }
    // Очень старые версии: ассеты по именам (virtual) или в папке resources игры (map_to_resources)
    let virtual_assets = data.get("virtual").and_then(Value::as_bool).unwrap_or(false);
    let map_to_resources = data.get("map_to_resources").and_then(Value::as_bool).unwrap_or(false);
    let mut game_assets = assets_root.clone();
    if virtual_assets || map_to_resources {
        let target = if map_to_resources { game_dir.join("resources") } else { assets_root.join("virtual").join(&index_id) };
        for (name, object) in &objects {
            let Some(hash) = str_of(object, "hash").filter(|h| h.len() == 40) else { continue };
            if name.split(['/', '\\']).any(|part| part == ".." || part.is_empty()) {
                continue;
            }
            let out = target.join(name);
            if out.exists() {
                continue;
            }
            if let Some(parent) = out.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(assets_root.join("objects").join(&hash[..2]).join(hash), &out);
        }
        game_assets = target;
    }
    Ok((assets_root, index_name, game_assets))
}
