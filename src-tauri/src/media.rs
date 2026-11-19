// Windows GSMTC сообщает о смене трека, паузе и перемотке. Один поток владеет
// WinRT-подключением и подписками. Даже если служба зависнет внутри COM-вызова,
// интерфейс получит ответ по таймауту, а новые запросы не создадут новые потоки.
use serde_json::{json, Value};
use tauri::AppHandle;

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, SyncSender};
    use std::time::Duration;
    use tauri::{Emitter, Manager as _};
    use tokio::sync::oneshot;
    use windows::core::{Error, Result, RuntimeType, HRESULT};
    use windows::Foundation::{AsyncOperationCompletedHandler, AsyncStatus, EventRegistrationToken, IAsyncOperation, TypedEventHandler};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    const READ_TIMEOUT: Duration = Duration::from_secs(3);

    pub struct Reader(std::sync::Mutex<Option<SyncSender<oneshot::Sender<Value>>>>);

    impl Reader {
        pub fn new(app: &AppHandle) -> Self {
            let (tx, rx) = mpsc::sync_channel::<oneshot::Sender<Value>>(1);
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                    crate::logs::write("warn", &format!("MediaIsland: {error}"));
                    return;
                }
                let mut connection = None;
                for reply in rx {
                    if reply.is_closed() { continue; }
                    let result = (|| {
                        if connection.is_none() { connection = Some(Connection::open(&app)?); }
                        connection.as_mut().unwrap().read(&app)
                    })();
                    let data = result.unwrap_or_else(|_: Error| {
                        connection = None;
                        json!({"unavailable": true})
                    });
                    let _ = reply.send(data);
                }
                drop(connection);
                unsafe { RoUninitialize() };
            });
            Self(std::sync::Mutex::new(Some(tx)))
        }

        pub fn stop(&self) {
            if let Ok(mut sender) = self.0.lock() { sender.take(); }
        }

        pub async fn now_playing(&self) -> Value {
            let (tx, rx) = oneshot::channel();
            let sent = self.0.lock().ok().is_some_and(|sender| {
                sender.as_ref().is_some_and(|sender| sender.try_send(tx).is_ok())
            });
            if sent {
                if let Ok(Ok(data)) = tokio::time::timeout(READ_TIMEOUT, rx).await {
                    return data;
                }
            }
            json!({"unavailable": true})
        }
    }

    fn wait<T: RuntimeType + 'static>(operation: IAsyncOperation<T>) -> Result<T> {
        if operation.Status()? == AsyncStatus::Started {
            let (tx, rx) = mpsc::sync_channel(1);
            operation.SetCompleted(&AsyncOperationCompletedHandler::new(move |_, _| {
                let _ = tx.try_send(());
                Ok(())
            }))?;
            if rx.recv_timeout(READ_TIMEOUT).is_err() {
                let _ = operation.Cancel();
                return Err(Error::new(HRESULT(0x800705B4u32 as i32), "Windows media request timed out"));
            }
        }
        operation.GetResults()
    }

    fn notify(app: &AppHandle) {
        static PENDING: AtomicBool = AtomicBool::new(false);
        if PENDING.swap(true, Ordering::AcqRel) { return; }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            PENDING.store(false, Ordering::Release);
            if app.try_state::<crate::state::AppState>().is_some_and(|s| !s.force_close()) {
                let _ = app.emit("rx:media-changed", ());
            }
        });
    }

    struct Subscription {
        session: Session,
        media: Option<EventRegistrationToken>,
        playback: Option<EventRegistrationToken>,
        timeline: Option<EventRegistrationToken>,
    }

    impl Subscription {
        fn new(session: Session, app: &AppHandle) -> Self {
            let (a, b, c) = (app.clone(), app.clone(), app.clone());
            let media = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| { notify(&a); Ok(()) })).ok();
            let playback = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| { notify(&b); Ok(()) })).ok();
            let timeline = session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| { notify(&c); Ok(()) })).ok();
            Self {session, media, playback, timeline}
        }
    }

    impl Drop for Subscription {
        fn drop(&mut self) {
            if let Some(t) = self.media { let _ = self.session.RemoveMediaPropertiesChanged(t); }
            if let Some(t) = self.playback { let _ = self.session.RemovePlaybackInfoChanged(t); }
            if let Some(t) = self.timeline { let _ = self.session.RemoveTimelinePropertiesChanged(t); }
        }
    }

    struct Connection {
        manager: Manager,
        changed: Option<EventRegistrationToken>,
        watched: Option<Subscription>,
    }

    impl Drop for Connection {
        fn drop(&mut self) {
            if let Some(t) = self.changed { let _ = self.manager.RemoveSessionsChanged(t); }
        }
    }

    impl Connection {
        fn open(app: &AppHandle) -> Result<Self> {
            let manager = wait(Manager::RequestAsync()?)?;
            let app = app.clone();
            let changed = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| { notify(&app); Ok(()) })).ok();
            Ok(Self {manager, changed, watched: None})
        }

        fn read(&mut self, app: &AppHandle) -> Result<Value> {
            let sessions = self.manager.GetSessions()?;
            let mut candidates = Vec::new();
            for index in 0..sessions.Size()? {
                let Ok(session) = sessions.GetAt(index) else { continue };
                if !session.SourceAppUserModelId().is_ok_and(|id| id.to_string().to_ascii_lowercase().contains("spotify")) { continue; }
                let playing = session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).is_ok_and(|status| status == Status::Playing);
                candidates.push((session, playing));
            }
            candidates.sort_by_key(|(_, playing)| !playing);
            let mut error = None;
            for (session, playing) in candidates {
                match snapshot(&session, playing) {
                    Ok(Some(data)) => {
                        if !self.watched.as_ref().is_some_and(|w| w.session == session) {
                            self.watched = Some(Subscription::new(session, app));
                        }
                        return Ok(data);
                    }
                    Ok(None) => {}
                    Err(e) => error = Some(e),
                }
            }
            self.watched = None;
            if let Some(e) = error { return Err(e); }
            Ok(json!({"found": false}))
        }
    }

    fn snapshot(session: &Session, playing: bool) -> Result<Option<Value>> {
        let properties = wait(session.TryGetMediaPropertiesAsync()?)?;
        let title = properties.Title()?.to_string();
        if title.trim().is_empty() { return Ok(None); }
        let timeline = session.GetTimelineProperties().ok();
        let position = timeline.as_ref().and_then(|t| t.Position().ok()).map(|t| t.Duration / 10_000);
        let duration = timeline.as_ref().and_then(|t| t.EndTime().ok()).map(|t| t.Duration / 10_000);
        let updated = timeline.as_ref().and_then(|t| t.LastUpdatedTime().ok()).map(|t| t.UniversalTime / 10_000 - 11_644_473_600_000);
        Ok(Some(json!({
            "found": true, "playing": playing, "title": title.chars().take(200).collect::<String>(),
            "artist": properties.Artist().unwrap_or_default().to_string().chars().take(200).collect::<String>(),
            "album": properties.AlbumTitle().unwrap_or_default().to_string().chars().take(200).collect::<String>(),
            "positionMs": position, "durationMs": duration, "updatedAt": updated,
        })))
    }
}

#[cfg(windows)]
pub use win::Reader;

#[cfg(not(windows))]
pub struct Reader;
#[cfg(not(windows))]
impl Reader {
    pub fn new(_: &AppHandle) -> Self { Self }
    pub fn stop(&self) {}
    pub async fn now_playing(&self) -> Value { json!({"found": false}) }
}
