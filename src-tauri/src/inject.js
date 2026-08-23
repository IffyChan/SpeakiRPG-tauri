(() => {
  if (window.__SPEAKI_RPG_INJECTED__) return;
  window.__SPEAKI_RPG_INJECTED__ = true;

  let settings = {
    translateTarget: 'en',
    translateEnabled: false,
    translateOwn: false,
    ...(window.__SPEAKI_SETTINGS__ || {}),
  };

  // __TAURI__ may not exist yet when the init script first runs
  function onTauriReady(callback) {
    if (window.__TAURI__) callback();
    else setTimeout(() => onTauriReady(callback), 50);
  }

  const listeners = { chat: [], stats: [], settings: [], player: [], target: [], dialog: [] };

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

  window.SpeakiRPG = {
    version: '1.0.4',
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

  function readPlayer() {
    const stats = readStats();
    if (!document.querySelector(SELECTORS.playerCard)) return null;
    const expTrack = document.querySelector(SELECTORS.playerExp);
    return {
      ...stats,
      expPercent: readPercentFromWidth(expTrack?.querySelector('.sr-player-card__exp-fill')),
      needsRevive: isVisible(document.querySelector(SELECTORS.playerRevive)),
    };
  }

  function readTarget() {
    const frame = document.querySelector(SELECTORS.targetFrame);
    if (!frame) return null;
    const name = readText(frame.querySelector(SELECTORS.targetName));
    return {
      name: name || null,
      hasTarget: !!name,
      isBoss: !!frame.querySelector(SELECTORS.targetBossBadge),
      isBurning: !!frame.querySelector(SELECTORS.targetBurnBadge),
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

  function observeDom(rootSelector, eventName, readFn) {
    const attach = (root) => {
      if (root.__srObserved === eventName) return;
      root.__srObserved = eventName;
      let last = '';
      const push = () => {
        const data = readFn(root);
        const key = JSON.stringify(data);
        if (key === last) return;
        last = key;
        emitTo(eventName, data, root);
      };
      push();
      new MutationObserver(push).observe(root, {
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
        if (translated) translationMemory.set(cacheKey, translated);
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
      emitTo(
        'chat',
        {
          text,
          sender: row.dataset.playerName ?? null,
          playerId: row.dataset.playerId ?? null,
          senderLabel: senderEl ? readText(senderEl) || null : null,
          isMine,
          isSystem,
        },
        row
      );
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
      if (!translated || translated === text) {
        delete row.dataset.srTranslatePending;
        return;
      }
      if (row.querySelector('.sr-translate-original')) return;
      applyTranslation(row, isSystem ? row : body, text, translated);
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

  onTauriReady(() => {
    window.__TAURI__.event.listen('refresh-stats', () => pushStats(true));

    window.__TAURI__.event.listen('settings-changed', (event) => {
      settings = { ...settings, ...event.payload };
      emitTo('settings', { ...settings });
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