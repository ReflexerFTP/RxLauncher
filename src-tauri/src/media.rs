// Что сейчас играет в Spotify: системные элементы управления мультимедиа Windows (GSMTC), без входа в Spotify.
// Отдаём название, исполнителя, альбом, идёт ли воспроизведение и позицию трека — интерфейс по ней
// синхронизирует строку текста песни в «острове» над лаунчером.
// Подключение к менеджеру Windows одно на поток (оно медленное, а спрашиваем часто). Смену трека, паузу и перемотку
// Windows сообщает событиями — ядро передаёт их интерфейсу (rx:media-changed), и тот обновляется сразу, а не по таймеру
use serde_json::{json, Value};

#[cfg(windows)]
pub fn now_playing() -> Value {
    read().unwrap_or_else(|_| {
        // Подключение могло устареть (перезапуск службы мультимедиа) — в следующий раз создаём заново
        MANAGER.with(|cell| cell.borrow_mut().take());
        json!({"found": false})
    })
}

#[cfg(not(windows))]
pub fn now_playing() -> Value {
    json!({"found": false})
}

#[cfg(not(windows))]
pub fn watch(_app: &tauri::AppHandle) {}

#[cfg(windows)]
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
};

#[cfg(windows)]
thread_local! {
    static MANAGER: std::cell::RefCell<Option<Manager>> = const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
fn manager() -> windows::core::Result<Manager> {
    MANAGER.with(|cell| {
        if let Some(manager) = cell.borrow().as_ref() {
            return Ok(manager.clone());
        }
        let manager = Manager::RequestAsync()?.get()?;
        *cell.borrow_mut() = Some(manager.clone());
        Ok(manager)
    })
}

// Spotify.exe и версия из Microsoft Store (SpotifyAB.SpotifyMusic_…!Spotify)
#[cfg(windows)]
fn is_spotify(session: &Session) -> bool {
    session.SourceAppUserModelId().map(|app| app.to_string().to_lowercase().contains("spotify")).unwrap_or(false)
}

#[cfg(windows)]
fn read() -> windows::core::Result<Value> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    let sessions = manager()?.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        if !is_spotify(&session) {
            continue;
        }
        let properties = session.TryGetMediaPropertiesAsync()?.get()?;
        let title = properties.Title()?.to_string();
        if title.trim().is_empty() {
            continue;
        }
        let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
        let timeline = session.GetTimelineProperties()?;
        // TimeSpan — в сотнях наносекунд; DateTime — от 1601 года
        let position_ms = timeline.Position()?.Duration / 10_000;
        let duration_ms = timeline.EndTime()?.Duration / 10_000;
        let updated_ms = timeline.LastUpdatedTime()?.UniversalTime / 10_000 - 11_644_473_600_000;
        return Ok(json!({
            "found": true,
            "playing": playing,
            "title": title.chars().take(200).collect::<String>(),
            "artist": properties.Artist()?.to_string().chars().take(200).collect::<String>(),
            "album": properties.AlbumTitle()?.to_string().chars().take(200).collect::<String>(),
            "positionMs": position_ms.max(0),
            "durationMs": duration_ms.max(0),
            "updatedAt": updated_ms,
        }));
    }
    Ok(json!({"found": false}))
}

// ---------- события Windows: сменился трек, пауза, перемотка, Spotify открыли или закрыли ----------
#[cfg(windows)]
pub fn watch(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = watch_sessions(app) {
            crate::logs::write("warn", &format!("MediaIsland: Windows media events unavailable ({error}), using polling"));
        }
    });
}

#[cfg(windows)]
fn notify(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("rx:media-changed", ());
}

// Подписка на события сеанса Spotify. Сеансы меняются (Spotify перезапустили) — подписываемся заново
#[cfg(windows)]
fn watch_sessions(app: tauri::AppHandle) -> windows::core::Result<()> {
    use std::sync::mpsc;
    use windows::Foundation::{EventRegistrationToken, TypedEventHandler};

    let manager = Manager::RequestAsync()?.get()?;
    let (changed, sessions_changed) = mpsc::channel::<()>();
    let resubscribe = changed.clone();
    manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        let _ = resubscribe.send(());
        Ok(())
    }))?;
    let _ = changed.send(());

    // Подписки на текущие сеансы Spotify: (сеанс, токены событий)
    let mut watched: Vec<(Session, [EventRegistrationToken; 3])> = Vec::new();
    while sessions_changed.recv().is_ok() {
        for (session, [media, playback, timeline]) in watched.drain(..) {
            let _ = session.RemoveMediaPropertiesChanged(media);
            let _ = session.RemovePlaybackInfoChanged(playback);
            let _ = session.RemoveTimelinePropertiesChanged(timeline);
        }
        let sessions = manager.GetSessions()?;
        for index in 0..sessions.Size()? {
            let session = sessions.GetAt(index)?;
            if !is_spotify(&session) {
                continue;
            }
            let (a, b, c) = (app.clone(), app.clone(), app.clone());
            let media = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| { notify(&a); Ok(()) }))?;
            let playback = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| { notify(&b); Ok(()) }))?;
            let timeline = session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| { notify(&c); Ok(()) }))?;
            watched.push((session, [media, playback, timeline]));
        }
        notify(&app);
    }
    Ok(())
}
