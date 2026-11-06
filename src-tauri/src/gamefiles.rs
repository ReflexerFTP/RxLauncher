// Файлы Minecraft: клиент, библиотеки, нативные библиотеки, ассеты, конфиг логов. Параллельная загрузка с SHA-1,
// повторами и запасным зеркалом BMCLAPI (как RxGameFiles в интерфейсе: «auto» — Mojang, при сбое зеркало)
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use serde_json::Value;
use sha1::Digest;

use crate::bridge::BridgeError;

pub const MIRROR: &str = "https://bmclapi2.bangbang93.com";
pub const LIBRARIES: &str = "https://libraries.minecraft.net/";
pub const RESOURCES: &str = "https://resources.download.minecraft.net/";

#[derive(Clone)]
pub struct Download {
    pub url: String,
    pub path: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

// Источник загрузки из настроек лаунчера: auto | official | mirror
pub fn download_source(user_data: &Path) -> String {
    std::fs::read(user_data.join("config.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c.get("downloadSource").and_then(Value::as_str).map(str::to_string))
        .filter(|s| matches!(s.as_str(), "auto" | "official" | "mirror"))
        .unwrap_or_else(|| "auto".into())
}

fn mirror_url(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let prefix = match parsed.host_str()? {
        "resources.download.minecraft.net" => "/assets",
        "libraries.minecraft.net" => "/maven",
        "piston-meta.mojang.com" | "piston-data.mojang.com" | "launchermeta.mojang.com" | "launcher.mojang.com" => "",
        _ => return None,
    };
    Some(format!("{MIRROR}{prefix}{}", parsed.path()))
}

fn routes(url: &str, source: &str) -> Vec<String> {
    match (mirror_url(url), source) {
        (Some(mirror), "mirror") => vec![mirror, url.to_string()],
        (Some(mirror), "auto") => vec![url.to_string(), mirror],
        _ => vec![url.to_string()],
    }
}

pub fn sha1_file(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = sha1::Sha1::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Some(hex::encode(hasher.finalize()))
}

// Файл на месте: размер совпадает, SHA-1 — проверяем только если verify (дорого для тысяч ассетов)
pub fn present(item: &Download, verify: bool) -> bool {
    let Ok(meta) = std::fs::metadata(&item.path) else { return false };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    if let Some(size) = item.size {
        if size > 0 && meta.len() != size {
            return false;
        }
    }
    match (&item.sha1, verify) {
        (Some(sha1), true) => sha1_file(&item.path).map(|h| h.eq_ignore_ascii_case(sha1)).unwrap_or(false),
        _ => true,
    }
}

async fn fetch_to(url: &str, item: &Download) -> Result<(), BridgeError> {
    let data = crate::http::get_bytes(url, Duration::from_secs(45), item.size.map(|s| s + 1024).unwrap_or(512 * 1024 * 1024)).await?;
    if let Some(size) = item.size {
        if size > 0 && data.len() as u64 != size {
            return Err(BridgeError::new(format!("Size mismatch for {}", item.path.display())));
        }
    }
    if let Some(expected) = &item.sha1 {
        let actual = hex::encode(sha1::Sha1::digest(&data));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(BridgeError::new(format!("Checksum mismatch for {}", item.path.display())));
        }
    }
    if let Some(parent) = item.path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::fsops::io_error(e, "mkdir", &parent.to_string_lossy(), None))?;
    }
    let temp = item.path.with_extension(format!("{:08x}.rxdownload", rand::random::<u32>()));
    std::fs::write(&temp, &data).map_err(|e| crate::fsops::io_error(e, "write", &temp.to_string_lossy(), None))?;
    std::fs::rename(&temp, &item.path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        crate::fsops::io_error(e, "rename", &temp.to_string_lossy(), None)
    })
}

pub async fn fetch(item: &Download, source: &str) -> Result<(), BridgeError> {
    let urls = routes(&item.url, source);
    let mut last = BridgeError::new("Download failed");
    for attempt in 0..4 {
        let url = &urls[attempt % urls.len()];
        match fetch_to(url, item).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                // 404 повторять бесполезно, разве что через другой адрес
                let missing = error.status.map(|s| (400..500).contains(&s)).unwrap_or(false);
                last = error;
                if missing && attempt + 1 >= urls.len() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(700 * (attempt as u64 + 1))).await;
            }
        }
    }
    Err(BridgeError::new(format!("{} ({})", last.message, item.url)))
}

// Скачать недостающее параллельно; on_progress(готово, всего)
pub async fn fetch_all(items: Vec<Download>, source: &str, concurrency: usize, on_progress: impl Fn(usize, usize) + Send + Sync + 'static) -> Result<(), BridgeError> {
    let total = items.len();
    let done = Arc::new(AtomicUsize::new(0));
    let progress = Arc::new(on_progress);
    let results: Vec<Result<(), BridgeError>> = stream::iter(items.into_iter().map(|item| {
        let done = done.clone();
        let progress = progress.clone();
        let source = source.to_string();
        async move {
            let result = fetch(&item, &source).await;
            let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
            progress(finished, total);
            result
        }
    }))
    .buffer_unordered(concurrency.max(1))
    .collect()
    .await;
    results.into_iter().collect::<Result<Vec<_>, _>>().map(|_| ())
}

// "group:artifact:version[:classifier][@ext]" → путь в Maven
pub fn maven_path(name: &str) -> Option<String> {
    let (coords, extension) = match name.split_once('@') {
        Some((c, e)) => (c, e),
        None => (name, "jar"),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let (group, artifact, version) = (parts[0], parts[1], parts[2]);
    let file = match parts.get(3) {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{extension}"),
        None => format!("{artifact}-{version}.{extension}"),
    };
    let segments: Vec<String> = group.split('.').map(str::to_string).chain([artifact.to_string(), version.to_string(), file]).collect();
    if segments.iter().any(|s| s.is_empty() || s == "." || s == ".." || s.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])) {
        return None;
    }
    Some(segments.join("/"))
}

// Распаковать нативные библиотеки (.dll) из jar в папку natives
pub fn extract_natives(jar: &Path, target: &Path, exclude: &[String]) -> Result<usize, BridgeError> {
    let file = std::fs::File::open(jar).map_err(|e| crate::fsops::io_error(e, "open", &jar.to_string_lossy(), None))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| BridgeError::new(format!("Broken natives jar {}: {e}", jar.display())))?;
    std::fs::create_dir_all(target).map_err(|e| crate::fsops::io_error(e, "mkdir", &target.to_string_lossy(), None))?;
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| BridgeError::new(e.to_string()))?;
        let name = entry.name().to_string();
        if entry.is_dir() || name.starts_with("META-INF/") || exclude.iter().any(|ex| name.starts_with(ex.as_str())) {
            continue;
        }
        let lower = name.to_lowercase();
        if !(lower.ends_with(".dll") || lower.ends_with(".so") || lower.ends_with(".dylib") || lower.ends_with(".jnilib")) {
            continue;
        }
        // Только имя файла: архив не может писать за пределы папки natives
        let Some(file_name) = Path::new(&name).file_name() else { continue };
        let out = target.join(file_name);
        if out.exists() && std::fs::metadata(&out).map(|m| m.len() == entry.size()).unwrap_or(false) {
            continue;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut data).map_err(|e| BridgeError::new(e.to_string()))?;
        std::fs::write(&out, data).map_err(|e| crate::fsops::io_error(e, "write", &out.to_string_lossy(), None))?;
        count += 1;
    }
    Ok(count)
}
