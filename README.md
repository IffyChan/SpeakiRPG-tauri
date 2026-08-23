# SpeakiRPG Desktop Client

Desktop wrapper for [Speaki RPG](https://speakirpg.overture.io.kr/) with Discord Rich Presence, in-game chat translation, and optional user scripts.

Based on the original [SpeakiRPG Electron client](https://github.com/DJTOMATO/SpeakiRPG) by [DJTOMATO](https://github.com/DJTOMATO). This repo is a Tauri port of that idea and feature set.

Fan-made client. Not affiliated with the game developers. No game assets are bundled.

## Screenshots

<!-- Drop PNGs into docs/screenshots/ with these filenames -->

![Game in the desktop client](docs/screenshots/game-window.png)
![Discord Rich Presence](docs/screenshots/discord-presence.png)
![Chat translation](docs/screenshots/chat-translation.png)

## Download

Pre-built installers: [GitHub Releases](https://github.com/IffyChan/SpeakiRPG-tauri/releases)

## Build from source

**Requirements:** [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/), and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/IffyChan/SpeakiRPG-tauri.git
cd SpeakiRPG-tauri
npm install
npm run dev      # run in development
npm run build    # release installer in src-tauri/target/release/bundle/
```

## Usage

1. Launch the app. It opens a splash screen, then loads the game site.
2. Log in. Discord status updates from your character card (name, level, XP, location) after a short delay, then every 5 minutes.
3. Korean chat lines get a translation under the message when translation is enabled (default on).

Discord must be running for Rich Presence to show.

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `F5` / `Ctrl+R` (`Cmd+R` on macOS) | Reload page |
| `Ctrl+Shift+D` | Force Discord status refresh |
| `Ctrl+Shift+T` | Toggle chat translation |

Shortcuts work while the game window is focused.

## Configuration

On first run the app creates `settings.json` in the config directory:

| OS | Path |
|----|------|
| Windows | `%APPDATA%\com.ifchan.speakirpg\settings.json` |
| Linux | `~/.config/com.ifchan.speakirpg/settings.json` |
| macOS | `~/Library/Application Support/com.ifchan.speakirpg/settings.json` |

```json
{
  "translateTarget": "ru",
  "translateEnabled": true
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `translateTarget` | `"ru"` | ISO language code for chat translation |
| `translateEnabled` | `true` | Start with translation on (`Ctrl+Shift+T` toggles at runtime) |

### User mods

Drop `.js` files into `<config dir>/mods/`. They run on every page load after the built-in inject script, in filename order.

### Discord app ID

The bundled build uses a shared Discord application ID. To ship your own build, change `CLIENT_ID` in `src-tauri/src/main.rs` and set up a Discord application in the [Developer Portal](https://discord.com/developers/applications).

## License

GPL-3.0. See [LICENSE](LICENSE).
