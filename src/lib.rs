//! LinguaSync — Tauri backend.
//!
//! Wraps the existing SolidJS frontend and exposes three invoke commands:
//!   * `load_settings` / `save_settings` — persist targetLang + selfNames.
//!   * `translate` — translate a chat message via the Codex app-server.
//!   * `codex_available` — whether a `codex` binary was detected.

mod codex;
mod settings;

use std::path::PathBuf;
use std::sync::Arc;

use codex::{CodexClient, HistoryEntry};
use settings::Settings;
use tauri::Manager;
use tokio::sync::Mutex;

/// Lazily spawns and reuses one Codex app-server connection. A failed turn drops
/// the cached client so the next call reconnects.
pub struct CodexManager {
    client: Mutex<Option<Arc<CodexClient>>>,
}

impl CodexManager {
    fn new() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }

    async fn ensure(&self) -> Result<Arc<CodexClient>, String> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }
        let client = CodexClient::spawn().await?;
        *guard = Some(client.clone());
        Ok(client)
    }

    async fn translate(
        &self,
        chat_id: &str,
        text: &str,
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<String, String> {
        let client = self.ensure().await?;
        match client.translate(chat_id, text, target_lang, history).await {
            Ok(out) => Ok(out),
            Err(err) => {
                self.drop_dead(&client).await;
                Err(err)
            }
        }
    }

    async fn translate_batch(
        &self,
        chat_id: &str,
        texts: &[String],
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<Vec<String>, String> {
        let client = self.ensure().await?;
        match client
            .translate_batch(chat_id, texts, target_lang, history)
            .await
        {
            Ok(out) => Ok(out),
            Err(err) => {
                self.drop_dead(&client).await;
                Err(err)
            }
        }
    }

    async fn suggest_replies(
        &self,
        chat_id: &str,
        message: &str,
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<Vec<String>, String> {
        let client = self.ensure().await?;
        match client
            .suggest_replies(chat_id, message, target_lang, history)
            .await
        {
            Ok(out) => Ok(out),
            Err(err) => {
                self.drop_dead(&client).await;
                Err(err)
            }
        }
    }

    /// Drop a possibly-dead client (if it's still the cached one) so the next
    /// request reconnects.
    async fn drop_dead(&self, client: &Arc<CodexClient>) {
        let mut guard = self.client.lock().await;
        if guard
            .as_ref()
            .is_some_and(|existing| Arc::ptr_eq(existing, client))
        {
            *guard = None;
        }
        drop(guard);
        client.kill().await;
    }

    async fn shutdown(&self) {
        if let Some(client) = self.client.lock().await.take() {
            client.kill().await;
        }
    }
}

struct AppState {
    config_dir: PathBuf,
    codex: Arc<CodexManager>,
}

#[tauri::command]
fn load_settings(state: tauri::State<'_, AppState>) -> Settings {
    settings::load(&state.config_dir.join("settings.json"))
}

#[tauri::command]
fn save_settings(settings: Settings, state: tauri::State<'_, AppState>) -> Result<(), String> {
    settings::save(&state.config_dir.join("settings.json"), &settings)
}

/// Persisted conversations + messages (opaque JSON owned by the frontend).
#[tauri::command]
fn load_chats(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let path = state.config_dir.join("chats.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    }
}

#[tauri::command]
fn save_chats(data: serde_json::Value, state: tauri::State<'_, AppState>) -> Result<(), String> {
    std::fs::create_dir_all(&state.config_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(state.config_dir.join("chats.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn translate(
    chat_id: String,
    text: String,
    target_lang: String,
    history: Option<Vec<HistoryEntry>>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let codex = state.codex.clone();
    codex
        .translate(&chat_id, &text, &target_lang, &history.unwrap_or_default())
        .await
}

#[tauri::command]
async fn translate_batch(
    chat_id: String,
    texts: Vec<String>,
    target_lang: String,
    history: Option<Vec<HistoryEntry>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let codex = state.codex.clone();
    codex
        .translate_batch(&chat_id, &texts, &target_lang, &history.unwrap_or_default())
        .await
}

#[tauri::command]
async fn suggest_replies(
    chat_id: String,
    message: String,
    target_lang: String,
    history: Option<Vec<HistoryEntry>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let codex = state.codex.clone();
    codex
        .suggest_replies(&chat_id, &message, &target_lang, &history.unwrap_or_default())
        .await
}

#[tauri::command]
fn codex_available() -> bool {
    codex::is_available()
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&dir);
            app.manage(AppState {
                config_dir: dir,
                codex: Arc::new(CodexManager::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            load_chats,
            save_chats,
            translate,
            translate_batch,
            suggest_replies,
            codex_available
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let codex = state.codex.clone();
                    tauri::async_runtime::block_on(async move {
                        codex.shutdown().await;
                    });
                }
            }
        });
}
