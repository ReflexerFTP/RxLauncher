// Загрузчики модов (замена tomate-loaders и pinnedLoader.js): конфиг запуска для vanilla/custom/fabric/quilt/forge/neoforge
// и установка Forge/NeoForge. Fabric и Quilt — профиль с meta-сервера; Forge — рекомендованная сборка
// (promotions_slim.json), NeoForge — самая новая стабильная. Без сети — то, что уже установлено
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use sha1::Digest;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::bridge::{ok, BridgeError, BridgeResult};
use crate::game::Sink;

fn valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'))
}

// Имя своей версии — это имя папки в versions/. TLauncher и другие лаунчеры называют их «Fabric 1.21.4»,
// «OptiFine 1.20.1 (HD U I6)»: пробелы и скобки допустимы, пути и запрещённые Windows символы — нет
pub fn valid_folder_name(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 80 && value != "." && value != ".."
        && !value.starts_with([' ', '.']) && !value.ends_with([' ', '.'])
        && !value.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

// Ошибка с кодом: интерфейс по нему объясняет игроку, что случилось
fn fail(code: &str, message: impl Into<String>) -> BridgeError {
    BridgeError::code(message, code)
}

fn atomic_write(file: &Path, data: &[u8]) -> Result<(), BridgeError> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::fsops::io_error(e, "mkdir", &parent.to_string_lossy(), None))?;
    }
    let temp = file.with_extension(format!("{:08x}.tmp", rand::random::<u32>()));
    std::fs::write(&temp, data).map_err(|e| crate::fsops::io_error(e, "write", &temp.to_string_lossy(), None))?;
    std::fs::rename(&temp, file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        crate::fsops::io_error(e, "rename", &file.to_string_lossy(), None)
    })
}

async fn get(url: &str, max: u64) -> Result<Vec<u8>, BridgeError> {
    crate::http::get_bytes(url, Duration::from_secs(45), max).await
}

async fn get_json(url: &str) -> Result<Value, BridgeError> {
    serde_json::from_slice(&get(url, 16 * 1024 * 1024).await?).map_err(|e| BridgeError::new(format!("Bad loader metadata from {url}: {e}")))
}

fn release(number: &str, root: &Path, custom: Option<&str>) -> Value {
    let mut version = json!({"number": number, "type": "release"});
    if let Some(custom) = custom {
        version["custom"] = Value::String(custom.to_string());
    }
    json!({"root": root, "version": version})
}

fn folder_type(kind: &str) -> &str {
    if kind == "forgeOptiFine" { "forge" } else { kind }
}

// Уже установленная версия загрузчика — без сети. pinned — закреплённая версия загрузчика (у сборок)
pub(crate) fn local_config(kind: &str, version: &str, pinned: Option<&str>, root: &Path) -> Option<Value> {
    let folder = folder_type(kind);
    let (id, runtime_root) = match pinned {
        Some(pin) if folder == "fabric" || folder == "quilt" => (format!("{folder}-{version}-{pin}"), root.to_path_buf()),
        Some(pin) => {
            let id = format!("{folder}-{version}-{pin}");
            let runtime_root = root.join("loader-runtimes").join(&id);
            (id, runtime_root)
        }
        None => (format!("{folder}-{version}"), root.to_path_buf()),
    };
    let dir = runtime_root.join("versions").join(&id);
    if folder == "fabric" || folder == "quilt" {
        return dir.join(format!("{id}.json")).is_file().then(|| release(version, &runtime_root, Some(&id)));
    }
    let installer = dir.join(format!("{folder}.jar"));
    installer.is_file().then(|| {
        let mut config = release(version, &runtime_root, Some(&id));
        config["forge"] = Value::String(installer.to_string_lossy().to_string());
        config["clientPackage"] = Value::Null;
        config
    })
}

