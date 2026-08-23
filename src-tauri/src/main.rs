// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use rand::Rng;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// same Discord application as the Electron build
const CLIENT_ID: &str = "861430403955949569";
const GAME_URL: &str = "https://speakirpg.overture.io.kr/";
const RELEASES_URL: &str = "https://github.com/DJTOMATO/SpeakiRPG/releases";

// Electron MIN_UPDATE_INTERVAL_MS
const MIN_UPDATE_INTERVAL_MS: u64 = 10_000;

// ported verbatim from the Electron client
const ACTIVITIES: &[&str] = &[
    "Playing Speaki RPG",
    "Exploring the world chowa chowa",
    "Fighting monsters cuayo",
    "Completing quests ayo",
    "Watching SPEAKIGOD dead at the entrance",
    "AUUUUUUUUUUUUUUUU",
    "SUPIKI",
    "SPK",
    "Looking for the house deed",
    "I am 2 kilobytes",
];

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct DiscordRpc {
    client: Option<DiscordIpcClient>,
}

impl DiscordRpc {
    fn new() -> Self {
        Self { client: None }
    }

    fn connect(&mut self) -> bool {
        if self.client.is_none() {
            // new() is lazy; connect() does the IPC I/O
            self.client = Some(DiscordIpcClient::new(CLIENT_ID));
        }
        match self.client.as_mut().map(DiscordIpc::connect) {
            Some(Ok(())) => true,
            _ => {
                // stale socket after a failed connect; next attempt needs a fresh client
                self.client = None;
                false
            }
        }
    }

    fn try_set(&mut self, activity: &activity::Activity) -> bool {
        match self.client.as_mut() {
            Some(client) => client.set_activity(activity.clone()).is_ok(),
            None => false,
        }
    }

    // retry setActivity after reconnect, same as Electron
    fn set_activity(&mut self, activity: activity::Activity) -> bool {
        if self.try_set(&activity) {
            return true;
        }
        if self.connect() && self.try_set(&activity) {
            return true;
        }
        eprintln!("Failed to update RPC activity");
        false
    }
}

fn menu_activity(start_ms: u64) -> activity::Activity<'static> {
    let details = ACTIVITIES[rand::thread_rng().gen_range(0..ACTIVITIES.len())];
    activity::Activity::new()
        .details(details)
        .state("Main Menu")
        .timestamps(activity::Timestamps::new().start(start_ms as i64))
        .assets(
            activity::Assets::new()
                .large_image("logo")
                .large_text("Ogey")
                .small_image("logo")
                .small_text("Rrat"),
        )
}

fn stats_activity(stats: &PageStats, start_ms: u64) -> activity::Activity<'static> {
    let details = match (&stats.player_name, &stats.location) {
        (Some(name), Some(location)) => format!("{name} • {location}"),
        (Some(name), None) => name.clone(),
        (None, Some(location)) => format!("Unknown Player • {location}"),
        (None, None) => "Unknown Player".to_string(),
    };

    let mut state = stats
        .level
        .as_deref()
        .map(|level| format!("Level {level}"))
        .unwrap_or_else(|| "In-Game".to_string());
    if let Some(exp) = stats.exp.as_deref() {
        state.push_str(" • ");
        state.push_str(exp);
    }

    activity::Activity::new()
        .details(details)
        .state(state)
        .timestamps(activity::Timestamps::new().start(start_ms as i64))
        .assets(
            activity::Assets::new()
                .large_image("logo")
                .large_text("Speaki RPG")
                .small_image("logo")
                .small_text("RPG"),
        )
        .buttons(vec![
            activity::Button::new("Play Speaki MMO", GAME_URL),
            activity::Button::new("Download Client", RELEASES_URL),
        ])
}

struct AppState {
    rpc: Mutex<DiscordRpc>,
    last_update_ms: Mutex<u64>,
    // Electron rpcTimestamp: presence elapsed time counts from app start
    session_start_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageStats {
    player_name: Option<String>,
    level: Option<String>,
    exp: Option<String>,
    location: Option<String>,
}

impl PageStats {
    fn is_empty(&self) -> bool {
        self.player_name.is_none()
            && self.level.is_none()
            && self.exp.is_none()
            && self.location.is_none()
    }
}

#[tauri::command]
fn update_stats(state: tauri::State<AppState>, stats: PageStats, manual: bool) {
    if stats.is_empty() {
        // no player card on page yet, ignore
        return;
    }

    // Ctrl+Shift+D passes manual=true and skips throttle
    if !manual {
        let mut last = state.last_update_ms.lock().unwrap();
        let now = now_millis();
        if now.saturating_sub(*last) < MIN_UPDATE_INTERVAL_MS {
            println!("Update throttled; skipping");
            return;
        }
        *last = now;
        drop(last);
    }

    let activity = stats_activity(&stats, state.session_start_ms);
    let mut rpc = state.rpc.lock().unwrap();
    if rpc.set_activity(activity) {
        println!(
            "RPC activity updated: name={:?} level={:?}",
            stats.player_name, stats.level
        );
    }
}

#[derive(Clone, Copy)]
enum ShortcutAction {
    Reload,
    RefreshStats,
}

#[cfg(target_os = "macos")]
const CMD_OR_CTRL: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const CMD_OR_CTRL: Modifiers = Modifiers::CONTROL;

fn shortcut_set() -> Vec<(Shortcut, ShortcutAction)> {
    vec![
        (Shortcut::new(None, Code::F5), ShortcutAction::Reload),
        (
            Shortcut::new(Some(CMD_OR_CTRL), Code::KeyR),
            ShortcutAction::Reload,
        ),
        (
            Shortcut::new(Some(CMD_OR_CTRL | Modifiers::SHIFT), Code::KeyD),
            ShortcutAction::RefreshStats,
        ),
    ]
}

fn handle_shortcut(app: &AppHandle, action: ShortcutAction) {
    if let Some(window) = app.get_webview_window("main") {
        match action {
            ShortcutAction::Reload => {
                let _ = window.eval("window.location.reload()");
            }
            // DOM read is in inject.js; Rust just emits refresh-stats
            ShortcutAction::RefreshStats => {
                let _ = window.emit("refresh-stats", ());
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![update_stats])
        .setup(|app| {
            app.manage(AppState {
                rpc: Mutex::new(DiscordRpc::new()),
                last_update_ms: Mutex::new(0),
                session_start_ms: now_millis(),
            });

            // initialization_script only on WebviewWindowBuilder; runs each navigation including remote game
            // eval can't return DOM, so inject.js pushes update_stats
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("SpeakiRPG")
            .inner_size(1920.0, 1080.0)
            .center()
            .initialization_script(include_str!("inject.js"))
            .build()?;

            // mirrors Electron register on focus / unregisterAll on blur
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(true) => {
                    let shortcuts = shortcut_set();
                    for (shortcut, action) in shortcuts {
                        let global_shortcut = app_handle.global_shortcut();
                        if !global_shortcut.is_registered(shortcut) {
                            let _ = global_shortcut.on_shortcut(shortcut, move |app,
                                                                    _shortcut,
                                                                    event| {
                                if event.state == ShortcutState::Pressed {
                                    handle_shortcut(app, action);
                                }
                            });
                        }
                    }
                }
                WindowEvent::Focused(false) => {
                    let _ = app_handle.global_shortcut().unregister_all();
                }
                _ => {}
            });

            // don't block window open on Discord IPC; it may not be running yet
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = app_handle.state::<AppState>();
                let start = state.session_start_ms;
                let mut rpc = state.rpc.lock().unwrap();
                if rpc.connect() {
                    rpc.try_set(&menu_activity(start));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
