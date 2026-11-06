// CurseForge API: ключ хранится только в ядре (зашифрован, как в версии на Electron), интерфейс просит запросы
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::bridge::{ok, BridgeResult};

const API: &str = "https://api.curseforge.com";

fn key_file(user_data: &Path) -> std::path::PathBuf {
    user_data.join("curseforge-api-key.bin")
}

fn env_key() -> String {
    std::env::var("RX_CURSEFORGE_API_KEY").unwrap_or_default().trim().to_string()
}

pub fn read_key(user_data: &Path) -> String {
    let env = env_key();
    if !env.is_empty() {
        return env;
    }
    std::fs::read(key_file(user_data)).ok().and_then(|data| crate::secure::decrypt(user_data, &data).ok()).map(|k| k.trim().to_string()).unwrap_or_default()
}

pub fn status(user_data: &Path) -> BridgeResult {
    ok(json!({"configured": !read_key(user_data).is_empty(), "managedByEnvironment": !env_key().is_empty(), "secureStorageAvailable": crate::secure::available()}))
}

async fn request(key: &str, endpoint: &str, query: Option<&Value>, method: &str, body: Option<&Value>) -> Value {
    if key.is_empty() {
        return json!({"success": false, "status": 0, "error": "missing_api_key"});
    }
    if !endpoint.starts_with("/v1/") || endpoint.contains("..") || endpoint.contains("//") {
        return json!({"success": false, "status": 0, "error": "invalid_endpoint"});
    }
    let Ok(mut url) = reqwest::Url::parse(&format!("{API}{endpoint}")) else {
        return json!({"success": false, "status": 0, "error": "invalid_endpoint"});
    };
    if let Some(query) = query.and_then(Value::as_object) {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            match value {
                Value::String(s) => { pairs.append_pair(name, s); }
                Value::Number(n) => { pairs.append_pair(name, &n.to_string()); }
                Value::Bool(b) => { pairs.append_pair(name, &b.to_string()); }
                _ => {}
            }
        }
    }
    let client = reqwest::Client::new();
    let mut builder = if method == "POST" { client.post(url) } else { client.get(url) };
    builder = builder.header("Accept", "application/json").header("x-api-key", key).header("User-Agent", crate::http::user_agent()).timeout(Duration::from_secs(20));
    if method == "POST" {
        builder = builder.json(body.unwrap_or(&json!({})));
    }
    match builder.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"message": text}));
            if (200..300).contains(&status) {
                json!({"success": true, "status": status, "data": parsed})
            } else {
                json!({"success": false, "status": status, "error": parsed.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"))})
            }
        }
        Err(error) => json!({"success": false, "status": 0, "error": error.to_string()}),
    }
}

pub async fn api_request(user_data: &Path, payload: &Value) -> BridgeResult {
    let endpoint = payload.get("endpoint").and_then(Value::as_str).unwrap_or("");
    let method = if payload.get("method").and_then(Value::as_str) == Some("POST") { "POST" } else { "GET" };
    let body = payload.get("body").filter(|b| b.is_object());
    ok(request(&read_key(user_data), endpoint, payload.get("query"), method, body).await)
}

pub async fn set_key(user_data: &Path, raw: &str) -> BridgeResult {
    let key = raw.trim();
    if key.len() < 16 || key.len() > 512 {
        return ok(json!({"success": false, "error": "invalid_key_format"}));
    }
    let check = request(key, "/v1/games/432", None, "GET", None).await;
    if check.get("success").and_then(Value::as_bool) != Some(true) {
        let status = check.get("status").and_then(Value::as_u64).unwrap_or(0);
        let error = if status == 401 || status == 403 { "invalid_key".to_string() } else { check.get("error").and_then(Value::as_str).unwrap_or("request_failed").to_string() };
        return ok(json!({"success": false, "error": error}));
    }
    match crate::secure::encrypt(user_data, key).and_then(|sealed| std::fs::write(key_file(user_data), sealed).map_err(|e| e.to_string())) {
        Ok(()) => ok(json!({"success": true})),
        Err(error) => ok(json!({"success": false, "error": error})),
    }
}

pub fn clear_key(user_data: &Path) -> BridgeResult {
    if !env_key().is_empty() {
        return ok(json!({"success": false, "error": "managed_by_environment"}));
    }
    match std::fs::remove_file(key_file(user_data)) {
        Ok(()) => ok(json!({"success": true})),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ok(json!({"success": true})),
        Err(error) => ok(json!({"success": false, "error": error.to_string()})),
    }
}
