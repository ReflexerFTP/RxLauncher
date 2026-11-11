// Файловые операции для модуля fs интерфейса — с поведением и кодами ошибок как в Node.js
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha1::Digest;
use tauri::{AppHandle, Manager};

use crate::bridge::{arg_bool, arg_str, arg_u64, bytes, ok, BridgeError, BridgeResult};
use crate::state::AppState;

// io::Error → ошибка в стиле Node: "ENOENT: no such file or directory, open 'C:\…'"
pub fn io_error(error: std::io::Error, syscall: &str, path: &str, dest: Option<&str>) -> BridgeError {
    use std::io::ErrorKind::*;
    let by_os = match error.raw_os_error() {
        Some(2) | Some(3) | Some(53) | Some(161) => Some(("ENOENT", -4058, "no such file or directory")),
        Some(5) => Some(("EPERM", -4048, "operation not permitted")),
        Some(32) | Some(33) => Some(("EBUSY", -4082, "resource busy or locked")),
        Some(80) | Some(183) => Some(("EEXIST", -4075, "file already exists")),
        Some(145) => Some(("ENOTEMPTY", -4051, "directory not empty")),
        Some(267) => Some(("ENOTDIR", -4052, "not a directory")),
        Some(112) | Some(39) => Some(("ENOSPC", -4055, "no space left on device")),
        Some(17) => Some(("EXDEV", -4037, "cross-device link not permitted")),
        Some(123) | Some(87) => Some(("EINVAL", -4071, "invalid argument")),
        Some(206) => Some(("ENAMETOOLONG", -4064, "name too long")),
        _ => None,
    };
    let (code, errno, description) = by_os.unwrap_or(match error.kind() {
        NotFound => ("ENOENT", -4058, "no such file or directory"),
        AlreadyExists => ("EEXIST", -4075, "file already exists"),
        PermissionDenied => ("EPERM", -4048, "operation not permitted"),
        InvalidInput | InvalidData => ("EINVAL", -4071, "invalid argument"),
        _ => ("EIO", -4070, "i/o error"),
    });
    let message = match dest {
        Some(dest) => format!("{code}: {description}, {syscall} '{path}' -> '{dest}'"),
        None => format!("{code}: {description}, {syscall} '{path}'"),
    };
    BridgeError {
        message,
        code: Some(code.into()),
        errno: Some(errno),
        syscall: Some(syscall.into()),
        path: Some(path.into()),
        dest: dest.map(Into::into),
        status: None,
    }
}

fn node_error(code: &str, errno: i32, description: &str, syscall: &str, path: &str) -> BridgeError {
    io_error_custom(code, errno, &format!("{code}: {description}, {syscall} '{path}'"), syscall, path)
}

fn io_error_custom(code: &str, errno: i32, message: &str, syscall: &str, path: &str) -> BridgeError {
    BridgeError {
        message: message.into(),
        code: Some(code.into()),
        errno: Some(errno),
        syscall: Some(syscall.into()),
        path: Some(path.into()),
        ..Default::default()
    }
}

fn millis(time: std::io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn kind_of(file_type: fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "dir"
    } else {
        "file"
    }
}

pub fn stat_json(meta: &fs::Metadata) -> Value {
    let kind = kind_of(meta.file_type());
    // Как Node на Windows: 0o40666 / 0o100666 (0o100444 у файлов только для чтения)
    let mode = match kind {
        "dir" => 0o40666,
        "symlink" => 0o120666,
        _ if meta.permissions().readonly() => 0o100444,
        _ => 0o100666,
    };
    json!({
        "kind": kind,
        "size": meta.len(),
        "mode": mode,
        "atimeMs": millis(meta.accessed()),
        "mtimeMs": millis(meta.modified()),
        "ctimeMs": millis(meta.modified()),
        "birthtimeMs": millis(meta.created()),
        "nlink": 1,
    })
}

