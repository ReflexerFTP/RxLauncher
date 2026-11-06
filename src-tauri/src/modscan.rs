// Проверка модов на стилеры (порт modScanner.js): признаки Discord-вебхуков и ботов, Telegram-ботов, кражи токенов,
// паролей, сессии и кошельков, автозапуска и скрытых команд. Строки ищутся как есть, задом наперёд, в hex и base64
// и в массивах байтов/символов из байткода. Результаты кешируются по SHA-1 (mod-scan-cache.json)
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use aho_corasick::AhoCorasick;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::bridge::{ok, BridgeError, BridgeResult};

const VERSION: u64 = 2;

struct Signature {
    id: &'static str,
    kind: &'static str,
    strong: bool,
    encoded: bool,
    needles: &'static [&'static str],
}

const fn sig(id: &'static str, kind: &'static str, strong: bool, encoded: bool, needles: &'static [&'static str]) -> Signature {
    Signature { id, kind, strong, encoded, needles }
}

static SIGNATURES: &[Signature] = &[
    sig("discordWebhook", "exfil", true, true, &["discord.com/api/webhooks", "discordapp.com/api/webhooks", "canary.discord.com/api/webhooks", "ptb.discord.com/api/webhooks",
        "/api/v6/webhooks/", "/api/v8/webhooks/", "/api/v9/webhooks/", "/api/v10/webhooks/"]),
    sig("discordWebhookLib", "exfil", true, false, &["club/minnced/discord/webhook", "com/mrpowergamerbr/temmiewebhook", "webhookclientbuilder", "discordwebhook"]),
    sig("discordBotApi", "exfil", true, true, &["discord.com/api/channels", "discordapp.com/api/channels", "/api/v8/channels/", "/api/v9/channels/", "/api/v10/channels/",
        "gateway.discord.gg", "discord.com/api/users/@me", "discordapp.com/api/users/@me", "/api/v9/users/@me", "/api/v10/users/@me"]),
    sig("discordBotLib", "exfil", false, false, &["net/dv8tion/jda", "discord4j/core", "org/javacord/api", "de/btobastian/javacord"]),
    sig("discordCdn", "exfil", false, false, &["cdn.discordapp.com/attachments", "media.discordapp.net/attachments"]),
    sig("telegramBotApi", "exfil", true, true, &["api.telegram.org"]),
    sig("telegramBotLib", "exfil", false, false, &["org/telegram/telegrambots", "com/pengrad/telegrambot", "org/telegram/abilitybots"]),
    sig("otherExfil", "exfil", false, true, &["hooks.slack.com", "webhook.site", "pipedream.net", "requestbin", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
        "pastebin.com/raw", "hastebin.com", "transfer.sh", "gofile.io", "anonfiles", "filebin.net", "catbox.moe", "litterbox.catbox"]),
    sig("ipLookup", "exfil", false, false, &["api.ipify.org", "ipinfo.io", "ip-api.com", "checkip.amazonaws.com", "icanhazip.com", "ifconfig.me", "myexternalip.com", "ipapi.co", "wtfismyip"]),
    sig("discordToken", "theft", true, true, &["dqw4w9wgxcq:", "local storage\\leveldb", "local storage/leveldb", "mfa\\.[\\w-]{84}", "]{24}\\.[\\w-]{6}", "]{26}\\.[\\w-]{6}",
        "]{6}\\.[\\w-]{27}", "]{6}\\.[\\w-]{38}"]),
    sig("discordApps", "theft", false, false, &["discordcanary", "discordptb", "lightcord"]),
    sig("browserData", "theft", false, false, &["login data", "local state", "encrypted_key", "os_crypt", "web data", "google\\chrome\\user data", "yandex\\yandexbrowser",
        "opera software", "bravesoftware", "microsoft\\edge\\user data", "mozilla\\firefox\\profiles", "logins.json", "key4.db",
        "vivaldi\\user data", "chromium\\user data", "cookies.sqlite"]),
    sig("cryptUnprotect", "theft", false, false, &["cryptunprotectdata"]),
    sig("rxAccounts", "theft", true, true, &["rx_accounts.json", "rx-account.bin"]),
    sig("mcAccounts", "theft", false, false, &["launcher_accounts.json", "launcher_accounts_microsoft_store.json", "launcher_msa_credentials", "tlauncherprofiles.json",
        "feather/accounts.json", "feather\\accounts.json", "microsoft_accounts.json", "prismlauncher/accounts.json",
        "prismlauncher\\accounts.json", "polymc/accounts.json", "polymc\\accounts.json", "multimc/accounts.json",
        "multimc\\accounts.json", "settings/game/accounts.json", "settings\\game\\accounts.json", "command_history.txt"]),
    sig("wallets", "theft", false, false, &["exodus.wallet", "exodus\\exodus", "electrum\\wallets", "wallet.dat", "nkbihfbeogaeaoehlefnkodbefgpgknn", "ethereum\\keystore",
        "coinomi", "atomic\\local storage", "metamask"]),
    sig("telegramSession", "theft", false, false, &["telegram desktop\\tdata", "telegram desktop/tdata", "\\tdata\\", "telegram desktop"]),
    sig("steam", "theft", false, false, &["loginusers.vdf", "steam\\config\\config.vdf"]),
    sig("screenCapture", "theft", false, false, &["createscreencapture"]),
    sig("session", "session", false, false, &["method_1674", "func_148254_d"]),
    sig("sessionUser", "probe", false, false, &["net/minecraft/client/user"]),
    sig("sessionGetter", "probe", false, false, &["getaccesstoken"]),
    sig("autorun", "exec", true, true, &["currentversion\\run", "currentversion/run", "start menu\\programs\\startup", "programs\\startup", "schtasks", "reg add "]),
    sig("hiddenShell", "exec", true, true, &["-encodedcommand", "powershell -e ", "powershell.exe -e ", "-windowstyle hidden", " -w hidden", "iex(", "iex (",
        "invoke-expression", "downloadstring", "invoke-webrequest", "add-mppreference", "set-mppreference", "exclusionpath",
        "disablerealtimemonitoring", "mshta", "certutil -urlcache", "certutil.exe -urlcache", "bitsadmin"]),
    sig("shell", "exec", false, false, &["powershell", "cmd.exe", "cmd /c", "wscript", "cscript"]),
    sig("fractureiser", "exec", true, true, &["85.217.144.130", "107.189.3.101", "files-8ie.pages.dev", "dev/neko/nekoclient", "dev/neko/nekoinjector", "skyrage"]),
    sig("remoteLoader", "loader", false, false, &["urlclassloader", "defineclass"]),
    sig("obfuscator", "obf", false, false, &["skidfuscator", "branchlock", "allatori", "zelix", "paramorphism", "superblaubeere", "bozar", "obzcure", "jnic/", "jnic."]),
];

