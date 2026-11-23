// Horizon — Minecraft Java Edition, переписанный на Rust (github.com/horizon-rust/horizon). Лаунчер запускает его
// по Launch API проекта (docs/api/launch.md, launch-guide.md):
//   1. сборка — архив релиза nightly; список SHA256SUMS подписан Ed25519 ключом проекта, архив сверяется по нему;
//   2. файлы ванильной версии (JSON, клиент, библиотеки, ассеты) и серверный jar — с серверов Mojang, как для обычной игры;
//   3. horizon-prepare собирает из них ресурсы (один раз на сборку, дальше --check);
//   4. horizon-client получает аккаунт JSON-ом через stdin, вывод и выход — те же события rx:game, что у Java.
// Всё лежит в <папка игры>/horizon: builds/<sha256[..16]>/ — сборки (текущая и предыдущая), prepared/ — ресурсы,
// game/ — миры, настройки и логи, server-<версия>.jar
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::bridge::{arg_str, ok, BridgeError, BridgeResult};
use crate::game::Events;
use crate::gamefiles::{self, Download};
use crate::state::AppState;

const RELEASE: &str = "https://github.com/horizon-rust/horizon/releases/download/nightly/";
// Подпись — над «horizon release nightly\n» + SHA256SUMS (тег в тексте: подпись не переносится на другой релиз)
const SIGNED_PREFIX: &str = "horizon release nightly\n";
// crates/horizon-release-sign/release-keys.txt
const RELEASE_KEYS: [&str; 1] = ["MU4oiIQcCxkZvbwSjjXs7SySCuM6ywRQ3nGaJYZG0gw="];
const MARKER: &str = ".rx-build.json";

static CANCEL: AtomicBool = AtomicBool::new(false);

fn asset_name() -> &'static str {
    if cfg!(target_arch = "aarch64") { "horizon-windows-arm64.zip" } else { "horizon-windows-x64.zip" }
}

fn io_error(error: std::io::Error, op: &str, path: &Path) -> BridgeError {
    crate::fsops::io_error(error, op, &path.to_string_lossy(), None)
}

fn cancelled_error() -> BridgeError {
    BridgeError::code("Launch cancelled", "ECANCELED")
}

async fn cancelled() {
    while !CANCEL.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

pub fn cancel() -> BridgeResult {
    CANCEL.store(true, Ordering::SeqCst);
    ok(Value::Null)
}

fn progress(app: &AppHandle, data: Value) {
    let _ = app.emit("rx:horizon", data);
}

// ---------- сборка ----------
pub fn verify_sums(sums: &[u8], signature: &str) -> Result<(), BridgeError> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let signature: [u8; 64] = engine.decode(signature.trim()).ok().and_then(|bytes| bytes.try_into().ok())
        .ok_or("Horizon release signature is malformed")?;
    let mut message = SIGNED_PREFIX.as_bytes().to_vec();
    message.extend_from_slice(sums);
    for key in RELEASE_KEYS {
        let Some(bytes) = engine.decode(key).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else { continue };
        let Ok(key) = VerifyingKey::from_bytes(&bytes) else { continue };
        if key.verify(&message, &Signature::from_bytes(&signature)).is_ok() {
            return Ok(());
        }
    }
    Err(BridgeError::new("Horizon release signature is invalid"))
}

// Строка «<sha256>  <файл>» из SHA256SUMS
pub fn sum_for(sums: &[u8], name: &str) -> Option<String> {
    String::from_utf8_lossy(sums).lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_lowercase())
    })
}

async fn latest_sha() -> Result<String, BridgeError> {
    let sums = crate::http::get_bytes(&format!("{RELEASE}SHA256SUMS"), Duration::from_secs(30), 1024 * 1024).await?;
    let signature = crate::http::get_bytes(&format!("{RELEASE}SHA256SUMS.sig"), Duration::from_secs(30), 4096).await?;
    verify_sums(&sums, &String::from_utf8_lossy(&signature))?;
    sum_for(&sums, asset_name()).ok_or_else(|| BridgeError::new(format!("{} is missing from the Horizon release", asset_name())))
}

struct Build {
    dir: PathBuf,
    sha: String,
    at: u64,
}

