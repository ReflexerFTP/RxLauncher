// Общее состояние ядра
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;

pub struct AppState {
    pub user_data: PathBuf,
    pub web_root: PathBuf,
    game_active: AtomicBool,
    game_pid: AtomicU32,
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
            game_active: AtomicBool::new(false),
            game_pid: AtomicU32::new(0),
            force_close: AtomicBool::new(false),
            files: Mutex::new(FileTable::default()),
            http_aborts: Mutex::new(HashMap::new()),
        })
    }

    pub fn game_active(&self) -> bool {
        self.game_active.load(Ordering::SeqCst)
    }

    pub fn force_close(&self) -> bool {
        self.force_close.load(Ordering::SeqCst)
    }

    pub fn set_force_close(&self, value: bool) {
        self.force_close.store(value, Ordering::SeqCst);
    }

    pub fn game_pid(&self) -> u32 {
        self.game_pid.load(Ordering::SeqCst)
    }

    pub fn set_game(&self, active: bool, pid: u32) {
        self.game_active.store(active, Ordering::SeqCst);
        self.game_pid.store(if active { pid } else { 0 }, Ordering::SeqCst);
    }
}
