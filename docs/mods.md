# Mods and game interaction

SpeakiRPG is a desktop shell around the live game site (`https://speakirpg.overture.io.kr/`) - a browser SPA (Three.js canvas + HTML overlays). The devs don't expose a modding API, so translation, Discord stats and mods are all really just a userscript: read and patch the DOM after the game draws it.

## Figuring out the UI

No schema, so we work it out:

1. DevTools in the game window (`F12` -> Elements). Game classes use the `sr-` prefix.
2. `MutationObserver` in `inject.js` on chat, player card, target bar, NPC dialog.
3. The Electron port for stats selectors: [DJTOMATO/SpeakiRPG](https://github.com/DJTOMATO/SpeakiRPG).
4. Offline dumps (maintainers only, `docs/secret/`, gitignored) for grepping minified JS.
5. Updates break things - prefer `SpeakiRPG.on` / `get*` over hardcoded selectors.

Found a stable selector? PR it into `SpeakiRPG.selectors` or add an event in `inject.js`.

## What runs where

```
Tauri main window (label: "main")
URL: https://speakirpg.overture.io.kr/

initialization_script, in order:
  1. window.__SPEAKI_SETTINGS__
  2. inject.js  -> window.SpeakiRPG API
  3. your mods/*.js (enabled only)
```

Scripts run in the game page context, not in `settings.html`. Mods load once per full page load (`F5`) - toggle in Settings, then reload. A mod crash is caught per listener, so it won't take down translation.

Bundled examples (copied into `<config dir>/mods/` if missing):

- `example-highlight.js` - yellow row when chat mentions your name
- `example-emotes.js` - sample `clickEmoteSlot()` usage

Enable/disable per file in Settings (`disabledMods` in `settings.json`).

---

## `window.SpeakiRPG` API

**Properties**

- `version` - client version string
- `settings` - read-only client settings (`translateTarget`, `translateEnabled`, ...)
- `selectors` - frozen map of confirmed CSS selectors (below)

**Methods** (snapshot reads, call anytime after the HUD exists - return `null` if the root node isn't in the DOM yet)

- `getStats()` - `{ playerName, level, exp, location }` (same as Discord)
- `getPlayer()` - stats plus `{ expPercent, needsRevive }`
- `getTarget()` - `{ name, hasTarget, isBoss, isBurning, hpText, hpPercent }`
- `getDialog()` - `{ open, npcName, text }`
- `clickEmoteSlot()` - clicks `.sr-emote-slot` on the hotbar, returns `false` if the slot's missing
- `query(selector)` / `queryAll(selector)` - `querySelector` / `querySelectorAll` (array)
- `translate(text)` - `Promise<string>`, built-in backend
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

`player` / `target` / `dialog` use live observers. `stats` follows the Discord poll schedule - use `player` if you want a fresh name/level.

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

More detail (bundle grep, wire ids) in `docs/secret/dom-audit-body2.md` (gitignored).

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

---

## Writing a mod

1. Create `my-mod.js` in the mods folder (or copy an example).
2. First line: `// SpeakiRPG mod: human-readable name` (shown in Settings).
3. Prefer `on` / `get*` / `selectors` over raw `document.querySelector`.
4. Enable in Settings -> Mods, reload with `F5`.
5. Check console for `[SpeakiRPG] mod listener failed:` if something's off.

## What you can and can't do

Works: chat/HUD/target/NPC dialog, styling the DOM, translation and client settings, clicking the emote slot.
Doesn't work: emote picker in the DOM, game network access, 3D positions (it's a canvas). Assume any of this can break on a game update.

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

**Hotkeys**

- **T** (game) - emote animation
- `Ctrl+Shift+T` - toggle translation
- `Ctrl+Shift+S` - open settings

## For contributors

- `src-tauri/src/inject.js` - API, observers, translation
- `src-tauri/src/main.rs` - mods, settings window
- `src-tauri/mods/example-*.js` - bundled samples
- `docs/secret/` - gitignored dumps + `dom-audit-body2.md`

New UI element? Add the selector in `inject.js`, a `get*`/`on` if it changes, and a row in this file. Bundle/HTML notes go in `docs/secret/`.