// Fabric/Quilt нужной версии игры, установленный как угодно (другая версия загрузчика, профиль официального
// лаунчера или TLauncher): versions/<id>/<id>.json, наследуется от этой версии игры и содержит загрузчик.
// Сначала — с той же версией загрузчика, что просили, потом — самая новая из установленных
pub(crate) fn any_installed_fabric(loader: &str, version: &str, wanted: Option<&str>, root: &Path) -> Option<Value> {
    let coordinate = coordinate(loader);
    let mut found: Vec<(String, String)> = Vec::new(); // (id, версия загрузчика)
    for entry in std::fs::read_dir(root.join("versions")).ok()?.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if !valid_folder_name(&id) {
            continue;
        }
        let Some(profile) = std::fs::read(entry.path().join(format!("{id}.json"))).ok().filter(|b| b.len() <= 4 * 1024 * 1024)
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { continue };
        if profile.get("inheritsFrom").and_then(Value::as_str) != Some(version) {
            continue;
        }
        let loader_version = profile.get("libraries").and_then(Value::as_array).and_then(|libs| libs.iter()
            .filter_map(|l| l.get("name").and_then(Value::as_str))
            .find_map(|name| name.strip_prefix(coordinate).map(str::to_string)));
        if let Some(loader_version) = loader_version {
            found.push((id, loader_version));
        }
    }
    let pick = wanted.and_then(|w| found.iter().find(|(_, v)| v == w)).or_else(|| found.iter().max_by_key(|(_, v)| version_key(v)))?;
    Some(release(version, root, Some(&pick.0)))
}

// Своя версия: versions/<имя>/<имя>.json; с inheritsFrom — поверх базовой.
// Если файл назван не по имени папки (переименовали папку), берётся единственный подходящий .json из неё и
// копируется под правильное имя — версия чинится сама
fn custom_manifest(name: &str, root: &Path) -> Result<serde_json::Map<String, Value>, BridgeError> {
    let dir = root.join("versions").join(name);
    let read = |path: &Path| -> Option<serde_json::Map<String, Value>> {
        let bytes = std::fs::read(path).ok().filter(|b| b.len() <= 16 * 1024 * 1024)?;
        match serde_json::from_slice::<Value>(&bytes).ok()? {
            Value::Object(map) if map.get("inheritsFrom").is_some() || map.get("mainClass").is_some() => Some(map),
            _ => None,
        }
    };
    let expected = dir.join(format!("{name}.json"));
    if let Some(manifest) = read(&expected) {
        return Ok(manifest);
    }
    if !dir.is_dir() {
        return Err(fail("version_missing", format!("Version folder not found: {name}")));
    }
    let candidates: Vec<(PathBuf, serde_json::Map<String, Value>)> = std::fs::read_dir(&dir).map(|entries| {
        entries.flatten().map(|e| e.path())
            .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("json")).unwrap_or(false))
            .filter_map(|p| read(&p).map(|m| (p, m))).collect()
    }).unwrap_or_default();
    match candidates.as_slice() {
        [(path, manifest)] => {
            let mut fixed = manifest.clone();
            fixed.insert("id".into(), Value::String(name.to_string()));
            atomic_write(&expected, &serde_json::to_vec_pretty(&Value::Object(fixed.clone())).unwrap_or_default())?;
            // Jar той же версии — тоже под имя папки (иначе игра не найдёт свою сборку клиента)
            let jar = path.with_extension("jar");
            let expected_jar = dir.join(format!("{name}.jar"));
            if jar.is_file() && !expected_jar.exists() {
                let _ = std::fs::copy(&jar, &expected_jar);
            }
            crate::logs::write("info", &format!("Version {name}: manifest restored from {}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
            Ok(fixed)
        }
        _ => Err(fail("version_missing", format!("Version manifest not found or broken: {name}"))),
    }
}

pub(crate) fn custom_config(name: &str, root: &Path) -> Result<Value, BridgeError> {
    if !valid_folder_name(name) {
        return Err(fail("version_name", format!("Unsupported version name: {name}")));
    }
    let manifest = custom_manifest(name, root)?;
    let kind = manifest.get("type").and_then(Value::as_str).filter(|t| matches!(*t, "release" | "snapshot" | "old_alpha" | "old_beta")).unwrap_or("release");
    match manifest.get("inheritsFrom").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(parent) if valid_folder_name(parent) => Ok(json!({"root": root, "version": {"number": parent, "type": kind, "custom": name}})),
        Some(parent) => Err(fail("version_name", format!("Unsupported parent version name: {parent}"))),
        None => Ok(json!({"root": root, "version": {"number": name, "type": kind}})),
    }
}

