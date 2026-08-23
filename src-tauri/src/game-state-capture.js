// Patches the game's main ES module so window.gameState is set at socket connect.
// Loaded before inject.js; exposes __speakiInstallGameStateCapture(emitTo, getSettings).
(() => {
  if (window.__SPEAKI_GAMESTATE_CAPTURE__) return;
  window.__SPEAKI_GAMESTATE_CAPTURE__ = true;

  const INDEX_RE = /\/assets\/index-[\w-]+\.js(?:\?|$)/;
  const ANCHORS = ['targetMonsterId', 'combatAssist', 'sendEmoteNow', 'tryUsePotion'];

  let captureStatus = 'disabled';
  let captureFailReason = null;
  let whenGameStateQueue = [];
  let readyEmitted = false;
  let pollTimer = null;

  function setCaptureStatus(status, reason) {
    captureStatus = status;
    captureFailReason = reason ?? null;
  }

  function isGameStateReady() {
    const gs = window.gameState;
    return !!(gs && gs.monsters);
  }

  function patchIndexBundle(source) {
    const anchorHits = ANCHORS.filter((a) => source.includes(a));
    if (anchorHits.length < 2) {
      return { ok: false, reason: `anchors found: ${anchorHits.length}/2` };
    }

    // bootstrap connect beside autoAttackEnabled guard (SpeakiMod breakpoint site)
    const primaryRe =
      /(\}\);)([\w$]+)\.connect\(([\w$]+)\),(sn\(\(\)=>\{an\(\)\.autoAttackEnabled\|\|)/;
    const primary = source.match(primaryRe);
    if (primary) {
      const recv = primary[2];
      const arg = primary[3];
      const code = source.replace(
        primaryRe,
        `$1(window.gameState=${recv},${recv}.connect(${arg})),$4`,
      );
      if (code.includes('window.gameState=')) {
        return { ok: true, code };
      }
    }

    // fallback: first short-var connect after combatAssist, skip socket.connect
    const combatPos = source.indexOf('combatAssist');
    if (combatPos >= 0) {
      const tail = source.slice(combatPos);
      const fallbackRe = /([\w$]+)\.connect\(([\w$]+)\)/g;
      let match;
      while ((match = fallbackRe.exec(tail))) {
        if (match[1] === 'socket' || match[1] === 'WebSocket') continue;
        const recv = match[1];
        const arg = match[2];
        const original = match[0];
        const abs = combatPos + match.index;
        const patched = `(window.gameState=${recv},${original})`;
        const code =
          source.slice(0, abs) + patched + source.slice(abs + original.length);
        if (code.includes('window.gameState=')) {
          return { ok: true, code };
        }
      }
    }

    return { ok: false, reason: 'connect() patch site not found' };
  }

  function flushWhenGameStateQueue(emitTo) {
    if (!isGameStateReady()) return;
    const gs = window.gameState;
    while (whenGameStateQueue.length) {
      const cb = whenGameStateQueue.shift();
      try {
        cb(gs);
      } catch (err) {
        console.error('[SpeakiRPG] whenGameState callback failed:', err);
      }
    }
  }

  function markReady(emitTo) {
    if (!isGameStateReady() || readyEmitted) return;
    readyEmitted = true;
    setCaptureStatus('ready');
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const gs = window.gameState;
    emitTo('gameStateReady', gs);
    flushWhenGameStateQueue(emitTo);
  }

  function startReadyPoll(emitTo) {
    if (pollTimer) return;
    let attempts = 0;
    const maxAttempts = 300; // 60s at 200ms
    pollTimer = setInterval(() => {
      attempts += 1;
      if (isGameStateReady()) {
        markReady(emitTo);
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (captureStatus === 'patched') {
          setCaptureStatus('patch_failed', 'gameState not set after load');
          console.error('[SpeakiRPG] gameState capture timed out');
        }
      }
    }, 200);
  }

  function installFetchHook(getSettings, emitTo) {
    if (window.__SPEAKI_FETCH_HOOKED__) return;
    window.__SPEAKI_FETCH_HOOKED__ = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : '';
      const res = await origFetch(input, init);

      if (!getSettings().captureGameState || !INDEX_RE.test(url)) {
        return res;
      }

      try {
        const text = await res.clone().text();
        const patched = patchIndexBundle(text);
        if (!patched.ok) {
          setCaptureStatus('patch_failed', patched.reason);
          console.error('[SpeakiRPG] gameState patch failed:', patched.reason);
          return res;
        }
        setCaptureStatus('patched');
        startReadyPoll(emitTo);
        return new Response(patched.code, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      } catch (err) {
        setCaptureStatus('patch_failed', String(err));
        console.error('[SpeakiRPG] gameState patch error:', err);
        return res;
      }
    };
  }

  function syncCaptureEnabled(getSettings, emitTo) {
    const enabled = !!getSettings().captureGameState;
    if (!enabled) {
      setCaptureStatus('disabled');
      return;
    }
    if (isGameStateReady()) {
      markReady(emitTo);
      return;
    }
    if (captureStatus === 'disabled' || captureStatus === 'patch_failed') {
      setCaptureStatus('pending');
    }
    installFetchHook(getSettings, emitTo);
    startReadyPoll(emitTo);
  }

  window.__speakiInstallGameStateCapture = (emitTo, getSettings) => ({
    getCaptureStatus: () => captureStatus,
    getCaptureFailReason: () => captureFailReason,
    isGameStateReady,
    whenGameState(cb) {
      if (isGameStateReady()) {
        try {
          cb(window.gameState);
        } catch (err) {
          console.error('[SpeakiRPG] whenGameState callback failed:', err);
        }
        return;
      }
      whenGameStateQueue.push(cb);
      syncCaptureEnabled(getSettings, emitTo);
    },
    listMonsterNames() {
      const gs = window.gameState;
      if (!gs?.monsters?.monsters) return [];
      const names = new Set();
      try {
        for (const m of gs.monsters.monsters.values()) {
          const name = m?.info?.name;
          if (name) names.add(name);
        }
      } catch {
        return [];
      }
      return [...names].sort();
    },
    syncCaptureEnabled: () => syncCaptureEnabled(getSettings, emitTo),
  });
})();