fn open_with_flags(path: &str, flags: &str) -> Result<File, BridgeError> {
    let mut options = OpenOptions::new();
    match flags {
        "r" | "rs" | "sr" => options.read(true),
        "r+" | "rs+" | "sr+" => options.read(true).write(true),
        "w" => options.write(true).create(true).truncate(true),
        "wx" | "xw" => options.write(true).create_new(true),
        "w+" => options.read(true).write(true).create(true).truncate(true),
        "wx+" | "xw+" => options.read(true).write(true).create_new(true),
        "a" | "as" | "sa" => options.append(true).create(true),
        "ax" | "xa" => options.append(true).create_new(true),
        "a+" | "as+" | "sa+" => options.read(true).append(true).create(true),
        "ax+" | "xa+" => options.read(true).append(true).create_new(true),
        other => return Err(BridgeError::code(format!("Unknown file open flag: {other}"), "ERR_INVALID_ARG_VALUE")),
    };
    options.open(path).map_err(|e| io_error(e, "open", path, None))
}

fn clear_readonly(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

// Удаление папки целиком, включая файлы «только для чтения» (Node с force делает так же)
fn remove_dir_all_force(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            for entry in walk(path) {
                clear_readonly(&entry);
            }
            fs::remove_dir_all(path)
        }
        Err(error) => Err(error),
    }
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
    }
    out
}

fn copy_recursive(from: &Path, to: &Path, force: bool, error_on_exist: bool) -> Result<(), BridgeError> {
    let meta = fs::symlink_metadata(from).map_err(|e| io_error(e, "lstat", &from.to_string_lossy(), None))?;
    if meta.is_dir() {
        fs::create_dir_all(to).map_err(|e| io_error(e, "mkdir", &to.to_string_lossy(), None))?;
        for entry in fs::read_dir(from).map_err(|e| io_error(e, "scandir", &from.to_string_lossy(), None))? {
            let entry = entry.map_err(|e| io_error(e, "scandir", &from.to_string_lossy(), None))?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()), force, error_on_exist)?;
        }
        return Ok(());
    }
    if to.exists() {
        if !force {
            if error_on_exist {
                return Err(io_error_custom("ERR_FS_CP_EEXIST", -4075, &format!("Target already exists: cp returned EEXIST ({} already exists)", to.display()), "cp", &to.to_string_lossy()));
            }
            return Ok(());
        }
        clear_readonly(to);
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error(e, "mkdir", &parent.to_string_lossy(), None))?;
    }
    fs::copy(from, to).map_err(|e| io_error(e, "copyfile", &from.to_string_lossy(), Some(&to.to_string_lossy())))?;
    Ok(())
}

