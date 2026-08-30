pub const GAME_HOST: &str = "speakirpg.overture.io.kr";

#[cfg(windows)]
mod imp {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_13, ICoreWebView2_2, ICoreWebView2Profile2,
        COREWEBVIEW2_BROWSING_DATA_KINDS, COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES,
    };
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use windows::core::Interface;

    type WvResult<T> = windows::core::Result<T>;

    // https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile2
    // Don't use wait_with_pump here: switch_account runs from an IPC thread and nested
    // GetMessage deadlocks the UI. Clear is async; inject.js clears origin storage on load.
    fn clear_browsing_data_fire_and_forget(
        profile_2: &ICoreWebView2Profile2,
        kinds: Option<COREWEBVIEW2_BROWSING_DATA_KINDS>,
    ) -> WvResult<()> {
        unsafe {
            match kinds {
                Some(kinds) => profile_2.ClearBrowsingData(
                    kinds,
                    &ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(()))),
                )?,
                None => profile_2.ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(
                    Box::new(|_| Ok(())),
                ))?,
            }
        }
        Ok(())
    }

    fn profile_2_from_webview(webview: &ICoreWebView2) -> WvResult<ICoreWebView2Profile2> {
        let webview_13 = webview.cast::<ICoreWebView2_13>()?;
        let profile = unsafe { webview_13.Profile() }?;
        profile.cast::<ICoreWebView2Profile2>()
    }

    fn clear_browsing_data(webview: &ICoreWebView2) -> WvResult<()> {
        let profile_2 = profile_2_from_webview(webview)?;
        let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES
            | COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE;
        clear_browsing_data_fire_and_forget(&profile_2, Some(kinds))
    }

    fn clear_browsing_data_all(webview: &ICoreWebView2) -> WvResult<()> {
        let profile_2 = profile_2_from_webview(webview)?;
        clear_browsing_data_fire_and_forget(&profile_2, None)
    }

    fn clear_cookies_last_resort(webview: &ICoreWebView2) -> WvResult<()> {
        let webview_2 = webview.cast::<ICoreWebView2_2>()?;
        let cookie_manager = unsafe { webview_2.CookieManager() }?;
        unsafe {
            cookie_manager.DeleteAllCookies()?;
        }
        Ok(())
    }

    pub fn clear_game_session(window: &WebviewWindow) -> Result<(), String> {
        println!("[SpeakiRPG] clearing game session ({})", super::GAME_HOST);
        let err = Arc::new(Mutex::new(None));
        let err_capture = Arc::clone(&err);

        window
            .with_webview(move |platform| {
                let setup = (|| -> WvResult<()> {
                    let controller = platform.controller();
                    let webview = unsafe { controller.CoreWebView2() }?;

                    if let Err(e) = clear_browsing_data(&webview) {
                        eprintln!(
                            "[SpeakiRPG] ClearBrowsingData failed ({e}), falling back to ClearBrowsingDataAll"
                        );
                        if let Err(e2) = clear_browsing_data_all(&webview) {
                            eprintln!(
                                "[SpeakiRPG] ClearBrowsingDataAll failed ({e2}), falling back to DeleteAllCookies"
                            );
                            clear_cookies_last_resort(&webview)?;
                        }
                    }

                    Ok(())
                })();

                if let Err(e) = setup {
                    *err_capture.lock().unwrap() =
                        Some(format!("failed to clear game session: {e}"));
                }
            })
            .map_err(|e| e.to_string())?;

        if let Some(message) = err.lock().unwrap().take() {
            return Err(message);
        }

        // brief pause so async WebView2 cookie/storage clear can start before navigation
        std::thread::sleep(Duration::from_millis(200));
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn clear_game_session(_window: &tauri::WebviewWindow) -> Result<(), String> {
    eprintln!("[SpeakiRPG] session clear skipped on this platform; inject.js clears storage on load");
    Ok(())
}

#[cfg(windows)]
pub fn clear_game_session(window: &tauri::WebviewWindow) -> Result<(), String> {
    imp::clear_game_session(window)
}
