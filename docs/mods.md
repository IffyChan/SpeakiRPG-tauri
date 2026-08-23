# Mods and game interaction

SpeakiRPG is a **desktop shell around the live game website** (`https://speakirpg.overture.io.kr/`). The game is a browser SPA (Three.js canvas + HTML UI overlays). There is **no official modding API** from the game developers.

Everything in this client — translation, Discord stats, mods — works the same way a userscript would: **read and tweak the page DOM** after the game renders it.

## How we figure out what is on the page

Nobody hands us a schema. We reverse-engineer the UI:

1. **DevTools in the client** — focus the game window, press `F12`, use Elements. Classes use the `sr-` prefix (BEM-style).
2. **Watch the DOM change** — `inject.js` uses `MutationObserver` on chat, player card, target bar, NPC dialog.
3. **Port from the Electron client** — stats selectors came from [DJTOMATO/SpeakiRPG](https://github.com/DJTOMATO/SpeakiRPG).
4. **HTML snapshots for maintainers** — private DOM dumps help when DevTools is awkward; class names are what matter.
5. **Trial and breakage** — game updates can rename classes. Prefer `SpeakiRPG.on(...)` and `SpeakiRPG.get*()` over copy-pasting selectors.

If you confirm a stable selector, open a PR to add it to `SpeakiRPG.selectors` or a new event in `inject.js`.

## What runs where

```
┌─────────────────────────────────────────────┐
│  Tauri main window (label: "main")          │
│  URL: https://speakirpg.overture.io.kr/     │
│                                             │
│  initialization_script (in order):          │
│    1. window.__SPEAKI_SETTINGS__            │
│    2. inject.js  → window.SpeakiRPG API     │
│    3. your mods/*.js (enabled only)         │
└─────────────────────────────────────────────┘
```

- Scripts run in the **game page context**, not in `settings.html`.
- Mods load **once per full page load** (`F5`). Toggle mods in Settings, then reload.
- A mod crash is caught per listener; it must not take down translation.

Bundled examples (copied into `<config dir>/mods/` if missing):

| File | What it does |
|------|----------------|
| `example-highlight.js` | Yellow row when chat mentions your name |
| `example-boss-target.js` | Red outline on target bar while a BOSS is selected |

Enable/disable per file in Settings (`disabledMods` in `settings.json`).

---

## `window.SpeakiRPG` API

### Properties

| Member | Description |
|--------|-------------|
| `version` | Client version string |
| `settings` | Read-only client settings (`translateTarget`, `translateEnabled`, …) |
| `selectors` | Frozen map of **confirmed** CSS selectors (see below) |

### Methods (snapshot reads)

Call anytime after the HUD exists. Return `null` if the root node is not in the DOM yet.

| Method | Returns |
|--------|---------|
| `getStats()` | `{ playerName, level, exp, location }` — same fields as Discord |
| `getPlayer()` | Stats plus `{ expPercent, needsRevive }` |
| `getTarget()` | `{ name, hasTarget, isBoss, isBurning, hpText, hpPercent }` |
| `getDialog()` | `{ open, npcName, text }` |
| `query(selector)` | `document.querySelector` |
| `queryAll(selector)` | `document.querySelectorAll` as array |
| `translate(text)` | `Promise<string>` — built-in translation backend |
| `on(event, cb)` | Subscribe; returns `unsubscribe()` |

### Events

| Event | When | Callback args |
|-------|------|----------------|
| `chat` | New chat row | `(message, rowElement)` |
| `player` | Player card / location changes | `(player, cardElement)` |
| `target` | Target bar changes | `(target, frameElement)` |
| `dialog` | NPC dialog open/close or text change | `(dialog, dialogElement)` |
| `stats` | Discord stats tick (~30s, 5min, `Ctrl+Shift+D`) | `(stats)` |
| `settings` | Client settings changed | `(settings)` |

`player` / `target` / `dialog` use live DOM observers. `stats` is throttled for Discord only — use `player` for up-to-date name/level.

### `SpeakiRPG.selectors`

Confirmed in client snapshots (Aug 2026). Prefer these over hard-coded strings:

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
| `castBar` | `.sr-cast-bar` |
| `gameCanvas` | `.sr-game-canvas` |

Row nodes also expose `data-player-id` and `data-player-name` (see `chat` event).

---

## Event payloads

### `chat`

```js
SpeakiRPG.on('chat', (message, row) => { /* ... */ });
```

| Field | Type | Meaning |
|-------|------|---------|
| `message.text` | string | Line body |
| `message.sender` | string \| null | `data-player-name` |
| `message.playerId` | string \| null | `data-player-id` |
| `message.senderLabel` | string \| null | e.g. `[PlayerName]` |
| `message.isMine` | boolean | Your message |
| `message.isSystem` | boolean | System line |
| `row` | HTMLElement | `.sr-chatbox__row` — safe to style |

Fires once per row (first time the client sees it).

### `player`

```js
SpeakiRPG.on('player', (player, card) => { /* ... */ });
```

| Field | Type | Meaning |
|-------|------|---------|
| `playerName` | string \| null | Character name |
| `level` | string \| null | Level badge text |
| `exp` | string \| null | XP `title` or visible text |
| `location` | string \| null | Minimap caption |
| `expPercent` | number \| null | Width of `.sr-player-card__exp-fill` |
| `needsRevive` | boolean | Revive pill visible |

### `target`

```js
SpeakiRPG.on('target', (target, frame) => { /* ... */ });
```

| Field | Type | Meaning |
|-------|------|---------|
| `hasTarget` | boolean | Name non-empty |
| `name` | string \| null | Target name |
| `isBoss` | boolean | BOSS badge present |
| `isBurning` | boolean | BURN badge present |
| `hpText` | string \| null | HP label text |
| `hpPercent` | number \| null | HP fill bar width % |

### `dialog`

```js
SpeakiRPG.on('dialog', (dialog, el) => { /* ... */ });
```

| Field | Type | Meaning |
|-------|------|---------|
| `open` | boolean | Dialog visible |
| `npcName` | string \| null | Name tag |
| `text` | string \| null | Dialog body |

### `stats` / `settings`

`stats` — `{ playerName, level, exp, location }` on Discord schedule.

`settings` — same shape as `SpeakiRPG.settings` when translation or provider changes.

---

## Examples

### Chat logger

```js
// SpeakiRPG mod: chat logger

SpeakiRPG.on('chat', (message) => {
  if (message.isSystem) return;
  console.log(message.senderLabel, message.text);
});
```

### Mention highlight (bundled)

Uses `getPlayer()` + `on('player')` for your name, styles the row on mention.

### Boss target outline (bundled)

```js
SpeakiRPG.on('target', (target, frame) => {
  frame.style.boxShadow =
    target.hasTarget && target.isBoss ? '0 0 0 2px rgba(220, 80, 80, 0.55)' : '';
});
```

### Translate NPC dialog line

```js
SpeakiRPG.on('dialog', async (dialog) => {
  if (!dialog.open || !dialog.text) return;
  const translated = await SpeakiRPG.translate(dialog.text);
  console.log('[dialog]', translated);
});
```

### Revive reminder

```js
// SpeakiRPG mod: revive ping

let wasDead = false;
SpeakiRPG.on('player', (player) => {
  if (player.needsRevive && !wasDead) console.log('You are dead — press R');
  wasDead = player.needsRevive;
});
```

### Custom DOM (advanced)

When no event exists yet, use `selectors` + `query` / `queryAll`:

```js
const slots = SpeakiRPG.queryAll(SpeakiRPG.selectors.skillSlot);
for (const slot of slots) {
  const cd = slot.querySelector('.sr-skill-slot__cooldown-text')?.textContent.trim();
  if (cd) console.log(slot.getAttribute('title'), 'CD:', cd);
}
```

Skill/cast observers are not built in — poll sparingly or open a PR to add `on('skill', …)`.

---

## Writing a mod

1. Create `my-mod.js` in the mods folder (or copy an example).
2. First line: `// SpeakiRPG mod: human-readable name` (shown in Settings).
3. Prefer `on` / `get*` / `selectors` over raw `document.querySelector`.
4. Enable in Settings → Mods, reload with `F5`.
5. Watch the console for `[SpeakiRPG] mod listener failed:`.

## Limits

| Goal | Status |
|------|--------|
| Chat, HUD, target, NPC dialog | Yes — API above |
| Style DOM | Yes |
| Translation / client settings | Yes |
| Game network / packets | No |
| 3D world / entity positions | No (Three.js canvas) |
| Survive game update | No guarantee |

## Debugging

1. `F12` → Console in the game window.
2. `SpeakiRPG.getPlayer()` / `getTarget()` after login.
3. `SpeakiRPG.on('chat', console.log)` — send a chat message.
4. Compare Elements panel to `SpeakiRPG.selectors`.
5. Mod missing from Settings? File must be `.js` in the mods folder.

## For contributors

| File | Role |
|------|------|
| `src-tauri/src/inject.js` | API, observers, translation |
| `src-tauri/src/main.rs` | Mod load, `disabledMods` |
| `src-tauri/mods/example-*.js` | Bundled samples |

New confirmed UI: add selector → `read*` + `get*` + `on` if it changes over time → document here.