fn signature(id: &str) -> Option<&'static Signature> {
    SIGNATURES.iter().find(|s| s.id == id)
}

struct Pattern {
    id: &'static str,
    needle: String,
    form: &'static str,
}

struct Matcher {
    automaton: AhoCorasick,
    patterns: Vec<Pattern>,
}

fn variants(needle: &str, encoded: bool) -> Vec<(String, &'static str)> {
    let mut list = vec![(needle.to_string(), "plain")];
    if needle.len() >= 8 {
        list.push((needle.chars().rev().collect(), "reversed"));
    }
    if !encoded {
        return list;
    }
    list.push((hex::encode(needle.as_bytes()), "hex"));
    for shift in 0..3 {
        let mut data = vec![0u8; shift];
        data.extend_from_slice(needle.as_bytes());
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let b64 = b64.trim_end_matches('=');
        let start = if shift > 0 { 4 } else { 0 };
        if b64.len() > start + 4 {
            let core = b64[start..b64.len() - 4].to_lowercase();
            if core.len() >= 12 {
                list.push((core, "base64"));
            }
        }
    }
    list
}

fn matcher() -> &'static Matcher {
    static MATCHER: OnceLock<Matcher> = OnceLock::new();
    MATCHER.get_or_init(|| {
        let mut patterns = Vec::new();
        for signature in SIGNATURES {
            for needle in signature.needles {
                for (text, form) in variants(&needle.to_lowercase(), signature.encoded) {
                    patterns.push(Pattern { id: signature.id, needle: text_or(needle, &text, form), form });
                }
            }
        }
        // http://1…, https://9… — адрес по IP; уточняется разбором ниже
        for digit in '1'..='9' {
            for scheme in ["http://", "https://"] {
                patterns.push(Pattern { id: "rawIpUrl", needle: format!("{scheme}{digit}"), form: "probe" });
            }
        }
        let search: Vec<String> = patterns.iter().map(|p| if p.form == "probe" { p.needle.clone() } else { pattern_text(p) }).collect();
        let automaton = AhoCorasick::builder().ascii_case_insensitive(true).build(&search).expect("stealer patterns");
        Matcher { automaton, patterns }
    })
}

