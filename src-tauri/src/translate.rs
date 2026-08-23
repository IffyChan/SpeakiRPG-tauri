//! Pluggable HTTP translation. Built-in presets or a user URL/body template (local LLM, etc.).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

const GTX_URL: &str = "https://translate.googleapis.com/translate_a/single";
const MYMEMORY_URL: &str = "https://api.mymemory.translated.net/get";
const GTX_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Clone)]
pub struct TranslateConfig {
    pub provider: String,
    pub target: String,
    pub endpoint: String,
    pub json_path: String,
    pub api_key: String,
    pub post_body: String,
}

#[derive(Deserialize)]
struct MyMemoryResponse {
    #[serde(rename = "responseData")]
    response_data: MyMemoryData,
    #[serde(rename = "quotaFinished")]
    quota_finished: Option<bool>,
    #[serde(rename = "responseStatus")]
    response_status: Option<i32>,
}

#[derive(Deserialize)]
struct MyMemoryData {
    #[serde(rename = "translatedText")]
    translated_text: String,
}

pub struct Translator {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, String>>,
}

impl Translator {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("failed to build HTTP client");
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn translate(&self, text: &str, config: &TranslateConfig) -> Result<String, String> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(String::new());
        }

        let cache_key = format!(
            "{}|{}|{}|{}|{}",
            config.provider, config.endpoint, config.json_path, config.target, text
        );
        if let Some(hit) = self.cache.lock().unwrap().get(&cache_key) {
            return Ok(hit.clone());
        }

        let translated = match config.provider.as_str() {
            "mymemory" => self.translate_mymemory(text, &config.target, &config.api_key).await?,
            "gtx" => self.translate_gtx(text, &config.target).await?,
            "custom" => self.translate_custom(text, config).await?,
            other => return Err(format!("unknown translate provider: {other}")),
        };

        self.cache
            .lock()
            .unwrap()
            .insert(cache_key, translated.clone());

        Ok(translated)
    }

    async fn translate_mymemory(
        &self,
        text: &str,
        target: &str,
        api_key: &str,
    ) -> Result<String, String> {
        let langpair = format!("autodetect|{target}");
        let mut request = self
            .client
            .get(MYMEMORY_URL)
            .query(&[("q", text), ("langpair", langpair.as_str())]);

        let email = api_key.trim();
        if !email.is_empty() {
            request = request.query(&[("de", email)]);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("mymemory request failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("mymemory returned HTTP {}", response.status()));
        }

        let body: MyMemoryResponse = response
            .json()
            .await
            .map_err(|e| format!("mymemory response parse failed: {e}"))?;

        if body.quota_finished == Some(true) {
            return Err("mymemory daily quota exhausted".into());
        }

        if let Some(status) = body.response_status {
            if status != 200 {
                return Err(format!("mymemory returned status {status}"));
            }
        }

        let translated = body.response_data.translated_text.trim().to_string();
        if translated.is_empty() {
            return Err("mymemory returned empty translation".into());
        }

        if translated.starts_with("MYMEMORY WARNING:") {
            return Err(translated);
        }

        Ok(translated)
    }

    async fn translate_gtx(&self, text: &str, target: &str) -> Result<String, String> {
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

        let value: Value = response
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

        Ok(translated)
    }

    async fn translate_custom(&self, text: &str, config: &TranslateConfig) -> Result<String, String> {
        let endpoint = config.endpoint.trim();
        if endpoint.is_empty() {
            return Err("custom provider needs translateEndpoint in settings".into());
        }

        let post_body = config.post_body.trim();
        let response = if post_body.is_empty() {
            let url = apply_url_template(endpoint, text, &config.target, &config.api_key)?;
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("translateEndpoint must start with http:// or https://".into());
            }
            self.client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("custom translate request failed: {e}"))?
        } else {
            let url = apply_url_template(endpoint, text, &config.target, &config.api_key)?;
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("translateEndpoint must start with http:// or https://".into());
            }
            let body = apply_json_template(post_body, text, &config.target, &config.api_key)?;
            self.client
                .post(url)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|e| format!("custom translate request failed: {e}"))?
        };

        if !response.status().is_success() {
            return Err(format!("custom translate returned HTTP {}", response.status()));
        }

        let raw = response
            .text()
            .await
            .map_err(|e| format!("custom translate read failed: {e}"))?;

        parse_custom_response(&raw, &config.json_path)
    }
}

fn apply_url_template(template: &str, text: &str, target: &str, api_key: &str) -> Result<String, String> {
    Ok(template
        .replace("{text}", &encode_query_component(text))
        .replace("{target}", &encode_query_component(target))
        .replace("{source}", "auto")
        .replace("{api_key}", &encode_query_component(api_key)))
}

fn apply_json_template(template: &str, text: &str, target: &str, api_key: &str) -> Result<String, String> {
    Ok(template
        .replace("{text}", &json_string_fragment(text))
        .replace("{target}", &json_string_fragment(target))
        .replace("{source}", "auto")
        .replace("{api_key}", &json_string_fragment(api_key)))
}

fn json_string_fragment(value: &str) -> String {
    let encoded = serde_json::to_string(value).expect("json string encode");
    encoded[1..encoded.len() - 1].to_string()
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => {
                let mut out = Vec::with_capacity(3);
                out.push('%');
                out.push(hex(byte >> 4));
                out.push(hex(byte & 0x0f));
                out
            }
        })
        .collect()
}

fn hex(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + nibble - 10) as char,
    }
}

fn parse_custom_response(raw: &str, json_path: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("custom translate returned empty body".into());
    }

    let path = json_path.trim();
    if path.is_empty() {
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            return Err(
                "custom JSON response needs translateJsonPath (e.g. responseData.translatedText)"
                    .into(),
            );
        }
        return Ok(trimmed.to_string());
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("custom translate JSON parse failed: {e}"))?;

    extract_json_path(&value, path)
        .ok_or_else(|| format!("translateJsonPath '{path}' not found in response"))
}

fn extract_json_path(value: &Value, path: &str) -> Option<String> {
    let mut current = value;
    for part in path.split('.') {
        if part.is_empty() {
            continue;
        }
        current = if let Ok(index) = part.parse::<usize>() {
            current.get(index)?
        } else {
            current.get(part)?
        };
    }

    match current {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_template_encodes_spaces_as_plus() {
        let url = apply_url_template(
            "http://127.0.0.1:5000/translate?q={text}&to={target}",
            "hello test",
            "ru",
            "",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:5000/translate?q=hello+test&to=ru");
    }

    #[test]
    fn json_template_keeps_spaces_literal() {
        let body = apply_json_template(
            r#"{"content":"Translate: {text}"}"#,
            "hello test",
            "ru",
            "",
        )
        .unwrap();
        assert_eq!(body, r#"{"content":"Translate: hello test"}"#);
    }

    #[test]
    fn json_template_escapes_quotes() {
        let body = apply_json_template(r#"{"q":"{text}"}"#, r#"say "hi""#, "en", "").unwrap();
        assert_eq!(body, r#"{"q":"say \"hi\""}"#);
    }
}
