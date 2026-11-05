// Сведения о системе для модулей os и process интерфейса, завершение дерева процессов игры
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::bridge::{ok, BridgeResult};

fn registry_string(path: &str, name: &str) -> Option<String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(path).ok()?;
    key.get_value::<String, _>(name).ok()
}

fn registry_u32(path: &str, name: &str) -> Option<u32> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(path).ok()?;
    key.get_value::<u32, _>(name).ok()
}

#[cfg(windows)]
fn memory() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return (0, 0);
    }
    (status.ullTotalPhys, status.ullAvailPhys)
}

#[cfg(not(windows))]
fn memory() -> (u64, u64) {
    (0, 0)
}

pub fn free_memory() -> u64 {
    memory().1
}

pub fn uptime() -> f64 {
    #[cfg(windows)]
    {
        (unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }) as f64 / 1000.0
    }
    #[cfg(not(windows))]
    {
        0.0
    }
}

const NT: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
const CPU: &str = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";

pub fn info(app: &AppHandle) -> Value {
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    let build: u32 = registry_string(NT, "CurrentBuildNumber").and_then(|b| b.parse().ok()).unwrap_or(0);
    let major = registry_u32(NT, "CurrentMajorVersionNumber").unwrap_or(10);
    let minor = registry_u32(NT, "CurrentMinorVersionNumber").unwrap_or(0);
    // ProductName на Windows 11 всё ещё «Windows 10 …» — как Node, поправляем по номеру сборки
    let mut product = registry_string(NT, "ProductName").unwrap_or_else(|| "Windows".into());
    if build >= 22000 {
        product = product.replace("Windows 10", "Windows 11");
    }
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    let environment: serde_json::Map<String, Value> = std::env::vars().map(|(k, v)| (k, Value::String(v))).collect();
    let resources = app.path().resource_dir().map(|p| dunce::simplified(&p).to_path_buf()).unwrap_or_default();
    json!({
        "arch": arch,
        "release": format!("{major}.{minor}.{build}"),
        "version": product,
        "hostname": env("COMPUTERNAME"),
        "homedir": env("USERPROFILE"),
        "tmpdir": std::env::temp_dir().to_string_lossy().trim_end_matches('\\'),
        "totalmem": memory().0,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "cpuModel": registry_string(CPU, "ProcessorNameString").map(|s| s.trim().to_string()).unwrap_or_default(),
        "cpuSpeed": registry_u32(CPU, "~MHz").unwrap_or(0),
        "username": env("USERNAME"),
        "env": environment,
        "pid": std::process::id(),
        "execPath": std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "resourcesPath": resources,
        "cwd": std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "versions": {
            "rxlauncher": app.package_info().version.to_string(),
            "tauri": tauri::VERSION,
            "webview": tauri::webview_version().unwrap_or_default(),
            "chrome": tauri::webview_version().unwrap_or_default(),
            "node": "",
            "electron": ""
        }
    })
}

// Завершить процесс со всеми дочерними (Minecraft запускает Java, та — свои процессы)
pub fn kill_tree(pid: u32) -> BridgeResult {
    if pid == 0 || pid == std::process::id() {
        return Err("Invalid process id".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| crate::bridge::BridgeError::new(e.to_string()))?;
        if !status.success() {
            crate::logs::write("warn", &format!("taskkill {pid} exited with {status}"));
        }
    }
    ok(Value::Null)
}
