(() => {
  if (window.__SPEAKI_RPG_INJECTED__) {
    if (window.__SPEAKI_SETTINGS__) {
      window.__SPEAKI_CORE__?.syncSettings?.(window.__SPEAKI_SETTINGS__);
    }
    window.__SPEAKI_CORE__?.onPageLoad?.();
    return;
  }
  window.__SPEAKI_RPG_INJECTED__ = true;

  let settings = {
    translateTarget: 'en',
    translateEnabled: false,
    translateOwn: false,
    captureGameState: false,
    modSettings: {},
    ...(window.__SPEAKI_SETTINGS__ || {}),
  };

  function syncSettingsFromPayload(payload) {
    settings = { ...settings, ...payload };
    window.__SPEAKI_SETTINGS__ = { ...settings };
    window.__SPEAKI_DISABLED_MODS = new Set(settings.disabledMods || []);
    try {
      sessionStorage.setItem('__SPEAKI_SETTINGS__', JSON.stringify(window.__SPEAKI_SETTINGS__));
    } catch (_) {}
  }

  // __TAURI__ may not exist yet when the init script first runs
  function onTauriReady(callback) {
    if (window.__TAURI__) callback();
    else setTimeout(() => onTauriReady(callback), 50);
  }

  const listeners = {
    chat: [],
    stats: [],
    settings: [],
    player: [],
    target: [],
    dialog: [],
    emote: [],
    gameStateReady: [],
    modAction: [],
  };

  const SELECTORS = Object.freeze({
    chatLog: '.sr-chatbox__log',
    chatRow: '.sr-chatbox__row',
    chatBody: '.sr-chatbox__body-text',
    chatSender: '.sr-chatbox__sender',
    chatSenderMine: '.sr-chatbox__sender--mine',
    chatSystemRow: '.sr-chatbox__system-text',
    playerCard: '.sr-player-card',
    playerName: '.sr-player-card__name',
    playerLevel: '.sr-player-card__portrait-wrap .sr-player-card__lv-badge',
    playerExp: '.sr-player-card__exp-track',
    playerRevive: '.sr-player-card__revive-pill',
    playerHp: '.sr-hp-gauge__value',
    minimapFrame: '.sr-minimap-frame',
    minimapCaption: '.sr-minimap-frame__caption',
    targetFrame: '.sr-target-frame',
    targetName: '.sr-target-frame__name',
    targetBossBadge: '.sr-target-frame__boss-badge',
    targetBurnBadge: '.sr-target-frame__burn-badge',
    targetHpValue: '.sr-target-frame__hp-value',
    targetHpFill: '.sr-target-frame__hp-fill',
    npcDialog: '.sr-npc-dialog',
    npcName: '.sr-npc-dialog__name-tag',
    npcText: '.sr-npc-dialog__text',
    skillBar: '.sr-skill-hotbar',
    skillSlot: '.sr-skill-slot',
    emoteSlot: '.sr-emote-slot',
    potionPopover: '.sr-potion-popover',
    castBar: '.sr-cast-bar',
    gameCanvas: '.sr-game-canvas',
  });

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function readText(el) {
    return el ? el.innerText.trim() : '';
  }

  function readPercentFromWidth(el) {
    if (!el?.style?.width) return null;
    const value = parseFloat(el.style.width);
    return Number.isFinite(value) ? value : null;
  }

  function emitTo(event, payload, ...extra) {
    for (const cb of listeners[event].slice()) {
      try {
        cb(payload, ...extra);
      } catch (err) {
        // a broken mod must not break translation or other mods
        console.error('[SpeakiRPG] mod listener failed:', err);
      }
    }
  }

  const gameStateBridge =
    typeof window.__speakiInstallGameStateCapture === 'function'
      ? window.__speakiInstallGameStateCapture(emitTo, () => settings)
      : null;

  if (gameStateBridge) {
    gameStateBridge.syncCaptureEnabled();
  }

  window.SpeakiRPG = {
    version: '1.0.5',
    selectors: SELECTORS,
    get settings() {
      return { ...settings };
    },
    getStats() {
      return { ...readStats() };
    },
    getPlayer() {
      const player = readPlayer();
      return player ? { ...player } : null;
    },
    getTarget() {
      const target = readTarget();
      return target ? { ...target } : null;
    },
    getDialog() {
      return { ...readDialog() };
    },
    clickEmoteSlot() {
      const slot = document.querySelector(SELECTORS.emoteSlot);
      if (!slot) return false;
      slot.click();
      return true;
    },
    query(selector) {
      return document.querySelector(selector);
    },
    queryAll(selector) {
      return [...document.querySelectorAll(selector)];
    },
    on(event, cb) {
      if (!listeners[event]) return () => {};
      listeners[event].push(cb);
      let alive = true;
      return () => {
        if (!alive) return;
        alive = false;
        const i = listeners[event].indexOf(cb);
        if (i >= 0) listeners[event].splice(i, 1);
      };
    },
    translate(text) {
      return window.__TAURI__.core.invoke('translate_text', { text });
    },
    getGameState() {
      return window.gameState ?? null;
    },
    isGameStateReady() {
      return gameStateBridge ? gameStateBridge.isGameStateReady() : false;
    },
    get gameStateStatus() {
      return gameStateBridge ? gameStateBridge.getCaptureStatus() : 'disabled';
    },
    get gameStateCaptureFailReason() {
      return gameStateBridge ? gameStateBridge.getCaptureFailReason() : null;
    },
    whenGameState(cb) {
      if (gameStateBridge) gameStateBridge.whenGameState(cb);
    },
    bootGameStateMod(name, init) {
      if (!gameStateBridge) {
        console.error(`[${name}] gameState capture not available`);
        return;
      }
      if (!settings.captureGameState) {
        console.warn(`[${name}] enable gameState capture in Settings, then F5`);
        return;
      }
      gameStateBridge.whenGameState((gs) => {
        const run = () => {
          try {
            init(gs);
          } catch (err) {
            console.error(`[${name}] init failed:`, err);
          }
        };
        if (document.body) run();
        else {
          const poll = () => {
            if (document.body) run();
            else setTimeout(poll, 50);
          };
          poll();
        }
      });
    },
    listMonsterNames() {
      return gameStateBridge ? gameStateBridge.listMonsterNames() : [];
    },
    getModSettings(modId) {
      const bag = settings.modSettings || {};
      return modId ? { ...(bag[modId] || {}) } : { ...bag };
    },
    getI18n() {
      return typeof window.i18n === 'function' ? window.i18n : null;
    },
    getQuestManager() {
      return window.questManager ?? null;
    },
  };

  // selectors from Electron capturePageStats()
  function readStats() {
    const nameEl = document.querySelector(SELECTORS.playerName);
    const levelEl = document.querySelector(SELECTORS.playerLevel);
    const expEl = document.querySelector(SELECTORS.playerExp);
    const locationEl = document.querySelector(SELECTORS.minimapCaption);
    return {
      playerName: nameEl ? readText(nameEl) || null : null,
      level: levelEl ? readText(levelEl) || null : null,
      exp: expEl ? (expEl.getAttribute('title') || readText(expEl) || null) : null,
      location: locationEl ? readText(locationEl) || null : null,
    };
  }

  function readHpGauge() {
    const text = readText(document.querySelector(SELECTORS.playerHp));
    const match = text.match(/^(\d+)\s*\/\s*(\d+)/);
    if (!match) {
      return { hpText: text || null, hpCurrent: null, hpMax: null };
    }
    return {
      hpText: text,
      hpCurrent: Number.parseInt(match[1], 10),
      hpMax: Number.parseInt(match[2], 10),
    };
  }

  function badgeActive(frame, selector) {
    const badge = frame.querySelector(selector);
    return isVisible(badge);
  }

  function readPlayer() {
    const stats = readStats();
    if (!document.querySelector(SELECTORS.playerCard)) return null;
    const expTrack = document.querySelector(SELECTORS.playerExp);
    const hp = readHpGauge();
    const reviveEl = document.querySelector(SELECTORS.playerRevive);
    const needsRevive =
      hp.hpCurrent === 0 || (hp.hpCurrent === null && isVisible(reviveEl));
    return {
      ...stats,
      ...hp,
      expPercent: readPercentFromWidth(expTrack?.querySelector('.sr-player-card__exp-fill')),
      needsRevive,
    };
  }

  function readTarget() {
    const frame = document.querySelector(SELECTORS.targetFrame);
    if (!frame) return null;
    const name = readText(frame.querySelector(SELECTORS.targetName));
    return {
      name: name || null,
      hasTarget: !!name,
      isBoss: badgeActive(frame, SELECTORS.targetBossBadge),
      isBurning: badgeActive(frame, SELECTORS.targetBurnBadge),
      hpText: readText(frame.querySelector(SELECTORS.targetHpValue)) || null,
      hpPercent: readPercentFromWidth(frame.querySelector(SELECTORS.targetHpFill)),
    };
  }

  function readDialog() {
    const dialog = document.querySelector(SELECTORS.npcDialog);
    if (!dialog || !isVisible(dialog)) {
      return { open: false, npcName: null, text: null };
    }
    return {
      open: true,
      npcName: readText(dialog.querySelector(SELECTORS.npcName)) || null,
      text: readText(dialog.querySelector(SELECTORS.npcText)) || null,
    };
  }

  const EMOJI_ONLY = /^[\p{Extended_Pictographic}\s]+$/u;
  const EMOTE_HINT =
    /\b(emote|emotes|wave|waves|dance|dances|bow|bows|cheer|cheers)\b/i;

  function isEmoteChat(text, isSystem) {
    if (!text) return false;
    const stripped = text.replace(/\[[^\]]+\]/g, '').trim();
    if (stripped && EMOJI_ONLY.test(stripped)) return true;
    if (isSystem && EMOTE_HINT.test(text)) return true;
    return false;
  }

  function observeDom(rootSelector, eventName, readFn) {
    const attach = (root) => {
      if (root.__srObserved === eventName) return;
      root.__srObserved = eventName;
      let last = '';
      let flushQueued = false;
      const push = () => {
        flushQueued = false;
        const data = readFn(root);
        const key = JSON.stringify(data);
        if (key === last) return;
        last = key;
        emitTo(eventName, data, root);
      };
      const queuePush = () => {
        // combat mutates the card every tick; skip the read+stringify entirely
        // while nothing listens, and coalesce bursts to one read per frame
        if (!listeners[eventName].length || flushQueued) return;
        flushQueued = true;
        // rAF stalls while hidden, fall back to a slow timer
        if (document.hidden) setTimeout(push, 500);
        else requestAnimationFrame(push);
      };
      push();
      new MutationObserver(queuePush).observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'style', 'class'],
      });
    };

    const poll = () => {
      const root = document.querySelector(rootSelector);
      if (root) attach(root);
      setTimeout(poll, 2000);
    };
    poll();
  }

  function hasStats(stats) {
    return !!(stats.playerName || stats.level || stats.exp || stats.location);
  }

  function pushStats(manual) {
    const stats = readStats();
    if (!hasStats(stats)) return;
    emitTo('stats', stats);
    window.__TAURI__.core
      .invoke('update_stats', { stats, manual: !!manual })
      .catch((err) => console.error('[SpeakiRPG] update_stats failed:', err));
  }

  const KOREAN = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
  const JAPANESE = /[\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]/;
  const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
  const CYRILLIC = /[\u0400-\u04FF]/;
  const LATIN = /[A-Za-z\u00C0-\u024F]/;
  const CHAT_LOG_SELECTOR = SELECTORS.chatLog;
  const MAX_TEXT_LENGTH = 500; // MyMemory free tier per request

  function shouldTranslate(text, isMine) {
    if (text.length > MAX_TEXT_LENGTH) return false;
    if (!/\p{L}/u.test(text)) return false;

    const hasEastAsian = KOREAN.test(text) || JAPANESE.test(text) || CJK.test(text);
    if (hasEastAsian) return true;

    const target = settings.translateTarget;
    const hasLatin = LATIN.test(text);
    const hasCyrillic = CYRILLIC.test(text);

    // own Latin lines (e.g. English) when the user opted in
    if (isMine && settings.translateOwn && hasLatin && target !== 'en') return true;

    // occasional English from others when target is Cyrillic
    if (!isMine && hasLatin && !hasCyrillic && target === 'ru') return true;

    // Cyrillic from others when target is not Russian/Ukrainian
    if (!isMine && hasCyrillic && target !== 'ru' && target !== 'uk') return true;

    return false;
  }

  // init script runs before <html>; head and documentElement can both be null
  function onDomReady(callback) {
    const run = () => {
      if (!document.documentElement) return false;
      callback();
      return true;
    };
    if (run()) return;
    document.addEventListener('DOMContentLoaded', () => run(), { once: true });
    window.addEventListener('load', () => run(), { once: true });
    const poll = () => {
      if (!run()) requestAnimationFrame(poll);
    };
    poll();
  }

  function injectStyles() {
    if (document.getElementById('sr-style')) return;
    const mount = document.head || document.documentElement;
    if (!mount) return;
    const style = document.createElement('style');
    style.id = 'sr-style';
    // 2147483647: game overlays sat above z-index 9999
    style.textContent = `
      .sr-translate-original { color: rgba(255, 255, 255, 0.78); font-size: 0.92em; }
      #sr-settings-btn {
        position: fixed; right: 10px; bottom: 10px;
        width: 28px; height: 28px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid rgba(255,255,255,0.25); border-radius: 6px;
        background: rgba(20,24,32,0.6); color: rgba(255,255,255,0.75);
        opacity: 0.35; cursor: pointer; z-index: 2147483647;
      }
      #sr-settings-btn:hover { opacity: 1; }
    `;
    mount.appendChild(style);
  }

  // one in flight; gap avoids hammering the free API during chat bursts
  let translationQueue = Promise.resolve();
  let lastTranslationAt = 0;
  let translateBackoffUntil = 0;
  const TRANSLATE_GAP_MS = 400;
  const translationMemory = new Map();

  function translateText(text) {
    const cacheKey = `${settings.translateTarget}::${text}`;
    if (translationMemory.has(cacheKey)) {
      return Promise.resolve(translationMemory.get(cacheKey));
    }

    translationQueue = translationQueue.then(async () => {
      const now = Date.now();
      const backoffWait = Math.max(0, translateBackoffUntil - now);
      const gapWait = Math.max(0, TRANSLATE_GAP_MS - (now - lastTranslationAt));
      const wait = Math.max(backoffWait, gapWait);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

      if (translationMemory.has(cacheKey)) {
        return translationMemory.get(cacheKey);
      }

      lastTranslationAt = Date.now();
      try {
        const translated = await window.__TAURI__.core.invoke('translate_text', { text });
        if (translated) {
          translationMemory.set(cacheKey, translated);
          // bound memory on long sessions; Map keeps insertion order
          if (translationMemory.size > 2000) {
            const drop = translationMemory.size - 2000;
            let dropped = 0;
            for (const key of translationMemory.keys()) {
              if (dropped++ >= drop) break;
              translationMemory.delete(key);
            }
          }
        }
        return translated;
      } catch (err) {
        const message = String(err);
        if (message.includes('429')) {
          translateBackoffUntil = Date.now() + 60_000;
        }
        console.error('[SpeakiRPG] translate_text failed:', err);
        return null;
      }
    });
    return translationQueue;
  }

  function applyTranslation(row, anchor, original, translated) {
    const orig = document.createElement('span');
    orig.className = 'sr-translate-original';
    orig.textContent = ` (${original})`;
    if (anchor === row) {
      // system rows put text on the row itself
      row.textContent = translated;
      row.appendChild(orig);
    } else {
      anchor.textContent = translated;
      anchor.after(orig);
    }
  }

  function processRow(row) {
    if (!row.classList.contains('sr-chatbox__row')) return;
    if (row.querySelector('.sr-translate-original')) return;

    const isSystem = row.classList.contains('sr-chatbox__system-text');
    const body = isSystem ? null : row.querySelector('.sr-chatbox__body-text');
    const text = (isSystem ? row.textContent : body ? body.textContent : '').trim();
    if (!text) return;

    const isMine = !isSystem && !!row.querySelector(SELECTORS.chatSenderMine);
    if (!row.dataset.srSeen) {
      row.dataset.srSeen = '1';
      const senderEl = row.querySelector(SELECTORS.chatSender);
      const message = {
        text,
        sender: row.dataset.playerName ?? null,
        playerId: row.dataset.playerId ?? null,
        senderLabel: senderEl ? readText(senderEl) || null : null,
        isMine,
        isSystem,
        isEmote: isEmoteChat(text, isSystem),
      };
      emitTo('chat', message, row);
      if (message.isEmote) emitTo('emote', message, row);
    }

    if (!settings.translateEnabled) return;
    if (!shouldTranslate(text, isMine)) return;
    if (row.dataset.srTranslatePending) return;

    const cacheKey = `${settings.translateTarget}::${text}`;
    if (translationMemory.has(cacheKey)) {
      const cached = translationMemory.get(cacheKey);
      if (cached && cached !== text) {
        applyTranslation(row, isSystem ? row : body, text, cached);
      }
      return;
    }

    row.dataset.srTranslatePending = '1';
    translateText(text).then((translated) => {
      try {
        if (!translated || translated === text) return;
        if (row.querySelector('.sr-translate-original')) return;
        applyTranslation(row, isSystem ? row : body, text, translated);
      } finally {
        delete row.dataset.srTranslatePending;
      }
    });
  }

  function rescanChatForTranslation(log) {
    for (const row of log.querySelectorAll('.sr-chatbox__row')) {
      if (row.querySelector('.sr-translate-original')) continue;
      delete row.dataset.srTranslatePending;
      processRow(row);
    }
  }

  function scanChatLog(log) {
    for (const row of log.querySelectorAll('.sr-chatbox__row')) {
      processRow(row);
    }
  }

  function observeChat() {
    const log = document.querySelector(CHAT_LOG_SELECTOR);
    if (log && !log.__srObserved) {
      log.__srObserved = true;
      scanChatLog(log);
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.classList && node.classList.contains('sr-chatbox__row')) {
              processRow(node);
            }
          }
        }
      }).observe(log, { childList: true });
    }
    // chat mounts after login; only watch for a new log element
    setTimeout(observeChat, 2000);
  }

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';

  function mountSettingsButton(root) {
    const btn = document.createElement('button');
    btn.id = 'sr-settings-btn';
    btn.type = 'button';
    btn.title = 'SpeakiRPG settings (Ctrl+Shift+S)';
    btn.innerHTML = GEAR_SVG;
    btn.addEventListener('click', () => {
      if (!window.__TAURI__) return;
      window.__TAURI__.core
        .invoke('open_settings')
        .catch((err) => console.error('[SpeakiRPG] open_settings failed:', err));
    });
    root.appendChild(btn);
  }

  // body preferred for fixed UI; SPA re-renders can drop the button
  function ensureSettingsButton() {
    if (document.getElementById('sr-settings-btn')) return;
    const root = document.body;
    if (!root) return;
    mountSettingsButton(root);
  }

  // remount gear on the same 2s poll as observeChat if the DOM was wiped
  function ensureUi() {
    ensureSettingsButton();
    setTimeout(ensureUi, 2000);
  }

  const GAME_URL = 'https://speakirpg.overture.io.kr/';

  function isGamePage() {
    return window.location.hostname === 'speakirpg.overture.io.kr';
  }

  function setBootStatus(text) {
    const el = document.getElementById('boot-status');
    if (el) el.textContent = text;
  }

  function waitGameStateProxyReady() {
    if (!window.__SPEAKI_NATIVE_GAMESTATE_PROXY) return Promise.resolve();
    if (window.__SPEAKI_GAMESTATE_PROXY_READY) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      (function tick() {
        if (window.__SPEAKI_GAMESTATE_PROXY_READY || Date.now() > deadline) {
          if (!window.__SPEAKI_GAMESTATE_PROXY_READY) {
            console.warn('[SpeakiRPG] gameState proxy hook not ready before game open');
          }
          resolve();
          return;
        }
        setTimeout(tick, 25);
      })();
    });
  }

  function loadUserMods() {
    if (!window.__TAURI__) return Promise.resolve();
    return window.__TAURI__.core
      .invoke('get_user_mod_scripts')
      .then((code) => {
        const src = String(code || '').trim();
        if (!src) {
          console.log('[SpeakiRPG] no user mods in config dir');
          return;
        }
        console.log('[SpeakiRPG] running user mods from config dir');
        // eslint-disable-next-line no-new-func
        new Function(src)();
      })
      .catch((err) => {
        console.error('[SpeakiRPG] user mods failed:', err);
      });
  }

  function clearGameStorageKeepSpeakiSettings() {
    const speaki = sessionStorage.getItem('__SPEAKI_SETTINGS__');
    try {
      localStorage.clear();
    } catch (_) {}
    try {
      sessionStorage.clear();
      if (speaki) sessionStorage.setItem('__SPEAKI_SETTINGS__', speaki);
    } catch (_) {}
    if (typeof indexedDB?.databases === 'function') {
      return indexedDB.databases().then((dbs) =>
        Promise.all(
          (dbs || []).map((db) => (db?.name ? indexedDB.deleteDatabase(db.name) : Promise.resolve())),
        ),
      );
    }
    return Promise.resolve();
  }

  function accountSwitchUrlFlag() {
    try {
      return new URLSearchParams(window.location.search).has('speaki_logout');
    } catch {
      return false;
    }
  }

  function stripAccountSwitchUrl() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('speaki_logout')) return;
      url.searchParams.delete('speaki_logout');
      const next = url.pathname + (url.search || '') + url.hash;
      window.history.replaceState(null, '', next || '/');
    } catch {
      /* optional */
    }
  }

  function maybeFinishAccountSwitch() {
    if (!window.__TAURI__ || !isGamePage()) return Promise.resolve(false);
    const urlFlag = accountSwitchUrlFlag();
    console.log('[SpeakiRPG] account switch: checking pending/url flag', { urlFlag });
    return window.__TAURI__.core
      .invoke('take_account_switch_pending')
      .then((pending) => {
        if (!pending && !urlFlag) return false;
        console.log('[SpeakiRPG] account switch: clearing game storage', { pending, urlFlag });
        stripAccountSwitchUrl();
        return clearGameStorageKeepSpeakiSettings().then(() => {
          console.log('[SpeakiRPG] account switch: reloading clean game URL');
          window.location.replace(GAME_URL);
          return true;
        });
      })
      .catch((err) => {
        console.error('[SpeakiRPG] account switch failed:', err);
        return false;
      });
  }

  function maybeReloadForMissedPatch() {
    if (!isGamePage() || !settings.captureGameState) return;
    setTimeout(() => {
      const status = SpeakiRPG?.gameStateStatus;
      const st = window.__speakiGsCaptureState;
      if (status !== 'pending' || st?.scriptHookPatchSeen || st?.nativePatchSeen) return;
      try {
        if (sessionStorage.getItem('__speaki_gs_reload')) return;
        sessionStorage.setItem('__speaki_gs_reload', '1');
      } catch {
        return;
      }
      console.warn('[SpeakiRPG] gameState patch missed, reloading once');
      window.location.reload();
    }, 5000);
  }

  function openGamePage() {
    if (isGamePage()) return;
    console.log('[SpeakiRPG] opening game');
    window.location.replace(GAME_URL);
  }

  function onPageLoad() {
    if (gameStateBridge) gameStateBridge.syncCaptureEnabled();

    onTauriReady(() => {
      if (!isGamePage()) setBootStatus('Loading mods…');

      maybeFinishAccountSwitch()
        .then((switched) => {
          if (switched) return;
          return loadUserMods()
            .then(() => waitGameStateProxyReady())
            .then(() => {
              if (!isGamePage()) {
                setBootStatus('Opening game…');
                openGamePage();
              }
            });
        });
    });

    if (!isGamePage()) {
      setTimeout(() => {
        if (!isGamePage()) {
          console.warn('[SpeakiRPG] boot timeout, opening game anyway');
          waitGameStateProxyReady().then(openGamePage);
        }
      }, 15000);
    } else {
      maybeReloadForMissedPatch();
    }
  }

  window.__SPEAKI_CORE__ = {
    syncSettings(payload) {
      syncSettingsFromPayload(payload);
    },
    onPageLoad,
  };

  onPageLoad();

  onTauriReady(() => {
    window.__TAURI__.event.listen('refresh-stats', () => pushStats(true));

    window.__TAURI__.event.listen('gamestate-index-patched', () => {
      window.__speakiGsOnNativePatch?.();
    });

    window.__TAURI__.event.listen('mod-action', (event) => {
      const payload = event.payload || {};
      emitTo('modAction', payload);
    });

    window.__TAURI__.event.listen('settings-changed', (event) => {
      syncSettingsFromPayload(event.payload);
      emitTo('settings', { ...settings });
      if (gameStateBridge) gameStateBridge.syncCaptureEnabled();
      const log = document.querySelector(CHAT_LOG_SELECTOR);
      if (log) rescanChatForTranslation(log);
    });

    // Electron intervals: 30s after load, then every 5 minutes
    setTimeout(() => {
      pushStats(false);
      setInterval(() => pushStats(false), 5 * 60 * 1000);
    }, 30 * 1000);

    observeChat();
    observeDom(SELECTORS.playerCard, 'player', () => readPlayer());
    observeDom(SELECTORS.targetFrame, 'target', () => readTarget());
    observeDom(SELECTORS.npcDialog, 'dialog', () => readDialog());
  });

  // gear/styles don't need __TAURI__; IPC listeners wait for it in onTauriReady
  onDomReady(() => {
    injectStyles();
    ensureUi();
  });
})();