# Adapting mods for the SpeakiRPG desktop client

This guide is for authors who already have a userscript, browser extension snippet, or mod written for Speaki RPG in the browser, and want it to run in the [SpeakiRPG desktop client](https://github.com/IffyChan/SpeakiRPG-tauri).

The desktop client loads your script into the same game page (`https://speakirpg.overture.io.kr/`). There is no separate mod SDK from the game developers — mods use the unofficial `window.SpeakiRPG` API provided by the client. Use this guide together with the full API reference in [mods.md](mods.md).

## Before you start

- **Unofficial tooling.** This client is fan-made and not affiliated with the game. Mods are your responsibility; follow the game's terms of service and community rules.
- **No guarantees.** Game updates can change the DOM or break advanced hooks. Prefer stable APIs (`SpeakiRPG.on`, `get*`, `selectors`) over brittle internals.
- **Scope.** This client is aimed at UI helpers, overlays, chat tools, and similar quality-of-life features — not automation that plays the game for you.

## Quick checklist

1. Save your script as `something.js` in the client's mods folder (see below).
2. Add a display name: `// SpeakiRPG mod: My Mod Name` on the first or second line.
3. Remove Tampermonkey headers (`// ==UserScript==`, `@grant`, `@match`, etc.).
4. Replace `unsafeWindow` / `window` game hacks with `SpeakiRPG` APIs where possible.
5. If you need live game data beyond the HUD, enable **Expose game client to mods** in Settings and use `whenGameState` (see below).
6. Enable the mod in **Settings → Mods**, then reload the game page with **F5**.

## Where mods live

| Platform | Mods folder |
|----------|-------------|
| Windows | `%APPDATA%\com.ifchan.speakirpg\mods\` |
| Linux | `~/.config/com.ifchan.speakirpg/mods/` |
| macOS | `~/Library/Application Support/com.ifchan.speakirpg/mods/` |

Open the folder from **Settings → Open mods folder**.

**Load order**

1. Client bootstrap (`inject.js`, optional gameState capture)
2. Bundled example mods (shipped inside the app)
3. Your `.js` files from the mods folder, sorted **by filename**

Use a numeric prefix if order matters, e.g. `10-shared.js` before `20-overlay.js`.

**Reload workflow**

- Edit a mod → **F5** on the game window. No need to restart the whole app.
- Toggle enable/disable in Settings → Mods → **F5** again.

## Porting from Tampermonkey / Violentmonkey

Tampermonkey scripts need a few mechanical changes:

| Userscript | Desktop client |
|------------|----------------|
| `// ==UserScript==` block | Remove entirely |
| `@match https://speakirpg...` | Not needed — script only runs on the game page |
| `GM_addStyle(...)` | `document.head.appendChild(style)` or inject a `<style>` tag |
| `GM_getValue` / `GM_setValue` | `localStorage`, or `SpeakiRPG.settings` + `on('settings')` for client settings |
| `unsafeWindow.foo` | `window.foo` or `SpeakiRPG` API |
| `$(document).ready(...)` | Often unnecessary; mods run after the client injects. Use `SpeakiRPG.on(...)` or wait for `document.body` |

**Minimal template**

```js
// SpeakiRPG mod: my overlay

(function () {
  if (!window.SpeakiRPG) {
    console.warn('[my-mod] SpeakiRPG API not found');
    return;
  }

  SpeakiRPG.on('player', (player) => {
    console.log('[my-mod] level', player.level);
  });
})();
```

Wrap top-level code in `try/catch` or an IIFE so one thrown error does not break other mods. The client already wraps each file, but defensive coding inside your mod still helps.

## Porting DOM-based mods (HUD, chat, styling)

If your mod only reads chat, the player card, target bar, or NPC dialog, you usually **do not** need gameState capture.

**Prefer the client API over raw selectors**

```js
// Good — survives minor DOM tweaks better
SpeakiRPG.on('chat', (message, row) => {
  if (message.isSystem) return;
  // ...
});

const player = SpeakiRPG.getPlayer();
const target = SpeakiRPG.getTarget();
```

```js
// OK for custom UI the API does not cover yet
const row = SpeakiRPG.query(SpeakiRPG.selectors.chatRow);
```

**Map common patterns**

| Old approach | Client approach |
|--------------|-----------------|
| `MutationObserver` on `.sr-chatbox__log` | `SpeakiRPG.on('chat', ...)` |
| Poll player name from DOM | `SpeakiRPG.getPlayer()` or `on('player', ...)` |
| Watch target HP bar | `SpeakiRPG.on('target', ...)` |
| NPC dialog text | `SpeakiRPG.on('dialog', ...)` |
| Translate text | `await SpeakiRPG.translate(text)` |

See [mods.md](mods.md) for event payloads and the full selector list.

## Porting mods that use `gameState`

Some community tools were written for browser DevTools or other clients that expose the minified game client as `window.gameState` (player stats, monsters, combat helpers, etc.). The desktop client can expose the same object **only when the user opts in**.

### Enable capture

**Settings → Developer → Expose game client to mods (gameState capture)** → **F5**.

Check status in the console:

```js
SpeakiRPG.gameStateStatus
// "disabled" | "pending" | "patched" | "ready" | "patch_failed"
```

Wait until you are logged in and in the world; status should become `"ready"`.

### Defer initialization

Do **not** read `window.gameState` at the top level of your file. It may not exist yet.

```js
// SpeakiRPG mod: example gameState mod

SpeakiRPG.bootGameStateMod('example-gamestate', (gs) => {
  console.log('[example] level', gs.myStat?.level);
  // mount UI, register hooks, etc.
});
```

`bootGameStateMod` is built into the client (`inject.js`). You do **not** need a separate boot helper mod — call it directly from your script.

Lower-level alternative:

```js
SpeakiRPG.whenGameState((gs) => {
  // runs when capture is ready
});
```

If your mod adds DOM panels, prefer `bootGameStateMod` so `document.body` exists before you mount.

### Adapting existing `gameState` code

| Pattern in old mod | Change for desktop client |
|--------------------|---------------------------|
| `const gs = window.gameState` at load time | Move inside `bootGameStateMod` / `whenGameState` |
| Breakpoint / manual paste in DevTools | Enable capture in Settings instead |
| `gameState.setTarget(...)` etc. | Same API when capture is `ready` — test after each game patch |
| Assumes capture always on | Check `SpeakiRPG.settings.captureGameState` and show a friendly message if off |

**Guard example**

```js
// SpeakiRPG mod: my tracker

if (!SpeakiRPG.settings.captureGameState) {
  console.warn('[my-tracker] Enable gameState capture in Settings, then F5');
} else {
  SpeakiRPG.bootGameStateMod('my-tracker', (gs) => {
    // ...
  });
}
```

### When capture fails

After a **game update**, capture may report `patch_failed`. DOM-based mods often keep working; `gameState` mods may need a client update. Open an issue on the client repository with the game bundle filename (`index-*.js` from the network tab) if capture stays broken.

## Settings and translation

Read client settings without touching `settings.json` directly:

```js
const { translateEnabled, translateTarget } = SpeakiRPG.settings;

SpeakiRPG.on('settings', (settings) => {
  console.log('translation', settings.translateEnabled);
});
```

## Debugging a port

1. **F12** → Console in the game window (not the splash screen).
2. Confirm `typeof SpeakiRPG === 'object'`.
3. For HUD mods: `SpeakiRPG.getPlayer()` after login.
4. For gameState mods: `SpeakiRPG.gameStateStatus` → `"ready"`.
5. Mod missing in Settings? File must be `.js` in the mods folder.
6. Changes not applying? **F5**, not only closing Settings.
7. Errors show as `[SpeakiRPG] mod failed: your-file.js` — fix the stack trace and reload.

## Common porting pitfalls

| Symptom | Likely cause |
|---------|----------------|
| Mod never runs | Disabled in Settings, or syntax error on load |
| `SpeakiRPG is undefined` | Script runs outside the game page context |
| `gameState` is `null` | Capture disabled, not logged in yet, or status not `ready` |
| `bootGameStateMod` warns about capture | Turn on capture in Settings, F5 |
| Worked in Tampermonkey, silent here | Removed `@match` but code still waits for wrong event |
| `clickEmoteSlot()` is false | Hotbar not visible yet (layout) — retry with `setTimeout` |
| Stale copy of bundled example | Client won't overwrite existing files in mods folder — delete or rename the old file |
| Two mods conflict | Both patch the same global; split responsibilities or merge scripts |

## What works well vs. what is fragile

**Reliable**

- Chat overlays, mention highlights, dialog helpers
- HUD readouts via `getPlayer` / `getTarget`
- Styling chat rows or panels you attach yourself
- Translation helpers via `SpeakiRPG.translate`

**Fragile (test after every game patch)**

- Anything that patches minified bundle code
- `gameState` combat / movement automation
- Hardcoded class names not listed in `SpeakiRPG.selectors`

## Sharing your mod

- Document required Settings (especially gameState capture).
- State the client version you tested against (`SpeakiRPG.version`).
- Prefer MIT/GPL-compatible licensing if you publish on GitHub.
- Link users to [mods.md](mods.md) for the API and to this file for installation.

## See also

- [mods.md](mods.md) — full API, events, selectors, examples
- [README.md](../README.md) — install, shortcuts, config paths
- Bundled samples in `src-tauri/mods/` in the repository (`example-highlight.js`, `example-emotes.js`)
