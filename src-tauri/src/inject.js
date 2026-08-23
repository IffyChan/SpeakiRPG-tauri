(() => {
  if (window.__SPEAKI_RPG_INJECTED__) return;
  window.__SPEAKI_RPG_INJECTED__ = true;

  const SETTINGS = window.__SPEAKI_SETTINGS__ || {};
  let translationEnabled = SETTINGS.translateEnabled !== false;

  // __TAURI__ may not exist yet when the init script first runs
  function onTauriReady(callback) {
    if (window.__TAURI__) callback();
    else setTimeout(() => onTauriReady(callback), 50);
  }

  // selectors from Electron capturePageStats()
  function readStats() {
    const nameEl = document.querySelector('.sr-player-card__name');
    const levelEl = document.querySelector(
      '.sr-player-card__portrait-wrap .sr-player-card__lv-badge'
    );
    const expEl = document.querySelector('.sr-player-card__exp-track');
    const locationEl = document.querySelector('.sr-minimap-frame__caption');
    return {
      playerName: nameEl ? nameEl.innerText.trim() : null,
      level: levelEl ? levelEl.innerText.trim() : null,
      exp: expEl ? (expEl.getAttribute('title') || expEl.innerText.trim()) : null,
      location: locationEl ? locationEl.innerText.trim() : null,
    };
  }

  function hasStats(stats) {
    return !!(stats.playerName || stats.level || stats.exp || stats.location);
  }

  function pushStats(manual) {
    const stats = readStats();
    if (!hasStats(stats)) return;
    window.__TAURI__.core
      .invoke('update_stats', { stats, manual: !!manual })
      .catch((err) => console.error('[SpeakiRPG] update_stats failed:', err));
  }

  // hangul syllables + jamo blocks
  const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
  // game chat DOM: .sr-chatbox__log > .sr-chatbox__row[data-player-name] > .sr-chatbox__body-text
  const CHAT_LOG_SELECTOR = '.sr-chatbox__log';
  const MAX_TEXT_LENGTH = 450; // gtx uses GET; long strings won't fit the URL

  function injectTranslationStyles() {
    if (document.getElementById('sr-translate-style')) return;
    const style = document.createElement('style');
    style.id = 'sr-translate-style';
    style.textContent = [
      '.sr-translate {',
      '  opacity: 0.72;',
      '  font-style: italic;',
      '  color: #8fa3bf;',
      '  margin-left: 4px;',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  // one in flight, 150ms gap so a busy chat doesn't hammer gtx
  let translationQueue = Promise.resolve();
  let lastTranslationAt = 0;

  function translateText(text) {
    translationQueue = translationQueue.then(async () => {
      const wait = Math.max(0, 150 - (Date.now() - lastTranslationAt));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastTranslationAt = Date.now();
      try {
        return await window.__TAURI__.core.invoke('translate_text', { text });
      } catch (err) {
        console.error('[SpeakiRPG] translate_text failed:', err);
        return null;
      }
    });
    return translationQueue;
  }

  function appendTranslation(row, anchor, translated) {
    const span = document.createElement('span');
    span.className = 'sr-chatbox__body-text sr-translate';
    span.textContent = `〔${translated}〕`;
    if (anchor === row) {
      // system rows put text on the row itself, not in .sr-chatbox__body-text
      row.appendChild(span);
    } else {
      anchor.after(span);
    }
  }

  function decorateRow(row) {
    if (!translationEnabled || row.dataset.srTranslated) return;
    row.dataset.srTranslated = '1';

    let text = '';
    let anchor = null;
    if (row.classList.contains('sr-chatbox__system-text')) {
      text = row.textContent.trim();
      anchor = row;
    } else {
      const body = row.querySelector('.sr-chatbox__body-text');
      if (!body) return;
      text = body.textContent.trim();
      anchor = body;
    }

    if (!text || text.length > MAX_TEXT_LENGTH || !HANGUL.test(text)) return;

    translateText(text).then((translated) => {
      if (translated) appendTranslation(row, anchor, translated);
    });
  }

  function observeChat() {
    const log = document.querySelector(CHAT_LOG_SELECTOR);
    if (log && !log.__srObserved) {
      log.__srObserved = true;
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.classList && node.classList.contains('sr-chatbox__row')) {
              decorateRow(node);
            }
          }
        }
      }).observe(log, { childList: true });
    }
    // chat mounts after login and can be recreated
    setTimeout(observeChat, 2000);
  }

  onTauriReady(() => {
    window.__TAURI__.event.listen('refresh-stats', () => pushStats(true));

    // Electron intervals: 30s after load, then every 5 minutes
    setTimeout(() => {
      pushStats(false);
      setInterval(() => pushStats(false), 5 * 60 * 1000);
    }, 30 * 1000);

    injectTranslationStyles();
    window.__TAURI__.event.listen('toggle-translation', () => {
      translationEnabled = !translationEnabled;
      console.log('[SpeakiRPG] translation ' + (translationEnabled ? 'ON' : 'OFF'));
    });
    observeChat();
  });
})();
