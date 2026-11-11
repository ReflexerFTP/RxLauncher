// Проверки ядра (cargo test): то, что раньше проверяли тесты JS-реализации на Electron
use std::collections::HashMap;
use std::io::Write;
use std::net::IpAddr;

use serde_json::json;

fn jar(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        for (name, data) in entries {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }
    buffer.into_inner()
}

fn scan(entries: &[(&str, &[u8])]) -> serde_json::Value {
    let dir = std::env::temp_dir().join(format!("rx-test-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("mod.jar");
    std::fs::write(&file, jar(entries)).unwrap();
    let result = crate::modscan::scan_file(&file);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn ids(result: &serde_json::Value) -> Vec<String> {
    result["findings"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn local_addresses_are_blocked() {
    for ip in ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.4", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"] {
        assert!(crate::http::is_local_ip(ip.parse::<IpAddr>().unwrap()), "{ip} must be local");
    }
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
        assert!(!crate::http::is_local_ip(ip.parse::<IpAddr>().unwrap()), "{ip} must be public");
    }
}

#[test]
fn guarded_urls() {
    let ok = |u: &str| crate::http::guarded_url_ok_for_test(u);
    assert!(ok("https://cdn.modrinth.com/data/x.jar"));
    for bad in ["http://cdn.modrinth.com/x.jar", "https://localhost/x", "https://a.localhost/x", "https://printer.local/x", "https://127.0.0.1/x",
        "https://user:pass@cdn.modrinth.com/x", "https://[::1]/x", "https://10.0.0.5/x"] {
        assert!(!ok(bad), "{bad} must be rejected");
    }
}

#[test]
fn archive_paths() {
    for bad in ["../x", "a/../../x", "C:/x", "/etc/x", "\\\\server\\x", "con.txt", "a/nul", "a/b.", "a/b ", "x\u{1}y"] {
        assert!(crate::archive::safe_relative(bad).is_none(), "{bad:?} must be unsafe");
    }
    assert!(crate::archive::safe_relative("mods/sodium.jar").is_some());
    assert!(crate::archive::safe_relative("overrides\\config\\a.toml").is_some());
}

#[test]
fn os_rules() {
    let features: HashMap<String, bool> = HashMap::new();
    let allow_windows = json!([{"action": "allow", "os": {"name": "windows"}}]);
    let allow_osx = json!([{"action": "allow", "os": {"name": "osx"}}]);
    let disallow_osx = json!([{"action": "allow"}, {"action": "disallow", "os": {"name": "osx"}}]);
    let demo = json!([{"action": "allow", "features": {"is_demo_user": true}}]);
    assert!(crate::game::rules_allow(Some(&allow_windows), &features));
    assert!(!crate::game::rules_allow(Some(&allow_osx), &features));
    assert!(crate::game::rules_allow(Some(&disallow_osx), &features));
    assert!(!crate::game::rules_allow(Some(&demo), &features));
    assert!(crate::game::rules_allow(None, &features));
}

#[test]
fn maven_paths() {
    assert_eq!(crate::gamefiles::maven_path("net.fabricmc:fabric-loader:0.16.9").unwrap(), "net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar");
    assert_eq!(crate::gamefiles::maven_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(), "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar");
    assert_eq!(crate::gamefiles::maven_path("a.b:c:1@zip").unwrap(), "a/b/c/1/c-1.zip");
    assert!(crate::gamefiles::maven_path("a:..:1").is_none());
    assert!(crate::gamefiles::maven_path("only:two").is_none());
}

#[test]
fn stealer_scan() {
    let clean = scan(&[("fabric.mod.json", b"{\"id\":\"demo\"}"), ("demo/Mod.class", b"\x01PrismLauncher detected\x01https://modrinth.com/mod/demo")]);
    assert_eq!(clean["verdict"], "clean", "{clean}");
    let webhook = scan(&[("a/Send.class", b"\x01https://discord.com/api/webhooks/1/2")]);
    assert_eq!(webhook["verdict"], "danger");
    assert!(ids(&webhook).contains(&"discordWebhook".to_string()));
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode("xhttps://api.telegram.org/bot1:A/sendDocument");
    let telegram = scan(&[("a/T.class", encoded.as_bytes())]);
    assert!(ids(&telegram).contains(&"telegramBotApi".to_string()), "{telegram}");
    // Адрес собран из массива байтов в байткоде (dup, bipush i, bipush c, bastore)
    let mut bytecode = vec![0xca, 0xfe, 0xba, 0xbe];
    for (index, byte) in b"https://discord.com/api/webhooks/1".iter().enumerate() {
        bytecode.extend_from_slice(&[0x59, 0x10, index as u8, 0x10, *byte, 0x54]);
    }
    let bytes = scan(&[("a/L.class", &bytecode)]);
    assert!(ids(&bytes).contains(&"discordWebhook".to_string()), "{bytes}");
    let stealer = scan(&[("s/G.class", b"\x01Local State\x01encrypted_key\x01Login Data\x01https://api.ipify.org")]);
    assert_eq!(stealer["findings"][0]["id"], "stealer");
    let jda = scan(&[("net/dv8tion/jda/api/JDA.class", b"getSessionId\x01getAccessToken")]);
    assert_eq!(jda["verdict"], "warning", "{jda}");
    let nested_inner = jar(&[("evil/S.class", b"\x01https://discord.com/api/webhooks/9/9")]);
    let nested = scan(&[("fabric.mod.json", b"{}"), ("META-INF/jars/inner.jar", &nested_inner)]);
    assert!(ids(&nested).contains(&"discordWebhook".to_string()), "{nested}");
    let script = scan(&[("run.bat", b"@echo off")]);
    assert!(ids(&script).contains(&"scriptFile".to_string()));
}

#[test]
fn command_history_passwords() {
    for line in ["/l secret", "/login p4ss", "/reg a a", "/authme:login hunter2", "/CP old new", "/2fa 123456"] {
        assert!(crate::vault::is_sensitive(line), "{line} must be hidden");
    }
    for line in ["/list", "/home", "/l", "/msg friend hi", "/logout", "/spawn"] {
        assert!(!crate::vault::is_sensitive(line), "{line} must stay");
    }
}

#[test]
fn log4j_events_become_text() {
    let mut log = crate::game::Log4jTextForTest::default();
    assert_eq!(log.push("plain line").unwrap(), "plain line\n");
    assert!(log.push(r#"<log4j:Event logger="x" timestamp="0" level="INFO" thread="Render thread">"#).is_none());
    assert!(log.push("  <log4j:Message><![CDATA[Hello ]]></log4j:Message>").is_none());
    let text = log.push("</log4j:Event>").unwrap();
    assert!(text.ends_with("[Render thread/INFO]: Hello\n"), "{text}");
}

#[cfg(windows)]
#[test]
fn safe_storage_roundtrip() {
    let dir = std::env::temp_dir().join(format!("rx-secure-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    let sealed = crate::secure::encrypt(&dir, "rx1_secret-token").unwrap();
    assert!(sealed.starts_with(b"v10"));
    assert_eq!(crate::secure::decrypt(&dir, &sealed).unwrap(), "rx1_secret-token");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scan_files_before_install() {
    let dir = std::env::temp_dir().join(format!("rx-stage-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    let bad = dir.join("bad.jar");
    std::fs::write(&bad, jar(&[("a/Send.class", b"\x01https://discord.com/api/webhooks/1/2")])).unwrap();
    let missing = dir.join("missing.jar").to_string_lossy().to_string();
    let result = crate::modscan::scan_files(&dir, &[bad.to_string_lossy().to_string(), missing]).unwrap().0;
    let files = result["files"].as_array().unwrap();
    assert_eq!(files[0]["verdict"], "danger");
    assert_eq!(files[0]["name"], "bad.jar");
    assert_eq!(files[0]["sha1"].as_str().unwrap().len(), 40);
    assert_eq!(files[1]["error"], "notFound");
    // Второй раз — из кеша по SHA-1
    let again = crate::modscan::scan_files(&dir, &[bad.to_string_lossy().to_string()]).unwrap().0;
    assert_eq!(again["files"][0]["verdict"], "danger");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn scope_paths_are_compared_without_tricks() {
    use crate::scope::key;
    assert_eq!(key(r"C:\Games\Minecraft").as_deref(), Some(r"c:\games\minecraft"));
    assert_eq!(key("c:/games/./Minecraft/").as_deref(), Some(r"c:\games\minecraft"));
    // «..» раскрывается до сравнения, выйти из папки через него нельзя
    assert_eq!(key(r"C:\Games\Minecraft\..\..\Users\x").as_deref(), Some(r"c:\users\x"));
    // Windows отбрасывает точки и пробелы в конце имён
    assert_eq!(key(r"C:\Games\Minecraft. \mods").as_deref(), Some(r"c:\games\minecraft\mods"));
    assert_eq!(key(r"\\?\C:\Games").as_deref(), Some(r"c:\games"));
    assert_eq!(key(r"C:\").as_deref(), Some(r"c:\"));
    assert_eq!(key(r"\\Server\Share\dir").as_deref(), Some(r"\\server\share\dir"));
    // Относительные пути, потоки NTFS и устройства не принимаются
    for bad in [r"mods\a.jar", "C:mods", r"C:\Games\file.txt:stream", r"\\.\PhysicalDrive0", ""] {
        assert_eq!(key(bad), None, "{bad} must be rejected");
    }
}

#[cfg(windows)]
#[test]
fn launcher_game_dir_is_read_from_properties() {
    use crate::scope::property_game_dir;
    let text = concat!("#comment\n", r"minecraft.gamedir.other=E\:\\no", "\n", r" minecraft.gamedir = D\:\\Games\\TL\u0020Game", "\nlocale=ru");
    assert_eq!(property_game_dir(text), Some(std::path::PathBuf::from(r"D:\Games\TL Game")));
    assert_eq!(property_game_dir(r"minecraft.gamedir=relative\\dir"), None);
    assert_eq!(property_game_dir("locale=ru"), None);
}

#[test]
fn folder_is_listed_in_one_call() {
    let dir = std::env::temp_dir().join(format!("rx-list-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(dir.join("world").join("region")).unwrap();
    std::fs::write(dir.join("mod.jar"), b"PK\x03\x04rest").unwrap();
    std::fs::write(dir.join("world").join("level.dat"), b"12345").unwrap();
    std::fs::write(dir.join("world").join("region").join("r.0.0.mca"), b"x").unwrap();

    let flat = crate::fsops::list_dir(&dir, 1, 4, 100).unwrap();
    assert_eq!(flat.len(), 2);
    let jar = flat.iter().find(|item| item["name"] == "mod.jar").unwrap();
    assert_eq!(jar["kind"], "file");
    assert_eq!(jar["size"], 8);
    assert_eq!(jar["head"], "504b0304");
    assert!(jar["mtimeMs"].as_f64().unwrap() > 0.0);
    assert_eq!(flat.iter().find(|item| item["name"] == "world").unwrap()["kind"], "dir");

    // Два уровня: содержимое мира видно, папка регионов — нет
    let deep = crate::fsops::list_dir(&dir, 2, 0, 100).unwrap();
    let names: Vec<&str> = deep.iter().map(|item| item["name"].as_str().unwrap()).collect();
    assert!(names.contains(&r"world\level.dat"), "{names:?}");
    assert!(names.contains(&r"world\region"));
    assert!(!names.iter().any(|name| name.ends_with(".mca")));
    assert!(deep.iter().all(|item| item.get("head").is_none()));

    assert_eq!(crate::fsops::list_dir(&dir, 8, 0, 2).unwrap().len(), 2);
    assert!(crate::fsops::list_dir(&dir.join("missing"), 1, 0, 10).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn version_folder_names_like_other_launchers() {
    use crate::loaders::valid_folder_name;
    for good in ["Fabric 1.21.4", "OptiFine 1.20.1 (HD U I6)", "fabric-loader-0.16.10-1.21.4", "1.21.4", "Сборка 1.20"] {
        assert!(valid_folder_name(good), "{good} must be accepted");
    }
    for bad in ["", ".", "..", "a/b", r"a\b", "C:x", "x?", "x*", "x|y", "name.", "name ", " name", "x\u{0007}"] {
        assert!(!valid_folder_name(bad), "{bad:?} must be rejected");
    }
}

fn temp_root(tag: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("rx-{tag}-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(root.join("versions")).unwrap();
    root
}

fn write_json(path: std::path::PathBuf, value: serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn custom_version_with_spaces_launches_and_repairs_itself() {
    let root = temp_root("custom");
    // Как у TLauncher: «Fabric 1.21.4» поверх 1.21.4
    write_json(root.join("versions/Fabric 1.21.4/Fabric 1.21.4.json"), json!({"id": "Fabric 1.21.4", "inheritsFrom": "1.21.4", "type": "release"}));
    let config = crate::loaders::custom_config("Fabric 1.21.4", &root).unwrap();
    assert_eq!(config["version"]["custom"], "Fabric 1.21.4");
    assert_eq!(config["version"]["number"], "1.21.4");

    // Папку переименовали, файлы внутри остались со старым именем — манифест и jar восстанавливаются
    write_json(root.join("versions/Моя версия/old-name.json"), json!({"id": "old-name", "inheritsFrom": "1.20.1"}));
    std::fs::write(root.join("versions/Моя версия/old-name.jar"), b"PK\x03\x04").unwrap();
    let config = crate::loaders::custom_config("Моя версия", &root).unwrap();
    assert_eq!(config["version"]["number"], "1.20.1");
    let restored: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("versions/Моя версия/Моя версия.json")).unwrap()).unwrap();
    assert_eq!(restored["id"], "Моя версия");
    assert!(root.join("versions/Моя версия/Моя версия.jar").is_file());

    // Нет файлов — понятная ошибка с кодом, а не молчаливое «нет конфигурации»
    std::fs::create_dir_all(root.join("versions/Пустая")).unwrap();
    assert_eq!(crate::loaders::custom_config("Пустая", &root).unwrap_err().code.as_deref(), Some("version_missing"));
    assert_eq!(crate::loaders::custom_config("Нет такой", &root).unwrap_err().code.as_deref(), Some("version_missing"));
    assert_eq!(crate::loaders::custom_config("a/../b", &root).unwrap_err().code.as_deref(), Some("version_name"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn pinned_and_any_installed_loader_work_without_network() {
    let root = temp_root("loader");
    let profile = |id: &str, loader: &str| json!({"id": id, "inheritsFrom": "1.21.4", "libraries": [{"name": format!("net.fabricmc:fabric-loader:{loader}")}, {"name": "org.ow2.asm:asm:9.7"}]});
    // Закреплённая версия сборки уже скачана — берётся с диска
    write_json(root.join("versions/fabric-1.21.4-0.20.1/fabric-1.21.4-0.20.1.json"), profile("fabric-1.21.4-0.20.1", "0.20.1"));
    let local = crate::loaders::local_config("fabric", "1.21.4", Some("0.20.1"), &root).unwrap();
    assert_eq!(local["version"]["custom"], "fabric-1.21.4-0.20.1");
    assert!(crate::loaders::local_config("fabric", "1.21.4", Some("0.19.0"), &root).is_none());

    // Нужной нет — запасной вариант: та же версия загрузчика под другим именем, иначе самая новая установленная
    write_json(root.join("versions/fabric-loader-0.16.10-1.21.4/fabric-loader-0.16.10-1.21.4.json"), profile("fabric-loader-0.16.10-1.21.4", "0.16.10"));
    write_json(root.join("versions/fabric-1.20.1/fabric-1.20.1.json"), json!({"id": "fabric-1.20.1", "inheritsFrom": "1.20.1", "libraries": [{"name": "net.fabricmc:fabric-loader:0.99.0"}]}));
    let same = crate::loaders::any_installed_fabric("fabric", "1.21.4", Some("0.16.10"), &root).unwrap();
    assert_eq!(same["version"]["custom"], "fabric-loader-0.16.10-1.21.4");
    let newest = crate::loaders::any_installed_fabric("fabric", "1.21.4", Some("0.19.0"), &root).unwrap();
    assert_eq!(newest["version"]["custom"], "fabric-1.21.4-0.20.1", "the newest installed loader for 1.21.4, never another game version");
    assert!(crate::loaders::any_installed_fabric("quilt", "1.21.4", None, &root).is_none());
    assert!(crate::loaders::any_installed_fabric("fabric", "1.19.2", None, &root).is_none());
    let _ = std::fs::remove_dir_all(&root);
}
