// Архивы: список и выборочное чтение записей jar/zip (метаданные модов и ресурспаков), безопасная распаковка zip/tar/tar.gz,
// упаковка папки (копии миров) и набора файлов (экспорт .mrpack). Распаковка не выходит за папку назначения,
// не создаёт ссылок и ограничена по числу записей и объёму
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::bridge::{arg_str, arg_u64, ok, BridgeError, BridgeResult};

const MAX_ENTRIES: usize = 100_000;
const MAX_TOTAL: u64 = 8 * 1024 * 1024 * 1024;

fn open_zip_source(args: &Value, payload: Vec<u8>) -> Result<zip::ZipArchive<Box<dyn ReadSeek>>, BridgeError> {
    let reader: Box<dyn ReadSeek> = match args.get("path").and_then(Value::as_str) {
        Some(path) => Box::new(File::open(path).map_err(|e| crate::fsops::io_error(e, "open", path, None))?),
        None => Box::new(Cursor::new(payload)),
    };
    zip::ZipArchive::new(reader).map_err(|e| BridgeError::code(format!("Invalid zip archive: {e}"), "EBADZIP"))
}

pub trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

fn is_symlink(mode: Option<u32>) -> bool {
    mode.map(|mode| mode & 0o170000 == 0o120000).unwrap_or(false)
}

// Относительный путь записи без выхода наружу, дисков, устройств Windows и управляющих символов
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.len() > 1024 || name.contains('\0') || name.contains(':') || name.starts_with('/') || name.starts_with('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        let lower = part.to_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        if part == ".." || part.ends_with(' ') || part.ends_with('.') || part.chars().any(|c| (c as u32) < 32)
            || matches!(stem, "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9" | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9") {
            return None;
        }
        out.push(part);
    }
    if out.components().any(|c| !matches!(c, Component::Normal(_))) || out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

fn list(args: &Value, payload: Vec<u8>) -> BridgeResult {
    let mut archive = open_zip_source(args, payload)?;
    let mut entries = Vec::new();
    for index in 0..archive.len().min(50_000) {
        let entry = archive.by_index_raw(index).map_err(|e| BridgeError::new(e.to_string()))?;
        entries.push(json!({
            "name": entry.name(),
            "size": entry.size(),
            "dir": entry.is_dir(),
            "encrypted": entry.encrypted(),
            "symlink": is_symlink(entry.unix_mode()),
        }));
    }
    ok(entries)
}

fn read(args: &Value, payload: Vec<u8>) -> BridgeResult {
    let names: Vec<String> = args.get("names").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let max = arg_u64(args, "maxBytes").unwrap_or(2 * 1024 * 1024);
    let mut archive = open_zip_source(args, payload)?;
    let mut index = Vec::new();
    let mut data = Vec::new();
    for name in names.iter().take(256) {
        let Ok(entry) = archive.by_name(name) else { continue };
        if entry.size() > max || entry.encrypted() || is_symlink(entry.unix_mode()) {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if entry.take(max + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > max || data.len() as u64 + bytes.len() as u64 > max * 2 {
            continue;
        }
        index.push(json!({"name": name, "offset": data.len(), "length": bytes.len()}));
        data.extend(bytes);
    }
    Ok((json!(index), Some(data)))
}

fn create_parent(path: &Path) -> Result<(), BridgeError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::fsops::io_error(e, "mkdir", &parent.to_string_lossy(), None))?;
    }
    Ok(())
}

// Папка назначения не должна идти через ссылки (junction/symlink)
fn no_links(root: &Path, target: &Path) -> Result<(), BridgeError> {
    let relative = target.strip_prefix(root).map_err(|_| BridgeError::new("Archive entry escapes destination"))?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(BridgeError::new("Linked archive destination is forbidden"));
            }
        }
    }
    Ok(())
}

