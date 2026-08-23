// Intercepts speakirpg HTML + index-*.js at the WebView2 layer.
// Asset-only SetResponse can lose to cache; HTML rewrite with a base64 blob loader is reliable.
#[cfg(windows)]
mod imp {
    use std::fmt::Write as _;
    use std::mem;
    use std::sync::{OnceLock, RwLock};

    use regex::Regex;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_22, ICoreWebView2Environment,
        ICoreWebView2WebResourceResponse, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::Interface;
    use windows::core::{HSTRING, PWSTR};

    use crate::Settings;

    type WvResult<T> = windows::core::Result<T>;

    const GAME_HOST: &str = "speakirpg.overture.io.kr";
    const PATCH_MARKER: &str = "window.__SPEAKI_GS_PATCHED__=1;";

    fn index_url_re() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(&format!(
                r"^https://{GAME_HOST}/assets/index-[\w-]+\.js"
            ))
            .expect("index url regex")
        })
    }

    fn index_script_tag_re() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(
                r#"(?is)<script[^>]*\ssrc="(/assets/index-[\w-]+\.js)"[^>]*>\s*</script>"#,
            )
            .expect("script tag regex")
        })
    }

    fn is_index_script_url(uri: &str) -> bool {
        let base = uri.split('?').next().unwrap_or(uri);
        index_url_re().is_match(base)
    }

    fn is_game_document_url(uri: &str) -> bool {
        let base = uri.split('?').next().unwrap_or(uri).trim_end_matches('/');
        base == format!("https://{GAME_HOST}") || base.ends_with("/index.html")
    }

    fn fetch_text(url: &str) -> std::result::Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("SpeakiRPG-tauri/1.0")
            .build()
            .map_err(|e| e.to_string())?;
        let res = client.get(url).send().map_err(|e| e.to_string())?;
        let text = res.text().map_err(|e| e.to_string())?;
        Ok(text)
    }

    fn with_patch_marker(code: String) -> String {
        if code.contains("__SPEAKI_GS_PATCHED__") {
            code
        } else {
            format!("{PATCH_MARKER}{code}")
        }
    }

    fn absolutize_vite_imports(source: &str) -> String {
        let base = format!("https://{GAME_HOST}/assets/");
        let mut out = source.to_string();
        for (open, close) in [("\"", "\""), ("'", "'")] {
            let static_re = Regex::new(&format!(
                r#"(from|import)\s*{open}\./([^{close}]+){close}"#
            ))
            .expect("static import re");
            out = static_re
                .replace_all(&out, |caps: &regex::Captures| {
                    format!(
                        "{}{}{}{}{}",
                        &caps[1], open, base, &caps[2], close
                    )
                })
                .into_owned();
            let dyn_re = Regex::new(&format!(
                r#"import\s*\(\s*{open}\./([^{close}]+){close}\s*\)"#
            ))
            .expect("dyn import re");
            out = dyn_re
                .replace_all(&out, |caps: &regex::Captures| {
                    format!("import({}{}{}{})", open, base, &caps[1], close)
                })
                .into_owned();
        }
        out = out.replace("\"assets/", &format!("\"{base}"));
        out.replace("'assets/", &format!("'{base}"))
    }

    fn finalize_patched_bundle(source: String) -> String {
        absolutize_vite_imports(&with_patch_marker(source))
    }

    pub(crate) fn patch_index_bundle(source: &str) -> std::result::Result<String, String> {
        const ANCHORS: &[&str] = &[
            "targetMonsterId",
            "combatAssist",
            "sendEmoteNow",
            "tryUsePotion",
        ];
        let hits = ANCHORS.iter().filter(|a| source.contains(**a)).count();
        if hits < 2 {
            return Err(format!("anchors found: {hits}/2"));
        }

        let primary = Regex::new(
            r"([\w$]+)\.connect\(([\w$]+)\),[sc]n\(\(\)=>\{[an]n\(\)\.autoAttackEnabled\|\|",
        )
        .map_err(|e| e.to_string())?;

        if let Some(caps) = primary.captures(source) {
            let recv = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let original = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            // comma expression, not wrapped in parens — closing ")" would break
            // `autoAttackEnabled||k.stopAutoAttack()` after the anchor
            let patched = format!("window.gameState={recv},{original}");
            let abs = caps.get(0).unwrap().start();
            let mut code = String::with_capacity(source.len() + patched.len());
            code.push_str(&source[..abs]);
            code.push_str(&patched);
            code.push_str(&source[abs + original.len()..]);
            if code.contains("window.gameState=") {
                return Ok(finalize_patched_bundle(code));
            }
        }

        let combat_pos = source
            .find("combatAssist")
            .ok_or_else(|| "connect() patch site not found".to_string())?;
        let tail = &source[combat_pos..];
        let connect_re =
            Regex::new(r"([\w$]+)\.connect\(([\w$]+)\)").map_err(|e| e.to_string())?;

        for caps in connect_re.captures_iter(tail) {
            let recv = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if recv == "socket" || recv == "WebSocket" {
                continue;
            }
            let original = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let abs = combat_pos + caps.get(0).unwrap().start();
            let patched = format!("window.gameState={recv},{original}");
            let mut code = String::with_capacity(source.len() + patched.len());
            code.push_str(&source[..abs]);
            code.push_str(&patched);
            code.push_str(&source[abs + original.len()..]);
            if code.contains("window.gameState=") {
                return Ok(finalize_patched_bundle(code));
            }
        }

        Err("connect() patch site not found".into())
    }

    fn rewrite_html_cache_bust(html: &str) -> std::result::Result<String, String> {
        let re = index_script_tag_re();
        if !re.is_match(html) {
            return Err("index module script tag not found".into());
        }
        Ok(re
            .replace_all(html, |caps: &regex::Captures| {
                let path = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                format!(r#"<script type="module" crossorigin src="{path}?speaki_gs=1"></script>"#)
            })
            .into_owned())
    }

    fn fetch_index_source(uri: &str) -> std::result::Result<String, String> {
        let base = uri.split('?').next().unwrap_or(uri);
        let text = fetch_text(base)?;
        if text.trim_start().starts_with('<') {
            return Err("index bundle response was HTML (CDN cache?)".into());
        }
        Ok(text)
    }

    fn take_pwstr(pwstr: PWSTR) -> String {
        if pwstr.is_null() {
            return String::new();
        }
        unsafe { pwstr.to_string().unwrap_or_default() }
    }

    unsafe fn create_response(
        env: &ICoreWebView2Environment,
        body: &[u8],
        content_type: &str,
    ) -> WvResult<ICoreWebView2WebResourceResponse> {
        let mut headers = String::new();
        let _ = writeln!(headers, "Content-Type: {content_type}");
        let _ = writeln!(headers, "Cache-Control: no-store");
        let headers = HSTRING::from(headers);
        let status = HSTRING::from("OK");
        let stream = windows::Win32::UI::Shell::SHCreateMemStream(Some(body));
        env.CreateWebResourceResponse(stream.as_ref(), 200, &status, &headers)
    }

    fn notify_patched(app: &AppHandle) {
        let _ = app.emit("gamestate-index-patched", ());
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(
                "window.__speakiGsOnNativePatch && window.__speakiGsOnNativePatch()",
            );
        }
    }

    pub fn install(window: &WebviewWindow, app: &AppHandle) {
        let app = app.clone();

        if let Err(err) = window.with_webview(move |platform| {
            let setup = (|| -> WvResult<()> {
                let controller = platform.controller();
                let webview: ICoreWebView2 = unsafe { controller.CoreWebView2() }?;
                let env = platform.environment();

                let filter = HSTRING::from(format!("https://{GAME_HOST}/*"));

                if let Ok(webview_22) = webview.cast::<ICoreWebView2_22>() {
                    println!(
                        "[SpeakiRPG] gameState proxy: host filter + RequestSourceKinds"
                    );
                    unsafe {
                        webview_22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                            &filter,
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                        )?;
                    }
                } else {
                    eprintln!(
                        "[SpeakiRPG] gameState proxy: WebView2_22 missing — update WebView2 runtime"
                    );
                    unsafe {
                        webview.AddWebResourceRequestedFilter(
                            &filter,
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        )?;
                    }
                }

                let env = env.clone();
                let app = app.clone();
                let mut token: i64 = 0;

                let handler = WebResourceRequestedEventHandler::create(Box::new(
                    move |_sender, args| -> WvResult<()> {
                        let Some(args) = args else {
                            return Ok(());
                        };

                        let request = unsafe { args.Request()? };

                        let uri = {
                            let mut raw = PWSTR::null();
                            unsafe { request.Uri(&mut raw)? };
                            take_pwstr(raw)
                        };

                        let is_doc = is_game_document_url(&uri);
                        let is_index = is_index_script_url(&uri);
                        if !is_doc && !is_index {
                            return Ok(());
                        }

                        let capture_on = app
                            .state::<RwLock<Settings>>()
                            .read()
                            .map(|s| s.capture_game_state)
                            .unwrap_or(false);
                        if !capture_on {
                            return Ok(());
                        }

                        println!("[SpeakiRPG] gameState proxy: intercept {uri}");

                        let deferral = unsafe { args.GetDeferral()? };
                        let env = env.clone();
                        let app = app.clone();

                        let result =
                            (|| -> std::result::Result<(Vec<u8>, &'static str, &'static str, bool), String> {
                                if is_doc {
                                    let html = fetch_text(&uri)?;
                                    let rewritten = rewrite_html_cache_bust(&html)?;
                                    return Ok((
                                        rewritten.into_bytes(),
                                        "text/html; charset=utf-8",
                                        "HTML cache bust",
                                        false,
                                    ));
                                }
                                let text = fetch_index_source(&uri)?;
                                let patched = patch_index_bundle(&text)?;
                                Ok((
                                    patched.into_bytes(),
                                    "text/javascript; charset=utf-8",
                                    "index module",
                                    true,
                                ))
                            })();

                        match result {
                            Ok((body, content_type, label, notify)) => {
                                println!(
                                    "[SpeakiRPG] gameState: patched via WebView2 ({label})"
                                );
                                let response =
                                    unsafe { create_response(&env, &body, content_type)? };
                                unsafe { args.SetResponse(&response)? };
                                if notify {
                                    notify_patched(&app);
                                }
                            }
                            Err(err) => {
                                eprintln!("[SpeakiRPG] gameState proxy patch failed: {err}");
                            }
                        }

                        unsafe {
                            deferral.Complete()?;
                        }

                        Ok(())
                    },
                ));

                unsafe {
                    webview.add_WebResourceRequested(&handler, &mut token)?;
                }
                mem::forget(handler);

                Ok(())
            })();

            if let Err(e) = setup {
                eprintln!("[SpeakiRPG] gameState proxy hook failed: {e}");
            }
        }) {
            eprintln!("[SpeakiRPG] gameState proxy install failed: {err}");
            return;
        }

        println!("[SpeakiRPG] gameState WebView2 proxy installed");
        let _ = window.eval("window.__SPEAKI_GAMESTATE_PROXY_READY = true;");
    }

    #[cfg(test)]
    mod tests {
        use super::{is_game_document_url, is_index_script_url, patch_index_bundle};

        #[test]
        fn index_url_matches_query_suffix() {
            assert!(is_index_script_url(
                "https://speakirpg.overture.io.kr/assets/index-CsGDb3P-.js?speaki_gs=1"
            ));
            assert!(is_game_document_url("https://speakirpg.overture.io.kr/"));
            assert!(is_game_document_url(
                "https://speakirpg.overture.io.kr/?sr1_cb=1"
            ));
        }

        #[test]
        fn patch_new_bundle_anchor() {
            let src = "combatAssist;targetMonsterId;});k.connect(t)})()}});k.connect(g),cn(()=>{nn().autoAttackEnabled||k.stopAutoAttack()});";
            let patched = super::patch_index_bundle(src).expect("patch new anchor");
            assert!(patched.contains("window.gameState=k,k.connect(g)"));
            assert!(!patched.contains("autoAttackEnabled||)"));
        }

        #[test]
        fn patch_saved_bundle() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../docs/secret/assets/index-CsGDb3P-.js");
            if !path.exists() {
                return;
            }
            let src = std::fs::read_to_string(path).expect("read bundle");
            let patched = patch_index_bundle(&src).expect("patch bundle");
            assert!(patched.contains("window.gameState="));
            assert!(patched.contains("window.gameState=k,k.connect(g)"));
            assert!(!patched.contains("window.gameState=k,k.connect(t)"));
            assert!(!patched.contains("autoAttackEnabled||)"));
            assert!(patched.contains("__SPEAKI_GS_PATCHED__"));
        }

        #[test]
        fn rewrite_html_adds_cache_bust() {
            let head = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../docs/secret/example_head2.html");
            if !head.exists() {
                return;
            }
            let html = std::fs::read_to_string(head).expect("read head");
            let out = super::rewrite_html_cache_bust(&html).expect("rewrite");
            assert!(out.contains("index-"));
            assert!(out.contains("speaki_gs=1"));
            assert!(!out.contains("atob("));
        }
    }
}

#[cfg(windows)]
pub use imp::install;

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow, _app: &tauri::AppHandle) {}
