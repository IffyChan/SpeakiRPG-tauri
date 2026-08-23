//! Google gtx client. HTTP in Rust because the game page can't call gtx (CORS).
//! Cache survives page reloads. Swap this module if Google rate-limits the endpoint.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const GTX_URL: &str = "https://translate.googleapis.com/translate_a/single";
// gtx expects a browser UA; bare reqwest gets 429 sooner
const GTX_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct Translator {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, String>>,
}

impl Translator {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client");
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }

    // gtx shape: [[["translated","source",...],...], ...]; sl=auto for mixed chat langs
    pub async fn translate(&self, text: &str, target: &str) -> Result<String, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(String::new());
        }

        let cache_key = format!("{target}::{text}");
        if let Some(hit) = self.cache.lock().unwrap().get(&cache_key) {
            return Ok(hit.clone());
        }

        let response = self
            .client
            .get(GTX_URL)
            .header("User-Agent", GTX_USER_AGENT)
            .query(&[
                ("client", "gtx"),
                ("sl", "auto"),
                ("tl", target),
                ("dt", "t"),
                ("q", text),
            ])
            .send()
            .await
            .map_err(|e| format!("gtx request failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("gtx returned HTTP {}", response.status()));
        }

        let value: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("gtx response parse failed: {e}"))?;

        let mut translated = String::new();
        if let Some(segments) = value.get(0).and_then(|v| v.as_array()) {
            for segment in segments {
                if let Some(part) = segment.get(0).and_then(|v| v.as_str()) {
                    translated.push_str(part);
                }
            }
        }

        if translated.is_empty() {
            return Err("gtx returned empty translation".into());
        }

        self.cache
            .lock()
            .unwrap()
            .insert(cache_key, translated.clone());

        Ok(translated)
    }
}