// В Pattern.needle — исходная сигнатура (для отчёта) и через \0 искомый текст, если он другой
fn text_or(original: &str, text: &str, form: &str) -> String {
    if form == "plain" { original.to_string() } else { format!("{original}\u{0}{text}") }
}

fn pattern_text(pattern: &Pattern) -> String {
    match pattern.needle.split_once('\u{0}') {
        Some((_, text)) => text.to_string(),
        None => pattern.needle.to_lowercase(),
    }
}

fn display_needle(pattern: &Pattern) -> String {
    pattern.needle.split('\u{0}').next().unwrap_or("").to_string()
}

// new byte[]{…} / new char[]{…} в байткоде: dup, индекс, значение, bastore|castore
fn push_value(buffer: &[u8], i: usize) -> Option<(i32, usize)> {
    let op = *buffer.get(i)?;
    match op {
        0x02..=0x08 => Some((op as i32 - 3, 1)),
        0x10 => Some(((*buffer.get(i + 1)? as i8) as i32, 2)),
        0x11 => Some((i16::from_be_bytes([*buffer.get(i + 1)?, *buffer.get(i + 2)?]) as i32, 3)),
        _ => None,
    }
}

pub fn array_strings(buffer: &[u8]) -> Vec<Vec<u8>> {
    let mut found = Vec::new();
    let mut chars: Vec<u8> = Vec::new();
    let mut i = 0;
    while i + 3 < buffer.len() {
        if buffer[i] == 0x59 {
            if let Some((_, index_len)) = push_value(buffer, i + 1) {
                if let Some((value, value_len)) = push_value(buffer, i + 1 + index_len) {
                    let store = buffer.get(i + 1 + index_len + value_len).copied();
                    if store == Some(0x54) || store == Some(0x55) {
                        chars.push((value & 0xff) as u8);
                        i += 2 + index_len + value_len;
                        if chars.len() >= 4096 {
                            found.push(std::mem::take(&mut chars));
                        }
                        continue;
                    }
                }
            }
        }
        if chars.len() >= 6 {
            found.push(std::mem::take(&mut chars));
        } else {
            chars.clear();
        }
        i += 1;
    }
    if chars.len() >= 6 {
        found.push(chars);
    }
    found
}

#[derive(Default)]
struct Finding {
    samples: Vec<Value>,
    needles: HashSet<String>,
}

#[derive(Default)]
struct Report {
    findings: Vec<(String, Finding)>,
    probes: HashMap<String, HashSet<&'static str>>,
    ip_entries: HashSet<String>,
}

impl Report {
    fn add(&mut self, id: &str, entry: &str, needle: &str, form: &str) {
        let index = match self.findings.iter().position(|(k, _)| k == id) {
            Some(index) => index,
            None => {
                self.findings.push((id.to_string(), Finding::default()));
                self.findings.len() - 1
            }
        };
        let item = &mut self.findings[index].1;
        let first_time = item.needles.insert(needle.to_string());
        if first_time && item.samples.len() < 3 {
            item.samples.push(json!({"entry": entry, "needle": needle, "form": form}));
        }
    }

    fn scan(&mut self, entry: &str, data: &[u8], form_override: Option<&'static str>) {
        let matcher = matcher();
        let mut seen: HashSet<usize> = HashSet::new();
        for found in matcher.automaton.find_overlapping_iter(data) {
            let index = found.pattern().as_usize();
            if !seen.insert(index) {
                continue;
            }
            let pattern = &matcher.patterns[index];
            if pattern.id == "rawIpUrl" {
                self.ip_entries.insert(entry.to_string());
                continue;
            }
            if signature(pattern.id).map(|s| s.kind) == Some("probe") {
                let set = self.probes.entry(entry.to_string()).or_default();
                set.insert(pattern.id);
                if set.contains("sessionUser") && set.contains("sessionGetter") {
                    self.add("session", entry, "User.getAccessToken", "plain");
                }
                continue;
            }
            self.add(pattern.id, entry, &display_needle(pattern), form_override.unwrap_or(pattern.form));
        }
    }

