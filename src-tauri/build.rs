fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            // registers update_stats; remote invoke needs capabilities/main.json (Tauri 2 default deny)
            .app_manifest(tauri_build::AppManifest::new().commands(&["update_stats"])),
    )
    .expect("failed to run tauri-build");
}