fn hasher_hex(algorithm: &str, reader: &mut dyn Read) -> Result<String, BridgeError> {
    let mut buffer = vec![0u8; 256 * 1024];
    macro_rules! digest {
        ($hasher:expr) => {{
            let mut hasher = $hasher;
            loop {
                let count = reader.read(&mut buffer).map_err(|e| BridgeError::new(e.to_string()))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            hex::encode(hasher.finalize())
        }};
    }
    Ok(match algorithm {
        "sha1" => digest!(sha1::Sha1::new()),
        "sha256" => digest!(sha2::Sha256::new()),
        "sha512" => digest!(sha2::Sha512::new()),
        "md5" => digest!(md5::Md5::new()),
        other => return Err(BridgeError::new(format!("Digest method not supported: {other}"))),
    })
}

pub fn hash_bytes(algorithm: &str, data: &[u8]) -> Result<String, BridgeError> {
    hasher_hex(algorithm, &mut std::io::Cursor::new(data))
}

pub fn hash_file(algorithm: &str, path: &Path) -> Result<String, BridgeError> {
    let mut file = File::open(path).map_err(|e| io_error(e, "open", &path.to_string_lossy(), None))?;
    hasher_hex(algorithm, &mut file)
}

pub fn zlib(args: &Value, data: &[u8]) -> BridgeResult {
    use flate2::read::{DeflateDecoder, DeflateEncoder, GzDecoder, GzEncoder, ZlibDecoder, ZlibEncoder};
    use flate2::Compression;
    let op = arg_str(args, "op")?;
    let max = arg_u64(args, "maxOutputLength").unwrap_or(512 * 1024 * 1024);
    let level = args.get("level").and_then(Value::as_i64).filter(|l| (0..=9).contains(l)).map(|l| Compression::new(l as u32)).unwrap_or_default();
    let reader: Box<dyn Read> = match op {
        "inflateRaw" => Box::new(DeflateDecoder::new(data)),
        "deflateRaw" => Box::new(DeflateEncoder::new(data, level)),
        "inflate" => Box::new(ZlibDecoder::new(data)),
        "deflate" => Box::new(ZlibEncoder::new(data, level)),
        "gunzip" => Box::new(GzDecoder::new(data)),
        "gzip" => Box::new(GzEncoder::new(data, level)),
        "unzip" => {
            if data.len() > 1 && data[0] == 0x1f && data[1] == 0x8b {
                Box::new(GzDecoder::new(data))
            } else {
                Box::new(ZlibDecoder::new(data))
            }
        }
        other => return Err(BridgeError::new(format!("Unknown zlib operation: {other}"))),
    };
    let mut out = Vec::new();
    reader
        .take(max + 1)
        .read_to_end(&mut out)
        .map_err(|e| BridgeError::code(format!("{e}"), "Z_DATA_ERROR"))?;
    if out.len() as u64 > max {
        return Err(BridgeError::code("Cannot create a Buffer larger than maxOutputLength", "ERR_BUFFER_TOO_LARGE"));
    }
    bytes(out)
}

#[cfg(windows)]
fn disk_free(path: &str) -> Result<(u64, u64, u64), BridgeError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok == 0 {
        return Err(io_error(std::io::Error::last_os_error(), "statfs", path, None));
    }
    Ok((available, total, free))
}

#[cfg(not(windows))]
fn disk_free(_path: &str) -> Result<(u64, u64, u64), BridgeError> {
    Ok((u64::MAX / 2, u64::MAX / 2, u64::MAX / 2))
}

// Список папки вместе с размером и временем изменения — одним обращением вместо readdir и stat на каждый файл.
// depth — сколько уровней читать (1 — только сама папка), head — сколько первых байт каждого файла вернуть (hex)
pub fn list_dir(root: &Path, depth: u64, head: usize, limit: usize) -> std::io::Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut queue: Vec<(PathBuf, String, u64)> = vec![(root.to_path_buf(), String::new(), 1)];
    while let Some((dir, prefix, level)) = queue.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if level == 1 => return Err(error),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= limit {
                return Ok(out);
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let relative = if prefix.is_empty() { name } else { format!("{prefix}\\{name}") };
            let kind = entry.file_type().map(kind_of).unwrap_or("file");
            // Метаданные берутся из записи каталога: файл не открывается, ссылки не раскрываются
            let meta = entry.metadata().ok();
            let mut item = json!({
                "name": relative,
                "kind": kind,
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "mtimeMs": meta.as_ref().map(|m| millis(m.modified())).unwrap_or(0.0),
            });
            if head > 0 && kind == "file" {
                let mut buffer = vec![0u8; head];
                let count = File::open(entry.path()).and_then(|mut file| file.read(&mut buffer)).unwrap_or(0);
                item["head"] = json!(hex::encode(&buffer[..count]));
            }
            if kind == "dir" && level < depth {
                queue.push((entry.path(), relative, level + 1));
            }
            out.push(item);
        }
    }
    Ok(out)
}

