# Локальный перевод чата через Ollama (SLM)

Перевод без облачных API, квот и 429 - модель крутится у тебя на машине через [Ollama](https://ollama.com/).

Нужен провайдер Custom в настройках клиента (Settings -> Translation API).

[English version](ollama-translation.en.md)

## Что нужно

- Ollama (Windows / macOS / Linux)
- 4-8 GB RAM для маленькой модели
- включённый перевод чата в SpeakiRPG

## 1. Установка Ollama

Скачай с [ollama.com/download](https://ollama.com/download), запусти - сервер должен подняться на `http://127.0.0.1:11434`. Проверка:

```bash
ollama --version
curl http://127.0.0.1:11434/api/tags
```

Если curl вернул JSON (пусть даже пустой список моделей) - сервер жив.

## 2. Модель

Нужна маленькая и быстрая модель, не 70B. Но не любая маленькая одинаково хороша с русским - многие заточены под английский и пару других языков, на остальных хуже держат смысл.

### `qwen3.5:4b` - основной выбор

```bash
ollama pull qwen3.5:4b
```

Замена старому `qwen2.5:3b`, тот же размер (~3.4 GB), но новее и стабильнее держит формат "только перевод, без комментариев". С русским работает уверенно.

### `qwen3:0.6b` - если RAM совсем мало (4 GB и меньше)

```bash
ollama pull qwen3:0.6b
```

Легче, но и заметно чаще путает смысл на сленге и составных фразах - это не "чуть хуже переводит", а реальные ошибки. Крайний вариант для слабых машин, не основной выбор.

### Что не брать для русского

- `llama3.2:3b` - официально поддерживает английский, немецкий, французский, итальянский, португальский, хинди, испанский, тайский. Русского там нет, переводит через остаточные данные претрейна и заметно проседает на сленге и бытовых фразах рядом с Qwen.
- `gemma2:2b` - устаревшая, слабовата для перевода даже в своём весе. Актуальнее линейка Gemma 3/4 edge, но она больше про vision/tool calling, чем про перевод текста.

Проверка:

```bash
ollama run qwen3.5:4b "Translate to Russian: hello"
```

Ждём что-то вроде "Привет" / "Здравствуй". Если модель разводит пояснения - дело не только в промпте, смотри ниже про API.

### Отключи thinking у Qwen3

По умолчанию Qwen3 / Qwen3.5 "думает" в скрытом поле `message.thinking`, а не сразу пишет ответ. Для перевода чата это означает десятки секунд ожидания и пустой `message.content`.

На той же машине (`qwen3.5:4b`, фраза "いい畑ですね"):

- без `think` (дефолт): ~71 с, `message.content` пусто
- `"think":false`: ~0.6 с, `message.content` = "Отличное поле!"

`"think":false` добавляется на верхнем уровне JSON, рядом с `"model"` - внутри `options` Ollama его молча игнорирует.

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Translate to Russian: いい畑ですね\"}],\"stream\":false}"
```

В ответе должен быть короткий `message.content`, без гигантского thinking.

## 3. Настройка SpeakiRPG

1. `Ctrl+Shift+S` или шестерёнка внизу справа.
2. Translation API -> Provider: Custom URL / local LLM.
3. Заполни (пример для `qwen3.5:4b`, target `ru`):

- Endpoint URL: `http://127.0.0.1:11434/api/chat`
- JSON path: `message.content`
- POST JSON body: см. ниже
- API key: пусто

Почему `/api/chat`, а не `/api/generate`: модели инструктированы под чат-темплейт с ролями system/user. Через `/api/generate` с сырым промптом инструкция "выведи только перевод" держится хуже.

POST body (одна строка, подставь своё имя модели):

```json
{"model":"qwen3.5:4b","think":false,"messages":[{"role":"system","content":"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown."},{"role":"user","content":"Translate to Russian:\n{text}"}],"stream":false,"options":{"temperature":0.2}}
```

`"think":false` и `"temperature":0.2` - оба важны. Без think:false Qwen3.5 уйдёт в reasoning на минуту+, температура по умолчанию (0.8) тоже плохо подходит для перевода.

4. В Chat translation выставь Translate into -> Russian (`ru`).
5. Сохраняется само при изменении полей.

`{text}` - текст сообщения из чата. `{target}` - код языка из настроек (`ru`, `en`, `ja`...); можно вместо жёсткого "Russian" в промпте писать `Translate to language code {target}`.

### settings.json

Путь - в [README](../README.md#configuration).

```json
{
  "translateEnabled": false,
  "translateTarget": "ru",
  "translateProvider": "custom",
  "translateEndpoint": "http://127.0.0.1:11434/api/chat",
  "translateJsonPath": "message.content",
  "translatePostBody": "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown.\"},{\"role\":\"user\",\"content\":\"Translate to Russian:\\n{text}\"}],\"stream\":false,\"options\":{\"temperature\":0.2}}",
  "translateApiKey": ""
}
```

Кавычки внутри `translatePostBody` экранируются как `\"`, перенос строки - как `\\n`. Включи "Translate chat messages" или `"translateEnabled": true`.

## 4. Если нет /api/chat

Возврат на `/api/generate` - но промпт нужно ужесточать явно:

- Endpoint: `http://127.0.0.1:11434/api/generate`
- JSON path: `response`

```json
{"model":"qwen3.5:4b","think":false,"prompt":"Output ONLY the translated text, no preamble, no markdown, no quotes.\n\nTranslate to Russian: {text}","stream":false,"options":{"temperature":0.2}}
```

`stream` обязательно `false`.

## 5. Проверка

Напрямую через Ollama:

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"Output ONLY the translated text.\"},{\"role\":\"user\",\"content\":\"Translate to Russian: いい畑ですね\"}],\"stream\":false}"
```

Смотри поле `message.content`.

Консоль игры (F12):

```js
await window.__TAURI__.core.invoke('translate_text', { text: 'いい畑ですね' })
```

В чате: `いい畑ですね` (японский), `안녕하세요` (корейский), `hello test` (английский, если target = ru).

Свои сообщения переводятся только с включённой галочкой Translate my own messages.

## 6. Скорость и качество

Первая строка после простоя медленная - модель грузится в память. Дальше клиент шлёт переводы по очереди (~400 мс между запросами) плюс время ответа Ollama, в активном чате обычно 1-5 с на строку.

Модель 3-4B ошибается на сленге и длинных фразах, но заметно реже, чем 0.5-1B - размер тут влияет именно на количество смысловых ошибок, не только на скорость. Дефолтное квантование при `ollama pull` (обычно Q4_K_M) достаточно для чата, `:q8_0` можно взять ради точности на длинных фразах ценой скорости, если он опубликован для модели. Сообщения длиннее 500 символов клиент не отправляет.

Если модель болтает лишнее ("Here is the translation: …"), проверь по порядку: `"think":false` на верхнем уровне JSON, `/api/chat` с system-ролью вместо `/api/generate`, temperature 0.1-0.3, и явный запрет пояснений в промпте.

## 7. Частые проблемы

| Симптом | Причина |
|---------|---------|
| `custom translate request failed` | Ollama не запущен - проверь `curl http://127.0.0.1:11434/api/tags` |
| `model not found` | `ollama pull <имя>`, имя должно совпадать с `ollama list` |
| `translateJsonPath 'message.content' not found` | для `/api/chat` нужен `message.content`, для `/api/generate` - `response` |
| Пустой / странный перевод | другая модель или промпт, проверь curl вручную |
| Путает смысл, а не просто криво формулирует | модель слишком маленькая, возьми `qwen3.5:4b` |
| Долго (10-60+ с), перевода нет | Qwen3 thinking включён - добавь `"think":false` |
| Медленно, но перевод есть | освободи RAM, не бери 7B+ |
| Invoke работает, в чате нет | проверь `translateEnabled` и жди новое сообщение (старые строки не переводятся) |

## 8. Другие локальные варианты

Тот же Custom провайдер подходит для LibreTranslate (`http://127.0.0.1:5000/translate`, классический MT, не LLM) и для LM Studio / llama.cpp server - другой URL и JSON path, те же плейсхолдеры `{text}` и `{target}`.