fn meta_base(loader: &str) -> &'static str {
    if loader == "fabric" { "https://meta.fabricmc.net/v2" } else { "https://meta.quiltmc.org/v3" }
}

fn coordinate(loader: &str) -> &'static str {
    if loader == "fabric" { "net.fabricmc:fabric-loader:" } else { "org.quiltmc:quilt-loader:" }
}

async fn fabric_like(loader: &str, version: &str, pinned: Option<&str>, root: &Path) -> Result<Value, BridgeError> {
    let base = meta_base(loader);
    // Закреплённая версия — своя папка (как pinnedLoader.js), обычная — <загрузчик>-<игра>
    let id = match pinned {
        Some(v) => format!("{loader}-{version}-{v}"),
        None => format!("{loader}-{version}"),
    };
    let loader_version = match pinned {
        Some(v) => v.to_string(),
        None => {
            let list = get_json(&format!("{base}/versions/loader")).await?;
            let list = list.as_array().cloned().unwrap_or_default();
            let pick = list.iter().find(|l| l.get("stable").and_then(Value::as_bool) == Some(true)).or_else(|| list.first());
            pick.and_then(|l| l.get("version")).and_then(Value::as_str).ok_or_else(|| BridgeError::new("No loader versions"))?.to_string()
        }
    };
    let mut profile = get_json(&format!("{base}/versions/loader/{version}/{loader_version}/profile/json")).await?;
    let matches = profile.get("inheritsFrom").and_then(Value::as_str) == Some(version)
        && profile.get("libraries").and_then(Value::as_array).map(|libs| libs.iter().any(|l| l.get("name").and_then(Value::as_str) == Some(&format!("{}{loader_version}", coordinate(loader))))).unwrap_or(false);
    if !matches {
        return Err(BridgeError::new("Loader profile does not match the requested version"));
    }
    profile["id"] = Value::String(id.clone());
    atomic_write(&root.join("versions").join(&id).join(format!("{id}.json")), &serde_json::to_vec(&profile).unwrap_or_default())?;
    Ok(release(version, root, Some(&id)))
}

fn xml_versions(xml: &str) -> Vec<String> {
    xml.split("<version>").skip(1).filter_map(|part| part.split("</version>").next()).map(str::trim).map(str::to_string).collect()
}

fn version_key(value: &str) -> Vec<u64> {
    value.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).map(|s| s.parse().unwrap_or(0)).collect()
}

// Номер сборки Forge/NeoForge для версии игры
async fn forge_artifact(loader: &str, version: &str) -> Result<String, BridgeError> {
    if loader == "forge" {
        if let Ok(promos) = get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json").await {
            let promos = promos.get("promos").cloned().unwrap_or(Value::Null);
            if let Some(build) = promos.get(format!("{version}-recommended")).or_else(|| promos.get(format!("{version}-latest"))).and_then(Value::as_str) {
                return Ok(format!("{version}-{build}"));
            }
        }
        let xml = String::from_utf8_lossy(&get("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml", 8 * 1024 * 1024).await?).to_string();
        let prefix = format!("{version}-");
        return xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).max_by_key(|v| version_key(&v[prefix.len()..]))
            .ok_or_else(|| BridgeError::new(format!("Forge is not available for {version}")));
    }
    // NeoForge: 1.21.1 → 21.1.x, 1.21 → 21.0.x
    let parts: Vec<&str> = version.split('.').collect();
    let prefix = format!("{}.{}.", parts.get(1).unwrap_or(&"0"), parts.get(2).unwrap_or(&"0"));
    let xml = String::from_utf8_lossy(&get("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml", 8 * 1024 * 1024).await?).to_string();
    let candidates: Vec<String> = xml_versions(&xml).into_iter().filter(|v| v.starts_with(&prefix)).collect();
    let stable: Vec<&String> = candidates.iter().filter(|v| !v.contains("beta") && !v.contains("alpha")).collect();
    let pool: Vec<&String> = if stable.is_empty() { candidates.iter().collect() } else { stable };
    pool.into_iter().max_by_key(|v| version_key(v)).cloned().ok_or_else(|| BridgeError::new(format!("NeoForge is not available for {version}")))
}

