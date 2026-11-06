// HTTP для интерфейса (RxHttp): запросы и загрузки файлов через reqwest.
// timeout — как в Node: сколько ждать соединения и каждого следующего куска данных (а не весь ответ целиком),
// чтобы медленный интернет не обрывал большие файлы. guarded — адреса из чужих данных (файлы сборок):
// только https, без логина в адресе, ни имя, ни DNS, ни редирект не должны вести в локальную сеть
use std::collections::HashMap;
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha1::Digest;
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge::{arg_bool, arg_str, arg_u64, ok, BridgeError, BridgeResult};
use crate::state::AppState;

const MAX_REDIRECTS: usize = 5;

pub fn is_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 0 || o[0] == 10 || o[0] == 127 || (o[0] == 100 && (o[1] & 0xc0) == 64) || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (o[1] & 0xf0) == 16) || (o[0] == 192 && o[1] == 168) || o[0] >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            v6.is_unspecified() || v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0 || (s[0] & 0xff00) == 0xff00
        }
    }
}

fn guarded_url_ok(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid pack download URL".into());
    }
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("Pack download URL points to a local network".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_local_ip(ip) {
            return Err("Pack download URL points to a local network".into());
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn guarded_url_ok_for_test(url: &str) -> bool {
    reqwest::Url::parse(url).map(|u| guarded_url_ok(&u).is_ok()).unwrap_or(false)
}

// DNS для guarded: соединение только с проверенными внешними адресами
struct SafeResolver;

impl reqwest::dns::Resolve for SafeResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() || addrs.iter().any(|addr| is_local_ip(addr.ip())) {
                let error: Box<dyn std::error::Error + Send + Sync> = "Pack download URL resolves to a local network".into();
                return Err(error);
            }
            let iter: reqwest::dns::Addrs = Box::new(addrs.into_iter());
            Ok(iter)
        })
    }
}

fn build_client(guarded: bool, decompress: bool) -> reqwest::Client {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("Too many redirects");
        }
        if guarded {
            if let Err(message) = guarded_url_ok(attempt.url()) {
                return attempt.error(message);
            }
        } else if attempt.previous().last().map(|u| u.scheme() == "https").unwrap_or(false) && attempt.url().scheme() != "https" {
            return attempt.error("Insecure redirect");
        }
        attempt.follow()
    });
    let mut builder = reqwest::Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(16);
    if !decompress {
        builder = builder.no_gzip().no_brotli().no_deflate();
    }
    if guarded {
        builder = builder.dns_resolver(std::sync::Arc::new(SafeResolver)).https_only(true);
    }
    builder.build().expect("HTTP client")
}

fn client(guarded: bool, decompress: bool) -> &'static reqwest::Client {
    static CLIENTS: OnceLock<[reqwest::Client; 4]> = OnceLock::new();
    let clients = CLIENTS.get_or_init(|| [build_client(false, false), build_client(false, true), build_client(true, false), build_client(true, true)]);
    &clients[(guarded as usize) * 2 + decompress as usize]
}

fn net_error(error: reqwest::Error) -> BridgeError {
    let code = if error.is_timeout() {
        "ETIMEDOUT"
    } else if error.is_connect() {
        "ECONNREFUSED"
    } else if error.is_redirect() {
        "ERR_REDIRECT"
    } else {
        "ECONNRESET"
    };
    // Причина целиком (например, «resolves to a local network» из SafeResolver)
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(inner) = source {
        message = format!("{message}: {inner}");
        source = inner.source();
    }
    BridgeError::code(message, code)
}

