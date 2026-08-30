use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettingsField {
    pub key: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub label: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub options: Option<Vec<ModSelectOption>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSelectOption {
    pub value: Value,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModSettingsSchema {
    pub id: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub fields: Vec<ModSettingsField>,
}

fn default_category() -> String {
    "Mods".into()
}

pub fn parse_mod_settings_schema(source: &str) -> Option<ModSettingsSchema> {
    let marker = "SpeakiRPG.settings";
    let start = source.find(marker)?;
    let after = &source[start + marker.len()..];
    let json_start = after.find('{')?;
    let tail = &after[json_start..];
    let comment_end = tail.find("*/")?;
    let json_str = tail[..comment_end].trim();
    let schema: ModSettingsSchema = serde_json::from_str(json_str).ok()?;
    if schema.id.trim().is_empty() {
        return None;
    }
    Some(schema)
}

pub fn default_mod_values(schema: &ModSettingsSchema) -> Map<String, Value> {
    let mut out = Map::new();
    for field in &schema.fields {
        if field.field_type == "action" {
            continue;
        }
        if let Some(default) = &field.default {
            out.insert(field.key.clone(), default.clone());
            continue;
        }
        let value = match field.field_type.as_str() {
            "bool" => Value::Bool(false),
            "number" => Value::Number(serde_json::Number::from(0)),
            "text" => Value::String(String::new()),
            _ => Value::Null,
        };
        out.insert(field.key.clone(), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_schema_block() {
        let src = r#"// SpeakiRPG mod: Demo
/* SpeakiRPG.settings
{
  "id": "demo",
  "category": "World",
  "fields": [
    { "key": "on", "type": "bool", "label": "Enable" }
  ]
}
*/
console.log('hi');
"#;
        let schema = parse_mod_settings_schema(src).expect("schema");
        assert_eq!(schema.id, "demo");
        assert_eq!(schema.category, "World");
        assert_eq!(schema.fields.len(), 1);
    }

    #[test]
    fn parses_select_and_text_fields() {
        let src = r#"/* SpeakiRPG.settings
{
  "id": "x",
  "fields": [
    { "key": "name", "type": "text", "label": "Name", "default": "" },
    { "key": "mode", "type": "select", "label": "Mode", "default": "a",
      "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }]
    }
  ]
}
*/"#;
        let schema = parse_mod_settings_schema(src).expect("schema");
        assert_eq!(schema.fields.len(), 2);
        assert_eq!(schema.fields[0].field_type, "text");
        assert_eq!(schema.fields[1].field_type, "select");
        assert_eq!(schema.fields[1].options.as_ref().map(|o| o.len()), Some(2));
    }
}
