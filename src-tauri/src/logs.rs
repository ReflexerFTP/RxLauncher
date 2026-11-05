// Журнал ядра: %APPDATA%\rxclient\logs\core.log (последние ~2 МБ, при переполнении — core.old.log)
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_SIZE: u64 = 2 * 1024 * 1024;

pub fn init() {
    let _ = std::fs::create_dir_all(crate::paths::logs_dir());
}

pub fn write(level: &str, message: &str) {
    let _guard = LOCK.lock();
    let dir = crate::paths::logs_dir();
    let file = dir.join("core.log");
    if std::fs::metadata(&file).map(|m| m.len() > MAX_SIZE).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("core.old.log"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(handle, "{now} [{level}] {message}");
    }
    #[cfg(debug_assertions)]
    eprintln!("[{level}] {message}");
}
