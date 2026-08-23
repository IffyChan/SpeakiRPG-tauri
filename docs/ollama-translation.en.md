# Local chat translation with Ollama (SLM)

Run translation locally instead of hitting cloud APIs - no quotas, no 429s, nothing leaves your machine.

Use the **Custom** provider (Settings -> Translation API).

[Russian version](ollama-translation.md), tuned for translating into Russian.

## Who this is for

Speaki RPG chat is mostly Japanese and Korean, with some English and emoji-only lines. If you play in English you probably want:

- Sources: Japanese, Korean, occasional English
- Target: whatever you set under "Translate into" (`en` for most people)

Examples below use `en`. Swap `translateTarget` and the prompt if you want German, Spanish, etc.

## Requirements

- [Ollama](https://ollama.com/), any OS
- 4-8 GB free RAM for a 3-4B model
- "Translate chat messages" enabled in SpeakiRPG

## 1. Install Ollama

Install from [ollama.com/download](https://ollama.com/download), leave it running (default API on `http://127.0.0.1:11434`), then check it's alive:

```bash
ollama --version
curl http://127.0.0.1:11434/api/tags
```

Any JSON back, even an empty model list, means the server's up.

## 2. Pick a model

You need something small and fast - you're firing a request every few seconds while chat is active, not running a 70B assistant.

### `qwen3.5:4b` - recommended

```bash
ollama pull qwen3.5:4b
```

~3.4 GB on disk, handles JA/KO input well, and actually respects "translation only" prompts. Good default for most target languages.

### `qwen3:0.6b` - if you're on 4 GB RAM or less

```bash
ollama pull qwen3:0.6b
```

Runs on weak machines but gets slang, idioms and game-specific phrases wrong pretty often. Use it if you have no other choice, not because it's a good pick.

### Models to skip

- `llama3.2:3b` - fine for English-only output, but noticeably worse than Qwen on Japanese/Korean input.
- `gemma2:2b` - old, weak at translation. Newer Gemma edge models are more about vision/tools than plain MT.
- Anything 7B+ - too slow for realtime chat once you add queue + inference time.

Quick sanity check:

```bash
ollama run qwen3.5:4b "Translate to English: いい畑ですね"
```

Should get something short like "Nice field." A wall of explanation, or a long pause with nothing, means the setup below needs fixing.

### Turn off thinking mode (Qwen3/3.5)

Qwen3 defaults to "thinking" - it reasons in `message.thinking` before touching `message.content`. For chat translation this just means long waits and an empty translation.

Tested on `qwen3.5:4b`, phrase "いい畑ですね":

- default (thinking on): ~71s, `message.content` empty
- `"think": false`: ~0.6s, `message.content` = "Отличное поле!"

Add `"think": false` at the **top level** of the POST body, next to `"model"`. Inside `options` it's silently ignored.

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Translate to English: いい畑ですね\"}],\"stream\":false}"
```

You want a short `message.content`, not pages of thinking.

## 3. Configure SpeakiRPG

1. `Ctrl+Shift+S`, or the gear icon bottom-right.
2. Translation API -> Custom URL / local LLM.
3. Fill in for `qwen3.5:4b`, target English:

- Endpoint URL: `http://127.0.0.1:11434/api/chat`
- JSON path: `message.content`
- POST JSON body: see below
- API key: leave empty

Use `/api/chat`, not `/api/generate` - instruct models expect system/user roles, and `/api/generate` with a raw prompt string gets you more preamble and fewer clean translations.

POST body, one line (`{target}` comes from your "Translate into" setting):

```json
{"model":"qwen3.5:4b","think":false,"messages":[{"role":"system","content":"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown."},{"role":"user","content":"Translate the following to language code {target}. Preserve tone and brevity of chat.\n\n{text}"}],"stream":false,"options":{"temperature":0.2}}
```

`think:false` and a low temperature both matter - without them Qwen3.5 can sit reasoning for over a minute, and default temperature (~0.8) makes it too chatty.

4. Chat translation -> Translate into -> English (`en`).
5. Settings save automatically.

Placeholders the client fills in: `{text}` (chat line), `{target}` (`translateTarget`), `{source}` (always `auto`), `{api_key}` (from settings if set).

### settings.json

Path: see [README](../README.md#configuration).

```json
{
  "translateEnabled": false,
  "translateTarget": "en",
  "translateProvider": "custom",
  "translateEndpoint": "http://127.0.0.1:11434/api/chat",
  "translateJsonPath": "message.content",
  "translatePostBody": "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown.\"},{\"role\":\"user\",\"content\":\"Translate the following to language code {target}. Preserve tone and brevity of chat.\\n\\n{text}\"}],\"stream\":false,\"options\":{\"temperature\":0.2}}",
  "translateApiKey": ""
}
```

Escape inner quotes as `\"`, newlines as `\\n`. Then turn on "Translate chat messages" (or set `translateEnabled: true`).

## 4. Fallback: /api/generate

Only if `/api/chat` isn't available:

- Endpoint: `http://127.0.0.1:11434/api/generate`
- JSON path: `response`

```json
{"model":"qwen3.5:4b","think":false,"prompt":"Output ONLY the translated text. No preamble.\n\nTranslate to {target}: {text}","stream":false,"options":{"temperature":0.2}}
```

`stream` has to be `false`.

## 5. Verify it works

Direct against Ollama:

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"Output ONLY the translated text.\"},{\"role\":\"user\",\"content\":\"Translate to English: いい畑ですね\"}],\"stream\":false}"
```

Check `message.content` in the response.

In-game console (F12):

```js
await window.__TAURI__.core.invoke('translate_text', { text: 'いい畑ですね' })
```

Should return English (or your target) once Ollama responds.

Test lines in live chat: `いい畑ですね` (Japanese), `ｱﾂｲ` (halfwidth katakana), `안녕하세요` (Korean), `gg wp` (Latin, only translated if target isn't `en`).

"Translate my own messages" has to be on separately if you want your own lines translated. Only new rows get processed - scrollback isn't touched.

## 6. What to expect

- First line after being idle is slow while the model loads.
- Roughly 400ms between requests plus Ollama's inference time - usually 1-5s per line when chat is busy.
- Lines over 500 characters get skipped.
- Default quant (usually Q4_K_M) is fine. `:q8_0` helps nuance a bit if it's published for your model, at some speed cost.
- A 4B model is a helper, not a real translator - it'll get slang, names and JA/KO memes wrong sometimes.

If you're getting "Here is the translation:" or nothing at all:

1. Check `"think": false` is at the top level of the POST body, not inside `options`.
2. Use `/api/chat` with a system message, not `/api/generate`.
3. Lower temperature to 0.1-0.3.
4. Tighten the system prompt: "Output ONLY the translated text."

## 7. Troubleshooting

| Symptom | Cause |
|---------|-------|
| `custom translate request failed` | Ollama isn't running - check `curl http://127.0.0.1:11434/api/tags` |
| `model not found` | `ollama pull qwen3.5:4b`; name in JSON must match `ollama list` |
| `translateJsonPath ... not found` | `/api/chat` -> `message.content`, `/api/generate` -> `response` |
| Gibberish / wrong language | `translateTarget` mismatch, test with curl |
| JA/KO -> EN is nonsense | Model's too small, switch to `qwen3.5:4b`, skip `qwen3:0.6b` |
| Waits 10-60s+, no translation | Qwen3 thinking is on, add `think: false` |
| Works but slow | Free up RAM, avoid 7B+ models |
| Console works, chat doesn't | Check `translateEnabled`, and send a *new* message |

## 8. Not using Ollama?

The Custom slot also works with:

- [LibreTranslate](https://libretranslate.com/) (local Docker) - traditional MT, lighter than an LLM
- LM Studio / llama.cpp OpenAI-compatible servers - point the endpoint and JSON path at their response shape

Same idea everywhere: URL + optional POST template + JSON path to the translated string.