    // «http://1.2.3.4/» — только там, где автомат увидел похожее начало; локальные адреса не считаем
    fn check_ip(&mut self, entry: &str, data: &[u8]) {
        if !self.ip_entries.contains(entry) {
            return;
        }
        let text = String::from_utf8_lossy(data);
        for scheme in ["http://", "https://"] {
            let mut rest: &str = &text;
            while let Some(position) = rest.find(scheme) {
                let after = &rest[position + scheme.len()..];
                let host: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                let parts: Vec<&str> = host.split('.').collect();
                if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3) {
                    let tail = &after[host.len()..];
                    let port: String = tail.strip_prefix(':').map(|t| t.chars().take_while(char::is_ascii_digit).collect()).unwrap_or_default();
                    let after_port = if port.is_empty() { tail } else { &tail[1 + port.len()..] };
                    let local = host.starts_with("127.") || host.starts_with("0.") || host.starts_with("10.") || host.starts_with("192.168.");
                    if after_port.starts_with('/') && !local {
                        let url = format!("{scheme}{host}{}/", if port.is_empty() { String::new() } else { format!(":{port}") });
                        self.add("rawIpUrl", entry, &url, "plain");
                        return;
                    }
                }
                rest = &after[..];
            }
        }
    }
}

const MEDIA: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "ogg", "wav", "mp3", "nbt", "mca", "ttf", "otf", "woff", "woff2", "psd", "blend", "bbmodel", "mcmeta"];
const SCRIPTS: &[&str] = &["bat", "cmd", "ps1", "vbs", "vbe", "hta", "scr", "wsf", "lnk", "jse"];
const ENTRY_LIMIT: u64 = 32 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 768 * 1024 * 1024;

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}

fn obfuscated_name(simple: &str) -> bool {
    simple.chars().count() <= 2 || simple.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        || (simple.len() >= 4 && simple.chars().all(|c| matches!(c, 'I' | 'l' | '1' | '|')))
}

fn scan_archive<R: Read + std::io::Seek>(reader: R, report: &mut Report, depth: usize, prefix: &str, started: Instant) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    if archive.len() > 60_000 {
        return Err("tooManyEntries".into());
    }
    let (mut classes, mut obfuscated, mut optifine, mut total) = (0usize, 0usize, false, 0u64);
    for index in 0..archive.len() {
        if started.elapsed() > Duration::from_secs(30) {
            return Err("timeout".into());
        }
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let full = format!("{prefix}{name}");
        report.scan(&full, name.as_bytes(), None);
        let lower = name.to_lowercase();
        if lower.starts_with("optifine/") || lower.starts_with("net/optifine/") {
            optifine = true;
        }
        let ext = extension(&name);
        if SCRIPTS.contains(&ext.as_str()) {
            report.add("scriptFile", &full, &format!(".{ext}"), "plain");
        } else if ext == "exe" {
            report.add("exeFile", &full, ".exe", "plain");
        }
        if ext == "class" {
            classes += 1;
            let simple = name.rsplit('/').next().unwrap_or("").trim_end_matches(".class").split('$').next().unwrap_or("");
            if obfuscated_name(simple) {
                obfuscated += 1;
            }
        }
        if MEDIA.contains(&ext.as_str()) || entry.size() > ENTRY_LIMIT || entry.encrypted() {
            continue;
        }
        total += entry.size();
        if total > TOTAL_LIMIT {
            return Err("tooLarge".into());
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        if (&mut entry).take(ENTRY_LIMIT + 1).read_to_end(&mut data).is_err() {
            continue;
        }
        drop(entry);
        if ext == "jar" {
            if depth < 2 {
                let _ = scan_archive(std::io::Cursor::new(data), report, depth + 1, &format!("{full}!/"), started);
            }
            continue;
        }
        report.scan(&full, &data, None);
        if ext == "class" {
            for decoded in array_strings(&data) {
                report.scan(&full, &decoded, Some("bytes"));
            }
        }
        report.check_ip(&full, &data);
    }
    if classes >= 30 && !optifine && obfuscated * 2 >= classes {
        report.add("obfNames", if prefix.is_empty() { "/" } else { prefix }, &format!("{obfuscated}/{classes}"), "plain");
    }
    Ok(())
}

