// RxLauncher на Tauri: Rust-ядро (файлы, сеть, запуск игры, защита данных) + интерфейс на HTML/CSS/JS.
// Интерфейс обращается к ядру через протокол rxsync:// (см. bridge.rs), ядро сообщает о событиях через Tauri events «rx:*»
mod archive;
mod bridge;
mod curseforge;
mod discord;
mod fsops;
mod game;
mod gamefiles;
mod http;
mod ipc;
mod loaders;
mod logs;
mod loopback;
mod modscan;
mod net;
mod paths;
mod secure;
mod state;
mod system;
mod updater;
mod vault;
mod window;

#[cfg(test)]
mod tests;

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
            // История команд, оставшаяся в папках игры (например, после сбоя), — в хранилище
            let user_data = app.state::<state::AppState>().user_data.clone();
            std::thread::spawn(move || {
                let hidden = vault::protect_everywhere(&user_data, &[]);
                if hidden > 0 {
                    logs::write("info", &format!("CommandHistory: swept {hidden} folder(s) at startup"));
                }
                system::keep_custom_uninstaller();
            });
            logs::write("info", &format!("RxLauncher {} started (Tauri {})", app.package_info().version, tauri::VERSION));
            updater::start(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Окно показывает сам интерфейс (rx-window-show), когда готов первый кадр: так нет пустого тёмного окна.
            // Если интерфейс не дошёл до этого (ошибка при запуске) — показываем сами через пару секунд
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let app = webview.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if !app.state::<state::AppState>().game_active() {
                        window::reveal(&app);
                    }
                });
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
