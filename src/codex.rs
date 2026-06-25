//! Auto-detect and drive the OpenAI Codex `app-server` for translation.
//!
//! Protocol: JSON-RPC 2.0 over newline-delimited JSON on the child's stdio
//! (https://developers.openai.com/codex/app-server). Lifecycle per process:
//!
//!   initialize            -> { userAgent, ... }
//!   initialized (notify)
//!   thread/start          -> { thread: { id } }
//!   turn/start            -> streams item/agentMessage/delta + item/completed
//!                            (agentMessage) and finishes with turn/completed.
//!
//! One long-lived app-server is shared, but each chat gets its OWN thread (keyed
//! by chat id). Reusing a chat's thread keeps Codex's prompt cache warm, so each
//! turn only processes its small new prompt instead of reprocessing the whole
//! conversation — the difference between a ~5s and a ~30s turn. Per-chat threads
//! also keep conversations isolated: the model never bleeds one chat's context (or
//! language!) into another. Turns are still globally serialized (one app-server,
//! one in-flight turn at a time).
//!
//! To stop a chat's thread from growing without bound, it's recycled every
//! [`RECYCLE_AFTER_TURNS`] turns. Recent chat history (capped, see
//! [`render_history`]) is sent to *seed* a freshly (re)created thread for
//! contextual translation; once the thread is warm, later turns send only their
//! own message and rely on that thread's accumulated context. A failed turn drops
//! the client so the next request reconnects.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

#[cfg(windows)]
const CODEX_EXE: &str = "codex.exe";
#[cfg(not(windows))]
const CODEX_EXE: &str = "codex";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const TURN_TIMEOUT: Duration = Duration::from_secs(90);

/// Recreate a chat's thread after this many turns so its accumulated context
/// (and the work to reprocess it) stays bounded. The turn that recreates it pays
/// a cold-cache cost and is reseeded with recent history; the rest are cheap.
const RECYCLE_AFTER_TURNS: u32 = 20;

/// Cap on how many per-chat threads we keep alive at once. When exceeded, the
/// whole table is dropped (threads lazily recreate on next use) — a crude but
/// cheap bound so churning through many chats can't leak server-side threads.
const MAX_LIVE_THREADS: usize = 24;

/// Upper bound on how much chat history is fed back as translation context.
/// Both caps protect the model's context window from a long conversation: at
/// most this many of the most-recent messages, and never more than this many
/// characters total (older lines past the budget are dropped).
const MAX_HISTORY_ENTRIES: usize = 12;
const MAX_HISTORY_CHARS: usize = 1600;

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;
type SharedTurn = Arc<Mutex<Option<ActiveTurn>>>;

/// One prior chat message, supplied as context so translations track tone,
/// references and pronouns across the conversation. Sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryEntry {
    /// Who sent it ("Me" for the user, otherwise the interlocutor's name).
    #[serde(default)]
    pub speaker: String,
    /// The message's original (untranslated) text.
    #[serde(default)]
    pub text: String,
}

/// The single in-flight turn's accumulator + completion channel.
struct ActiveTurn {
    delta: String,
    final_text: Option<String>,
    done: Option<oneshot::Sender<Result<String, String>>>,
}

/// A chat's thread and how many turns it has served (for recycling).
struct ThreadState {
    id: String,
    turns: u32,
}

pub struct CodexClient {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicI64,
    pending: PendingMap,
    active: SharedTurn,
    turn_lock: Mutex<()>,
    /// One thread per chat (keyed by chat id), so chats stay isolated. Only touched
    /// inside a serialized turn; the Mutex keeps it `Send`/`Sync` without unsafe.
    threads: Mutex<HashMap<String, ThreadState>>,
}

