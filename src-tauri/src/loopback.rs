// Вход через Discord (RFC 8252, порт discordLoopback.js): сайт после входа отправляет браузер на 127.0.0.1 этого ПК
// с одноразовым кодом. Токен выдаётся только вместе с PKCE verifier, который знает лишь этот лаунчер
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

use crate::bridge::{ok, BridgeError, BridgeResult};

const PAGE: &str = r#"<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>RxLauncher</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#e8e8ea;font:16px system-ui,sans-serif;text-align:center}
b{display:block;font-size:22px;margin-bottom:8px}span{color:#9a9aa3}</style></head>
<body><div><b>Вход выполнен</b><span>Вернитесь в RxLauncher — эту вкладку можно закрыть.</span></div></body></html>"#;

struct Active {
    id: u64,
    stop: watch::Sender<bool>,
    result: watch::Receiver<Option<Option<String>>>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn valid_code(code: &str) -> bool {
    (32..=64).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn stop() {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(current) = active.take() {
            let _ = current.stop.send(true);
        }
    }
}

pub async fn start() -> BridgeResult {
    stop();
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| BridgeError::new(e.to_string()))?;
    let port = listener.local_addr().map_err(|e| BridgeError::new(e.to_string()))?.port();
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let (result_tx, result_rx) = watch::channel::<Option<Option<String>>>(None);
    if let Ok(mut active) = ACTIVE.lock() {
        *active = Some(Active { id, stop: stop_tx, result: result_rx });
    }
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::sleep(Duration::from_secs(5 * 60));
        tokio::pin!(deadline);
        let code = loop {
            tokio::select! {
                _ = &mut deadline => break None,
                _ = stop_rx.changed() => break None,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { continue };
                    let mut buffer = vec![0u8; 8192];
                    let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer)).await.ok().and_then(Result::ok).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let mut lines = request.lines();
                    let first = lines.next().unwrap_or("");
                    let host = lines.find_map(|l| l.strip_prefix("Host:").or_else(|| l.strip_prefix("host:"))).map(str::trim).unwrap_or("");
                    let path = first.strip_prefix("GET ").and_then(|r| r.split(' ').next()).unwrap_or("");
                    let code = path.strip_prefix("/rx-discord?").and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("code="))).unwrap_or("").to_string();
                    // Host проверяем, чтобы сюда не достучалась чужая страница через DNS rebinding
                    if host != format!("127.0.0.1:{port}") || !valid_code(&code) {
                        let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 9\r\n\r\nNot found").await;
                        continue;
                    }
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{PAGE}", PAGE.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                    break Some(code);
                }
            }
        };
        let _ = result_tx.send(Some(code));
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().map(|a| a.id) == Some(id) {
                *active = None;
            }
        }
    });
    ok(json!({"id": id, "port": port}))
}

// Код из браузера или null (отмена, таймаут, начат другой вход)
pub async fn wait(id: u64) -> BridgeResult {
    let receiver = ACTIVE.lock().ok().and_then(|a| a.as_ref().filter(|a| a.id == id).map(|a| a.result.clone()));
    let Some(mut receiver) = receiver else { return ok(Value::Null) };
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return ok(result);
        }
        if receiver.changed().await.is_err() {
            return ok(receiver.borrow().clone().flatten());
        }
    }
}