// Установщик Forge/NeoForge с проверкой SHA-1 (контрольная сумма с того же maven)
async fn forge_installer(loader: &str, version: &str, artifact: &str, dir: &Path) -> Result<PathBuf, BridgeError> {
    let base = if loader == "forge" { "https://maven.minecraftforge.net/net/minecraftforge/forge" } else { "https://maven.neoforged.net/releases/net/neoforged/neoforge" };
    let url = format!("{base}/{artifact}/{loader}-{artifact}-installer.jar");
    let file = dir.join(format!("{loader}.jar"));
    let receipt = dir.join("installer.sha1");
    let hash = |bytes: &[u8]| hex::encode(sha1::Sha1::digest(bytes));
    if let (Ok(expected), Ok(bytes)) = (std::fs::read_to_string(&receipt), std::fs::read(&file)) {
        let expected = expected.trim().to_lowercase();
        let artifact_ok = std::fs::read_to_string(dir.join("installer.artifact")).map(|a| a.trim() == artifact).unwrap_or(true);
        if expected.len() == 40 && hash(&bytes) == expected && artifact_ok {
            return Ok(file);
        }
    }
    let expected = String::from_utf8_lossy(&get(&format!("{url}.sha1"), 1024).await?).split_whitespace().next().unwrap_or("").to_lowercase();
    if expected.len() != 40 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(BridgeError::new("Invalid loader checksum"));
    }
    let bytes = get(&url, 64 * 1024 * 1024).await?;
    if bytes.len() < 4 || bytes[..4] != [0x50, 0x4b, 0x03, 0x04] || hash(&bytes) != expected {
        return Err(BridgeError::new("Loader installer checksum mismatch"));
    }
    atomic_write(&file, &bytes)?;
    atomic_write(&receipt, expected.as_bytes())?;
    atomic_write(&dir.join("installer.artifact"), artifact.as_bytes())?;
    let _ = version;
    Ok(file)
}

async fn forge_like(kind: &str, version: &str, loader_version: Option<&str>, root: &Path) -> Result<Value, BridgeError> {
    let loader = folder_type(kind);
    let (artifact, id, runtime_root) = match loader_version {
        Some(pinned) => {
            let artifact = if loader == "forge" { format!("{version}-{pinned}") } else { pinned.to_string() };
            let id = format!("{loader}-{version}-{pinned}");
            // Закреплённые сборки — в своей папке, чтобы разные версии загрузчика не мешали друг другу
            (artifact, id.clone(), root.join("loader-runtimes").join(&id))
        }
        None => (forge_artifact(loader, version).await?, format!("{loader}-{version}"), root.to_path_buf()),
    };
    let dir = runtime_root.join("versions").join(&id);
    let installer = forge_installer(loader, version, &artifact, &dir).await?;
    let mut config = release(version, &runtime_root, Some(&id));
    config["forge"] = Value::String(installer.to_string_lossy().to_string());
    config["clientPackage"] = Value::Null;
    Ok(config)
}

