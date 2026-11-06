// RxLauncher на Tauri: Rust-ядро (файлы, сеть, запуск игры, защита данных) + интерфейс на HTML/CSS/JS.
// Интерфейс обращается к ядру через протокол rxsync:// (см. bridge.rs), ядро сообщает о событиях через Tauri events «rx:*»
mod bridge;
mod fsops;
mod game;
mod gamefiles;
mod http;
mod ipc;
mod loaders;
mod logs;
mod paths;
mod secure;
mod state;
mod system;
mod window;

use tauri::{Manager, WindowEvent};

pub fn run() {
    logs::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Второй запуск — просто показать уже открытый лаунчер
            window::show_launcher(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("rxsync", |ctx, request, responder| {
            bridge::handle(ctx.app_handle().clone(), request, responder);
        })
        .setup(|app| {
            app.manage(state::AppState::new(app.handle())?);
            logs::write("info", &format!("RxLauncher {} started (Tauri {})", app.package_info().version, tauri::VERSION));
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
                let _ = webview.window().set_focus();
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Пока идёт игра, крестик (и Alt+F4) прячет лаунчер в трей, а не закрывает
                let state = window.state::<state::AppState>();
                if state.game_active() && !state.force_close() {
                    api.prevent_close();
                    window::hide_launcher(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running RxLauncher");
}