fn verdict(report: Report) -> Value {
    let mut result: Vec<Value> = Vec::new();
    let ids: HashSet<String> = report.findings.iter().map(|(id, _)| id.clone()).collect();
    let mut kinds_by_id: Vec<(String, &'static str)> = Vec::new();
    for (id, item) in &report.findings {
        let sig = signature(id);
        let kind = sig.map(|s| s.kind).unwrap_or(if id == "scriptFile" || id == "exeFile" { "exec" } else { "obf" });
        let mut severity = if sig.map(|s| s.strong).unwrap_or(false) || id == "scriptFile" { "danger" } else { "warning" };
        if kind == "session" || kind == "loader" {
            severity = "info";
        }
        if id == "browserData" && item.needles.len() >= 3 {
            severity = "danger";
        }
        kinds_by_id.push((id.clone(), kind));
        result.push(json!({"id": id, "kind": kind, "severity": severity, "samples": item.samples}));
    }
    let exfil: Vec<String> = kinds_by_id.iter().filter(|(_, k)| *k == "exfil").map(|(id, _)| id.clone()).collect();
    let theft: Vec<String> = kinds_by_id.iter().filter(|(_, k)| *k == "theft" || *k == "session").map(|(id, _)| id.clone()).collect();
    let pure_theft: Vec<String> = kinds_by_id.iter().filter(|(_, k)| *k == "theft").map(|(id, _)| id.clone()).collect();
    if !exfil.is_empty() && !theft.is_empty() {
        result.insert(0, json!({"id": "stealer", "kind": "combo", "severity": "danger", "samples": [], "theft": theft, "exfil": exfil}));
    }
    if (ids.contains("obfuscator") || ids.contains("obfNames")) && !pure_theft.is_empty() && exfil.is_empty() {
        result.insert(0, json!({"id": "hiddenStealer", "kind": "combo", "severity": "danger", "samples": [], "theft": pure_theft, "exfil": []}));
    }
    if ids.contains("remoteLoader") && ["otherExfil", "discordCdn", "rawIpUrl"].iter().any(|id| ids.contains(*id)) {
        let samples = report.findings.iter().find(|(id, _)| id == "remoteLoader").map(|(_, f)| f.samples.clone()).unwrap_or_default();
        result.insert(0, json!({"id": "dropper", "kind": "combo", "severity": "danger", "samples": samples}));
    }
    let rank = |v: &Value| match v.get("severity").and_then(Value::as_str) { Some("danger") => 0, Some("warning") => 1, _ => 2 };
    result.sort_by_key(rank);
    let verdict = if result.iter().any(|v| rank(v) == 0) { "danger" } else if result.iter().any(|v| rank(v) == 1) { "warning" } else { "clean" };
    let findings: Vec<Value> = result.into_iter().filter(|v| rank(v) != 2 || verdict != "clean").collect();
    json!({"verdict": verdict, "findings": findings})
}

pub fn scan_file(path: &Path) -> Value {
    let started = Instant::now();
    let mut report = Report::default();
    let error = match std::fs::File::open(path) {
        Ok(file) => scan_archive(std::io::BufReader::new(file), &mut report, 0, "", started).err(),
        Err(error) => Some(error.to_string()),
    };
    let mut result = verdict(report);
    if let Some(error) = error {
        result["error"] = Value::String(error);
        if result["verdict"] == "clean" {
            result["verdict"] = Value::String("unknown".into());
        }
    }
    result
}

// ---------- папка модов с кешем ----------
fn load_cache(file: &Path) -> Value {
    std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(|c| c.get("version").and_then(Value::as_u64) == Some(VERSION) && c.get("bySha1").is_some() && c.get("byStat").is_some())
        .unwrap_or_else(|| json!({"version": VERSION, "bySha1": {}, "byStat": {}}))
}

fn save_cache(file: &Path, cache: &mut Value) {
    let mut by_sha1: Vec<(String, Value)> = cache["bySha1"].as_object().cloned().unwrap_or_default().into_iter().collect();
    by_sha1.sort_by_key(|(_, v)| std::cmp::Reverse(v.get("at").and_then(Value::as_u64).unwrap_or(0)));
    by_sha1.truncate(4000);
    let known: HashSet<String> = by_sha1.iter().map(|(k, _)| k.clone()).collect();
    let by_stat: Map<String, Value> = cache["byStat"].as_object().cloned().unwrap_or_default().into_iter()
        .filter(|(_, v)| v.as_str().map(|s| known.contains(s)).unwrap_or(false)).collect();
    cache["bySha1"] = Value::Object(by_sha1.into_iter().collect());
    cache["byStat"] = Value::Object(by_stat);
    let temp = file.with_extension("json.tmp");
    if std::fs::write(&temp, serde_json::to_vec(cache).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&temp, file);
    }
}