fn headers_json(headers: &reqwest::header::HeaderMap) -> Value {
    let mut map: HashMap<String, String> = HashMap::new();
    for (name, value) in headers {
        let value = String::from_utf8_lossy(value.as_bytes()).to_string();
        map.entry(name.as_str().to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }
    json!(map)
}

// Регистрация отмены: http.abort {id} прерывает запрос
fn register_abort(app: &AppHandle, id: u64) -> tokio::sync::watch::Receiver<Option<String>> {
    let (sender, receiver) = tokio::sync::watch::channel(None);
    if let Ok(mut aborts) = app.state::<AppState>().http_aborts.lock() {
        aborts.insert(id, sender);
    }
    receiver
}

fn unregister_abort(app: &AppHandle, id: u64) {
    if let Ok(mut aborts) = app.state::<AppState>().http_aborts.lock() {
        aborts.remove(&id);
    }
}

async fn next_chunk(
    stream: &mut (impl futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Unpin),
    idle: Duration,
    abort: &mut tokio::sync::watch::Receiver<Option<String>>,
) -> Result<Option<bytes::Bytes>, BridgeError> {
    tokio::select! {
        changed = abort.changed() => {
            let reason = if changed.is_ok() { abort.borrow().clone() } else { None };
            Err(BridgeError::code(reason.unwrap_or_else(|| "Request aborted".into()), "ABORT_ERR"))
        }
        result = tokio::time::timeout(idle, stream.next()) => match result {
            Err(_) => Err(BridgeError::code("Request timed out", "ETIMEDOUT")),
            Ok(None) => Ok(None),
            Ok(Some(Err(error))) => Err(net_error(error)),
            Ok(Some(Ok(chunk))) => Ok(Some(chunk)),
        }
    }
}

async fn send(args: &Value, body: Option<Vec<u8>>, decompress: bool, abort: &mut tokio::sync::watch::Receiver<Option<String>>) -> Result<reqwest::Response, BridgeError> {
    let url_text = arg_str(args, "url")?;
    let url = reqwest::Url::parse(url_text).map_err(|e| BridgeError::code(format!("Invalid URL: {e}"), "ERR_INVALID_URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(BridgeError::new(format!("Unsupported protocol {}:", url.scheme())));
    }
    let guarded = arg_bool(args, "guarded");
    if guarded {
        guarded_url_ok(&url).map_err(BridgeError::new)?;
    }
    let method = reqwest::Method::from_bytes(args.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase().as_bytes())
        .map_err(|_| BridgeError::new("Invalid HTTP method"))?;
    let mut request = client(guarded, decompress).request(method, url);
    if let Some(headers) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            let text = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            // Длину и сжатие считает сам клиент
            if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("accept-encoding") {
                continue;
            }
            request = request.header(name.as_str(), text);
        }
    }
    if let Some(user_agent) = args.get("userAgent").and_then(Value::as_str) {
        request = request.header("User-Agent", user_agent);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let idle = Duration::from_millis(arg_u64(args, "timeout").unwrap_or(20_000).clamp(1_000, 600_000));
    tokio::select! {
        changed = abort.changed() => {
            let reason = if changed.is_ok() { abort.borrow().clone() } else { None };
            Err(BridgeError::code(reason.unwrap_or_else(|| "Request aborted".into()), "ABORT_ERR"))
        }
        result = tokio::time::timeout(idle.max(Duration::from_secs(30)), request.send()) => match result {
            Err(_) => Err(BridgeError::code("Request timed out", "ETIMEDOUT")),
            Ok(Err(error)) => Err(net_error(error)),
            Ok(Ok(response)) => Ok(response),
        }
    }
}

async fn request(app: &AppHandle, args: Value, payload: Vec<u8>) -> BridgeResult {
    let id = arg_u64(&args, "id").unwrap_or(0);
    let mut abort = register_abort(app, id);
    let result = async {
        let max = arg_u64(&args, "maxBytes").unwrap_or(16 * 1024 * 1024);
        let decompress = args.get("compress").and_then(Value::as_bool).unwrap_or(true);
        let response = send(&args, if payload.is_empty() { None } else { Some(payload) }, decompress, &mut abort).await?;
        let status = response.status().as_u16();
        let url = response.url().to_string();
        let headers = headers_json(response.headers());
        if response.content_length().map(|len| len > max).unwrap_or(false) {
            return Err(BridgeError::new("Response too large"));
        }
        let idle = Duration::from_millis(arg_u64(&args, "timeout").unwrap_or(20_000).clamp(1_000, 600_000));
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = next_chunk(&mut stream, idle, &mut abort).await? {
            if body.len() as u64 + chunk.len() as u64 > max {
                return Err(BridgeError::new("Response too large"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok((json!({"status": status, "url": url, "headers": headers}), Some(body)))
    }
    .await;
    unregister_abort(app, id);
    result
}

enum Hasher {
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
    Sha512(sha2::Sha512),
    Md5(md5::Md5),
}

impl Hasher {
    fn new(algorithm: &str) -> Option<Self> {
        Some(match algorithm {
            "sha1" => Self::Sha1(sha1::Sha1::new()),
            "sha256" => Self::Sha256(sha2::Sha256::new()),
            "sha512" => Self::Sha512(sha2::Sha512::new()),
            "md5" => Self::Md5(md5::Md5::new()),
            _ => return None,
        })
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha1(h) => h.update(data),
            Self::Sha256(h) => h.update(data),
            Self::Sha512(h) => h.update(data),
            Self::Md5(h) => h.update(data),
        }
    }

    fn hex(self) -> String {
        match self {
            Self::Sha1(h) => hex::encode(h.finalize()),
            Self::Sha256(h) => hex::encode(h.finalize()),
            Self::Sha512(h) => hex::encode(h.finalize()),
            Self::Md5(h) => hex::encode(h.finalize()),
        }
    }
}

// Скачать во временный файл, проверить размер и хеш, затем переименовать на место
async fn download(app: &AppHandle, args: Value) -> BridgeResult {
    let id = arg_u64(&args, "id").unwrap_or(0);
    let target = arg_str(&args, "path")?.to_string();
    let mut abort = register_abort(app, id);
    let temp = format!("{target}.{:016x}.rxdownload", rand::random::<u64>());
    let result = async {
        let max = arg_u64(&args, "maxBytes").unwrap_or(4 * 1024 * 1024 * 1024);
        let expected_size = arg_u64(&args, "expectedSize");
        let expected_hash = args.get("hash").filter(|h| h.is_object()).map(|h| {
            (h.get("algorithm").and_then(Value::as_str).unwrap_or("").to_string(), h.get("value").and_then(Value::as_str).unwrap_or("").to_lowercase())
        });
        let progress = arg_bool(&args, "progress");
        if let Some(parent) = Path::new(&target).parent() {
            std::fs::create_dir_all(parent).map_err(|e| crate::fsops::io_error(e, "mkdir", &parent.to_string_lossy(), None))?;
        }
        let response = send(&args, None, false, &mut abort).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(BridgeError { message: format!("Download failed with HTTP {}", status.as_u16()), status: Some(status.as_u16()), ..Default::default() });
        }
        let total = response.content_length().unwrap_or(0);
        if total > max {
            return Err(BridgeError::new("Download exceeds size limit"));
        }
        let mut hasher = match &expected_hash {
            Some((algorithm, _)) => Some(Hasher::new(algorithm).ok_or_else(|| BridgeError::new(format!("Digest method not supported: {algorithm}")))?),
            None => None,
        };
        let mut file = std::io::BufWriter::with_capacity(256 * 1024, std::fs::File::create(&temp).map_err(|e| crate::fsops::io_error(e, "open", &temp, None))?);
        let idle = Duration::from_millis(arg_u64(&args, "timeout").unwrap_or(30_000).clamp(1_000, 600_000));
        let mut stream = response.bytes_stream();
        let mut received: u64 = 0;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        while let Some(chunk) = next_chunk(&mut stream, idle, &mut abort).await? {
            received += chunk.len() as u64;
            if received > max {
                return Err(BridgeError::new("Download exceeds size limit"));
            }
            if let Some(h) = hasher.as_mut() {
                h.update(&chunk);
            }
            file.write_all(&chunk).map_err(|e| crate::fsops::io_error(e, "write", &temp, None))?;
            if progress && last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = Instant::now();
                let _ = app.emit("rx:http-progress", json!({"id": id, "received": received, "total": total}));
            }
        }
        file.flush().map_err(|e| crate::fsops::io_error(e, "write", &temp, None))?;
        drop(file);
        let name = Path::new(&target).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if total > 0 && received != total {
            return Err(BridgeError::new("Incomplete download"));
        }
        if let Some(size) = expected_size {
            if received != size {
                return Err(BridgeError::new(format!("Size mismatch for {name}")));
            }
        }
        if let (Some(h), Some((_, value))) = (hasher, expected_hash) {
            if h.hex() != value {
                return Err(BridgeError::new(format!("Checksum mismatch for {name}")));
            }
        }
        if progress {
            let _ = app.emit("rx:http-progress", json!({"id": id, "received": received, "total": total.max(received)}));
        }
        std::fs::rename(&temp, &target).map_err(|e| crate::fsops::io_error(e, "rename", &temp, Some(&target)))?;
        ok(json!({"bytes": received}))
    }
    .await;
    unregister_abort(app, id);
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub async fn run(app: &AppHandle, op: &str, args: Value, payload: Vec<u8>) -> BridgeResult {
    match op {
        "request" => request(app, args, payload).await,
        "download" => download(app, args).await,
        "abort" => {
            let id = arg_u64(&args, "id").unwrap_or(0);
            let reason = args.get("reason").and_then(Value::as_str).map(str::to_string);
            if let Ok(aborts) = app.state::<AppState>().http_aborts.lock() {
                if let Some(sender) = aborts.get(&id) {
                    let _ = sender.send(Some(reason.unwrap_or_else(|| "Request aborted".into())));
                }
            }
            ok(Value::Null)
        }
        other => Err(BridgeError::code(format!("Unknown http operation: {other}"), "ENOSYS")),
    }
}

// Простой GET для кода ядра (запуск игры, загрузчики): JSON или байты
pub async fn get_bytes(url: &str, idle: Duration, max: u64) -> Result<Vec<u8>, BridgeError> {
    let response = tokio::time::timeout(Duration::from_secs(60), client(false, true).get(url).header("User-Agent", user_agent()).send())
        .await
        .map_err(|_| BridgeError::code("Request timed out", "ETIMEDOUT"))?
        .map_err(net_error)?;
    if !response.status().is_success() {
        return Err(BridgeError { message: format!("HTTP {} for {url}", response.status().as_u16()), status: Some(response.status().as_u16()), ..Default::default() });
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => return Err(BridgeError::code("Request timed out", "ETIMEDOUT")),
            Ok(None) => break,
            Ok(Some(Err(error))) => return Err(net_error(error)),
            Ok(Some(Ok(chunk))) => {
                if body.len() as u64 + chunk.len() as u64 > max {
                    return Err(BridgeError::new("Response too large"));
                }
                body.extend_from_slice(&chunk);
            }
        }
    }
    Ok(body)
}

pub fn user_agent() -> String {
    format!("MaxRx/RxLauncher/{} (https://rxlauncher.xyz)", env!("CARGO_PKG_VERSION"))
}
