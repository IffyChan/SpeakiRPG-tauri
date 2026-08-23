// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    sync::{Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

mod translate;

use translate::Translator;

const CLIENT_ID: &str = "1540927437523779696";
const GAME_URL: &str = "https://speakirpg.overture.io.kr/";
const RELEASES_URL: &str = "https://github.com/IffyChan/SpeakiRPG-tauri/releases";

// same throttle as MIN_UPDATE_INTERVAL_MS in Electron
const MIN_UPDATE_INTERVAL_MS: u64 = 10_000;

// ported verbatim from Electron
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

// live in RwLock; settings window and hotkeys push via settings-changed
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub translate_target: String,
    pub translate_enabled: bool,
    // off by default; you already know what you typed
    pub translate_own: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            translate_target: "ru".into(),
            translate_enabled: true,
            translate_own: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let defaults = Settings::default();
    let Some(path) = settings_path(app) else {
        return defaults;
    };

    if let Ok(json) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<Settings>(&json) {
            Ok(settings) => return settings,
            Err(err) => eprintln!("settings.json is unreadable, using defaults: {err}"),
        }
    }

    // write defaults on first run for hand-editing
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_ok() {
            if let Ok(json) = serde_json::to_string_pretty(&defaults) {
                let _ = std::fs::write(&path, format!("{json}\n"));
            }
        }
    }
    defaults
}

fn persist_settings(app: &AppHandle, settings: &Settings) {
    if let Some(path) = settings_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            // in-memory copy wins if disk write fails
            let _ = std::fs::write(&path, format!("{json}\n"));
        }
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<RwLock<Settings>>) -> Settings {
    state.read().unwrap().clone()
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: tauri::State<RwLock<Settings>>,
    settings: Settings,
) -> Result<(), String> {
    // bad language code would break every translate call
    let target = settings.translate_target.trim().to_lowercase();
    let valid = (2..=8).contains(&target.len())
        && target.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return Err("invalid translateTarget".into());
    }
    let settings = Settings {
        translate_target: target,
        ..settings
    };

    *state.write().unwrap() = settings.clone();
    persist_settings(&app, &settings);
    app.emit("settings-changed", &settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_mods_folder(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("mods");
    // creates mods/ on first click if missing
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn open_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        return window.set_focus().map_err(|e| e.to_string());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("SpeakiRPG Settings")
    .inner_size(420.0, 540.0)
    .resizable(false)
    .center();

    if let Some(parent) = app.get_webview_window("main") {
        builder = builder
            .parent(&parent)
            .map_err(|e| e.to_string())?;
    }

    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

// window create must run on the main thread. Shortcut handlers also run there;
// calling run_on_main_thread from the main thread deadlocks the event loop.
fn schedule_open_settings(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = app.clone();
        if let Err(err) = app.run_on_main_thread(move || {
            if let Err(err) = open_settings_window(&handle) {
                eprintln!("failed to open settings window: {err}");
            }
        }) {
            eprintln!("failed to schedule settings window: {err}");
        }
    });
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    schedule_open_settings(&app);
    Ok(())
}

fn load_mod_scripts(app: &AppHandle) -> String {
    let mut scripts = String::new();
    let Ok(config_dir) = app.path().app_config_dir() else {
        return scripts;
    };

    let mods_dir = config_dir.join("mods");
    let Ok(entries) = std::fs::read_dir(&mods_dir) else {
        return scripts; // no mods folder yet
    };

    let mut paths: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
        .collect();
    paths.sort(); // stable mod load order

    for path in paths {
        match std::fs::read_to_string(&path) {
            Ok(code) => {
                println!("loaded mod: {}", path.display());
                scripts.push_str("\n;\n");
                scripts.push_str(&code);
            }
            Err(err) => eprintln!("failed to read mod {}: {err}", path.display()),
        }
    }
    scripts
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
        eprintln!("failed to update RPC activity");
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
                .small_image("logo_small")
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
                .small_image("logo_small")
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
    // Electron rpcTimestamp
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
        // no player card yet, ignore
        return;
    }

    // manual=true skips throttle
    if !manual {
        let mut last = state.last_update_ms.lock().unwrap();
        let now = now_millis();
        if now.saturating_sub(*last) < MIN_UPDATE_INTERVAL_MS {
            println!("update throttled, skipping");
            return;
        }
        *last = now;
        drop(last);
    }

    let activity = stats_activity(&stats, state.session_start_ms);
    let mut rpc = state.rpc.lock().unwrap();
    if rpc.set_activity(activity) {
        println!(
            "rpc activity updated: name={:?} level={:?}",
            stats.player_name, stats.level
        );
    }
}

#[tauri::command]
async fn translate_text(
    settings: tauri::State<'_, RwLock<Settings>>,
    translator: tauri::State<'_, Translator>,
    text: String,
) -> Result<String, String> {
    let target = settings.read().unwrap().translate_target.clone();
    translator.translate(&text, &target).await
}

#[derive(Clone, Copy)]
enum ShortcutAction {
    Reload,
    RefreshStats,
    ToggleTranslation,
    OpenSettings,
}

// Cmd on macOS, Ctrl elsewhere
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
        (
            Shortcut::new(Some(CMD_OR_CTRL | Modifiers::SHIFT), Code::KeyT),
            ShortcutAction::ToggleTranslation,
        ),
        (
            Shortcut::new(Some(CMD_OR_CTRL | Modifiers::SHIFT), Code::KeyS),
            ShortcutAction::OpenSettings,
        ),
    ]
}

fn handle_shortcut(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::Reload => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload()");
            }
        }
        ShortcutAction::RefreshStats => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("refresh-stats", ());
            }
        }
        ShortcutAction::ToggleTranslation => {
            // toggle in Rust so settings window and inject.js stay in sync
            let state = app.state::<RwLock<Settings>>();
            let mut settings = state.write().unwrap();
            settings.translate_enabled = !settings.translate_enabled;
            let snapshot = settings.clone();
            drop(settings);
            persist_settings(app, &snapshot);
            let _ = app.emit("settings-changed", &snapshot);
            println!(
                "chat translation {}",
                if snapshot.translate_enabled { "on" } else { "off" }
            );
        }
        ShortcutAction::OpenSettings => schedule_open_settings(app),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            update_stats,
            translate_text,
            get_settings,
            set_settings,
            open_mods_folder,
            open_settings
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            let settings = load_settings(&app_handle);
            app.manage(RwLock::new(settings.clone()));
            app.manage(Translator::new());

            app.manage(AppState {
                rpc: Mutex::new(DiscordRpc::new()),
                last_update_ms: Mutex::new(0),
                session_start_ms: now_millis(),
            });

            // WebviewWindowBuilder only: init order is settings snapshot, inject.js, mods
            let settings_json = serde_json::to_string(&settings)
                .unwrap_or_else(|_| "{}".into());
            let mods = load_mod_scripts(&app_handle);

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("SpeakiRPG")
            .inner_size(1920.0, 1080.0)
            .center()
            // runs on every navigation; inject.js pushes to Rust (eval can't return DOM)
            .initialization_script(format!(
                "window.__SPEAKI_SETTINGS__ = {settings_json};"
            ))
            .initialization_script(include_str!("inject.js"))
            .initialization_script(mods)
            .build()?;

            // register shortcuts only while focused so F5 isn't stolen from other apps
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

            // don't block window open on Discord IPC
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