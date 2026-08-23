(() => {
  if (window.__SPEAKI_RPG_INJECTED__) return;
  window.__SPEAKI_RPG_INJECTED__ = true;

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

  onTauriReady(() => {
    // Ctrl+Shift+D handled in Rust; manual=true skips throttle in update_stats
    window.__TAURI__.event.listen('refresh-stats', () => pushStats(true));

    // Electron intervals: 30s after load, then every 5 minutes
    setTimeout(() => {
      pushStats(false);
      setInterval(() => pushStats(false), 5 * 60 * 1000);
    }, 30 * 1000);
  });
})();