fn installed_builds(builds: &Path) -> Vec<Build> {
    let mut list: Vec<Build> = std::fs::read_dir(builds).into_iter().flatten().flatten().filter_map(|entry| {
        let dir = entry.path();
        let marker: Value = serde_json::from_slice(&std::fs::read(dir.join(MARKER)).ok()?).ok()?;
        Some(Build { sha: marker.get("sha256")?.as_str()?.to_string(), at: marker.get("installedAt").and_then(Value::as_u64).unwrap_or(0), dir })
    }).filter(|build| client_dir(&build.dir).is_some()).collect();
    list.sort_by(|a, b| b.at.cmp(&a.at));
    list
}

// Папка с horizon-client.exe: сама сборка или единственная папка внутри архива (horizon-windows-x64/)
fn client_dir(build: &Path) -> Option<PathBuf> {
    if build.join("horizon-client.exe").is_file() {
        return Some(build.to_path_buf());
    }
    std::fs::read_dir(build).ok()?.flatten().map(|e| e.path()).find(|p| p.join("horizon-client.exe").is_file())
}

fn sha256_file(path: &Path) -> Result<String, BridgeError> {
    let mut file = std::fs::File::open(path).map_err(|e| io_error(e, "open", path))?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| io_error(e, "read", path))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn download_build(app: &AppHandle, dir: &Path, sha: &str) -> Result<PathBuf, BridgeError> {
    let url = format!("{RELEASE}{}", asset_name());
    let downloads = dir.join("downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| io_error(e, "mkdir", &downloads))?;
    let part = downloads.join(format!("{}-{}.part", &sha[..16], asset_name()));
    // Недокачанные архивы прошлых сборок больше не нужны
    for entry in std::fs::read_dir(&downloads).into_iter().flatten().flatten() {
        if entry.path() != part {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let size = crate::http::head_size(&url).await?;
    let mut attempt = 0;
    loop {
        let handle = app.clone();
        let mut last = 0u64;
        let fetch = crate::http::fetch_to_file(&url, &part, size, move |have| {
            if have == size || have.saturating_sub(last) >= 512 * 1024 || have < last {
                last = have;
                progress(&handle, json!({"stage": "download", "current": have, "total": size}));
            }
        });
        let result = tokio::select! {
            result = fetch => result,
            _ = cancelled() => return Err(cancelled_error()),
        };
        match result {
            Ok(()) => break,
            // Обрыв связи: докачка продолжит с того же места
            Err(error) if attempt < 5 && error.status.is_none() => {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }

    progress(app, json!({"stage": "unpack"}));
    let builds = dir.join("builds");
    let target = builds.join(&sha[..16]);
    let sha = sha.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, BridgeError> {
        if sha256_file(&part)? != sha {
            let _ = std::fs::remove_file(&part);
            return Err(BridgeError::new("Horizon download is damaged (SHA-256 mismatch), try again"));
        }
        let staging = builds.join(format!(".staging-{:08x}", rand::random::<u32>()));
        std::fs::create_dir_all(&staging).map_err(|e| io_error(e, "mkdir", &staging))?;
        let unpacked = dunce::canonicalize(&staging).map_err(|e| io_error(e, "realpath", &staging))
            .and_then(|root| crate::archive::unpack_zip(&part.to_string_lossy(), &root).map(|_| root));
        let finish = unpacked.and_then(|root| {
            if client_dir(&root).is_none() {
                return Err(BridgeError::new("Horizon build has no horizon-client.exe"));
            }
            let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            std::fs::write(root.join(MARKER), json!({"sha256": sha, "installedAt": at, "asset": asset_name()}).to_string())
                .map_err(|e| io_error(e, "write", &root))?;
            if target.exists() {
                std::fs::remove_dir_all(&target).map_err(|e| io_error(e, "rm", &target))?;
            }
            std::fs::rename(&root, &target).map_err(|e| io_error(e, "rename", &root))
        });
        if finish.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        finish?;
        let _ = std::fs::remove_file(&part);
        Ok(target)
    }).await.map_err(|e| BridgeError::new(format!("Task failed: {e}")))?
}

// Сборка и то, что ей нужно: {dir, sha, minecraft, javaMajor, updated}. Без сети — последняя установленная
pub async fn install(app: &AppHandle, args: Value) -> BridgeResult {
    CANCEL.store(false, Ordering::SeqCst);
    let root = PathBuf::from(arg_str(&args, "root")?);
    crate::scope::check(&root.to_string_lossy(), crate::scope::Access::Write, "horizon")?;
    let dir = root.join("horizon");
    let builds_dir = dir.join("builds");
    let installed = installed_builds(&builds_dir);
    let (build, updated) = match latest_sha().await {
        Ok(sha) => match installed.iter().find(|b| b.sha == sha) {
            Some(build) => (build.dir.clone(), false),
            None => match download_build(app, &dir, &sha).await {
                Ok(dir) => (dir, true),
                Err(error) if error.code.as_deref() != Some("ECANCELED") && !installed.is_empty() => {
                    crate::logs::write("warn", &format!("Horizon: update failed, using the installed build [error={}]", error.message));
                    (installed[0].dir.clone(), false)
                }
                Err(error) => return Err(error),
            },
        },
        Err(error) => match installed.first() {
            Some(build) => {
                crate::logs::write("warn", &format!("Horizon: release check failed, using the installed build [error={}]", error.message));
                (build.dir.clone(), false)
            }
            None => return Err(BridgeError::code(format!("Horizon is not downloaded yet and GitHub is unreachable: {}", error.message), "horizon_offline")),
        },
    };
    // Хранится текущая сборка и ещё одна — к ней можно вернуться, пока новая не запустилась
    let keep: HashSet<PathBuf> = installed_builds(&builds_dir).into_iter().map(|b| b.dir).filter(|d| *d != build).take(1).chain([build.clone()]).collect();
    for entry in std::fs::read_dir(&builds_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && !keep.contains(&path) {
            let _ = std::fs::remove_dir_all(&path); // занятая запущенной игрой — удалится в следующий раз
        }
    }
    let client = client_dir(&build).ok_or("Horizon build is incomplete")?;
    let (minecraft, java_major) = read_lock(&client)?;
    let sha = installed_builds(&builds_dir).into_iter().find(|b| b.dir == build).map(|b| b.sha).unwrap_or_default();
    ok(json!({"dir": client, "sha": sha, "minecraft": minecraft, "javaMajor": java_major, "updated": updated}))
}

// research-lock.json: версия Minecraft, из файлов которой собираются ресурсы, и нужная для этого Java
fn read_lock(client: &Path) -> Result<(String, u64), BridgeError> {
    let path = client.join("research-lock.json");
    let lock: Value = serde_json::from_slice(&std::fs::read(&path).map_err(|e| io_error(e, "open", &path))?)
        .map_err(|e| BridgeError::new(format!("Bad research-lock.json: {e}")))?;
    let minecraft = lock.pointer("/minecraft/version").and_then(Value::as_str).unwrap_or("").to_string();
    if minecraft.is_empty() || minecraft.len() > 32 || !minecraft.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err(BridgeError::new("Horizon build names no Minecraft version"));
    }
    Ok((minecraft, lock.pointer("/minecraft/java_major").and_then(Value::as_u64).unwrap_or(25)))
}

// ---------- запуск ----------
pub async fn launch(app: &AppHandle, args: Value) -> BridgeResult {
    let id = args.get("launchId").and_then(Value::as_u64).unwrap_or(0);
    let events = Events::new(app, id);
    let config = args.get("config").cloned().unwrap_or(Value::Null);
    match prepare_and_spawn(app, &events, config).await {
        Ok(pid) => ok(json!({"pid": pid})),
        Err(error) => {
            events.debug(format!("Horizon launch failed: {}", error.message));
            Err(error)
        }
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn command(exe: &Path, cwd: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(exe);
    command.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

// Файл версии из её JSON (downloads.client / downloads.server)
async fn fetch_jar(version: &Value, kind: &str, path: PathBuf, source: &str, events: &Events) -> Result<(), BridgeError> {
    let info = version.pointer(&format!("/downloads/{kind}")).ok_or_else(|| BridgeError::new(format!("Version has no {kind} jar")))?;
    let item = Download { url: str_of(info, "url").unwrap_or("").to_string(), path, sha1: str_of(info, "sha1").map(str::to_string), size: info.get("size").and_then(Value::as_u64) };
    if gamefiles::present(&item, true) {
        return Ok(());
    }
    let name = item.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let total = item.size.unwrap_or(0);
    events.emit("download-status", json!({"name": name, "type": "version-jar", "current": 0, "total": total}));
    gamefiles::fetch(&item, source).await?;
    events.emit("download-status", json!({"name": name, "type": "version-jar", "current": total, "total": total}));
    Ok(())
}

// Ресурсы готовы для этой сборки (быстро, файлы игры не читаются)
async fn resources_ready(client: &Path, prepared: &Path) -> bool {
    let mut check = command(&client.join("horizon-prepare.exe"), client);
    check.arg("--check").arg("--output").arg(prepared);
    matches!(tokio::time::timeout(Duration::from_secs(120), check.output()).await, Ok(Ok(output)) if output.status.success())
}

async fn prepare_resources(client: &Path, root: &Path, server_jar: &Path, java_home: &Path, prepared: &Path, events: &Events) -> Result<(), BridgeError> {
    let mut prepare = command(&client.join("horizon-prepare.exe"), client);
    prepare.arg("--prepare").arg("--minecraft-dir").arg(root).arg("--server-jar").arg(server_jar)
        .arg("--java-home").arg(java_home).arg("--output").arg(prepared).args(["--complete", "--progress", "json"])
        // Java из JAVA_HOME проверяется первой: пусть это будет наша
        .env("JAVA_HOME", java_home);
    let mut child = prepare.spawn().map_err(|e| BridgeError::new(format!("Cannot start horizon-prepare: {e}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let error_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        let sink = crate::game::events_sink(events);
        let error_line = error_line.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(error) = str_of(&message, "error") {
                    *error_line.lock().unwrap() = error.to_string();
                    sink("debug", Value::String(format!("[Horizon]: {error}")));
                } else if let Some(text) = str_of(&message, "message") {
                    sink("debug", Value::String(format!("[Horizon]: {text}")));
                    sink("horizon", json!({"message": text}));
                } else if let Some(fraction) = message.get("fraction").and_then(Value::as_f64) {
                    sink("horizon", json!({"fraction": fraction.clamp(0.0, 1.0)}));
                }
            }
        }));
    }
    if let Some(stderr) = stderr {
        let sink = crate::game::events_sink(events);
        let error_line = error_line.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let mut last = error_line.lock().unwrap();
                if last.is_empty() || line.to_lowercase().contains("error") {
                    *last = line.clone();
                }
                drop(last);
                sink("debug", Value::String(format!("[Horizon]: {line}")));
            }
        }));
    }
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| BridgeError::new(e.to_string()))?,
        _ = cancelled() => {
            let _ = child.kill().await;
            return Err(cancelled_error());
        }
    };
    for reader in readers {
        let _ = reader.await;
    }
    if status.success() {
        return Ok(());
    }
    let reason = error_line.lock().unwrap().clone();
    Err(BridgeError::code(if reason.is_empty() { format!("horizon-prepare exited with {status}") } else { reason }, "horizon_prepare"))
}

