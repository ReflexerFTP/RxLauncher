// Прямой опрос сервера Minecraft (Server List Ping): handshake → status → ping. Используется, когда
// HTTPS-сервисы статуса не ответили (allowDirect)
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::bridge::{arg_str, arg_u64, ok, BridgeError, BridgeResult};

fn varint(mut value: i32, out: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value = ((value as u32) >> 7) as i32;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32, BridgeError> {
    let mut result: i32 = 0;
    for shift in 0..5 {
        let byte = stream.read_u8().await.map_err(|e| BridgeError::new(e.to_string()))?;
        result |= ((byte & 0x7f) as i32) << (7 * shift);
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    Err(BridgeError::new("VarInt is too big"))
}

fn packet(id: i32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::new();
    varint(id, &mut inner);
    inner.extend_from_slice(body);
    let mut out = Vec::new();
    varint(inner.len() as i32, &mut out);
    out.extend(inner);
    out
}

async fn query(host: &str, port: u16) -> Result<Value, BridgeError> {
    let started = Instant::now();
    let mut stream = TcpStream::connect((host, port)).await.map_err(|e| BridgeError::new(e.to_string()))?;
    stream.set_nodelay(true).ok();
    let mut handshake = Vec::new();
    varint(-1, &mut handshake); // версия протокола: «любая» для статуса
    varint(host.len() as i32, &mut handshake);
    handshake.extend_from_slice(host.as_bytes());
    handshake.extend_from_slice(&port.to_be_bytes());
    varint(1, &mut handshake);
    stream.write_all(&packet(0x00, &handshake)).await.map_err(|e| BridgeError::new(e.to_string()))?;
    stream.write_all(&packet(0x00, &[])).await.map_err(|e| BridgeError::new(e.to_string()))?;
    let length = read_varint(&mut stream).await?;
    if !(1..=2 * 1024 * 1024).contains(&length) {
        return Err(BridgeError::new("Bad status packet"));
    }
    let id = read_varint(&mut stream).await?;
    if id != 0 {
        return Err(BridgeError::new("Unexpected status packet"));
    }
    let text_length = read_varint(&mut stream).await?;
    if !(1..=2 * 1024 * 1024).contains(&text_length) {
        return Err(BridgeError::new("Bad status payload"));
    }
    let mut text = vec![0u8; text_length as usize];
    stream.read_exact(&mut text).await.map_err(|e| BridgeError::new(e.to_string()))?;
    let latency = started.elapsed().as_millis() as u64;
    let status: Value = serde_json::from_slice(&text).map_err(|e| BridgeError::new(format!("Bad status JSON: {e}")))?;
    Ok(json!({"status": status, "ping": latency}))
}

pub async fn mcping(args: Value) -> BridgeResult {
    let host = arg_str(&args, "host")?.to_string();
    if host.is_empty() || host.len() > 255 || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')) {
        return Err("Invalid host".into());
    }
    let port = arg_u64(&args, "port").unwrap_or(25565).clamp(1, 65535) as u16;
    let timeout = Duration::from_millis(arg_u64(&args, "timeout").unwrap_or(6500).clamp(500, 15000));
    match tokio::time::timeout(timeout, query(&host, port)).await {
        Ok(Ok(value)) => ok(value),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(BridgeError::code("Server did not answer", "ETIMEDOUT")),
    }
}