impl CodexClient {
    /// Spawn `codex app-server`, run the initialize/thread handshake, and return
    /// a ready client. Errors if codex is missing or the handshake fails.
    pub async fn spawn() -> Result<Arc<CodexClient>, String> {
        let program =
            resolve_codex().ok_or_else(|| "codex executable not found in PATH".to_string())?;

        let mut child = Command::new(&program)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn `{program} app-server`: {e}"))?;

        let stdin = child.stdin.take().ok_or("codex app-server: no stdin")?;
        let stdout = child.stdout.take().ok_or("codex app-server: no stdout")?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let active: SharedTurn = Arc::new(Mutex::new(None));

        // Reader task: demux responses (by id) and notifications (by method).
        {
            let pending = pending.clone();
            let active = active.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                        dispatch(&pending, &active, msg).await;
                    }
                }
                // stdout closed: fail any in-flight turn so callers don't hang.
                if let Some(mut turn) = active.lock().await.take() {
                    if let Some(done) = turn.done.take() {
                        let _ = done.send(Err("codex app-server connection closed".to_string()));
                    }
                }
            });
        }

        let client = Arc::new(CodexClient {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicI64::new(1),
            pending,
            active,
            turn_lock: Mutex::new(()),
            threads: Mutex::new(HashMap::new()),
        });

        client.handshake().await?;
        Ok(client)
    }

    /// Run the connection-level `initialize`/`initialized` handshake once. Threads
    /// are created per turn (see [`start_thread`]), not here, so context stays
    /// bounded to each turn.
    async fn handshake(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "trch",
                    "title": "LinguaSync",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .await?;

        self.send_notification("initialized", json!({})).await
    }

    /// Issue a `thread/start` and return the new thread's id.
    async fn start_thread(&self) -> Result<String, String> {
        let res = self
            .send_request(
                "thread/start",
                json!({
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                }),
            )
            .await?;

        res.get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .or_else(|| res.get("id").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .ok_or_else(|| format!("thread/start: missing thread id in response: {res}"))
    }

    /// Return the thread to run `chat_id`'s next turn on, reusing that chat's
    /// thread to keep Codex's prompt cache warm. Recreates it after
    /// [`RECYCLE_AFTER_TURNS`] turns to bound accumulated context. The bool is
    /// `true` when the thread is fresh (just created) so the caller seeds it with
    /// conversation history. Called only inside a turn (serialized by `turn_lock`).
    async fn current_thread(&self, chat_id: &str) -> Result<(String, bool), String> {
        let mut guard = self.threads.lock().await;
        let stale = match guard.get(chat_id) {
            Some(ts) => ts.turns >= RECYCLE_AFTER_TURNS,
            None => true,
        };
        if stale {
            // Bound live threads: if we're about to grow the table past the cap
            // with a new chat, drop everything (each chat lazily re-seeds).
            if !guard.contains_key(chat_id) && guard.len() >= MAX_LIVE_THREADS {
                guard.clear();
            }
            let id = self.start_thread().await?;
            guard.insert(chat_id.to_string(), ThreadState { id: id.clone(), turns: 1 });
            Ok((id, true))
        } else {
            let ts = guard.get_mut(chat_id).expect("thread present");
            ts.turns += 1;
            Ok((ts.id.clone(), false))
        }
    }

    /// Translate a single `text` into `target_lang`, using `history` (recent chat
    /// messages) only as context for tone, references and pronouns.
    pub async fn translate(
        &self,
        chat_id: &str,
        text: &str,
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<String, String> {
        let instruction = format!(
            "Translate the chat message below into natural, conversational {target_lang}. \
Your reply MUST be written in {target_lang}, even if the message is already in another language — \
never echo it back in its original language. Earlier messages are context for tone, references and \
pronouns ONLY; they never decide the output language. Translate ONLY the message below, not the \
context. Reply with ONLY the {target_lang} translation — no quotes, no explanations, no notes.\n\n\
Message:\n{text}"
        );
        let out = self
            .run_turn(chat_id, &render_history(history), &instruction, None)
            .await?;
        let trimmed = out.trim().to_string();
        if trimmed.is_empty() {
            Err("codex returned an empty translation".to_string())
        } else {
            Ok(trimmed)
        }
    }

    /// Translate many messages in a single turn. Returns one translation per input
    /// (same order); slots Codex omits come back empty so the caller can fall back.
    /// `history` is shared context that precedes the batch.
    pub async fn translate_batch(
        &self,
        chat_id: &str,
        texts: &[String],
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<Vec<String>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let input_json = serde_json::to_string(texts).map_err(|e| e.to_string())?;
        let instruction = format!(
            "Translate each message in the JSON array below into natural, conversational \
{target_lang}. EVERY output string MUST be written in {target_lang}, even if the input is already \
in another language — never echo an item back in its original language. Earlier messages are \
context only and never decide the output language; translate ONLY the array items.\n\
Return ONLY a JSON object of the form {{\"translations\": [\"...\"]}} containing \
exactly {n} strings — one translation per input message, in the same order. Translate only; no \
notes.\n\nInput messages (JSON array):\n{input_json}",
            n = texts.len()
        );
        let schema = json!({
            "type": "object",
            "properties": { "translations": { "type": "array", "items": { "type": "string" } } },
            "required": ["translations"],
            "additionalProperties": false
        });
        let out = self
            .run_turn(chat_id, &render_history(history), &instruction, Some(schema))
            .await?;
        parse_batch(&out, texts.len())
    }

    /// Suggest up to 3 short replies (in `target_lang`) to an incoming message.
    pub async fn suggest_replies(
        &self,
        chat_id: &str,
        message: &str,
        target_lang: &str,
        history: &[HistoryEntry],
    ) -> Result<Vec<String>, String> {
        let instruction = format!(
            "I'm chatting with someone and they just sent me the message below. Use the \
conversation for context. Suggest 3 short, natural replies I could send back — each written \
in {target_lang}, under ~10 words, and distinct in tone. Return ONLY a JSON object of the form \
{{\"suggestions\": [\"...\"]}} with exactly 3 entries. No notes.\n\nTheir message:\n{message}"
        );
        let schema = json!({
            "type": "object",
            "properties": { "suggestions": { "type": "array", "items": { "type": "string" } } },
            "required": ["suggestions"],
            "additionalProperties": false
        });
        let out = self
            .run_turn(chat_id, &render_history(history), &instruction, Some(schema))
            .await?;
        parse_suggestions(&out)
    }

    /// Run one turn to completion on the shared thread and return the final agent
    /// message text. `context` (rendered history) is prepended only when the thread
    /// was just (re)created; otherwise the warm thread already holds the context, so
    /// only `instruction` is sent. Serialized: one turn at a time (one accumulator).
    async fn run_turn(
        &self,
        chat_id: &str,
        context: &str,
        instruction: &str,
        output_schema: Option<Value>,
    ) -> Result<String, String> {
        let _guard = self.turn_lock.lock().await;

        // Reuse this chat's warm thread (fast); only a freshly (re)created one gets
        // seeded with the history block, so warm turns stay small and cached.
        let (thread_id, fresh) = self.current_thread(chat_id).await?;
        let prompt = if fresh && !context.is_empty() {
            format!("{context}{instruction}")
        } else {
            instruction.to_string()
        };

        let (done_tx, done_rx) = oneshot::channel();
        {
            let mut active = self.active.lock().await;
            *active = Some(ActiveTurn {
                delta: String::new(),
                final_text: None,
                done: Some(done_tx),
            });
        }

        let mut params = json!({
            "threadId": thread_id,
            "approvalPolicy": "never",
            "input": [ { "type": "text", "text": prompt } ],
        });
        if let Some(schema) = output_schema {
            params["outputSchema"] = schema;
        }

        if let Err(e) = self.send_request("turn/start", params).await {
            *self.active.lock().await = None;
            return Err(e);
        }

        match timeout(TURN_TIMEOUT, done_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                *self.active.lock().await = None;
                Err("translation turn channel closed".to_string())
            }
            Err(_) => {
                *self.active.lock().await = None;
                Err("translation timed out".to_string())
            }
        }
    }

    /// Stop the underlying app-server process.
    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        let _ = child.start_kill();
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        self.write_line(&json!({ "method": method, "id": id, "params": params }))
            .await?;

        let resp = timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| format!("timed out waiting for `{method}` response"))?
            .map_err(|_| format!("`{method}` response channel closed"))?;

        if let Some(err) = resp.get("error").filter(|e| !e.is_null()) {
            return Err(format!("`{method}` error: {err}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&json!({ "method": method, "params": params }))
            .await
    }

    async fn write_line(&self, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
}

/// Route a single decoded message to the matching pending request or the active
/// turn. Server->client requests (id + method) are ignored: with
/// `approvalPolicy: "never"` and a read-only sandbox, a translation turn issues
/// none, and the turn timeout guards against any stall.
async fn dispatch(pending: &PendingMap, active: &SharedTurn, msg: Value) {
    let method = msg.get("method").and_then(|m| m.as_str());

    // Response to one of our requests (has id, no method).
    if method.is_none() {
        if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
        }
        return;
    }

    let method = method.unwrap();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if let Some(turn) = active.lock().await.as_mut() {
                    turn.delta.push_str(delta);
                }
            }
        }
        "item/completed" => {
            let item = params.get("item");
            let is_agent = item.and_then(|i| i.get("type")).and_then(|v| v.as_str())
                == Some("agentMessage");
            if is_agent {
                if let Some(text) = item.and_then(|i| i.get("text")).and_then(|v| v.as_str()) {
                    if let Some(turn) = active.lock().await.as_mut() {
                        turn.final_text = Some(text.to_string());
                    }
                }
            }
        }
        "turn/completed" => {
            if let Some(mut turn) = active.lock().await.take() {
                let text = turn.final_text.take().unwrap_or_else(|| turn.delta.clone());
                if let Some(done) = turn.done.take() {
                    let _ = done.send(Ok(text));
                }
            }
        }
        "error" => {
            let will_retry = params
                .get("willRetry")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !will_retry {
                let detail = params
                    .get("error")
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "codex turn error".to_string());
                if let Some(mut turn) = active.lock().await.take() {
                    if let Some(done) = turn.done.take() {
                        let _ = done.send(Err(detail));
                    }
                }
            }
        }
        _ => {}
    }
}

