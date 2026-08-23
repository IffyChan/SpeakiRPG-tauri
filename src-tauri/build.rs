fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            // registers update_stats + translate_text; remote invoke needs capabilities/main.json
            .app_manifest(
                tauri_build::AppManifest::new()
                    .commands(&["update_stats", "translate_text"]),
            ),
    )
    .expect("failed to run tauri-build");
}