//! Google Translate gtx client. HTTP runs in Rust because the game page can't call
//! gtx (CORS) and we cache translations across page reloads. Unofficial endpoint;
//! swap Translator internals if Google rate-limits it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const GTX_URL: &str = "https://translate.googleapis.com/translate_a/single";

pub struct Translator {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, String>>,
    pub target: String,
}

impl Translator {
    pub fn new(target: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client");
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
            target,
        }
    }

    // gtx shape: [[["translated","source",...],...], ...]; concatenate segment [0] values
    pub async fn translate(&self, text: &str) -> Result<String, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(String::new());
        }

        let cache_key = format!("{}::{}", self.target, text);
        if let Some(hit) = self.cache.lock().unwrap().get(&cache_key) {
            return Ok(hit.clone());
        }

        let response = self
            .client
            .get(GTX_URL)
            .query(&[
                ("client", "gtx"),
                ("sl", "auto"),
                ("tl", self.target.as_str()),
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

        // don't cache failures
        self.cache
            .lock()
            .unwrap()
            .insert(cache_key, translated.clone());

        Ok(translated)
    }
}
