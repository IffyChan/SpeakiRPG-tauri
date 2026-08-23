# Локальный перевод чата через Ollama (SLM)

Гайд для SpeakiRPG: перевод без облачных API, квот и 429. Модель крутится у тебя на машине через [Ollama](https://ollama.com/).

Нужен провайдер **Custom** в настройках клиента (Settings → Translation API).

[English version](ollama-translation.en.md)

## Что понадобится

- Установленный Ollama (Windows / macOS / Linux)
- 4–8 GB RAM для маленькой модели (зависит от модели и ОЗУ)
- SpeakiRPG с включённым переводом чата

## 1. Установка Ollama

1. Скачай установщик с [ollama.com](https://ollama.com/download).
2. Установи и запусти. В трее / фоне должен работать сервер на `http://127.0.0.1:11434`.
3. Проверь в терминале:

```bash
ollama --version
curl http://127.0.0.1:11434/api/tags
```

Если `curl` отвечает JSON со списком моделей (или пустым списком) — сервер жив.

## 2. Выбери модель (SLM)

Для чата в игре нужна **маленькая и быстрая** модель, не 70B. Но не любая маленькая модель одинаково хороша для русского — многие оптимизированы под английский и пару других языков, а на остальных просто хуже держат смысл.

### Основная рекомендация — `qwen3.5:4b`

```bash
ollama pull qwen3.5:4b
```

Актуальная модель на замену старому `qwen2.5:3b` — тот же практичный размер (~3.4 GB на диске), но новее и стабильнее держит формат «только перевод, без комментариев». Мультиязычная, с русским работает уверенно.

### Если очень мало RAM (4 GB и меньше)

```bash
ollama pull qwen3:0.6b
```

Заметно легче, но и заметно чаще путает смысл на сленге, идиомах и составных фразах — не «чуть хуже переводит», а именно ошибается в смысле. Годится как крайний вариант для совсем слабых машин, не как основной выбор.

### Что НЕ стоит брать для русского

- **`llama3.2:3b`** — официально заявленная поддержка языков ограничена английским, немецким, французским, итальянским, португальским, хинди, испанским и тайским. Русского в списке нет. Модель переводит «по остаточному принципу» через мультиязычные данные претрейна и заметно проседает на сленге и бытовых фразах по сравнению с Qwen.
- **`gemma2:2b`** — устаревшая версия, для перевода на русский слабовата даже в своём весе. Если хочется Gemma — сейчас актуальнее линейка Gemma 3/4 edge-моделей, но они больше заточены под vision/tool calling, чем под чистый перевод текста.

Проверка модели:

```bash
ollama run qwen3.5:4b "Translate to Russian: hello"
```

Должен вернуть что-то вроде «Привет» / «Здравствуй». Если ответ развёрнутый с пояснениями — дело не только в промпте, но и в том, каким API ты его дёргаешь (см. ниже).

### Qwen3: режим thinking (обязательно выключить)

У **Qwen3 / Qwen3.5** в Ollama по умолчанию включён **thinking** — модель сначала «думает» в скрытом поле `message.thinking`, а не в ответе. Для перевода чата это катастрофа: десятки секунд ожидания и пустой `message.content`.

Проверка на той же машине (`qwen3.5:4b`, фраза `いい畑ですね`):

| Настройка | Время | `message.content` |
|-----------|-------|-------------------|
| без `think` (дефолт) | ~71 с | пусто (весь лимит ушёл в thinking) |
| `"think":false` | ~0,6 с | `Отличное поле!` |

**В POST body обязательно добавь `"think":false` на верхнем уровне JSON** (рядом с `"model"`), не внутри `options` — иначе Ollama молча игнорирует.

Быстрый тест в терминале:

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Translate to Russian: いい畑ですね\"}],\"stream\":false}"
```

В ответе должно быть короткое `message.content`, без гигантского `thinking`.

## 3. Настройка SpeakiRPG

### Через окно Settings

1. `Ctrl+Shift+S` или шестерёнка внизу справа.
2. **Translation API** → Provider: **Custom URL / local LLM**.
3. Заполни поля (пример для `qwen3.5:4b`, целевой язык `ru`):

| Поле | Значение |
|------|----------|
| **Endpoint URL** | `http://127.0.0.1:11434/api/chat` |
| **JSON path** | `message.content` |
| **POST JSON body** | см. блок ниже |
| **API key** | оставь пустым |

**Почему `/api/chat`, а не `/api/generate`:** все современные модели из этого гайда — instruct-версии, обученные под чат-темплейт с ролями system/user. Через `/api/generate` с сырым промптом инструкция «выведи только перевод» держится хуже, модель чаще добавляет пояснения. `/api/chat` с явной system-ролью — надёжнее.

**POST JSON body** (одна строка, подставь своё имя модели):

```json
{"model":"qwen3.5:4b","think":false,"messages":[{"role":"system","content":"You are a translation engine. Output ONLY the translated text. No quotes, no explanations, no markdown."},{"role":"user","content":"Translate to Russian:\n{text}"}],"stream":false,"options":{"temperature":0.2}}
```

Обрати внимание на `"think":false` и `"temperature":0.2`. Без `think:false` Qwen3.5 уйдёт в reasoning на минуту+. Температура 0.8 по умолчанию тоже плоха для перевода — держи 0.1–0.3.

4. В секции **Chat translation** выставь **Translate into** → Russian (`ru`).
5. Сохранится автоматически при изменении полей.

Плейсхолдер `{text}` — текст сообщения из чата.
Плейсхолдер `{target}` — код языка из настроек (`ru`, `en`, `ja`, …). Можно вместо жёсткого «Russian» в промпте написать: `Translate to language code {target}.`

### Через settings.json

Путь к файлу — в [README](../README.md#configuration). Пример фрагмента:

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

Включи перевод: галочка **Translate chat messages** в Settings или `"translateEnabled": true`.

Важно: в JSON файле кавычки внутри `translatePostBody` экранируются как `\"`, перенос строки — как `\\n`.

## 4. Альтернатива: Generate API

Если по какой-то причине `/api/chat` недоступен (старая сборка Ollama, кастомный сервер) — можно вернуться на `/api/generate`, но промпт нужно ужесточать явно:

| Поле | Значение |
|------|----------|
| **Endpoint URL** | `http://127.0.0.1:11434/api/generate` |
| **JSON path** | `response` |
| **POST JSON body** | |

```json
{"model":"qwen3.5:4b","think":false,"prompt":"Output ONLY the translated text, no preamble, no markdown, no quotes.\n\nTranslate to Russian: {text}","stream":false,"options":{"temperature":0.2}}
```

`stream` обязательно `false` — клиент ждёт один JSON-ответ, не поток.

## 5. Проверка

### API Ollama напрямую

PowerShell / bash:

```bash
curl http://127.0.0.1:11434/api/chat -d "{\"model\":\"qwen3.5:4b\",\"think\":false,\"messages\":[{\"role\":\"system\",\"content\":\"Output ONLY the translated text.\"},{\"role\":\"user\",\"content\":\"Translate to Russian: いい畑ですね\"}],\"stream\":false}"
```

В ответе поле `message.content` должно содержать перевод.

### Через SpeakiRPG (консоль F12 в игре)

```js
await window.__TAURI__.core.invoke('translate_text', { text: 'いい畑ですね' })
```

### В чате игры

Отправь или дождись строки:

| Текст | Зачем |
|-------|--------|
| `いい畑ですね` | японский |
| `안녕하세요` | корейский |
| `hello test` | английский (если target = `ru`) |

Свои сообщения переводятся только с галочкой **Translate my own messages**.

## 6. Скорость и качество

- Первая строка после простоя **медленная** (модель грузится в RAM). Дальше быстрее.
- Клиент шлёт переводы **по очереди** (~400 ms между запросами) + время ответа Ollama. В активном чате возможна задержка 1–5 с на строку.
- Модель 3–4B **ошибается** на сленге, смеси языков и длинных фразах, но заметно реже, чем модели 0.5–1B — размер тут прямо влияет на количество смысловых ошибок, а не только на скорость.
- Дефолтное квантование при `ollama pull` — обычно Q4_K_M, этого достаточно для чата. Если хочется точнее переводить длинные/сложные фразы ценой скорости — можно взять `:q8_0` вариант модели, если он опубликован.
- Сообщения длиннее **500 символов** клиент не отправляет на перевод.

Если модель болтает лишнее («Here is the translation: …»), проверь четыре вещи по порядку:
1. Есть ли `"think":false` на верхнем уровне JSON (не в `options`).
2. Используешь ли `/api/chat` с system-ролью (см. раздел 3), а не `/api/generate` с сырым промптом.
3. Не завышена ли `temperature` (должна быть 0.1–0.3).
4. Явно ли в промпте написано `Output ONLY the translated text. No preamble. No markdown.`

## 7. Частые проблемы

| Симптом | Что проверить |
|---------|----------------|
| `custom translate request failed` | Ollama запущен? `curl http://127.0.0.1:11434/api/tags` |
| `model not found` | `ollama pull <имя_модели>` — имя в POST body совпадает с `ollama list` |
| `translateJsonPath 'message.content' not found` | Неверный path; для `/api/chat` — `message.content`, для `/api/generate` — `response` |
| Пустой / странный перевод | Другая модель или другой промпт; проверь curl вручную |
| Модель путает смысл, а не просто криво формулирует | Слишком маленькая модель (0.5–1B) — попробуй `qwen3.5:4b` |
| Очень долго (10–60+ с), перевода нет | Qwen3 thinking включён — добавь `"think":false` в POST body |
| Медленно, но перевод есть | Закрой лишнее из RAM; не используй 7B+ для чата |
| Перевод не в чате, но invoke работает | `translateEnabled`, новое сообщение (старые строки сами не обновятся) |

## 8. Другие локальные варианты

Тот же **Custom** провайдер подходит для:

- **LibreTranslate** (`http://127.0.0.1:5000/translate`) — классический MT, не LLM
- **LM Studio**, **llama.cpp server** — другой URL/JSON, те же плейсхолдеры `{text}`, `{target}`

Схема одна: POST/GET URL + при необходимости JSON path до поля с текстом перевода.

## Краткий чеклист

1. `ollama pull qwen3.5:4b` (или `qwen3:0.6b` для слабых машин)
2. Settings → Custom → endpoint `/api/chat` + `"think":false` + post body с system-ролью и `temperature:0.2` + `message.content`
3. `translateTarget` = нужный язык
4. Тест в консоли: `invoke('translate_text', { text: '…' })`
5. Новое сообщение в чате