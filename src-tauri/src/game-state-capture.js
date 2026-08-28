// Patches the game's main ES module so window.gameState is set at socket connect.
// Module scripts bypass fetch hooks in WebView2; intercept script src before the parser loads the bundle.
(() => {
  const INDEX_RE = /\/assets\/index-[\w-]+\.js(?:\?|$)/;
  const ANCHORS = ['targetMonsterId', 'combatAssist', 'sendEmoteNow', 'tryUsePotion'];

  const state = (window.__speakiGsCaptureState ??= {
    captureStatus: 'disabled',
    captureFailReason: null,
    whenGameStateQueue: [],
    readyEmitted: false,
    nativePatchSeen: false,
    scriptHookPatchSeen: false,
    pollTimer: null,
    getSettings: null,
    emitTo: null,
  });

  window.__speakiGsOnNativePatch = function onNativePatch() {
    onIndexPatched('WebView2 proxy', true);
  };

  function onIndexPatched(via, fromNative) {
    const seen = state.scriptHookPatchSeen || state.nativePatchSeen;
    if (!seen) {
      console.log(`[SpeakiRPG] gameState: index bundle patched (${via})`);
    }
    if (fromNative) state.nativePatchSeen = true;
    else state.scriptHookPatchSeen = true;
    setCaptureStatus('patched');
    startReadyPoll();
  }

  function setCaptureStatus(status, reason) {
    state.captureStatus = status;
    state.captureFailReason = reason ?? null;
  }

  function isGameStateReady() {
    const gs = window.gameState;
    if (!gs || typeof gs !== 'object') return false;
    return !!(gs.monsters || gs.myStat);
  }

  if (!isGameStateReady()) {
    state.readyEmitted = false;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.captureStatus === 'ready') {
      state.captureStatus = 'pending';
    }
  }

  const PATCH_MARKER = 'window.__SPEAKI_GS_PATCHED__=1;';

  function withPatchMarker(code) {
    return code.includes('__SPEAKI_GS_PATCHED__') ? code : PATCH_MARKER + code;
  }

  function absolutizeViteImports(source) {
    const base = 'https://speakirpg.overture.io.kr/assets/';
    let out = source.replace(
      /(from|import)\s*(['"])\.\/([^'"]+)\2/g,
      (_, kw, q, path) => `${kw}${q}${base}${path}${q}`,
    );
    out = out.replace(
      /import\s*\(\s*(['"])\.\/([^'"]+)\1\s*\)/g,
      (_, q, path) => `import(${q}${base}${path}${q})`,
    );
    out = out.replace(/"assets\//g, `"${base}`);
    return out.replace(/'assets\//g, `'${base}`);
  }

  function finalizePatchedBundle(code) {
    return absolutizeViteImports(withPatchMarker(code));
  }

  function extractI18nId(source) {
    const m = source.match(
      /function (\w+)\(e\)\s*\{\s*let \w+\s*=\s*\w+\[\w+\(\)\];\s*return Object\.prototype\.hasOwnProperty\.call\(\w+,\s*e\)\s*\?\s*\w+\[e\]\s*:/,
    );
    return m ? m[1] : null;
  }

  function extractQuestManagerId(source) {
    const m = source.match(
      /new\s*(\w+)\(\{\s*container:\s*e,\s*showToast:\s*e\s*=>\s*\w+\.setStatus\(e\),\s*onClaimSuccess:\s*\(\)\s*=>\s*\{\s*\w+\.markStale\(\),\s*\w+\.markStale\(\),\s*\w+\(\)\s*}/,
    );
    return m ? m[1] : null;
  }

  function buildCapturePrefix(recv, i18n, questManager) {
    const parts = [`window.gameState=${recv}`];
    if (i18n && i18n !== 'null') parts.push(`window.i18n=${i18n}`);
    if (questManager && questManager !== 'null') {
      parts.push(`window.questManager=${questManager}`);
    }
    return parts.join(',');
  }

  function spliceConnectPatch(source, abs, original, recv, i18n, questManager) {
    const prefix = buildCapturePrefix(recv, i18n, questManager);
    const patched = `${prefix},${original}`;
    return source.slice(0, abs) + patched + source.slice(abs + original.length);
  }

  function tryPatchConnectSite(source, abs, original, recv, i18n, questManager) {
    if (recv === 'socket' || recv === 'WebSocket') return null;
    const code = spliceConnectPatch(source, abs, original, recv, i18n, questManager);
    if (code.includes('window.gameState=')) {
      return finalizePatchedBundle(code);
    }
    return null;
  }

  function patchIndexBundle(source) {
    const anchorHits = ANCHORS.filter((a) => source.includes(a));
    if (anchorHits.length < 2) {
      return { ok: false, reason: `anchors found: ${anchorHits.length}/2` };
    }

    const i18n = extractI18nId(source);
    const questManager = extractQuestManagerId(source);

    const primaryRe =
      /([\w$]+)\.connect\(([\w$]+)\),[sc]n\(\(\)=>\{[an]n\(\)\.autoAttackEnabled\|\|/;
    const primary = source.match(primaryRe);
    if (primary) {
      const recv = primary[1];
      const original = primary[0];
      const abs = primary.index;
      const code = tryPatchConnectSite(source, abs, original, recv, i18n, questManager);
      if (code) return { ok: true, code };
    }

    const legacyRe =
      /(\}\);)([\w$]+)\.connect\(([\w$]+)\),([sc]n\(\(\)=>\{[an]n\(\)\.autoAttackEnabled\|\|)/;
    const legacy = source.match(legacyRe);
    if (legacy) {
      const recv = legacy[2];
      const arg = legacy[3];
      const prefix = buildCapturePrefix(recv, i18n, questManager);
      const code = source.replace(
        legacyRe,
        `$1(${prefix},${recv}.connect(${arg})),$4`,
      );
      if (code.includes('window.gameState=')) {
        return { ok: true, code: finalizePatchedBundle(code) };
      }
    }

    const electronRe =
      /;\s*(([\w$]+)\.connect\(([\w$]+)\)),([^;]{0,96}autoAttackEnabled)/;
    const electron = source.match(electronRe);
    if (electron) {
      const recv = electron[2];
      const original = electron[1];
      const abs = electron.index + electron[0].indexOf(original);
      const code = tryPatchConnectSite(source, abs, original, recv, i18n, questManager);
      if (code) return { ok: true, code };
    }

    const combatPos = source.indexOf('combatAssist');
    if (combatPos >= 0) {
      const tail = source.slice(combatPos);
      const fallbackRe = /([\w$]+)\.connect\(([\w$]+)\)/g;
      let match;
      while ((match = fallbackRe.exec(tail))) {
        const recv = match[1];
        const original = match[0];
        const abs = combatPos + match.index;
        const code = tryPatchConnectSite(source, abs, original, recv, i18n, questManager);
        if (code) return { ok: true, code };
      }
    }

    return { ok: false, reason: 'connect() patch site not found' };
  }

  function resolveScriptUrl(url) {
    try {
      return new URL(url, document.baseURI || window.location.href).href;
    } catch {
      return url;
    }
  }

  function isIndexScriptUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:')) return false;
    return INDEX_RE.test(url);
  }

  const pendingPatches = new Map();

  async function fetchPatchedBlobUrl(url) {
    const abs = resolveScriptUrl(url);
    if (pendingPatches.has(abs)) return pendingPatches.get(abs);

    const task = (async () => {
      const res = await fetch(abs, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith('<')) {
        throw new Error('got HTML instead of JS (CDN cache?)');
      }
      const patched = patchIndexBundle(text);
      if (!patched.ok) throw new Error(patched.reason);
      const blob = new Blob([patched.code], { type: 'text/javascript' });
      return URL.createObjectURL(blob);
    })();

    pendingPatches.set(abs, task);
    try {
      return await task;
    } finally {
      pendingPatches.delete(abs);
    }
  }

  function installScriptSrcHook() {
    if (window.__SPEAKI_SCRIPT_SRC_HOOK__) return;
    window.__SPEAKI_SCRIPT_SRC_HOOK__ = true;

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (
        this.tagName === 'SCRIPT' &&
        name === 'src' &&
        isIndexScriptUrl(value)
      ) {
        const el = this;
        const orig = value;
        fetchPatchedBlobUrl(orig)
          .then((blobUrl) => {
            onIndexPatched('script src hook');
            origSetAttribute.call(el, 'src', blobUrl);
          })
          .catch((err) => {
            setCaptureStatus('patch_failed', String(err));
            console.error('[SpeakiRPG] gameState script hook failed:', err);
            origSetAttribute.call(el, 'src', orig);
          });
        return;
      }
      return origSetAttribute.call(this, name, value);
    };

    const srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (srcDesc?.set && srcDesc?.get) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set(value) {
          if (isIndexScriptUrl(value)) {
            const el = this;
            const orig = value;
            fetchPatchedBlobUrl(orig)
              .then((blobUrl) => {
                onIndexPatched('script src hook');
                srcDesc.set.call(el, blobUrl);
              })
              .catch((err) => {
                setCaptureStatus('patch_failed', String(err));
                console.error('[SpeakiRPG] gameState script hook failed:', err);
                srcDesc.set.call(el, orig);
              });
            return;
          }
          return srcDesc.set.call(this, value);
        },
      });
    }

    console.log('[SpeakiRPG] gameState: script src hook installed');
  }

  function flushWhenGameStateQueue() {
    if (!isGameStateReady()) return;
    const gs = window.gameState;
    while (state.whenGameStateQueue.length) {
      const cb = state.whenGameStateQueue.shift();
      try {
        cb(gs);
      } catch (err) {
        console.error('[SpeakiRPG] whenGameState callback failed:', err);
      }
    }
  }

  function markReady() {
    if (!isGameStateReady() || state.readyEmitted) return;
    state.readyEmitted = true;
    setCaptureStatus('ready');
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const gs = window.gameState;
    if (state.emitTo) state.emitTo('gameStateReady', gs);
    flushWhenGameStateQueue();
  }

  function startReadyPoll() {
    if (state.pollTimer) return;
    let attempts = 0;
    const maxAttempts = 300;
    state.pollTimer = setInterval(() => {
      attempts += 1;
      if (isGameStateReady()) {
        markReady();
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state.captureStatus === 'patched') {
          const ran = !!window.__SPEAKI_GS_PATCHED__;
          const msg = ran
            ? 'gameState not set after patched bundle (connect hook missed?)'
            : 'gameState not set after load';
          setCaptureStatus('patch_failed', msg);
          console.error('[SpeakiRPG] gameState capture timed out', { ran });
        } else if (state.captureStatus === 'pending') {
          setCaptureStatus(
            'patch_failed',
            'index bundle not patched; enable capture then F5',
          );
          console.error('[SpeakiRPG] gameState capture: index bundle never patched');
        }
      }
    }, 200);
  }

  async function tryPatchIndexResponse(res, url) {
    const settings = state.getSettings?.() ?? window.__SPEAKI_SETTINGS__ ?? {};
    if (!settings.captureGameState || !INDEX_RE.test(url)) {
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
      onIndexPatched('fetch hook');
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
  }

  function installFetchHook(getSettings, emitTo) {
    state.getSettings = getSettings;
    if (emitTo) state.emitTo = emitTo;

    const origFetch = window.__SPEAKI_ORIG_FETCH__ ?? window.fetch.bind(window);
    window.__SPEAKI_ORIG_FETCH__ = origFetch;

    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : '';
      const res = await origFetch(input, init);
      return tryPatchIndexResponse(res, url);
    };
  }

  function syncCaptureEnabled(getSettings, emitTo) {
    const enabled = !!getSettings().captureGameState;
    if (!enabled) {
      setCaptureStatus('disabled');
      return;
    }
    if (isGameStateReady()) {
      markReady();
      return;
    }
    if (
      state.captureStatus === 'disabled' ||
      state.captureStatus === 'patch_failed' ||
      state.captureStatus === 'ready'
    ) {
      setCaptureStatus('pending');
    }
    if (!window.__SPEAKI_NATIVE_GAMESTATE_PROXY) {
      installScriptSrcHook();
    }
    installFetchHook(getSettings, emitTo);
    startReadyPoll();
  }

  window.__speakiInstallGameStateCapture = (emitTo, getSettings) => ({
    getCaptureStatus: () => state.captureStatus,
    getCaptureFailReason: () => state.captureFailReason,
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
      state.whenGameStateQueue.push(cb);
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

  if (window.__SPEAKI_SETTINGS__?.captureGameState) {
    if (!window.__SPEAKI_NATIVE_GAMESTATE_PROXY) {
      installScriptSrcHook();
    }
    installFetchHook(() => window.__SPEAKI_SETTINGS__, null);
    if (state.captureStatus === 'disabled') setCaptureStatus('pending');
    startReadyPoll();
  }
})();
