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
        ICoreWebView2WebResourceResponse, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::Interface;
    use windows::core::{HSTRING, PWSTR};

    use crate::Settings;

    type WvResult<T> = windows::core::Result<T>;

    // WebView2 COM objects are thread-affine: every call must happen on the
    // thread that created them (0x802A000C RPC_E_WRONG_THREAD otherwise). The
    // worker below only fetches/patches plain strings; args/env/deferral are
    // carried back to the UI thread via run_on_main_thread before any COM call.
    // windows-rs wrappers don't claim Send, so moves go through this wrapper —
    // it only carries the pointer, never services a call off-thread.
    struct Agile<T>(T);
    unsafe impl<T> Send for Agile<T> {}
    impl<T> Agile<T> {
        // whole-struct capture: a plain `.0` field access would let the closure
        // capture just the non-Send inner COM object (disjoint capture)
        fn into_inner(self) -> T {
            self.0
        }
    }

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

    // one client for the app lifetime: reuse the connection pool and TLS session
    // instead of re-handshaking on every intercepted request
    fn http_client() -> &'static reqwest::blocking::Client {
        static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::blocking::Client::builder()
                .user_agent("SpeakiRPG-tauri/1.0")
                .build()
                .unwrap_or_default()
        })
    }

    fn fetch_text(url: &str) -> std::result::Result<String, String> {
        let res = http_client().get(url).send().map_err(|e| e.to_string())?;
        res.text().map_err(|e| e.to_string())
    }

    fn with_patch_marker(code: String) -> String {
        if code.contains("__SPEAKI_GS_PATCHED__") {
            code
        } else {
            format!("{PATCH_MARKER}{code}")
        }
    }

    fn absolutize_vite_imports(source: &str) -> String {
        static FROM_DQ: OnceLock<Regex> = OnceLock::new();
        static FROM_SQ: OnceLock<Regex> = OnceLock::new();
        static DYN_DQ: OnceLock<Regex> = OnceLock::new();
        static DYN_SQ: OnceLock<Regex> = OnceLock::new();

        let base = format!("https://{GAME_HOST}/assets/");
        let from_dq = FROM_DQ.get_or_init(|| {
            Regex::new(r#"(from|import)\s*"\./([^"]+)""#).expect("vite import regex")
        });
        let from_sq = FROM_SQ.get_or_init(|| {
            Regex::new(r"(from|import)\s*'\./([^']+)'").expect("vite import regex")
        });
        let dyn_dq = DYN_DQ.get_or_init(|| {
            Regex::new(r#"import\s*\(\s*"\./([^"]+)"\s*\)"#).expect("vite dynamic import regex")
        });
        let dyn_sq = DYN_SQ.get_or_init(|| {
            Regex::new(r"import\s*\(\s*'\./([^']+)'\s*\)").expect("vite dynamic import regex")
        });

        let mut out = from_dq
            .replace_all(source, |caps: &regex::Captures| {
                format!("{}\"{}{}\"", &caps[1], base, &caps[2])
            })
            .into_owned();
        out = from_sq
            .replace_all(&out, |caps: &regex::Captures| {
                format!("{}'{}{}'", &caps[1], base, &caps[2])
            })
            .into_owned();
        out = dyn_dq
            .replace_all(&out, |caps: &regex::Captures| {
                format!("import(\"{}{}\")", base, &caps[1])
            })
            .into_owned();
        out = dyn_sq
            .replace_all(&out, |caps: &regex::Captures| {
                format!("import('{}{}')", base, &caps[1])
            })
            .into_owned();
        out = out.replace("\"assets/", &format!("\"{base}"));
        out.replace("'assets/", &format!("'{base}"))
    }

    fn finalize_patched_bundle(source: String) -> String {
        absolutize_vite_imports(&with_patch_marker(source))
    }

    fn extract_i18n_id(source: &str) -> Option<String> {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| {
            Regex::new(
                r"function (\w+)\(e\)\s*\{\s*let \w+\s*=\s*\w+\[\w+\(\)\];\s*return Object\.prototype\.hasOwnProperty\.call\(\w+,\s*e\)\s*\?\s*\w+\[e\]\s*:",
            )
            .expect("i18n regex")
        });
        re.captures(source)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
    }

    fn extract_quest_manager_id(source: &str) -> Option<String> {
        static RE: OnceLock<Regex> = OnceLock::new();
        let re = RE.get_or_init(|| {
            Regex::new(
                r"new\s*(\w+)\(\{\s*container:\s*e,\s*showToast:\s*e\s*=>\s*\w+\.setStatus\(e\),\s*onClaimSuccess:\s*\(\)\s*=>\s*\{\s*\w+\.markStale\(\),\s*\w+\.markStale\(\),\s*\w+\(\)\s*}",
            )
            .expect("quest manager regex")
        });
        re.captures(source)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
    }

    fn build_capture_prefix(recv: &str, i18n: Option<&str>, quest_manager: Option<&str>) -> String {
        let mut parts = vec![format!("window.gameState={recv}")];
        if let Some(id) = i18n {
            if id != "null" {
                parts.push(format!("window.i18n={id}"));
            }
        }
        if let Some(id) = quest_manager {
            if id != "null" {
                parts.push(format!("window.questManager={id}"));
            }
        }
        parts.join(",")
    }

    fn splice_connect_patch(
        source: &str,
        abs: usize,
        original: &str,
        recv: &str,
        i18n: Option<&str>,
        quest_manager: Option<&str>,
    ) -> String {
        let prefix = build_capture_prefix(recv, i18n, quest_manager);
        let patched = format!("{prefix},{original}");
        let mut code = String::with_capacity(source.len() + patched.len());
        code.push_str(&source[..abs]);
        code.push_str(&patched);
        code.push_str(&source[abs + original.len()..]);
        code
    }

    fn try_patch_connect_site(
        source: &str,
        abs: usize,
        original: &str,
        recv: &str,
        i18n: Option<&str>,
        quest_manager: Option<&str>,
    ) -> Option<String> {
        if recv == "socket" || recv == "WebSocket" {
            return None;
        }
        let code = splice_connect_patch(source, abs, original, recv, i18n, quest_manager);
        if code.contains("window.gameState=") {
            Some(finalize_patched_bundle(code))
        } else {
            None
        }
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

        let i18n = extract_i18n_id(source);
        let quest_manager = extract_quest_manager_id(source);
        let i18n_ref = i18n.as_deref();
        let quest_ref = quest_manager.as_deref();

        static PRIMARY_RE: OnceLock<Regex> = OnceLock::new();
        let primary_re = PRIMARY_RE.get_or_init(|| {
            Regex::new(
                r"([\w$]+)\.connect\(([\w$]+)\),[sc]n\(\(\)=>\{[an]n\(\)\.autoAttackEnabled\|\|",
            )
            .expect("primary connect regex")
        });

        if let Some(caps) = primary_re.captures(source) {
            let recv = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let original = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let abs = caps.get(0).unwrap().start();
            if let Some(code) = try_patch_connect_site(source, abs, original, recv, i18n_ref, quest_ref)
            {
                return Ok(code);
            }
        }

        static LEGACY_RE: OnceLock<Regex> = OnceLock::new();
        let legacy_re = LEGACY_RE.get_or_init(|| {
            Regex::new(
                r"(\}\);)([\w$]+)\.connect\(([\w$]+)\),([sc]n\(\(\)=>\{[an]n\(\)\.autoAttackEnabled\|\|)",
            )
            .expect("legacy connect regex")
        });
        if let Some(caps) = legacy_re.captures(source) {
            let recv = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let arg = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            let prefix = build_capture_prefix(recv, i18n_ref, quest_ref);
            let replacement = format!("$1({prefix},{recv}.connect({arg})),$4");
            let code = legacy_re
                .replace(source, replacement.as_str())
                .into_owned();
            if code.contains("window.gameState=") {
                return Ok(finalize_patched_bundle(code));
            }
        }

        static ELECTRON_RE: OnceLock<Regex> = OnceLock::new();
        let electron_re = ELECTRON_RE.get_or_init(|| {
            Regex::new(r";\s*(([\w$]+)\.connect\(([\w$]+)\)),([^;]{0,96}autoAttackEnabled)")
                .expect("electron connect regex")
        });
        if let Some(caps) = electron_re.captures(source) {
            let recv = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let original = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let connect_abs = caps.get(1).unwrap().start();
            if let Some(code) = try_patch_connect_site(
                source,
                connect_abs,
                original,
                recv,
                i18n_ref,
                quest_ref,
            ) {
                return Ok(code);
            }
        }

        let combat_pos = source
            .find("combatAssist")
            .ok_or_else(|| "connect() patch site not found".to_string())?;
        let tail = &source[combat_pos..];
        static CONNECT_RE: OnceLock<Regex> = OnceLock::new();
        let connect_re = CONNECT_RE.get_or_init(|| {
            Regex::new(r"([\w$]+)\.connect\(([\w$]+)\)").expect("connect regex")
        });

        for caps in connect_re.captures_iter(tail) {
            let recv = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let original = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let abs = combat_pos + caps.get(0).unwrap().start();
            if let Some(code) =
                try_patch_connect_site(source, abs, original, recv, i18n_ref, quest_ref)
            {
                return Ok(code);
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

                let webview_22 = webview.cast::<ICoreWebView2_22>().ok();
                if webview_22.is_some() {
                    println!("[SpeakiRPG] gameState proxy: host filter + RequestSourceKinds");
                } else {
                    eprintln!(
                        "[SpeakiRPG] gameState proxy: WebView2_22 missing — update WebView2 runtime"
                    );
                }

                // Only document + script requests need to reach the host. Filtering
                // ALL contexts routes every image/XHR the game loads through a
                // per-request cross-process round trip.
                for context in [
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
                ] {
                    match &webview_22 {
                        Some(webview_22) => unsafe {
                            webview_22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                                &filter,
                                context,
                                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                            )?;
                        },
                        None => unsafe {
                            webview.AddWebResourceRequestedFilter(&filter, context)?;
                        },
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

                        // The handler runs on the webview UI thread; fetch + regex
                        // patch of a multi-MB bundle would freeze the whole game for
                        // its duration. Take a deferral and finish on a worker thread.
                        let deferral = unsafe { args.GetDeferral()? };
                        let env = env.clone();
                        let app = app.clone();

                        let args = Agile(args);
                        let env = Agile(env);
                        let deferral = Agile(deferral);

                        std::thread::spawn(move || {
                            // fetch + regex patch of a multi-MB bundle: pure Rust,
                            // safe on any thread
                            let result = (|| -> std::result::Result<
                                (Vec<u8>, &'static str, &'static str, bool),
                                String,
                            > {
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

                            // every WebView2 COM call (create_response, SetResponse,
                            // Complete) must run on the creating UI thread
                            let main_app = app.clone();
                            let scheduled = app.run_on_main_thread(move || {
                                let args = args.into_inner();
                                let env = env.into_inner();
                                let deferral = deferral.into_inner();

                                match result {
                                    Ok((body, content_type, label, notify)) => {
                                        println!(
                                            "[SpeakiRPG] gameState: patched via WebView2 ({label})"
                                        );
                                        // on any failure the deferral completes without a
                                        // response and the request proceeds to the network
                                        match unsafe { create_response(&env, &body, content_type) }
                                        {
                                            Ok(response) => {
                                                unsafe {
                                                    if let Err(e) = args.SetResponse(&response) {
                                                        eprintln!(
                                                            "[SpeakiRPG] gameState proxy: SetResponse failed: {e}"
                                                        );
                                                    }
                                                }
                                                if notify {
                                                    notify_patched(&main_app);
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!(
                                                    "[SpeakiRPG] gameState proxy: response build failed: {e}"
                                                );
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        eprintln!(
                                            "[SpeakiRPG] gameState proxy patch failed: {err}"
                                        );
                                    }
                                }

                                unsafe {
                                    if let Err(e) = deferral.Complete() {
                                        eprintln!(
                                            "[SpeakiRPG] gameState proxy: deferral complete failed: {e}"
                                        );
                                    }
                                }
                            });

                            if let Err(e) = scheduled {
                                // event loop gone (app shutting down): nothing left
                                // to complete on the UI thread
                                eprintln!(
                                    "[SpeakiRPG] gameState proxy: main thread dispatch failed: {e}"
                                );
                            }
                        });

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
        use super::{is_game_document_url, is_index_script_url};

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
            assert!(patched.contains("window.gameState=k,"));
            assert!(patched.contains("k.connect(g)"));
            assert!(!patched.contains("autoAttackEnabled||)"));
        }

        #[test]
        fn patch_electron_fallback_without_primary() {
            let src = "combatAssist;targetMonsterId;socket.connect(ws);k.connect(g),middleStuff,cn(()=>{nn().autoAttackEnabled||k.stopAutoAttack()});";
            let patched = super::patch_index_bundle(src).expect("electron fallback");
            assert!(patched.contains("window.gameState=k,"));
            assert!(patched.contains("k.connect(g)"));
            assert!(!patched.contains("window.gameState=socket"));
        }

        #[test]
        fn rewrite_html_adds_cache_bust() {
            let html = r#"<!DOCTYPE html><html><head>
<script type="module" crossorigin src="/assets/index-AbCdEf.js"></script>
</head><body></body></html>"#;
            let out = super::rewrite_html_cache_bust(html).expect("rewrite");
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