pub fn scan_dir(user_data: &Path, dir: &str, only_enabled: bool) -> BridgeResult {
    if dir.is_empty() || dir.len() > 1024 || !Path::new(dir).is_absolute() {
        return Err(BridgeError::new("Invalid mods directory"));
    }
    if !Path::new(dir).exists() {
        return ok(json!({"files": [], "scanned": 0, "cached": 0, "timedOut": false}));
    }
    let real = dunce::canonicalize(dir).map_err(|e| crate::fsops::io_error(e, "realpath", dir, None))?;
    if !real.is_dir() {
        return Err(BridgeError::new("Invalid mods directory"));
    }
    let mut files: Vec<(PathBuf, String, u64, bool, String)> = Vec::new();
    for entry in std::fs::read_dir(&real).map_err(|e| crate::fsops::io_error(e, "scandir", dir, None))?.flatten().take(2000) {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !(lower.ends_with(".jar") || lower.ends_with(".jar.disabled")) || !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let enabled = !lower.ends_with(".disabled");
        if only_enabled && !enabled {
            continue;
        }
        let meta = entry.metadata().map_err(|e| BridgeError::new(e.to_string()))?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
        let path = entry.path();
        let stat_key = format!("{}:{}:{}", meta.len(), mtime, path.to_string_lossy());
        files.push((path, name, meta.len(), enabled, stat_key));
    }
    let cache_file = user_data.join("mod-scan-cache.json");
    let mut cache = load_cache(&cache_file);
    let started = Instant::now();
    let (mut scanned, mut cached, mut timed_out) = (0, 0, false);
    // Хеши и проверка — в нескольких потоках
    let work: Vec<(usize, PathBuf, Option<String>)> = files.iter().enumerate()
        .map(|(i, f)| (i, f.0.clone(), cache["byStat"].get(&f.4).and_then(Value::as_str).map(str::to_string))).collect();
    let by_sha1 = cache["bySha1"].clone();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 4);
    let chunks: Vec<Vec<(usize, PathBuf, Option<String>)>> = (0..threads).map(|t| work.iter().filter(|w| w.0 % threads == t).cloned().collect()).collect();
    let outputs: Vec<(usize, String, Value, bool)> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks.into_iter().map(|chunk| {
            let by_sha1 = &by_sha1;
            scope.spawn(move || {
                let mut out = Vec::new();
                for (index, path, known_sha1) in chunk {
                    if started.elapsed() > Duration::from_secs(600) {
                        break;
                    }
                    let sha1 = known_sha1.or_else(|| crate::gamefiles::sha1_file(&path)).unwrap_or_default();
                    match by_sha1.get(&sha1).filter(|_| !sha1.is_empty()) {
                        Some(result) => out.push((index, sha1, result.clone(), true)),
                        None => out.push((index, sha1.clone(), scan_file(&path), false)),
                    }
                }
                out
            })
        }).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut results: HashMap<usize, Value> = HashMap::new();
    for (index, sha1, result, from_cache) in outputs {
        if from_cache { cached += 1 } else { scanned += 1 }
        if !sha1.is_empty() && result["verdict"] != "unknown" {
            cache["byStat"][&files[index].4] = Value::String(sha1.clone());
            let mut stored = result.clone();
            stored["at"] = json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0));
            cache["bySha1"][&sha1] = stored;
        }
        let mut item = result;
        item["sha1"] = Value::String(sha1);
        results.insert(index, item);
    }
    if results.len() < files.len() {
        timed_out = true;
    }
    save_cache(&cache_file, &mut cache);
    let list: Vec<Value> = files.iter().enumerate().map(|(index, (path, name, size, enabled, _))| {
        let mut item = results.remove(&index).unwrap_or_else(|| json!({"verdict": "unknown", "findings": [], "error": "notScanned"}));
        if let Some(map) = item.as_object_mut() {
            map.remove("at");
            map.insert("name".into(), json!(name));
            map.insert("path".into(), json!(path));
            map.insert("size".into(), json!(size));
            map.insert("enabled".into(), json!(enabled));
        }
        item
    }).collect();
    ok(json!({"files": list, "scanned": scanned, "cached": cached, "timedOut": timed_out}))
}
