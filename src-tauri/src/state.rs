// Общее состояние ядра
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;

pub struct AppState {
    pub user_data: PathBuf,
    pub web_root: PathBuf,
    // Запущенные клиенты Minecraft (их может быть несколько одновременно)
    games: Mutex<HashSet<u32>>,
    force_close: AtomicBool,
    pub files: Mutex<FileTable>,
    pub http_aborts: Mutex<HashMap<u64, tokio::sync::watch::Sender<Option<String>>>>,
}

#[derive(Default)]
pub struct FileTable {
    next: u32,
    pub open: HashMap<u32, File>,
}

impl FileTable {
    pub fn insert(&mut self, file: File) -> u32 {
        self.next = self.next.wrapping_add(1).max(100);
        let id = self.next;
        self.open.insert(id, file);
        id
    }
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let user_data = crate::paths::user_data_dir();
        std::fs::create_dir_all(&user_data)?;
        Ok(Self {
            web_root: crate::paths::web_root(app),
            user_data,
            games: Mutex::new(HashSet::new()),
            force_close: AtomicBool::new(false),
            files: Mutex::new(FileTable::default()),
            http_aborts: Mutex::new(HashMap::new()),
        })
    }

    pub fn game_active(&self) -> bool {
        self.games.lock().map(|games| !games.is_empty()).unwrap_or(false)
    }

    pub fn force_close(&self) -> bool {
        self.force_close.load(Ordering::SeqCst)
    }

    pub fn set_force_close(&self, value: bool) {
        self.force_close.store(value, Ordering::SeqCst);
    }

    pub fn add_game(&self, pid: u32) {
        if let Ok(mut games) = self.games.lock() {
            games.insert(pid);
        }
    }

    // Убрать закрывшийся клиент. true — больше ни одной игры не запущено
    pub fn remove_game(&self, pid: u32) -> bool {
        self.games.lock().map(|mut games| {
            games.remove(&pid);
            games.is_empty()
        }).unwrap_or(true)
    }
}