/// Render recent chat history into a compact context block for the prompt, or an
/// empty string when there's nothing to show. Bounded by [`MAX_HISTORY_ENTRIES`]
/// and [`MAX_HISTORY_CHARS`] from the most recent end, so a long conversation
/// never blows up the model's context.
fn render_history(history: &[HistoryEntry]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    // Walk newest -> oldest, keeping the freshest messages that fit the budget.
    for entry in history.iter().rev() {
        if lines.len() >= MAX_HISTORY_ENTRIES {
            break;
        }
        let text = entry.text.trim();
        if text.is_empty() {
            continue;
        }
        let speaker = match entry.speaker.trim() {
            "" => "?",
            s => s,
        };
        let line = format!("{speaker}: {text}");
        if used + line.len() > MAX_HISTORY_CHARS && !lines.is_empty() {
            break;
        }
        used += line.len();
        lines.push(line);
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.reverse(); // back to chronological order
    format!(
        "Conversation so far (context only — do NOT translate these lines):\n{}\n\n",
        lines.join("\n")
    )
}

/// Extract a JSON object from a turn's final message, tolerating stray prose or
/// code fences around it.
fn extract_json(raw: &str) -> Result<Value, String> {
    let text = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Ok(v);
    }
    match (text.find('{'), text.rfind('}')) {
        (Some(s), Some(e)) if e > s => {
            serde_json::from_str(&text[s..=e]).map_err(|err| format!("failed to parse JSON: {err}"))
        }
        _ => Err("response was not JSON".to_string()),
    }
}