fn unpack_zip(archive_path: &str, destination: &Path) -> Result<usize, BridgeError> {
    let file = File::open(archive_path).map_err(|e| crate::fsops::io_error(e, "open", archive_path, None))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| BridgeError::code(format!("Invalid zip archive: {e}"), "EBADZIP"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(BridgeError::new("Archive has too many entries"));
    }
    // Сначала проверить всё, потом распаковывать
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|e| BridgeError::new(e.to_string()))?;
        if entry.encrypted() || is_symlink(entry.unix_mode()) || safe_relative(entry.name()).is_none() {
            return Err(BridgeError::new(format!("Unsafe archive entry: {}", entry.name())));
        }
        total += entry.size();
        if total > MAX_TOTAL {
            return Err(BridgeError::new("Archive is too large"));
        }
    }
    let mut count = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| BridgeError::new(e.to_string()))?;
        let relative = safe_relative(entry.name()).ok_or("Unsafe archive entry")?;
        let target = destination.join(relative);
        no_links(destination, &target)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| crate::fsops::io_error(e, "mkdir", &target.to_string_lossy(), None))?;
            continue;
        }
        create_parent(&target)?;
        let mut out = File::create(&target).map_err(|e| crate::fsops::io_error(e, "open", &target.to_string_lossy(), None))?;
        let size = entry.size();
        let copied = std::io::copy(&mut (&mut entry).take(size + 1), &mut out).map_err(|e| BridgeError::new(e.to_string()))?;
        if copied > size {
            return Err(BridgeError::new("Archive entry size mismatch"));
        }
        count += 1;
    }
    Ok(count)
}

fn unpack_tar(archive_path: &str, destination: &Path, gzip: bool) -> Result<usize, BridgeError> {
    let file = File::open(archive_path).map_err(|e| crate::fsops::io_error(e, "open", archive_path, None))?;
    let reader: Box<dyn Read> = if gzip { Box::new(flate2::read::GzDecoder::new(file)) } else { Box::new(file) };
    let mut archive = tar::Archive::new(reader);
    let mut count = 0;
    let mut total: u64 = 0;
    for entry in archive.entries().map_err(|e| BridgeError::new(e.to_string()))? {
        let mut entry = entry.map_err(|e| BridgeError::new(e.to_string()))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(BridgeError::new("Archive has too many entries"));
        }
        let kind = entry.header().entry_type();
        let name = entry.path().map_err(|e| BridgeError::new(e.to_string()))?.to_string_lossy().to_string();
        let relative = safe_relative(&name).ok_or_else(|| BridgeError::new(format!("Unsafe archive entry: {name}")))?;
        let target = destination.join(relative);
        no_links(destination, &target)?;
        if kind.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| crate::fsops::io_error(e, "mkdir", &target.to_string_lossy(), None))?;
        } else if kind.is_file() {
            total += entry.size();
            if total > MAX_TOTAL {
                return Err(BridgeError::new("Archive is too large"));
            }
            create_parent(&target)?;
            let mut out = File::create(&target).map_err(|e| crate::fsops::io_error(e, "open", &target.to_string_lossy(), None))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| BridgeError::new(e.to_string()))?;
        } else if !matches!(kind, tar::EntryType::XGlobalHeader | tar::EntryType::XHeader | tar::EntryType::GNULongName) {
            return Err(BridgeError::new(format!("Unsupported archive entry type: {name}")));
        }
    }
    Ok(count)
}

fn unpack(args: &Value) -> BridgeResult {
    let archive = arg_str(args, "archive")?;
    let destination = arg_str(args, "destination")?;
    let kind = arg_str(args, "type")?;
    if !Path::new(archive).is_absolute() || !Path::new(destination).is_absolute() {
        return Err("Invalid archive paths".into());
    }
    std::fs::create_dir_all(destination).map_err(|e| crate::fsops::io_error(e, "mkdir", destination, None))?;
    let root = dunce::canonicalize(destination).map_err(|e| crate::fsops::io_error(e, "realpath", destination, None))?;
    let count = match kind {
        "zip" => unpack_zip(archive, &root)?,
        "tar" => unpack_tar(archive, &root, false)?,
        "tgz" => unpack_tar(archive, &root, true)?,
        _ => return Err("Unsupported archive type".into()),
    };
    ok(json!({"ok": true, "files": count}))
}

