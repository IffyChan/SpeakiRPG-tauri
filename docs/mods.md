# Mods and game interaction

SpeakiRPG is a desktop shell around the live game site (`https://speakirpg.overture.io.kr/`) - a browser SPA (Three.js canvas + HTML overlays). The devs don't expose a modding API, so translation, Discord stats and mods are all really just a userscript: read and patch the DOM after the game draws it.

## Figuring out the UI

No schema, so we work it out:

1. DevTools in the game window (`F12` -> Elements). Game classes use the `sr-` prefix.
2. `MutationObserver` in `inject.js` on chat, player card, target bar, NPC dialog.
3. The Electron port for stats selectors: [DJTOMATO/SpeakiRPG](https://github.com/DJTOMATO/SpeakiRPG).
4. Offline dumps for grepping minified JS.
5. Updates break things - prefer `SpeakiRPG.on` / `get*` over hardcoded selectors.

Found a stable selector? PR it into `SpeakiRPG.selectors` or add an event in `inject.js`.

## What runs where

```
Tauri main window (label: "main")
URL: https://speakirpg.overture.io.kr/

initialization_script, in order:
  1. settings bootstrap (`__SPEAKI_SETTINGS__`, `disabledMods`)
  2. game-state-capture.js (if enabled in settings)
  3. inject.js  -> window.SpeakiRPG API, then loads user mods from disk
  4. bundled example mods (from the .exe via include_str!)
```

User mods (`my-overlay.js`, etc.) are read from `<config dir>/mods/` on **every page load** (F5), not baked into the `.exe`. After editing a user mod, F5 is enough — no full app restart.

**Porting an existing userscript or browser mod?** See [adapting-mods.md](adapting-mods.md).

Scripts run in the game page context, not in `settings.html`. On cold start the local splash (`index.html`) waits for hooks + user mods before opening the game site. Disable/enable in Settings applies after reload (`F5` on the game page).

**Bundled with the release** (only these two ship inside the `.exe`; `src-tauri/mods/`):

- `example-highlight.js` - yellow row when chat mentions your name
- `example-emotes.js` - sample `clickEmoteSlot()` usage
- `game-tools.js` - QoL utilities (status strip, camera, emotes, portal walk) with Settings schema

On first run the client also copies those files into `<config dir>/mods/` if missing (for editing). Loading uses the in-exe copy, not the folder duplicate.

**User mods** (`theme-tweaks.js`, overlays, etc.) live only in `<config dir>/mods/`. They are read at runtime and are not packed into the GitHub release binary.

Enable/disable per file in Settings (`disabledMods` in `settings.json`).

---

## `window.SpeakiRPG` API

**Properties**

- `version` - client version string
- `settings` - read-only client settings (`translateTarget`, `translateEnabled`, `captureGameState`, ...)
- `selectors` - frozen map of confirmed CSS selectors (below)
- `gameStateStatus` - `disabled` | `pending` | `patched` | `ready` | `patch_failed` (see below)
- `gameStateCaptureFailReason` - string when capture failed, else `null`

**Methods** (snapshot reads, call anytime after the HUD exists - return `null` if the root node isn't in the DOM yet)

- `getStats()` - `{ playerName, level, exp, location }` (same as Discord)
- `getPlayer()` - stats plus `{ expPercent, needsRevive }`
- `getTarget()` - `{ name, hasTarget, isBoss, isBurning, hpText, hpPercent }`
- `getDialog()` - `{ open, npcName, text }`
- `clickEmoteSlot()` - clicks `.sr-emote-slot` on the hotbar, returns `false` if the slot's missing
- `query(selector)` / `queryAll(selector)` - `querySelector` / `querySelectorAll` (array)
- `translate(text)` - `Promise<string>`, built-in backend
- `getGameState()` - live game client when capture is ready, else `null`
- `isGameStateReady()` - boolean
- `whenGameState(cb)` - run when `gameState` is available (see Advanced)
- `bootGameStateMod(name, init)` - same, but waits for `document.body` (for HUD mods)
- `getModSettings(modId)` - per-mod values from Settings (`modSettings`); omit `modId` for the full map
- `getI18n()` / `getQuestManager()` - helpers when capture patch exposed them, else `null`
- `listMonsterNames()` - mob names from `gameState` when ready, else `[]`
- `on(event, cb)` - subscribe, returns `unsubscribe()`

**Events**

| Event | When | Callback args |
|-------|------|----------------|
| `chat` | new chat row | `(message, rowElement)` |
| `player` | player card / location changes | `(player, cardElement)` |
| `target` | target bar changes | `(target, frameElement)` |
| `dialog` | NPC dialog open/close or text change | `(dialog, dialogElement)` |
| `emote` | chat line matches emote heuristic | `(message, rowElement)` |
| `stats` | Discord stats tick (~30s, 5min, `Ctrl+Shift+D`) | `(stats)` |
| `settings` | client settings changed | `(settings)` |
| `gameStateReady` | game client captured (capture on) | `(gameState)` |
| `modAction` | Settings action button for a mod schema | `({ modId, action })` |

`player` / `target` / `dialog` use live observers. `stats` follows the Discord poll schedule - use `player` if you want a fresh name/level.

### Advanced: gameState capture (opt-in)

Off by default. **Settings → Developer → Expose game client to mods**, then **F5**.

The client patches `/assets/index-*.js` on load so `window.gameState` exists (same idea as a manual DevTools breakpoint on socket connect). Mods must defer:

```js
SpeakiRPG.whenGameState((gs) => {
  console.log('[mod] hp', gs.myStat?.hp);
});

// or, if the mod mounts DOM on init:
SpeakiRPG.bootGameStateMod('my-mod', (gs) => { /* ... */ });
```

Can break on game updates (`SpeakiRPG.gameStateStatus === 'patch_failed'`). See [adapting-mods.md](adapting-mods.md) for porting notes.

### `SpeakiRPG.selectors`

Confirmed against DOM dumps (Aug 2026). Use these instead of copying strings around:

| Key | Selector |
|-----|----------|
| `chatLog` | `.sr-chatbox__log` |
| `chatRow` | `.sr-chatbox__row` |
| `chatBody` | `.sr-chatbox__body-text` |
| `chatSender` | `.sr-chatbox__sender` |
| `chatSenderMine` | `.sr-chatbox__sender--mine` |
| `chatSystemRow` | `.sr-chatbox__system-text` |
| `playerCard` | `.sr-player-card` |
| `playerName` | `.sr-player-card__name` |
| `playerLevel` | `.sr-player-card__portrait-wrap .sr-player-card__lv-badge` |
| `playerExp` | `.sr-player-card__exp-track` |
| `playerRevive` | `.sr-player-card__revive-pill` |
| `playerHp` | `.sr-hp-gauge__value` |
| `minimapFrame` | `.sr-minimap-frame` |
| `minimapCaption` | `.sr-minimap-frame__caption` |
| `targetFrame` | `.sr-target-frame` |
| `targetName` | `.sr-target-frame__name` |
| `targetBossBadge` | `.sr-target-frame__boss-badge` |
| `targetBurnBadge` | `.sr-target-frame__burn-badge` |
| `targetHpValue` | `.sr-target-frame__hp-value` |
| `targetHpFill` | `.sr-target-frame__hp-fill` |
| `npcDialog` | `.sr-npc-dialog` |
| `npcName` | `.sr-npc-dialog__name-tag` |
| `npcText` | `.sr-npc-dialog__text` |
| `skillBar` | `.sr-skill-hotbar` |
| `skillSlot` | `.sr-skill-slot` |
| `emoteSlot` | `.sr-emote-slot` (hotbar, `title="Emote"`, smiley icon) |
| `potionPopover` | `.sr-potion-popover` (empty in our dumps - potion UI, not emotes) |
| `castBar` | `.sr-cast-bar` |
| `gameCanvas` | `.sr-game-canvas` |

Hotbar also has `.sr-jump-slot` and `.sr-camera-reset-slot`, not in `selectors` yet - use `query`.

Row nodes carry `data-player-id`, `data-player-name` (see `chat`).

---

## Emotes

**T** (Settings -> Keybinds -> Emote in-game) plays an animation. There's no emote wheel in the HTML.

The hotbar smiley (`.sr-emote-slot`) does the same thing as that keybind when clicked. `clickEmoteSlot()` triggers that click - it doesn't synthesize a keypress, so rebinding **T** in-game still matters.

`.sr-potion-popover` is for potions, empty in our dumps.

`on('emote')` only looks at chat (emoji-only lines etc.) - it doesn't fire for character animations in the world.

---

## Event payloads

### `chat`

```js
SpeakiRPG.on('chat', (message, row) => { /* ... */ });
```

- `message.text` (string) - line body
- `message.sender` (string|null) - `data-player-name`
- `message.playerId` (string|null) - `data-player-id`
- `message.senderLabel` (string|null) - e.g. `[PlayerName]`
- `message.isMine` (bool)
- `message.isSystem` (bool)
- `message.isEmote` (bool) - heuristic: emoji-only or system emote keywords
- `row` (HTMLElement) - `.sr-chatbox__row`, safe to style

Fires once per row, first time the client sees it.

### `player`

```js
SpeakiRPG.on('player', (player, card) => { /* ... */ });
```

- `playerName`, `level`, `exp`, `location` (string|null)
- `expPercent` (number|null) - width of `.sr-player-card__exp-fill`
- `hpText` (string|null) - e.g. `85 / 140`
- `hpCurrent` / `hpMax` (number|null) - parsed from `hpText`
- `needsRevive` (bool) - `hpCurrent === 0` (the revive pill alone isn't reliable)

### `target`

```js
SpeakiRPG.on('target', (target, frame) => { /* ... */ });
```

- `hasTarget` (bool) - name non-empty
- `name` (string|null)
- `isBoss` (bool) - BOSS badge visible (`display: none` when it's not a boss)
- `isBurning` (bool) - BURN badge visible
- `hpText` (string|null)
- `hpPercent` (number|null) - HP fill bar width %

### `dialog`

```js
SpeakiRPG.on('dialog', (dialog, el) => { /* ... */ });
```

`open` (bool), `npcName` (string|null), `text` (string|null).

### `stats` / `settings`

`stats`: `{ playerName, level, exp, location }` on the Discord tick.
`settings`: same shape as `SpeakiRPG.settings`, fires on change.

---

## Examples

**Chat logger**

```js
// SpeakiRPG mod: chat logger

SpeakiRPG.on('chat', (message) => {
  if (message.isSystem) return;
  console.log(message.senderLabel, message.text);
});
```

**`emote` (chat only)** - world emotes (**T**, hotbar) are separate, see above. This fires when a chat row matches the heuristic in `inject.js`.

```js
SpeakiRPG.on('emote', (emote, row) => {
  row.style.background = 'rgba(180, 140, 255, 0.12)';
});
```

**Mention highlight** (bundled) - uses `getPlayer()` + `on('player')` for your name, styles the row on mention. Bundled files only copy to `<config dir>/mods/` if missing - after an update, delete stale copies there and reload.

**Translate NPC dialog line**

```js
SpeakiRPG.on('dialog', async (dialog) => {
  if (!dialog.open || !dialog.text) return;
  const translated = await SpeakiRPG.translate(dialog.text);
  console.log('[dialog]', translated);
});
```

**Revive reminder**

```js
// SpeakiRPG mod: revive ping

let wasDead = false;
SpeakiRPG.on('player', (player) => {
  if (player.needsRevive && !wasDead) console.log('You are dead - press R');
  wasDead = player.needsRevive;
});
```

**Custom DOM (advanced)** - when there's no event yet, use `selectors` + `query`/`queryAll`:

```js
const slots = SpeakiRPG.queryAll(SpeakiRPG.selectors.skillSlot);
for (const slot of slots) {
  const cd = slot.querySelector('.sr-skill-slot__cooldown-text')?.textContent.trim();
  if (cd) console.log(slot.getAttribute('title'), 'CD:', cd);
}
```

No built-in skill/cast observers - poll if you need it, or PR an `on('skill')`.

## Mod settings schema (Settings window)

Mods can declare a JSON schema in a block comment (parsed from disk, not executed). When present, fields show under **Mod settings** in the Settings window, grouped by `category`. Values persist in `settings.json` as `modSettings[modId]`.

```js
// SpeakiRPG mod: My mod
/* SpeakiRPG.settings
{
  "id": "my-mod",
  "category": "UI",
  "fields": [
    { "key": "enabled", "type": "bool", "label": "Feature on", "default": true },
    { "key": "scale", "type": "number", "label": "Scale", "min": 0.5, "max": 2, "default": 1 },
    { "key": "refresh", "type": "action", "label": "Refresh now", "action": "refresh" }
  ]
}
*/
```

Field types: `bool`, `number`, `text`, `select`, `action`. Read values with `SpeakiRPG.getModSettings('my-mod')` and react to `SpeakiRPG.on('settings', ...)`. For `action` buttons, listen to `SpeakiRPG.on('modAction', ({ modId, action }) => { ... })`.

```js
{ "key": "mode", "type": "select", "label": "Mode", "default": "a",
  "options": [
    { "value": "a", "label": "Option A" },
    { "value": "b", "label": "Option B" }
  ]
}
{ "key": "note", "type": "text", "label": "Custom label", "default": "" }
```

The Settings window has search across client sections and mod categories. Mods without a schema only appear in the enable/disable list.

Bundled **game-tools** (`src-tauri/mods/game-tools.js`) includes:

- **Minimap strips** (stacked above the legend): nearby players, exp/min, zone name; optional zone ID; EXP time-to-level; channel population (`GET /api/realtime/channels` with JWT from the game socket URL).
- **Walk to zone** — `select` for ring zones 1–10; portal routing with session cache (see below).
- **Quest pin** — Pin button on incomplete quests in the quest list; progress bar under the minimap; polls `GET /api/quests?period=…`.
- **Spectate** — text field + **Watch player** action (camera follows; **Reset camera** returns to self).
- Camera lock, view clip, nametags, zoom, emotes, spin.

Requires **Expose game client to mods** and **F5** after changing mod settings. Quest pin also needs `questManager` capture (enabled with gameState capture).

Zone walk routes along the main world ring, learns portal positions from `gameState.findNearbyPortal()` into a session cache, and falls back to a compact edge hint table when a hop is not cached yet.

**REST from a mod:** JWT is available from `gameState.socket.socket.url` (same pattern as game-tools). Use `Authorization: Bearer …` against `https://sr1.overture.io.kr`. No public `getAuthToken()` helper yet.

---

## Writing a mod

1. Create `my-mod.js` in the mods folder (or copy an example).
2. First line: `// SpeakiRPG mod: human-readable name` (shown in Settings).
3. Prefer `on` / `get*` / `selectors` over raw `document.querySelector`.
4. Enable in Settings -> Mods, reload with `F5`.
5. Check console for `[SpeakiRPG] mod listener failed:` if something's off.

## What you can and can't do

Works: chat/HUD/target/NPC dialog, styling the DOM, translation and client settings, clicking the emote slot. With opt-in capture: read `gameState` (monsters, combat assist, etc.) via `whenGameState`.
Doesn't work: emote picker in the DOM. Without capture: no direct game client. Assume selectors or patch sites can break on a game update.

## Debugging

1. `F12` -> Console in the game window.
2. `SpeakiRPG.getPlayer()` / `getTarget()` after login.
3. `SpeakiRPG.on('chat', console.log)`, then send a chat message.
4. Compare Elements panel to `SpeakiRPG.selectors`.
5. Mod not showing in Settings? File has to be `.js` in the mods folder.

**Pitfalls**

| Symptom | Cause |
|---------|-------|
| `clickEmoteSlot()` returns false | no `.sr-emote-slot` yet (mobile layout etc.) |
| `on('emote')` silent | chat line doesn't match the heuristic |
| Old bundled mod sticking around | already in `%APPDATA%/.../mods/`, client won't overwrite |
| `needsRevive` stuck true | revive pill stays in HTML while alive - API uses `hpCurrent === 0` instead |
| RU chat shows target `en` | turn on translation, Cyrillic passes through as-is when target is `ru`/`uk` |
| RU text + `(hello)` | that's a translated line, brackets hold the original |
| `gameStateStatus` stays `disabled` | enable capture in Settings, F5 |
| `patch_failed` after game update | gameState capture may need a client update; try DOM-based APIs or open an issue |
| `whenGameState` never runs | log in after capture; wait until status is `ready` |

**Hotkeys**

- **T** (game) - emote animation
- `Ctrl+Shift+T` - toggle translation
- `Ctrl+Shift+S` - open settings

## For contributors

- `src-tauri/src/inject.js` - API, observers, translation
- `src-tauri/src/game-state-capture.js` - opt-in gameState fetch patch
- `src-tauri/src/main.rs` - mods, settings window
- `src-tauri/mods/example-*.js` - bundled samples

New UI element? Add the selector in `inject.js`, a `get*`/`on` if it changes, and a row in this file.
