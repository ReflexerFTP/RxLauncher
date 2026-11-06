// Discord Rich Presence: транспорт через именованный канал Discord (\\.\pipe\discord-ipc-N).
// Что показывать, решает интерфейс (services.js); здесь — подключение, рукопожатие и SET_ACTIVITY
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::bridge::{ok, BridgeError, BridgeResult};

const CLIENT_ID: &str = "1531981667160555530";

#[cfg(windows)]
type Pipe = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(windows)]
static CONNECTION: Mutex<Option<Pipe>> = Mutex::const_new(None);

#[cfg(windows)]
async fn write_frame(pipe: &mut Pipe, op: u32, payload: &Value) -> Result<(), BridgeError> {
    let body = serde_json::to_vec(payload).map_err(|e| BridgeError::new(e.to_string()))?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend(body);
    pipe.write_all(&frame).await.map_err(|e| BridgeError::new(e.to_string()))
}

#[cfg(windows)]
async fn read_frame(pipe: &mut Pipe) -> Result<(u32, Value), BridgeError> {
    let mut header = [0u8; 8];
    tokio::time::timeout(std::time::Duration::from_secs(5), pipe.read_exact(&mut header)).await
        .map_err(|_| BridgeError::new("Discord did not answer"))?
        .map_err(|e| BridgeError::new(e.to_string()))?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if length > 1024 * 1024 {
        return Err(BridgeError::new("Discord frame is too large"));
    }
    let mut body = vec![0u8; length];
    pipe.read_exact(&mut body).await.map_err(|e| BridgeError::new(e.to_string()))?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

#[cfg(windows)]
async fn connect() -> Result<Pipe, BridgeError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    for index in 0..10 {
        let Ok(mut pipe) = ClientOptions::new().open(format!(r"\\.\pipe\discord-ipc-{index}")) else { continue };
        write_frame(&mut pipe, 0, &json!({"v": 1, "client_id": CLIENT_ID})).await?;
        let (op, data) = read_frame(&mut pipe).await?;
        if op == 1 && data.get("evt").and_then(Value::as_str) == Some("READY") {
            return Ok(pipe);
        }
    }
    Err(BridgeError::code("Discord is not running", "ENOENT"))
}

// activity = null — очистить статус
#[cfg(windows)]
pub async fn set_activity(activity: Value) -> BridgeResult {
    let mut guard = CONNECTION.lock().await;
    if guard.is_none() {
        *guard = Some(connect().await?);
    }
    let pipe = guard.as_mut().unwrap();
    let nonce = format!("{:032x}", rand::random::<u128>());
    let command = json!({"cmd": "SET_ACTIVITY", "args": {"pid": std::process::id(), "activity": activity}, "nonce": nonce});
    let result = async {
        write_frame(pipe, 1, &command).await?;
        // Ответ на команду (или событие) — прочитать, чтобы канал не забивался
        let (op, data) = read_frame(pipe).await?;
        if op == 2 {
            return Err(BridgeError::new("Discord closed the connection"));
        }
        if data.get("evt").and_then(Value::as_str) == Some("ERROR") {
            return Err(BridgeError::new(data.get("data").and_then(|d| d.get("message")).and_then(Value::as_str).unwrap_or("Discord error").to_string()));
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        *guard = None;
        return Err(error);
    }
    ok(true)
}

#[cfg(windows)]
pub async fn disconnect() -> BridgeResult {
    let mut guard = CONNECTION.lock().await;
    if let Some(mut pipe) = guard.take() {
        let _ = write_frame(&mut pipe, 2, &json!({})).await;
    }
    ok(true)
}

#[cfg(not(windows))]
pub async fn set_activity(_activity: Value) -> BridgeResult {
    Err(BridgeError::code("Discord RPC is only available on Windows", "ENOSYS"))
}

#[cfg(not(windows))]
pub async fn disconnect() -> BridgeResult {
    ok(true)
}
