// Persists the main window geometry so it can be recreated at its final size.
// On Wayland a webview that gets resized after creation renders blurry
// (WebKitGTK compositor tiles, wry#1727); starting already maximized/sized
// avoids that first resize entirely.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "window-state.json";
const MIN_SIZE: f64 = 400.0;

#[derive(Serialize, Deserialize)]
struct SavedState {
    maximized: bool,
    // logical units, so DPI changes between runs don't double-scale
    width: f64,
    height: f64,
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE_NAME))
}

fn capture(window: &tauri::WebviewWindow) -> Option<SavedState> {
    let maximized = window.is_maximized().ok()?;
    let scale = window.scale_factor().ok()?;
    let physical = window.inner_size().ok()?;
    Some(SavedState {
        maximized,
        width: (physical.width as f64 / scale).round(),
        height: (physical.height as f64 / scale).round(),
    })
}

// Best-effort save on close; a missing window or disk error must never
// block the app from exiting.
pub fn persist(app: &AppHandle) {
    let Some(path) = state_path(app) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = capture(&window) else {
        return;
    };
    if state.width < MIN_SIZE || state.height < MIN_SIZE {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, format!("{json}\n"));
    }
}

pub struct RestoredState {
    pub maximized: bool,
    pub width: f64,
    pub height: f64,
}

// None = first run or unreadable file: fall back to the built-in defaults.
pub fn load(app: &AppHandle) -> Option<RestoredState> {
    let path = state_path(app)?;
    let json = std::fs::read_to_string(path).ok()?;
    let saved: SavedState = serde_json::from_str(&json).ok()?;
    if !saved.maximized && (saved.width < MIN_SIZE || saved.height < MIN_SIZE) {
        return None;
    }
    Some(RestoredState {
        maximized: saved.maximized,
        width: saved.width,
        height: saved.height,
    })
}
