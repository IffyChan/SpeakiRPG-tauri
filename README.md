# SpeakiRPG Desktop Client

Tauri desktop client for [Speaki RPG](https://speakirpg.overture.io.kr/): Discord Rich Presence, chat translation, user scripts.

Tauri port of the [original Electron client](https://github.com/DJTOMATO/SpeakiRPG) by [DJTOMATO](https://github.com/DJTOMATO). Fan-made, not affiliated with the game. No game assets included.

## Screenshots

![Game in the desktop client](docs/screenshots/game-window.png)
![Discord Rich Presence](docs/screenshots/discord-presence.png)
![Chat translation](docs/screenshots/chat-translation.png)
![Settings window](docs/screenshots/settings-window.png)

## Install

**Releases:** [github.com/IffyChan/SpeakiRPG-tauri/releases](https://github.com/IffyChan/SpeakiRPG-tauri/releases)

**From source** ([Node.js](https://nodejs.org/), [Rust](https://rustup.rs/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)):

```bash
git clone https://github.com/IffyChan/SpeakiRPG-tauri.git
cd SpeakiRPG-tauri
npm install
npm run dev
npm run build    # installer -> src-tauri/target/release/bundle/
```

## Usage

1. Run the app, log in on the game site (splash redirects automatically).
2. Discord shows name, level, XP, and location from your character card (~30s after load, then every 5 min). Discord must be running.
3. Chat lines in Korean or Japanese can be translated in place when enabled in Settings; original text stays in muted brackets. Toggle with `Ctrl+Shift+T` or Settings (`Ctrl+Shift+S` / gear button bottom-right).

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5`, `Ctrl+R` (`Cmd+R` on macOS) | Reload page |
| `Ctrl+Shift+D` | Refresh Discord status |
| `Ctrl+Shift+T` | Toggle chat translation |
| `Ctrl+Shift+S` | Open settings |

Active while the game window is focused.

## Configuration

Settings window or `settings.json` in the app config dir:

| OS | Path |
|----|------|
| Windows | `%APPDATA%\com.ifchan.speakirpg\settings.json` |
| Linux | `~/.config/com.ifchan.speakirpg/settings.json` |
| macOS | `~/Library/Application Support/com.ifchan.speakirpg/settings.json` |

| Field | Default | Description |
|-------|---------|-------------|
| `translateTarget` | `"en"` | Target language (ISO code) |
| `translateEnabled` | `false` | Chat translation on/off |
| `translateOwn` | `false` | Translate your own messages |
| `translateProvider` | `"mymemory"` | `mymemory`, `gtx`, or `custom` |
| `translateEndpoint` | `""` | Custom GET/POST URL (`{text}`, `{target}`, `{api_key}`) |
| `translateJsonPath` | `""` | Dot path into JSON response for custom provider |
| `translateApiKey` | `""` | MyMemory email or `{api_key}` for custom |
| `translatePostBody` | `""` | Optional JSON POST body template for custom |

**Built-in providers**

- **mymemory** - free shared API; optional `translateApiKey` (your email) raises daily quota per user.
- **gtx** - unofficial Google endpoint (same idea as the Chrome widget). May return HTTP 429.
- **custom** - your URL or local service (LibreTranslate, Ollama, etc.). Example GET: `https://api.mymemory.translated.net/get?q={text}&langpair=autodetect|{target}`. Example POST body for a JSON API: `{"q":"{text}","target":"{target}"}` with `translateJsonPath` set to the result field.

**Local SLM (Ollama):** [English](docs/ollama-translation.en.md) · [Russian](docs/ollama-translation.md)

### Mods

Put `.js` files in `<config dir>/mods/`. Loaded after the built-in script, sorted by filename. Enable or disable each mod in Settings (reload the game page with F5 to apply). On first run the client copies `example-highlight.js` into that folder.

**Full guide:** [docs/mods.md](docs/mods.md) — API reference, confirmed selectors, examples.

`window.SpeakiRPG` API (summary):

| Member | Description |
|--------|-------------|
| `version` | Client version |
| `selectors` | Confirmed `sr-*` CSS selectors |
| `settings` | Client settings snapshot |
| `getStats()` / `getPlayer()` / `getTarget()` / `getDialog()` | HUD snapshots |
| `query` / `queryAll` | DOM helpers |
| `on('chat', cb)` | `cb({ text, sender, playerId, senderLabel, isMine, isSystem }, row)` |
| `on('player', cb)` | `cb({ playerName, level, exp, location, expPercent, needsRevive }, card)` |
| `on('target', cb)` | `cb({ name, hasTarget, isBoss, isBurning, hpText, hpPercent }, frame)` |
| `on('dialog', cb)` | `cb({ open, npcName, text }, dialog)` |
| `on('stats', cb)` | `cb({ playerName, level, exp, location })` (Discord schedule) |
| `on('settings', cb)` | `cb(settings)` on change |
| `translate(text)` | Returns a Promise with translated text |

`on()` returns unsubscribe. Bundled examples: `example-highlight.js`, `example-boss-target.js`.

### Discord app ID

Default build uses a shared `CLIENT_ID` in `src-tauri/src/main.rs`. For your own release, create an app in the [Discord Developer Portal](https://discord.com/developers/applications) and replace it.

## License

GPL-3.0. See [LICENSE](LICENSE).