// generate-mclc-config из интерфейса
pub async fn generate_config(input: Value) -> BridgeResult {
    let kind = input.get("type").and_then(Value::as_str).unwrap_or("");
    let version = input.get("version").and_then(Value::as_str).unwrap_or("");
    let loader_version = input.get("loaderVersion").and_then(Value::as_str).filter(|s| !s.is_empty());
    let game_data = input.get("gameData").and_then(Value::as_str).unwrap_or("");
    let version_ok = if kind == "custom" { valid_folder_name(version) } else { valid(version) };
    if !["vanilla", "custom", "forge", "forgeOptiFine", "neoforge", "fabric", "quilt"].contains(&kind) || !version_ok
        || loader_version.map(|v| !valid(v)).unwrap_or(false) || game_data.is_empty() || !Path::new(game_data).is_absolute() || game_data.contains("..") {
        crate::logs::write("warn", &format!("Loader config rejected: type={kind} version={version} loader={loader_version:?}"));
        return Err(fail(if version_ok { "bad_request" } else { "version_name" }, format!("Unsupported launch request: {kind} {version}")));
    }
    let root = PathBuf::from(game_data);
    match kind {
        "vanilla" => return ok(json!({"version": {"type": "release", "number": version}, "root": root})),
        "custom" => {
            return custom_config(version, &root).map(|config| (config, None)).map_err(|error| {
                crate::logs::write("warn", &format!("Custom version {version}: {}", error.message));
                error
            })
        }
        _ => {}
    }
    // Закреплённая версия загрузчика уже установлена — она не меняется, сеть не нужна
    if loader_version.is_some() {
        if let Some(local) = local_config(kind, version, loader_version, &root) {
            crate::logs::write("info", &format!("Loader config {kind}-{version}-{}: installed, no network needed", loader_version.unwrap_or("")));
            return ok(local);
        }
    }
    let online = async {
        match folder_type(kind) {
            "fabric" | "quilt" => fabric_like(folder_type(kind), version, loader_version, &root).await,
            _ => forge_like(kind, version, loader_version, &root).await,
        }
    };
    // Если версия уже установлена — при недоступной сети запускаем её с диска.
    // Для закреплённой версии, которой нет на диске, запасной вариант — любая установленная версия того же загрузчика
    let offline = input.get("offline").and_then(Value::as_bool).unwrap_or(false);
    let fabric_like_kind = matches!(folder_type(kind), "fabric" | "quilt");
    let local = local_config(kind, version, None, &root)
        .filter(|_| loader_version.is_none() || offline)
        .or_else(|| fabric_like_kind.then(|| any_installed_fabric(folder_type(kind), version, loader_version, &root)).flatten());
    // Офлайн-режим: интернета нет — не ждём серверов загрузчиков
    if offline {
        if let Some(local) = local {
            crate::logs::write("info", &format!("Loader config {kind}-{version}: offline, using installed files"));
            return ok(local);
        }
    }
    let limit = Duration::from_secs(if local.is_some() { 8 } else { 90 });
    let error = match tokio::time::timeout(limit, online).await {
        Ok(Ok(config)) => return ok(config),
        Ok(Err(error)) => error,
        Err(_) => fail("loader_offline", format!("Loader servers did not answer in {} s", limit.as_secs())),
    };
    crate::logs::write("warn", &format!("Loader config {kind}-{version} failed: {} (local={})", error.message, local.is_some()));
    match local {
        Some(local) => {
            crate::logs::write("info", &format!("Loader config {kind}-{version}: using installed loader {}", local["version"]["custom"].as_str().unwrap_or("")));
            ok(local)
        }
        // Нет ни сети, ни установленной версии
        None => Err(fail("loader_offline", error.message)),
    }
}

// ---------- установка Forge/NeoForge перед запуском: возвращает id установленной версии ----------
fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let mut entry = archive.by_name(name).ok()?;
    let mut data = Vec::new();
    entry.read_to_end(&mut data).ok()?;
    Some(data)
}