/// Parse a batch turn into exactly `expected` translations; pads/truncates so the
/// caller can map results back by index (empty slots fall back to the source).
fn parse_batch(raw: &str, expected: usize) -> Result<Vec<String>, String> {
    let value = extract_json(raw)?;
    let arr = value
        .get("translations")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "batch translation missing `translations` array".to_string())?;
    let mut out: Vec<String> = arr
        .iter()
        .map(|v| v.as_str().map(|s| s.trim().to_string()).unwrap_or_default())
        .collect();
    if out.len() < expected {
        out.resize(expected, String::new());
    } else if out.len() > expected {
        out.truncate(expected);
    }
    Ok(out)
}

/// Parse a suggestions turn into up to 3 non-empty reply strings.
fn parse_suggestions(raw: &str) -> Result<Vec<String>, String> {
    let value = extract_json(raw)?;
    let arr = value
        .get("suggestions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "suggestions response missing `suggestions` array".to_string())?;
    let mut out: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    out.truncate(3);
    Ok(out)
}

/// True if a `codex` executable can be found.
pub fn is_available() -> bool {
    resolve_codex().is_some()
}

/// Find the `codex` binary: `CODEX_BIN` override, then `PATH`, then common
/// install locations (bundled apps inherit a minimal PATH that often omits
/// Homebrew / user bin dirs).
fn resolve_codex() -> Option<String> {
    if let Ok(p) = std::env::var("CODEX_BIN") {
        if !p.is_empty() && std::path::Path::new(&p).is_file() {
            return Some(p);
        }
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(CODEX_EXE);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }

    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for sub in [".local/bin", ".cargo/bin", ".bun/bin", ".volta/bin", ".npm-global/bin"] {
            dirs.push(home.join(sub));
        }
    }
    for dir in dirs {
        let candidate = dir.join(CODEX_EXE);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Live end-to-end check: spawns a real `codex app-server` and translates.
    // Requires codex installed + authenticated + network, so it's #[ignore]d.
    // Run with: cargo test --lib -- --ignored --nocapture live_translate
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn live_translate() {
        let client = CodexClient::spawn().await.expect("spawn codex app-server");
        let out = client
            .translate("test-chat", "Hello, how are you?", "Russian", &[])
            .await
            .expect("translate");
        eprintln!("translation -> {out:?}");
        assert!(!out.trim().is_empty(), "expected a non-empty translation");
        client.kill().await;
    }

    // Live batch check: one turn translates several messages and returns them in order.
    // Run with: cargo test --lib -- --ignored --nocapture live_translate_batch
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn live_translate_batch() {
        let client = CodexClient::spawn().await.expect("spawn codex app-server");
        let inputs = vec![
            "Hello, how are you?".to_string(),
            "I'm running a bit late.".to_string(),
            "See you tomorrow!".to_string(),
        ];
        let out = client
            .translate_batch("test-chat", &inputs, "Russian", &[])
            .await
            .expect("batch translate");
        eprintln!("batch -> {out:#?}");
        assert_eq!(out.len(), inputs.len(), "one translation per input");
        assert!(out.iter().all(|s| !s.trim().is_empty()), "all non-empty");
        client.kill().await;
    }

    // Live: suggest replies to an incoming message.
    // Run with: cargo test --lib -- --ignored --nocapture live_suggest
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn live_suggest() {
        let client = CodexClient::spawn().await.expect("spawn codex app-server");
        let out = client
            .suggest_replies("test-chat", "我刚参加完爷爷的葬礼，心情很沉重。", "English", &[])
            .await
            .expect("suggest");
        eprintln!("suggestions -> {out:#?}");
        assert!(!out.is_empty() && out.len() <= 3, "1..=3 suggestions");
        client.kill().await;
    }

    #[test]
    fn parse_suggestions_filters_and_caps() {
        let v = parse_suggestions(r#"{"suggestions":["a","","b","c","d"]}"#).unwrap();
        assert_eq!(v, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn render_history_empty_is_blank() {
        assert_eq!(render_history(&[]), "");
        // whitespace-only entries contribute nothing
        let h = vec![HistoryEntry { speaker: "Me".into(), text: "   ".into() }];
        assert_eq!(render_history(&h), "");
    }

    #[test]
    fn render_history_caps_entries_and_keeps_recent() {
        let h: Vec<HistoryEntry> = (0..30)
            .map(|i| HistoryEntry { speaker: "Me".into(), text: format!("msg{i}") })
            .collect();
        let out = render_history(&h);
        // Only the most recent MAX_HISTORY_ENTRIES are kept...
        assert_eq!(out.matches("Me: ").count(), MAX_HISTORY_ENTRIES);
        // ...and they are the freshest ones, in chronological order.
        assert!(out.contains("msg29"));
        assert!(!out.contains("msg17")); // older than the window
        assert!(out.find("msg18").unwrap() < out.find("msg29").unwrap());
    }

    #[test]
    fn render_history_caps_total_chars() {
        let big = "x".repeat(MAX_HISTORY_CHARS * 2);
        let h = vec![
            HistoryEntry { speaker: "Me".into(), text: "older".into() },
            HistoryEntry { speaker: "Them".into(), text: big.clone() },
        ];
        let out = render_history(&h);
        // The huge most-recent line is kept; the older one is dropped by the budget.
        assert!(out.contains(&big));
        assert!(!out.contains("older"));
    }

    #[test]
    fn parse_batch_extracts_and_normalizes() {
        // exact JSON
        let v = parse_batch(r#"{"translations":["a","b"]}"#, 2).unwrap();
        assert_eq!(v, vec!["a".to_string(), "b".to_string()]);
        // surrounded by prose, and short -> padded to expected length
        let v = parse_batch("here you go: {\"translations\": [\"x\"]} done", 2).unwrap();
        assert_eq!(v, vec!["x".to_string(), String::new()]);
        // too many -> truncated
        let v = parse_batch(r#"{"translations":["a","b","c"]}"#, 2).unwrap();
        assert_eq!(v.len(), 2);
    }
}
