// Протокол rxsync:// — единственный вход из интерфейса в ядро (кроме подписки на события).
// Запрос: POST /<операция>, тело [u32 LE длина JSON][JSON-аргументы][двоичные данные].
// Ответ (всегда 200): [u8 0 — успех, 1 — ошибка][u32 LE длина JSON][JSON][двоичные данные].
// Принимаются только запросы со страницы самого лаунчера (проверка Origin)
use serde::Serialize;
use serde_json::Value;
use tauri::http::{Request, Response};
use tauri::{AppHandle, UriSchemeResponder};

pub type Reply = (Value, Option<Vec<u8>>);

#[derive(Debug, Serialize, Default)]
pub struct BridgeError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errno: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syscall: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl BridgeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), ..Default::default() }
    }

    pub fn code(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: Some(code.to_string()), ..Default::default() }
    }
}

impl From<String> for BridgeError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&str> for BridgeError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

pub type BridgeResult = Result<Reply, BridgeError>;

pub fn ok(value: impl Serialize) -> BridgeResult {
    Ok((serde_json::to_value(value).map_err(|e| BridgeError::new(e.to_string()))?, None))
}

pub fn bytes(data: Vec<u8>) -> BridgeResult {
    Ok((Value::Null, Some(data)))
}

// Аргументы
pub fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, BridgeError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::code(format!("The \"{key}\" argument must be of type string"), "ERR_INVALID_ARG_TYPE"))
}

pub fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}

// Страницы самого лаунчера; в отладочной сборке ещё и локальный сервер интерфейса
fn origin_allowed(origin: &str) -> bool {
    if matches!(origin, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost") {
        return true;
    }
    #[cfg(feature = "devui")]
    if origin == "http://127.0.0.1:1420" || origin == "http://localhost:1420" {
        return true;
    }
    false
}

fn encode(result: BridgeResult) -> Vec<u8> {
    let (status, json, payload) = match result {
        Ok((value, payload)) => (0u8, serde_json::to_vec(&value).unwrap_or_else(|_| b"null".to_vec()), payload.unwrap_or_default()),
        Err(error) => (1u8, serde_json::to_vec(&error).unwrap_or_else(|_| b"{\"message\":\"error\"}".to_vec()), Vec::new()),
    };
    let mut out = Vec::with_capacity(5 + json.len() + payload.len());
    out.push(status);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&payload);
    out
}

fn decode_request(body: &[u8]) -> Result<(Value, Vec<u8>), BridgeError> {
    if body.len() < 4 {
        return Err(BridgeError::new("Malformed request"));
    }
    let length = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + length {
        return Err(BridgeError::new("Malformed request"));
    }
    let args = if length == 0 { Value::Null } else { serde_json::from_slice(&body[4..4 + length]).map_err(|e| BridgeError::new(format!("Bad request JSON: {e}")))? };
    Ok((args, body[4 + length..].to_vec()))
}

fn response(origin: &str, status: u16, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", origin)
        .header("Access-Control-Allow-Methods", "POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "*")
        .header("Content-Type", "application/octet-stream")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !origin_allowed(&origin) {
        crate::logs::write("warn", &format!("rxsync: rejected request from origin '{origin}'"));
        responder.respond(Response::builder().status(403).body(Vec::new()).unwrap_or_else(|_| Response::new(Vec::new())));
        return;
    }
    if request.method() == "OPTIONS" {
        responder.respond(response(&origin, 204, Vec::new()));
        return;
    }
    let op = percent_encoding::percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8_lossy()
        .to_string();
    let body = request.into_body();
    tauri::async_runtime::spawn(async move {
        let result = match decode_request(&body) {
            Ok((args, payload)) => dispatch(&app, &op, args, payload).await,
            Err(error) => Err(error),
        };
        responder.respond(response(&origin, 200, encode(result)));
    });
}

// Тяжёлая синхронная работа — в отдельном потоке, чтобы не держать async-рантайм
pub async fn blocking<F>(task: F) -> BridgeResult
where
    F: FnOnce() -> BridgeResult + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .unwrap_or_else(|error| Err(BridgeError::new(format!("Task failed: {error}"))))
}

async fn dispatch(app: &AppHandle, op: &str, args: Value, payload: Vec<u8>) -> BridgeResult {
    if let Some(fs_op) = op.strip_prefix("fs.") {
        let app = app.clone();
        let fs_op = fs_op.to_string();
        return blocking(move || crate::fsops::run(&app, &fs_op, &args, payload)).await;
    }
    if let Some(http_op) = op.strip_prefix("http.") {
        return crate::http::run(app, http_op, args, payload).await;
    }
    match op {
        "ipc" => crate::ipc::dispatch(app, args).await,
        "game.launch" => crate::game::launch(app, args).await,
        "system.info" => ok(crate::system::info(app)),
        "system.freemem" => ok(crate::system::free_memory()),
        "system.uptime" => ok(crate::system::uptime()),
        "app.paths" => {
            let state = tauri::Manager::state::<crate::state::AppState>(app);
            ok(serde_json::json!({"webRoot": state.web_root, "userData": state.user_data}))
        }
        "hash" => {
            let algorithm = arg_str(&args, "algorithm")?.to_string();
            blocking(move || ok(crate::fsops::hash_bytes(&algorithm, &payload)?)).await
        }
        "zlib" => blocking(move || crate::fsops::zlib(&args, &payload)).await,
        "log" => {
            let level = args.get("level").and_then(Value::as_str).unwrap_or("info");
            crate::logs::write(level, args.get("message").and_then(Value::as_str).unwrap_or(""));
            ok(Value::Null)
        }
        "shell.openExternal" => crate::window::open_external(app, arg_str(&args, "url")?),
        "shell.openPath" => crate::window::open_path(app, arg_str(&args, "path")?),
        "shell.showItemInFolder" => crate::window::show_in_folder(app, arg_str(&args, "path")?),
        "shell.trash" => {
            let target = arg_str(&args, "path")?.to_string();
            blocking(move || trash::delete(&target).map(|_| (Value::Null, None)).map_err(|e| BridgeError::new(e.to_string()))).await
        }
        "clipboard.writeText" => crate::window::clipboard_write(arg_str(&args, "text")?),
        "clipboard.readText" => crate::window::clipboard_read(),
        "process.killTree" => crate::system::kill_tree(arg_u64(&args, "pid").unwrap_or(0) as u32),
        _ => Err(BridgeError::code(format!("Unknown launcher core operation: {op}"), "ENOSYS")),
    }
}
