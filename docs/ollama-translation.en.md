# Local chat translation with Ollama (SLM)

Use SpeakiRPG with a **local small language model** instead of cloud translation APIs — no quotas, no HTTP 429, nothing leaves your machine except what Ollama already does locally.

You will use the **Custom** provider (Settings → Translation API).

[Russian version](ollama-translation.md) — tuned for players translating into Russian.

## Who this is for

Speaki RPG chat is mostly **Japanese and Korean**, with some English and emoji-only lines. If you play in English, you typically want:

- **Sources:** Japanese, Korean, occasional English from other players  
- **Target:** whatever you set under **Translate into** (`en` is the usual pick)

This guide assumes **`en`** in examples. Change `translateTarget` and the prompt if you want German, Spanish, etc.

## Requirements

- [Ollama](https://ollama.com/) on Windows, macOS, or Linux  
- ~4–8 GB free RAM for a 3–4B model (varies by model and quant)  
- SpeakiRPG with **Translate chat messages** enabled  

## 1. Install Ollama

1. Install from [ollama.com/download](https://ollama.com/download).  
2. Leave the app running — default API: `http://127.0.0.1:11434`.  
3. Smoke test:

```bash
ollama --version
curl http://127.0.0.1:11434/api/tags
```

JSON back (even an empty model list) means the server is up.

## 2. Pick a model

Chat translation needs a **small, fast** model. You are not running a 70B assistant — you are firing a request every few seconds when the lobby is active.

What matters for this game:

| Need | Why |
|------|-----|
| Strong **multilingual** input | JA/KO chat, halfwidth katakana, mixed emoji + text |
| Follows **“translation only”** | No “Sure! Here’s the translation:” |
| Fits in **consumer RAM** | 3–4B class |

### Recommended — `qwen3.5:4b`

```bash
ollama pull qwen3.5:4b
```

Good default over older `qwen2.5:3b`: ~3.4 GB disk, newer, handles Asian source text well, and usually respects a strict system prompt. Works for essentially any target language SpeakiRPG supports.

### Low RAM (≤4 GB system RAM)

```bash
ollama pull qwen3:0.6b
```

Runs on weak hardware. Expect **meaning** mistakes on slang, game-specific phrases, and idioms — not just awkward English. Fine for “something is better than nothing”, not for quality.

### Models that look popular but fit this job poorly

- **`llama3.2:3b`** — fine if you only ever translate **into English** (it is in Meta’s supported set). Still weaker on **Japanese/Korean input** than Qwen at the same size. Skip if most of your chat is JA/KO.  
- **`gemma2:2b`** — old and small; translation quality is underwhelming. Newer Gemma edge models target vision/tools more than plain MT.  
- **7B+ models** — overkill for chat lines; slow under queue + Ollama latency.

Quick test (swap target language if you are not using English):

```bash
ollama run qwen3.5:4b "Translate to English: いい畑ですね"
```

Expect a short line like “Nice field” / “That’s a nice field”. If you get a paragraph of explanation — or a long pause with no translation — fix the API setup below.

### Qwen3: turn off thinking (required)

**Qwen3 / Qwen3.5** on Ollama defaults to **thinking mode**: the model reasons in `message.thinking` before (or instead of) filling `message.content`. For chat translation that means huge latency and often an **empty** translated line.

Benchmark on `qwen3.5:4b`, phrase `いい畑ですね`:

| Setting | Time | `message.content` |
|---------|------|-------------------|
| default (thinking on) | ~71 s | empty (budget spent on thinking) |
| `"think": false` | ~0.6 s | `Отличное поле!` |

Add **`"think": false` at the top level of the POST JSON** (next to `"model"`). Putting `think` inside `options` is **ignored**.

Quick terminal test:

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Translate to English: いい畑ですね\"}],\"stream\":false}"
```

You want a short `message.content`, not pages of `thinking`.

## 3. Configure SpeakiRPG

### Settings UI

1. `Ctrl+Shift+S` (or gear icon, bottom-right).  
2. **Translation API** → **Custom URL / local LLM**.  
3. Example for `qwen3.5:4b` and target **English**:

| Field | Value |
|-------|--------|
| **Endpoint URL** | `http://127.0.0.1:11434/api/chat` |
| **JSON path** | `message.content` |
| **POST JSON body** | see below |
| **API key** | empty |

**Use `/api/chat`, not `/api/generate`:** current instruct models expect `system` / `user` roles. `/api/generate` with a raw string ignores that structure; you get more preamble and fewer “translation only” replies.

**POST JSON body** (one line; `{target}` comes from your **Translate into** setting):

```json
{"model":"qwen3.5:4b","think":false,"messages":[{"role":"system","content":"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown."},{"role":"user","content":"Translate the following to language code {target}. Preserve tone and brevity of chat.\n\n{text}"}],"stream":false,"options":{"temperature":0.2}}
```

Use `"think":false` and `"temperature":0.2`. Without `think:false`, Qwen3.5 can sit in reasoning for a minute+. Default temperature (~0.8) is too chatty for inline translation.

4. **Chat translation** → **Translate into** → English (`en`).  
5. Changes save automatically.

Placeholders injected by the client:

| Placeholder | Value |
|-------------|--------|
| `{text}` | Chat line |
| `{target}` | `translateTarget` (`en`, `de`, `ja`, …) |
| `{source}` | `auto` (literal string in template) |
| `{api_key}` | from settings if you set one |

### settings.json

Path: [README → Configuration](../README.md#configuration).

```json
{
  "translateEnabled": true,
  "translateTarget": "en",
  "translateProvider": "custom",
  "translateEndpoint": "http://127.0.0.1:11434/api/chat",
  "translateJsonPath": "message.content",
  "translatePostBody": "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown.\"},{\"role\":\"user\",\"content\":\"Translate the following to language code {target}. Preserve tone and brevity of chat.\\n\\n{text}\"}],\"stream\":false,\"options\":{\"temperature\":0.2}}",
  "translateApiKey": ""
}
```

Escape inner quotes as `\"`, newlines as `\\n`.

## 4. Fallback: `/api/generate`

Only if `/api/chat` is unavailable:

| Field | Value |
|-------|--------|
| **Endpoint URL** | `http://127.0.0.1:11434/api/generate` |
| **JSON path** | `response` |

```json
{"model":"qwen3.5:4b","think":false,"prompt":"Output ONLY the translated text. No preamble.\n\nTranslate to {target}: {text}","stream":false,"options":{"temperature":0.2}}
```

`stream` must be `false`.

## 5. Verify

### Ollama directly

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"Output ONLY the translated text.\"},{\"role\":\"user\",\"content\":\"Translate to English: いい畑ですね\"}],\"stream\":false}"
```

Check `message.content` in the JSON response.

### SpeakiRPG console (F12 in-game)

```js
await window.__TAURI__.core.invoke('translate_text', { text: 'いい畑ですね' })
```

Should resolve to English (or your `translateTarget`) after Ollama returns.

### Live chat

| Message | What it exercises |
|---------|-------------------|
| `いい畑ですね` | Japanese (common in lobby) |
| `ｱﾂｲ` | Halfwidth katakana |
| `안녕하세요` | Korean |
| `gg wp` | Latin (others’ English; translated when target ≠ `en`) |

**Translate my own messages** must be on to translate lines you send.

The client only processes **new** rows after setup; scrollback is not rewritten.

## 6. Speed and quality expectations

- **Cold start:** first line after idle is slow while the model loads.  
- **Queue:** ~400 ms minimum between API calls + Ollama inference → often **1–5 s per line** in busy chat.  
- **Length cap:** lines over **500 characters** are skipped.  
- **Quant:** default `ollama pull` quant (usually Q4_K_M) is enough. `:q8_0` can help nuance at a speed cost if published for your model.  
- **SLM limits:** game slang, names, and KO/JA memes will be wrong sometimes. A 4B model is a helper, not a professional translator.

If output includes “Here is the translation:” or nothing shows up after a long wait:

1. Add `"think": false` at the **top level** of the POST JSON (not inside `options`).
2. Use `/api/chat` with a system message (section 3).
3. Lower `temperature` (0.1–0.3).
4. Tighten system text: `Output ONLY the translated text.`

## 7. Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `custom translate request failed` | Ollama not running → `curl http://127.0.0.1:11434/api/tags` |
| `model not found` | `ollama pull qwen3.5:4b`; model name in JSON must match `ollama list` |
| `translateJsonPath ... not found` | `/api/chat` → `message.content`; `/api/generate` → `response` |
| Gibberish / wrong language | `translateTarget` mismatch; test with curl first |
| JA/KO → EN is nonsense | Model too small → `qwen3.5:4b`; avoid `qwen3:0.6b` for quality |
| 10–60+ s wait, no translation | Qwen3 thinking on — add `"think": false` to POST body |
| Slow but translation works | Free RAM; avoid 7B+ for realtime chat |
| Console works, chat does not | Enable translation; send a **new** message; check `translateEnabled` |

## 8. Not Ollama?

Same **Custom** slot works for:

- **[LibreTranslate](https://libretranslate.com/)** (local Docker) — traditional MT, lighter than an LLM  
- **LM Studio** / **llama.cpp** OpenAI-compatible servers — point endpoint + JSON path at their response shape  

Pattern: URL + optional POST template + JSON path to the translated string.

## Checklist

1. `ollama pull qwen3.5:4b`  
2. Settings → Custom → `/api/chat`, `"think":false`, body with `system` + `{target}` + `{text}`, `temperature: 0.2`  
3. **Translate into** = your language (`en` for most English players)  
4. `invoke('translate_text', …)` in console  
5. New message in lobby chat  
