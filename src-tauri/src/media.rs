// Что сейчас играет в Spotify: системные элементы управления мультимедиа Windows (GSMTC), без входа в Spotify.
// Отдаём название, исполнителя, альбом, идёт ли воспроизведение и позицию трека — интерфейс по ней
// синхронизирует строку текста песни в «острове» над лаунчером
use serde_json::{json, Value};

#[cfg(windows)]
pub fn now_playing() -> Value {
    read().unwrap_or_else(|_| json!({"found": false}))
}

#[cfg(not(windows))]
pub fn now_playing() -> Value {
    json!({"found": false})
}

#[cfg(windows)]
fn read() -> windows::core::Result<Value> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let manager = Manager::RequestAsync()?.get()?;
    let sessions = manager.GetSessions()?;
    for index in 0..sessions.Size()? {
        let session = sessions.GetAt(index)?;
        // Spotify.exe и версия из Microsoft Store (SpotifyAB.SpotifyMusic_…!Spotify)
        let app = session.SourceAppUserModelId()?.to_string();
        if !app.to_lowercase().contains("spotify") {
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