fn with_fd<T>(app: &AppHandle, fd: u64, f: impl FnOnce(&mut File) -> Result<T, BridgeError>) -> Result<T, BridgeError> {
    let state = app.state::<AppState>();
    let mut table = state.files.lock().map_err(|_| BridgeError::new("File table poisoned"))?;
    let file = table
        .open
        .get_mut(&(fd as u32))
        .ok_or_else(|| io_error_custom("EBADF", -4083, "EBADF: bad file descriptor", "read", ""))?;
    f(file)
}

pub fn run(app: &AppHandle, op: &str, args: &Value, payload: Vec<u8>) -> BridgeResult {
    match op {
        "exists" => ok(Path::new(arg_str(args, "path")?).exists()),
        "stat" => {
            let path = arg_str(args, "path")?;
            let meta = if arg_bool(args, "lstat") { fs::symlink_metadata(path) } else { fs::metadata(path) };
            let meta = meta.map_err(|e| io_error(e, if arg_bool(args, "lstat") { "lstat" } else { "stat" }, path, None))?;
            ok(stat_json(&meta))
        }
        "readFile" => {
            let path = arg_str(args, "path")?;
            if Path::new(path).is_dir() {
                return Err(node_error("EISDIR", -4068, "illegal operation on a directory", "read", path));
            }
            bytes(fs::read(path).map_err(|e| io_error(e, "open", path, None))?)
        }
        "writeFile" => {
            let path = arg_str(args, "path")?;
            let flag = args.get("flag").and_then(Value::as_str).unwrap_or("w");
            let mut file = open_with_flags(path, flag)?;
            file.write_all(&payload).map_err(|e| io_error(e, "write", path, None))?;
            ok(Value::Null)
        }
        "readdir" => {
            let path = arg_str(args, "path")?;
            let mut list = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| io_error(e, "scandir", path, None))? {
                let entry = entry.map_err(|e| io_error(e, "scandir", path, None))?;
                let kind = entry.file_type().map(kind_of).unwrap_or("file");
                list.push(json!({"name": entry.file_name().to_string_lossy(), "kind": kind}));
            }
            ok(list)
        }
        "list" => {
            let path = arg_str(args, "path")?;
            let depth = arg_u64(args, "depth").unwrap_or(1).clamp(1, 8);
            let head = arg_u64(args, "head").unwrap_or(0).min(64) as usize;
            let limit = arg_u64(args, "limit").unwrap_or(20_000).clamp(1, 200_000) as usize;
            ok(list_dir(Path::new(path), depth, head, limit).map_err(|e| io_error(e, "scandir", path, None))?)
        }
        "mkdir" => {
            let path = arg_str(args, "path")?;
            if arg_bool(args, "recursive") {
                let target = Path::new(path);
                if target.is_dir() {
                    return ok(Value::Null);
                }
                // Node возвращает первую созданную папку
                let mut first = target.to_path_buf();
                while let Some(parent) = first.parent() {
                    if parent.as_os_str().is_empty() || parent.exists() {
                        break;
                    }
                    first = parent.to_path_buf();
                }
                fs::create_dir_all(target).map_err(|e| io_error(e, "mkdir", path, None))?;
                ok(first.to_string_lossy())
            } else {
                fs::create_dir(path).map_err(|e| io_error(e, "mkdir", path, None))?;
                ok(Value::Null)
            }
        }
        "rm" => {
            let path = arg_str(args, "path")?;
            let target = Path::new(path);
            let meta = match fs::symlink_metadata(target) {
                Ok(meta) => meta,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && arg_bool(args, "force") => return ok(Value::Null),
                Err(error) => return Err(io_error(error, "stat", path, None)),
            };
            if meta.is_dir() {
                if !arg_bool(args, "recursive") {
                    return Err(io_error_custom("ERR_FS_EISDIR", -4068, &format!("Path is a directory: rm returned EISDIR (is a directory) {path}"), "rm", path));
                }
                remove_dir_all_force(target).map_err(|e| io_error(e, "rm", path, None))?;
            } else {
                if fs::remove_file(target).is_err() {
                    clear_readonly(target);
                    fs::remove_file(target).map_err(|e| io_error(e, "unlink", path, None))?;
                }
            }
            ok(Value::Null)
        }
        "rmdir" => {
            let path = arg_str(args, "path")?;
            let result = if arg_bool(args, "recursive") { remove_dir_all_force(Path::new(path)) } else { fs::remove_dir(path) };
            result.map_err(|e| io_error(e, "rmdir", path, None))?;
            ok(Value::Null)
        }
        "unlink" => {
            let path = arg_str(args, "path")?;
            if Path::new(path).is_dir() {
                return Err(node_error("EPERM", -4048, "operation not permitted", "unlink", path));
            }
            fs::remove_file(path).map_err(|e| io_error(e, "unlink", path, None))?;
            ok(Value::Null)
        }
        "rename" => {
            let (from, to) = (arg_str(args, "from")?, arg_str(args, "to")?);
            fs::rename(from, to).map_err(|e| io_error(e, "rename", from, Some(to)))?;
            ok(Value::Null)
        }
        "copyFile" => {
            let (from, to) = (arg_str(args, "from")?, arg_str(args, "to")?);
            if arg_bool(args, "exclusive") && Path::new(to).exists() {
                return Err(BridgeError {
                    message: format!("EEXIST: file already exists, copyfile '{from}' -> '{to}'"),
                    code: Some("EEXIST".into()),
                    errno: Some(-4075),
                    syscall: Some("copyfile".into()),
                    path: Some(from.into()),
                    dest: Some(to.into()),
                    status: None,
                });
            }
            fs::copy(from, to).map_err(|e| io_error(e, "copyfile", from, Some(to)))?;
            ok(Value::Null)
        }
        "cp" => {
            let (from, to) = (arg_str(args, "from")?, arg_str(args, "to")?);
            if Path::new(from).is_dir() && !arg_bool(args, "recursive") {
                return Err(io_error_custom("ERR_FS_EISDIR", -4068, &format!("Recursive option is required to copy a directory: cp returned EISDIR ({from} is a directory (not copied))"), "cp", from));
            }
            let force = args.get("force").and_then(Value::as_bool).unwrap_or(true);
            copy_recursive(Path::new(from), Path::new(to), force, arg_bool(args, "errorOnExist"))?;
            ok(Value::Null)
        }
        "realpath" => {
            let path = arg_str(args, "path")?;
            ok(dunce::canonicalize(path).map_err(|e| io_error(e, "realpath", path, None))?.to_string_lossy())
        }
        "mkdtemp" => {
            let prefix = arg_str(args, "prefix")?;
            use rand::Rng;
            for _ in 0..16 {
                let suffix: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(6).map(char::from).collect();
                let candidate = format!("{prefix}{suffix}");
                match fs::create_dir(&candidate) {
                    Ok(()) => return ok(candidate),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(io_error(error, "mkdtemp", prefix, None)),
                }
            }
            Err(node_error("EEXIST", -4075, "file already exists", "mkdtemp", prefix))
        }
        "statfs" => {
            let path = arg_str(args, "path")?;
            let (available, total, free) = disk_free(path)?;
            ok(json!({"type": 0, "bsize": 4096, "blocks": total / 4096, "bfree": free / 4096, "bavail": available / 4096, "files": 0, "ffree": 0}))
        }
        "access" => {
            let path = arg_str(args, "path")?;
            let meta = fs::metadata(path).map_err(|e| io_error(e, "access", path, None))?;
            let mode = arg_u64(args, "mode").unwrap_or(0);
            if mode & 2 != 0 && meta.permissions().readonly() {
                return Err(node_error("EACCES", -4092, "permission denied", "access", path));
            }
            ok(Value::Null)
        }
        "open" => {
            let path = arg_str(args, "path")?;
            let flags = args.get("flags").and_then(Value::as_str).unwrap_or("r");
            let file = open_with_flags(path, flags)?;
            let state = app.state::<AppState>();
            let mut table = state.files.lock().map_err(|_| BridgeError::new("File table poisoned"))?;
            ok(table.insert(file))
        }
        "read" => {
            let fd = arg_u64(args, "fd").unwrap_or(0);
            let length = arg_u64(args, "length").unwrap_or(0).min(64 * 1024 * 1024) as usize;
            let position = arg_u64(args, "position");
            with_fd(app, fd, |file| {
                if let Some(position) = position {
                    file.seek(SeekFrom::Start(position)).map_err(|e| io_error(e, "read", "", None))?;
                }
                let mut buffer = vec![0u8; length];
                let mut filled = 0;
                while filled < length {
                    let count = file.read(&mut buffer[filled..]).map_err(|e| io_error(e, "read", "", None))?;
                    if count == 0 {
                        break;
                    }
                    filled += count;
                }
                buffer.truncate(filled);
                bytes(buffer)
            })
        }
        "readFd" => {
            let fd = arg_u64(args, "fd").unwrap_or(0);
            with_fd(app, fd, |file| {
                let mut out = Vec::new();
                file.read_to_end(&mut out).map_err(|e| io_error(e, "read", "", None))?;
                bytes(out)
            })
        }
        "write" => {
            let fd = arg_u64(args, "fd").unwrap_or(0);
            let position = arg_u64(args, "position");
            with_fd(app, fd, |file| {
                if let Some(position) = position {
                    file.seek(SeekFrom::Start(position)).map_err(|e| io_error(e, "write", "", None))?;
                }
                file.write_all(&payload).map_err(|e| io_error(e, "write", "", None))?;
                ok(payload.len())
            })
        }
        "fstat" => {
            let fd = arg_u64(args, "fd").unwrap_or(0);
            with_fd(app, fd, |file| ok(stat_json(&file.metadata().map_err(|e| io_error(e, "fstat", "", None))?)))
        }
        "fsync" => {
            let fd = arg_u64(args, "fd").unwrap_or(0);
            with_fd(app, fd, |file| {
                file.sync_all().map_err(|e| io_error(e, "fsync", "", None))?;
                ok(Value::Null)
            })
        }
        "close" => {
            let fd = arg_u64(args, "fd").unwrap_or(0) as u32;
            let state = app.state::<AppState>();
            let mut table = state.files.lock().map_err(|_| BridgeError::new("File table poisoned"))?;
            if table.open.remove(&fd).is_none() {
                return Err(io_error_custom("EBADF", -4083, "EBADF: bad file descriptor, close", "close", ""));
            }
            ok(Value::Null)
        }
        "truncate" => {
            let path = arg_str(args, "path")?;
            let file = OpenOptions::new().write(true).open(path).map_err(|e| io_error(e, "open", path, None))?;
            file.set_len(arg_u64(args, "length").unwrap_or(0)).map_err(|e| io_error(e, "ftruncate", path, None))?;
            ok(Value::Null)
        }
        "utimes" => {
            let path = arg_str(args, "path")?;
            let to_time = |key: &str| UNIX_EPOCH + Duration::from_millis(arg_u64(args, key).unwrap_or(0));
            let file = OpenOptions::new().write(true).open(path).map_err(|e| io_error(e, "utime", path, None))?;
            file.set_times(fs::FileTimes::new().set_accessed(to_time("atimeMs")).set_modified(to_time("mtimeMs")))
                .map_err(|e| io_error(e, "utime", path, None))?;
            ok(Value::Null)
        }
        "hashFile" => {
            let path = arg_str(args, "path")?;
            ok(hash_file(arg_str(args, "algorithm")?, Path::new(path))?)
        }
        other => Err(BridgeError::code(format!("Unknown fs operation: {other}"), "ENOSYS")),
    }
}