pub async fn install_forge(_app: &AppHandle, sink: Sink, root: &Path, installer: &Path, java: &Path, mc_version: &str) -> Result<String, BridgeError> {
    let file = std::fs::File::open(installer).map_err(|e| crate::fsops::io_error(e, "open", &installer.to_string_lossy(), None))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| BridgeError::new(format!("Broken loader installer: {e}")))?;
    let profile: Value = read_entry(&mut archive, "install_profile.json").and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| BridgeError::new("Loader installer has no install_profile.json"))?;
    let installer_sha1 = crate::gamefiles::sha1_file(installer).unwrap_or_default();

    // Старый формат (1.12.2 и раньше): versionInfo + универсальный jar внутри установщика
    if let Some(info) = profile.get("versionInfo") {
        let id = info.get("id").and_then(Value::as_str).filter(|id| !id.contains(['/', '\\', ':'])).ok_or("Bad legacy Forge profile")?.to_string();
        let mut info = info.clone();
        if info.get("inheritsFrom").is_none() {
            info["inheritsFrom"] = Value::String(mc_version.to_string());
        }
        if info.get("jar").is_none() {
            info["jar"] = Value::String(mc_version.to_string());
        }
        let install = profile.get("install").cloned().unwrap_or(Value::Null);
        if let (Some(entry), Some(coords)) = (install.get("filePath").and_then(Value::as_str), install.get("path").and_then(Value::as_str)) {
            if let (Some(relative), Some(data)) = (crate::gamefiles::maven_path(coords), read_entry(&mut archive, entry)) {
                atomic_write(&root.join("libraries").join(relative), &data)?;
            }
        }
        atomic_write(&root.join("versions").join(&id).join(format!("{id}.json")), &serde_json::to_vec_pretty(&info).unwrap_or_default())?;
        return Ok(id);
    }

    // Современный формат: id из version.json, установка самим установщиком в тихом режиме
    let version: Value = read_entry(&mut archive, "version.json").and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| BridgeError::new("Loader installer has no version.json"))?;
    drop(archive);
    let id = version.get("id").and_then(Value::as_str).filter(|id| !id.contains(['/', '\\', ':']) && !id.is_empty()).ok_or("Bad loader version id")?.to_string();
    let version_dir = root.join("versions").join(&id);
    let marker = version_dir.join(".rx-installed");
    if version_dir.join(format!("{id}.json")).is_file() && std::fs::read_to_string(&marker).map(|m| m.trim() == installer_sha1).unwrap_or(false) {
        return Ok(id);
    }
    // Установщику нужен профиль официального лаунчера в папке игры
    let profiles = root.join("launcher_profiles.json");
    if !profiles.exists() {
        atomic_write(&profiles, br#"{"profiles":{},"settings":{},"version":3}"#)?;
    }
    sink("debug", Value::String(format!("[RxCore]: Installing {id} (this can take a few minutes on the first launch)")));
    let mut command = tokio::process::Command::new(java);
    command.arg("-jar").arg(installer).arg("--installClient").arg(root).current_dir(root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|e| BridgeError::new(format!("Cannot start the loader installer: {e}")))?;
    let mut tail: Vec<String> = Vec::new();
    let mut readers = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
        let sink = sink.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            let mut last = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                sink("debug", Value::String(format!("[Installer]: {line}")));
                last.push(line);
                if last.len() > 20 {
                    last.remove(0);
                }
            }
            last
        }));
    }
    let status = tokio::time::timeout(Duration::from_secs(20 * 60), child.wait()).await
        .map_err(|_| BridgeError::new("Loader installation timed out"))?
        .map_err(|e| BridgeError::new(e.to_string()))?;
    for reader in readers {
        if let Ok(lines) = reader.await {
            tail.extend(lines);
        }
    }
    if !status.success() || !version_dir.join(format!("{id}.json")).is_file() {
        return Err(BridgeError::new(format!("Loader installation failed ({status}): {}", tail.join(" | "))));
    }
    atomic_write(&marker, installer_sha1.as_bytes())?;
    Ok(id)
}