// Какие параметры понимает эта сборка horizon-client (--launch-api); None — сборка не ответила
async fn client_options(client: &Path) -> Option<HashSet<String>> {
    let mut query = command(&client.join("horizon-client.exe"), client);
    query.arg("--launch-api");
    let output = tokio::time::timeout(Duration::from_secs(30), query.output()).await.ok()?.ok()?;
    let reply: Value = serde_json::from_slice(&output.stdout).ok()?;
    Some(reply.get("options")?.as_array()?.iter().filter_map(|o| str_of(o, "name").map(str::to_string)).collect())
}

async fn prepare_and_spawn(app: &AppHandle, events: &Events, config: Value) -> Result<u32, BridgeError> {
    CANCEL.store(false, Ordering::SeqCst);
    let state = app.state::<AppState>();
    let source = gamefiles::download_source(&state.user_data);
    let root = PathBuf::from(str_of(&config, "root").ok_or("Launch config has no root")?);
    let java = PathBuf::from(str_of(&config, "javaPath").ok_or("Launch config has no Java path")?);
    crate::scope::check(&root.to_string_lossy(), crate::scope::Access::Write, "launch")?;
    crate::scope::check(&java.to_string_lossy(), crate::scope::Access::Read, "launch")?;
    if !java.is_file() {
        return Err(BridgeError::new(format!("Java not found: {}", java.display())));
    }
    let java_home = java.parent().and_then(Path::parent).ok_or("Bad Java path")?.to_path_buf();
    let dir = root.join("horizon");
    // Сборка — только из своей папки builds (её туда положил install после проверки подписи)
    let builds = dunce::canonicalize(dir.join("builds")).map_err(|e| io_error(e, "realpath", &dir))?;
    let client = dunce::canonicalize(str_of(&config, "build").ok_or("Launch config has no Horizon build")?)
        .map_err(|e| BridgeError::new(format!("Horizon build is missing: {e}")))?;
    if !client.starts_with(&builds) || !client.join("horizon-client.exe").is_file() {
        return Err(BridgeError::new("Horizon build is not installed"));
    }
    let (minecraft, _) = read_lock(&client)?;
    let game_dir = str_of(&config, "gameDirectory").map(PathBuf::from).unwrap_or_else(|| dir.join("game"));
    crate::scope::check(&game_dir.to_string_lossy(), crate::scope::Access::Write, "launch")?;
    std::fs::create_dir_all(&game_dir).map_err(|e| io_error(e, "mkdir", &game_dir))?;
    let prepared = dir.join("prepared");

    // Файлы ванильной версии — Horizon читает их из папки игры, раскладка как у официального лаунчера
    events.debug(format!("Horizon: preparing Minecraft {minecraft} files"));
    let version = crate::game::resolve_version(&root, &minecraft, &source, events).await?;
    fetch_jar(&version, "client", root.join("versions").join(&minecraft).join(format!("{minecraft}.jar")), &source, events).await?;
    let libraries: Vec<Download> = crate::game::library_downloads(&version, &root.join("libraries")).into_iter()
        .filter(|d| !gamefiles::present(d, false)).collect();
    if !libraries.is_empty() {
        events.debug(format!("Downloading {} libraries", libraries.len()));
        let sink = crate::game::events_sink(events);
        gamefiles::fetch_all(libraries, &source, 16, move |task, total| sink("progress", json!({"type": "classes", "task": task, "total": total}))).await?;
    }
    crate::game::prepare_assets(&root, &game_dir, &version, &minecraft, &source, events).await?;
    let server_jar = dir.join(format!("server-{minecraft}.jar"));
    fetch_jar(&version, "server", server_jar.clone(), &source, events).await?;
    if CANCEL.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }

    // Ресурсы: первый раз — несколько минут, потом только проверка
    if !resources_ready(&client, &prepared).await {
        events.debug("Horizon: preparing resources");
        events.emit("horizon", json!({"stage": "prepare", "fraction": 0.0}));
        prepare_resources(&client, &root, &server_jar, &java_home, &prepared, events).await?;
    }

    // Аккаунт — JSON в stdin: токен не попадает в командную строку
    let auth = config.get("authorization").cloned().unwrap_or(Value::Null);
    let mut session = json!({
        "name": str_of(&auth, "name").unwrap_or("Player"),
        "uuid": str_of(&auth, "uuid").unwrap_or(""),
        "access_token": str_of(&auth, "access_token").filter(|t| !t.is_empty()).unwrap_or("0"),
    });
    if str_of(&config, "accountType") == Some("microsoft") {
        session["user_type"] = json!("msa");
        if let Some(xuid) = auth.pointer("/meta/xuid").and_then(Value::as_str) {
            session["xuid"] = json!(xuid);
        }
    }

    let options = client_options(&client).await;
    let supports = |name: &str| options.as_ref().map(|set| set.contains(name)).unwrap_or(true);
    let mut args: Vec<OsString> = vec!["--resources".into(), prepared.clone().into(), "--game-dir".into(), game_dir.clone().into()];
    if supports("--home") {
        args.extend([OsString::from("--home"), game_dir.clone().into()]);
    }
    let window = config.get("window").cloned().unwrap_or(Value::Null);
    if window.get("fullscreen").and_then(Value::as_bool) == Some(true) && supports("--fullscreen") {
        args.push("--fullscreen".into());
    } else if let (Some(w), Some(h)) = (window.get("width").and_then(Value::as_u64), window.get("height").and_then(Value::as_u64)) {
        if supports("--width") && supports("--height") {
            args.extend([OsString::from("--width"), w.to_string().into(), "--height".into(), h.to_string().into()]);
        }
    }
    if let Some(server) = str_of(&config, "server").filter(|s| !s.is_empty() && s.len() <= 255 && !s.starts_with('-')) {
        if supports("--quickPlayMultiplayer") {
            args.extend([OsString::from("--quickPlayMultiplayer"), server.into()]);
        }
    }
    args.push("--session-stdin".into());

    events.emit("arguments", Value::Null);
    events.debug(format!("Launching Horizon {minecraft} from {}", client.display()));
    let mut spawn = command(&client.join("horizon-client.exe"), &game_dir);
    spawn.args(&args).stdin(Stdio::piped()).kill_on_drop(false);
    // Статус в Discord показывает лаунчер: свой у Horizon перебил бы его
    if config.get("launcherDiscord").and_then(Value::as_bool) == Some(true) {
        spawn.env("HORIZON_NO_DISCORD", "1");
    }
    let mut child = spawn.spawn().map_err(|e| BridgeError::new(format!("Cannot start Horizon: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(session.to_string().as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    Ok(crate::game::supervise(app, events, child, game_dir))
}