fn add_file(writer: &mut zip::ZipWriter<File>, name: &str, source: &Path) -> Result<(), BridgeError> {
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    writer.start_file(name, options).map_err(|e| BridgeError::new(e.to_string()))?;
    let mut input = File::open(source).map_err(|e| crate::fsops::io_error(e, "open", &source.to_string_lossy(), None))?;
    std::io::copy(&mut input, writer).map_err(|e| BridgeError::new(e.to_string()))?;
    Ok(())
}

fn add_dir(writer: &mut zip::ZipWriter<File>, prefix: &str, dir: &Path) -> Result<usize, BridgeError> {
    let mut count = 0;
    let mut stack = vec![(dir.to_path_buf(), prefix.trim_end_matches('/').to_string())];
    while let Some((current, base)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&current).map_err(|e| crate::fsops::io_error(e, "scandir", &current.to_string_lossy(), None))?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let file_type = entry.file_type().map_err(|e| BridgeError::new(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path_in_zip = if base.is_empty() { name.clone() } else { format!("{base}/{name}") };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push((entry.path(), path_in_zip));
            } else {
                // Файл блокировки мира открыт игрой — без него копия не хуже
                if name == "session.lock" {
                    continue;
                }
                add_file(writer, &path_in_zip, &entry.path())?;
                count += 1;
            }
        }
    }
    Ok(count)
}

fn zip_dir(args: &Value) -> BridgeResult {
    let source = PathBuf::from(arg_str(args, "source")?);
    let target = arg_str(args, "target")?;
    let base = if args.get("ignoreBase").and_then(Value::as_bool) == Some(true) {
        String::new()
    } else {
        source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    };
    let file = File::create(target).map_err(|e| crate::fsops::io_error(e, "open", target, None))?;
    let mut writer = zip::ZipWriter::new(file);
    let count = add_dir(&mut writer, &base, &source)?;
    writer.finish().map_err(|e| BridgeError::new(e.to_string()))?;
    ok(json!({"files": count}))
}

// Набор записей: {data: [offset, length] из payload | file | dir, relativePath, ignoreBase}
fn zip_entries(args: &Value, payload: Vec<u8>) -> BridgeResult {
    let target = arg_str(args, "target")?;
    let file = File::create(target).map_err(|e| crate::fsops::io_error(e, "open", target, None))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let mut count = 0;
    for entry in args.get("entries").and_then(Value::as_array).cloned().unwrap_or_default() {
        let relative = entry.get("relativePath").and_then(Value::as_str).unwrap_or("");
        if safe_relative(relative).is_none() {
            return Err(BridgeError::new(format!("Unsafe archive path: {relative}")));
        }
        let name = relative.replace('\\', "/");
        if let Some(range) = entry.get("data").and_then(Value::as_array) {
            let offset = range.first().and_then(Value::as_u64).unwrap_or(0) as usize;
            let length = range.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
            let bytes = payload.get(offset..offset + length).ok_or("Bad archive entry data")?;
            writer.start_file(name.as_str(), options).map_err(|e| BridgeError::new(e.to_string()))?;
            writer.write_all(bytes).map_err(|e| BridgeError::new(e.to_string()))?;
            count += 1;
        } else if let Some(source) = entry.get("file").and_then(Value::as_str) {
            add_file(&mut writer, &name, Path::new(source))?;
            count += 1;
        } else if let Some(dir) = entry.get("dir").and_then(Value::as_str) {
            count += add_dir(&mut writer, &name, Path::new(dir))?;
        }
    }
    writer.finish().map_err(|e| BridgeError::new(e.to_string()))?;
    ok(json!({"files": count}))
}

pub fn run(op: &str, args: Value, payload: Vec<u8>) -> BridgeResult {
    match op {
        "list" => list(&args, payload),
        "read" => read(&args, payload),
        "unpack" => unpack(&args),
        "zipDir" => zip_dir(&args),
        "zipEntries" => zip_entries(&args, payload),
        other => Err(BridgeError::code(format!("Unknown archive operation: {other}"), "ENOSYS")),
    }
}
