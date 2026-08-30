fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            // registers app commands; remote invoke allowed only via capabilities/*.json
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "update_stats",
                    "translate_text",
                    "get_settings",
                    "set_settings",
                    "open_mods_folder",
                    "open_settings",
                    "list_mods",
                    "get_user_mod_scripts",
                    "mod_action",
                    "switch_account",
                    "take_account_switch_pending",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}