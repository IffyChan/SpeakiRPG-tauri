// SpeakiRPG mod: Game tools
/* SpeakiRPG.settings
{
  "id": "game-tools",
  "category": "World",
  "fields": [
    { "key": "statusStrip", "type": "bool", "label": "Compact status strip", "default": true },
    { "key": "showExpEta", "type": "bool", "label": "EXP time-to-level strip", "default": true },
    { "key": "channelTracker", "type": "bool", "label": "Channel population strip", "default": true },
    { "key": "showZoneId", "type": "bool", "label": "Show zone ID in strip", "default": false },
    { "key": "cameraLock", "type": "bool", "label": "Lock camera (PS1 style)" },
    { "key": "viewClip", "type": "bool", "label": "ViewClip (camera through walls)" },
    { "key": "hideNametags", "type": "bool", "label": "Hide other players' nametags" },
    { "key": "zoom", "type": "number", "label": "Camera zoom", "min": 3, "max": 12, "default": 8 },
    { "key": "walkZone", "type": "select", "label": "Walk to zone", "default": "0",
      "options": [
        { "value": "0", "label": "Stop" },
        { "value": "1", "label": "Town (1)" },
        { "value": "2", "label": "Sunbreeze (2)" },
        { "value": "5", "label": "Mistwood (5)" },
        { "value": "3", "label": "Crystal (3)" },
        { "value": "6", "label": "Ash (6)" },
        { "value": "4", "label": "Frost (4)" },
        { "value": "7", "label": "Thunder (7)" },
        { "value": "8", "label": "Sand (8)" },
        { "value": "9", "label": "Void (9)" },
        { "value": "10", "label": "Peak (10)" }
      ]
    },
    { "key": "spectatePlayer", "type": "text", "label": "Player to spectate", "default": "" },
    { "key": "watchPlayer", "type": "action", "label": "Watch player", "action": "watchPlayer" },
    { "key": "dance", "type": "action", "label": "Dance", "action": "dance" },
    { "key": "joayo", "type": "action", "label": "Joayo", "action": "joayo" },
    { "key": "faceCamera", "type": "action", "label": "Turn to camera", "action": "faceCamera" },
    { "key": "spinToggle", "type": "action", "label": "Toggle spin", "action": "spinToggle" },
    { "key": "spinFaster", "type": "action", "label": "Spin faster", "action": "spinFaster" },
    { "key": "spinSlower", "type": "action", "label": "Spin slower", "action": "spinSlower" },
    { "key": "resetCamera", "type": "action", "label": "Reset camera to self", "action": "resetCamera" }
  ]
}
*/

(function () {
  const MOD_ID = 'game-tools';
  const EMOTE_DANCE = 8;
  const EMOTE_JOAYO = 3;
  const TICK_MS = 50;
  const PORTAL_USE_COOLDOWN_MS = 500;
  const PORTAL_USE_DIST = 2.9;
  const PORTAL_ARRIVE_DIST = 1.5;
  const PORTAL_CACHE_KEY = 'sr-portal-cache-v1';
  const CHANNEL_POLL_MS = 10_000;
  const QUEST_POLL_MS = 2000;
  const API_BASE = 'https://sr1.overture.io.kr';

  const ZONE_RING = [1, 2, 5, 3, 6, 4, 7, 8, 9, 10];
  const EDGE_HINTS = new Int16Array([
    1, 2, 95, 50, 2, 1, 105, 50, 2, 5, 196, 100, 5, 2, 204, 100, 5, 3, 296, 120, 3, 5, 306, 120,
    3, 6, 426, 100, 6, 3, 434, 100, 6, 4, 554, 100, 4, 6, 580, 100, 4, 7, 656, 100, 7, 4, 664, 100,
    7, 8, 756, 100, 8, 7, 764, 100, 8, 9, 956, 100, 9, 8, 964, 100, 9, 10, 1136, 100, 10, 9, 1144, 100,
  ]);
  const Z5_DETOUR = [{ x: 272, z: 106 }];

  const STRIP_STYLE =
    'box-sizing:border-box;width:100%;margin-top:4px;padding:3px 8px;font:11px/1.35 system-ui,sans-serif;color:rgba(255,255,255,0.85);background:rgba(12,14,18,0.72);border:1px solid rgba(255,255,255,0.15);border-radius:6px;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;';

  const QUEST_PIN_STYLE =
    'box-sizing:border-box;width:100%;margin-top:4px;padding:6px 8px;font:11px/1.35 system-ui,sans-serif;color:rgba(255,255,255,0.9);background:rgba(12,14,18,0.82);border:1px solid rgba(255,255,255,0.2);border-radius:6px;pointer-events:auto;';

  // strip stack order before minimap legend
  const STRIP_ORDER = ['sr-game-tools-strip', 'sr-game-tools-exp', 'sr-game-tools-channels', 'sr-game-tools-quest-pin'];

  let gs = null;
  let cfg = {};
  let blocks = {};
  let tickTimer = null;
  let spinSpeed = 0;
  let spinAngle = 0;
  let expStart = 0;
  let expStartAt = 0;
  let expPerMin = 0;
  let hooks = null;
  let channelText = '';
  let channelNextPoll = 0;
  let channelFetching = false;
  let questHooked = false;
  let pinnedQuest = null;
  let questNextPoll = 0;
  let questFetching = false;
  let runtimeWalkZone = null;

  function hintFor(from, to) {
    for (let i = 0; i < EDGE_HINTS.length; i += 4) {
      if (EDGE_HINTS[i] === from && EDGE_HINTS[i + 1] === to) {
        return { x: EDGE_HINTS[i + 2], z: EDGE_HINTS[i + 3] };
      }
    }
    return null;
  }

  function edgeKey(from, to) {
    return `${from}>${to}`;
  }

  const PortalWalker = {
    targetZone: null,
    seekTarget: null,
    detourCrossed: {},
    useCooldown: 0,
    cache: new Map(),
    pendingEdge: null,

    loadCache() {
      try {
        const raw = sessionStorage.getItem(PORTAL_CACHE_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) this.cache.set(k, v);
        }
      } catch {
        /* optional */
      }
    },

    saveCache() {
      try {
        const obj = {};
        this.cache.forEach((v, k) => {
          obj[k] = v;
        });
        sessionStorage.setItem(PORTAL_CACHE_KEY, JSON.stringify(obj));
      } catch {
        /* optional */
      }
    },

    rememberEdge(from, to, pos, portalId) {
      const entry = { x: pos.x, z: pos.z };
      if (portalId != null) entry.portalId = portalId;
      this.cache.set(edgeKey(from, to), entry);
      this.saveCache();
    },

    cacheGet(from, to) {
      return this.cache.get(edgeKey(from, to)) || null;
    },

    attach(gameState) {
      if (gameState.__srPortalProbeWrapped || typeof gameState.findNearbyPortal !== 'function') return;
      const orig = gameState.findNearbyPortal.bind(gameState);
      const self = this;
      gameState.findNearbyPortal = function () {
        const hit = orig();
        if (hit?.position && self.pendingEdge) {
          const { from, to } = self.pendingEdge;
          self.rememberEdge(from, to, hit.position, hit.portalId);
        }
        return hit;
      };
      gameState.__srPortalProbeWrapped = true;
    },

    resetDetour() {
      this.detourCrossed = {};
    },

    nextHopZone(from, targetZone) {
      const cur = ZONE_RING.indexOf(from);
      const tgt = ZONE_RING.indexOf(targetZone);
      if (cur < 0 || tgt < 0) return null;
      const step = Math.sign(tgt - cur);
      if (!step) return null;
      return ZONE_RING[cur + step];
    },

    pickByDirection(candidates, forward) {
      if (!candidates.length) return null;
      if (candidates.length === 1) return candidates[0];
      const sorted = [...candidates].sort((a, b) => a.x - b.x);
      return forward ? sorted[sorted.length - 1] : sorted[0];
    },

    cachedInZone(from) {
      const out = [];
      for (const [key, val] of this.cache) {
        if (key.startsWith(`${from}>`)) out.push(val);
      }
      return out;
    },

    resolveSeekPos(from, next) {
      const cached = this.cacheGet(from, next);
      if (cached) return cached;

      const forward = ZONE_RING.indexOf(next) > ZONE_RING.indexOf(from);
      const heuristic = this.pickByDirection(this.cachedInZone(from), forward);
      if (heuristic) return heuristic;

      return hintFor(from, next);
    },

    resolveDetour(from) {
      if (from !== 5) return null;
      for (let i = 0; i < Z5_DETOUR.length; i++) {
        if (this.detourCrossed[i]) continue;
        const wp = Z5_DETOUR[i];
        if (distTo(wp) > 2) return wp;
        this.detourCrossed[i] = true;
      }
      return null;
    },

    tryUsePortal() {
      const now = Date.now();
      if (now < this.useCooldown) return;
      this.useCooldown = now + PORTAL_USE_COOLDOWN_MS;
      if (typeof gs.tryUsePortal === 'function') gs.tryUsePortal();
    },

    sync(want, busy, fromZone) {
      if (!want || busy) {
        this.targetZone = null;
        this.seekTarget = null;
        this.pendingEdge = null;
        if (window.__speakiCombatAssistOwner === MOD_ID) {
          window.__speakiCombatAssistOwner = null;
        }
        return;
      }

      if (this.targetZone !== want) {
        this.targetZone = want;
        this.resetDetour();
      }

      if (fromZone == null) return;

      if (fromZone === this.targetZone) {
        this.seekTarget = null;
        this.pendingEdge = null;
        return;
      }

      const next = this.nextHopZone(fromZone, this.targetZone);
      if (!next) {
        this.seekTarget = null;
        this.pendingEdge = null;
        return;
      }

      this.pendingEdge = { from: fromZone, to: next };

      const detour = this.resolveDetour(fromZone);
      if (detour) {
        this.seekTarget = detour;
        window.__speakiCombatAssistOwner = MOD_ID;
        return;
      }

      const pos = this.resolveSeekPos(fromZone, next);
      if (!pos) {
        this.seekTarget = null;
        return;
      }

      this.seekTarget = pos;
      window.__speakiCombatAssistOwner = MOD_ID;
    },

    moveIntent(playerPos) {
      if (!this.seekTarget || !this.targetZone) return null;

      const d = Math.hypot(this.seekTarget.x - playerPos.x, this.seekTarget.z - playerPos.z);
      if (d <= PORTAL_ARRIVE_DIST) {
        this.tryUsePortal();
        return { moveDir: null, castSkillId: null };
      }
      if (d < PORTAL_USE_DIST) {
        this.tryUsePortal();
      }

      const len = Math.hypot(
        this.seekTarget.x - playerPos.x,
        this.seekTarget.z - playerPos.z,
      ) || 1;
      return {
        moveDir: {
          x: (this.seekTarget.x - playerPos.x) / len,
          z: (this.seekTarget.z - playerPos.z) / len,
        },
        castSkillId: null,
      };
    },
  };

  function cfgBool(key, fallback) {
    return cfg[key] != null ? !!cfg[key] : !!fallback;
  }

  function cfgNum(key, fallback) {
    const n = Number(cfg[key]);
    return Number.isFinite(n) ? n : fallback;
  }

  function effectiveWalkZone() {
    if (runtimeWalkZone != null) return runtimeWalkZone;
    return cfgNum('walkZone', 0);
  }

  function reloadCfg() {
    cfg = SpeakiRPG.getModSettings(MOD_ID);
  }

  function zoneId() {
    const z = gs?.zoneId;
    return z == null ? null : z % 10000;
  }

  function playerPos() {
    const p = gs?.playerContainer?.position;
    return p ? { x: p.x, z: p.z } : { x: 0, z: 0 };
  }

  function distTo(pos) {
    const p = playerPos();
    return Math.hypot(pos.x - p.x, pos.z - p.z);
  }

  function i18nZone(id) {
    const fn = SpeakiRPG.getI18n();
    if (!fn) return `Z${id}`;
    try {
      return fn(`content.zone.${id}.name`) || `Z${id}`;
    } catch {
      return `Z${id}`;
    }
  }

  function i18nQuest(code) {
    const fn = SpeakiRPG.getI18n();
    if (!fn) return code || '';
    try {
      return fn(`content.quest.${code}.description`) || code || '';
    } catch {
      return code || '';
    }
  }

  function playersNearby() {
    try {
      return gs.remotePlayers.remotePlayers.size;
    } catch {
      return 0;
    }
  }

  function minimapFrame() {
    return document.querySelector(SpeakiRPG.selectors.minimapFrame);
  }

  function anchorBeforeLegend(el) {
    if (!el) return false;
    const frame = minimapFrame();
    if (!frame) return false;
    const legend = frame.querySelector('.sr-minimap-frame__legend');
    if (el.parentElement !== frame) {
      if (legend) frame.insertBefore(el, legend);
      else frame.appendChild(el);
    }
    let anchor = legend;
    for (let i = STRIP_ORDER.length - 1; i >= 0; i--) {
      const id = STRIP_ORDER[i];
      const node = id === el.id ? el : document.getElementById(id);
      if (!node || node === el) continue;
      if (node.parentElement === frame) {
        anchor = node;
        break;
      }
    }
    if (anchor && el.nextElementSibling !== anchor) {
      frame.insertBefore(el, anchor);
    }
    return true;
  }

  function anchorAllBlocks() {
    for (const id of STRIP_ORDER) {
      const el = blocks[id] || document.getElementById(id);
      if (el?.parentElement) anchorBeforeLegend(el);
    }
  }

  function ensureBlock(id, enabled, baseStyle, createFn) {
    if (!enabled) {
      if (blocks[id]) {
        blocks[id].remove();
        delete blocks[id];
      }
      return null;
    }
    if (!blocks[id]) {
      blocks[id] = createFn();
      blocks[id].id = id;
    }
    blocks[id].style.cssText = baseStyle;
    if (!anchorBeforeLegend(blocks[id])) {
      blocks[id].style.cssText =
        baseStyle +
        'position:fixed;right:12px;top:12px;max-width:min(420px,55vw);width:auto;z-index:2147483646;';
      if (blocks[id].parentElement !== document.body) document.body.appendChild(blocks[id]);
    }
    return blocks[id];
  }

  function authToken() {
    const url = gs?.socket?.socket?.url;
    if (!url) return null;
    const m = url.match(/eyJhb.+?(?=&|$)/);
    return m ? m[0] : null;
  }

  async function apiGet(path) {
    const token = authToken();
    if (!token) throw new Error('no token');
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function pollChannels(now) {
    if (!cfgBool('channelTracker', true) || !authToken()) return;
    if (channelFetching || now < channelNextPoll) return;
    channelNextPoll = now + CHANNEL_POLL_MS;
    channelFetching = true;
    apiGet('/api/realtime/channels')
      .then((resp) => {
        if (Array.isArray(resp)) {
          channelText = resp
            .map((t) => `${t.channel}:${t.population}/${t.capacity}`)
            .join(' · ');
        }
      })
      .catch((err) => {
        channelText = `channels: error ${err.status || '?'}`;
      })
      .finally(() => {
        channelFetching = false;
        updateChannelStrip();
      });
  }

  function pollPinnedQuest(now) {
    if (!pinnedQuest || !authToken()) return;
    if (questFetching || now < questNextPoll) return;
    questNextPoll = now + QUEST_POLL_MS;
    questFetching = true;
    const { period, questId } = pinnedQuest;
    apiGet(`/api/quests?period=${period}`)
      .then((resp) => {
        if (!Array.isArray(resp)) return;
        const q = resp.find((t) => t.questId == questId);
        if (!q || q.isClaimed) {
          unpinQuest();
          return;
        }
        updateQuestPanel(q);
      })
      .catch(() => {
        const content = blocks['sr-game-tools-quest-pin']?.querySelector('.sr-gt-quest-content');
        if (content) content.textContent = 'quest update failed';
      })
      .finally(() => {
        questFetching = false;
      });
  }

  function updateMainStrip() {
    const el = ensureBlock('sr-game-tools-strip', cfgBool('statusStrip', true), STRIP_STYLE, () => {
      const d = document.createElement('div');
      return d;
    });
    if (!el) return;
    const stats = SpeakiRPG.getStats();
    const z = zoneId();
    let zLabel = z != null ? i18nZone(z) : stats.location || '…';
    if (cfgBool('showZoneId', false) && z != null) {
      zLabel = `Z${z} · ${zLabel}`;
    }
    const parts = [
      `nearby ${playersNearby()}`,
      expPerMin > 0 ? `${Math.round(expPerMin)} exp/m` : null,
      zLabel,
    ].filter(Boolean);
    el.textContent = parts.join(' · ');
  }

  function updateExpStrip() {
    const el = ensureBlock('sr-game-tools-exp', cfgBool('showExpEta', true), STRIP_STYLE, () => {
      return document.createElement('div');
    });
    if (!el) return;
    const exp = gs?.myStat?.exp;
    const maxExp = gs?.myStat?.maxExp;
    if (typeof exp !== 'number' || typeof maxExp !== 'number' || expPerMin <= 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const remaining = maxExp - exp;
    const minToLevel = remaining / expPerMin;
    el.textContent = `~${minToLevel.toFixed(1)} min to next level`;
  }

  function updateChannelStrip() {
    const el = ensureBlock('sr-game-tools-channels', cfgBool('channelTracker', true), STRIP_STYLE, () => {
      return document.createElement('div');
    });
    if (!el) return;
    el.textContent = channelText || 'channels…';
  }

  function ensureQuestPanel() {
    if (!pinnedQuest) {
      if (blocks['sr-game-tools-quest-pin']) {
        blocks['sr-game-tools-quest-pin'].remove();
        delete blocks['sr-game-tools-quest-pin'];
      }
      return;
    }
    let panel = blocks['sr-game-tools-quest-pin'];
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'sr-gt-quest-pin';
      panel.style.cssText = QUEST_PIN_STYLE;

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-weight:600;';
      header.textContent = 'Pinned quest';

      const unpin = document.createElement('button');
      unpin.type = 'button';
      unpin.textContent = 'Unpin';
      unpin.className = 'sr-btn';
      unpin.style.cssText = 'pointer-events:auto;cursor:pointer;padding:2px 8px;font-size:10px;';
      unpin.addEventListener('click', (e) => {
        e.stopPropagation();
        unpinQuest();
      });
      header.appendChild(unpin);

      const content = document.createElement('div');
      content.className = 'sr-gt-quest-content';
      content.style.cssText = 'margin-bottom:6px;font-size:10px;line-height:1.3;';

      const barBg = document.createElement('div');
      barBg.style.cssText = 'height:6px;background:rgba(255,255,255,0.15);border-radius:3px;overflow:hidden;';
      const barFill = document.createElement('div');
      barFill.className = 'sr-gt-quest-pbar';
      barFill.style.cssText = 'height:100%;width:0;background:rgba(120,180,255,0.85);transition:width 0.3s;';
      barBg.appendChild(barFill);

      panel.appendChild(header);
      panel.appendChild(content);
      panel.appendChild(barBg);
      blocks['sr-game-tools-quest-pin'] = panel;
    }
    anchorBeforeLegend(panel);
  }

  function updateQuestPanel(quest) {
    ensureQuestPanel();
    const panel = blocks['sr-game-tools-quest-pin'];
    if (!panel || !quest) return;
    const content = panel.querySelector('.sr-gt-quest-content');
    const pbar = panel.querySelector('.sr-gt-quest-pbar');
    const desc = i18nQuest(quest.code);
    const cur = quest.currentAmount ?? 0;
    const tgt = quest.targetAmount ?? 1;
    if (content) {
      content.textContent = `${desc} ${cur} / ${tgt}`;
    }
    if (pbar && tgt > 0) {
      pbar.style.width = `${Math.min(100, (cur / tgt) * 100).toFixed(0)}%`;
    }
  }

  function pinQuest(quest) {
    if (!quest || quest.isCompleted) return;
    pinnedQuest = {
      period: quest.period,
      questId: quest.questId,
      code: quest.code,
    };
    questNextPoll = 0;
    updateQuestPanel(quest);
    ensureQuestPanel();
  }

  function unpinQuest() {
    pinnedQuest = null;
    questNextPoll = 0;
    if (blocks['sr-game-tools-quest-pin']) {
      blocks['sr-game-tools-quest-pin'].remove();
      delete blocks['sr-game-tools-quest-pin'];
    }
  }

  function installQuestHook() {
    if (questHooked) return;
    const QM = SpeakiRPG.getQuestManager();
    if (!QM?.prototype?.renderRow) return;
    const orig = QM.prototype.renderRow;
    QM.prototype.renderRow = function (quest) {
      const row = orig.apply(this, [quest]);
      if (!quest.isCompleted && row) {
        const sub = row.querySelector('.sr-list-item__subtitle');
        if (sub) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sr-btn';
          btn.textContent = 'Pin';
          btn.style.cssText = 'height:2rem;padding:0 12px;font-size:var(--sr-font-md,12px);cursor:pointer;';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            pinQuest(quest);
          });
          sub.replaceWith(btn);
        }
      }
      return row;
    };
    questHooked = true;
  }

  function updateAllStrips() {
    updateMainStrip();
    updateExpStrip();
    updateChannelStrip();
    ensureQuestPanel();
    anchorAllBlocks();
  }

  function applyZoom() {
    if (!gs?.cameraController) return;
    const z = cfgNum('zoom', 8);
    gs.cameraController.cameraZoomDistance = Math.min(12, Math.max(3, z));
  }

  function setNametagsHidden(hidden) {
    try {
      gs.remotePlayers.remotePlayers.forEach((rp) => {
        const tag = rp?.container?.children?.[0]?.children?.[1];
        if (tag) tag.visible = !hidden;
      });
    } catch {
      /* optional */
    }
  }

  function combatAssistBusy() {
    return window.__speakiCombatAssistOwner && window.__speakiCombatAssistOwner !== MOD_ID;
  }

  function installHooks() {
    if (hooks || !gs?.cameraController || !gs?.combatAssist) return;
    const cam = gs.cameraController;
    const ca = gs.combatAssist;
    hooks = {
      computeCameraTargetPosition: cam.computeCameraTargetPosition.bind(cam),
      getObstacles: cam.getObstacles.bind(cam),
      combatAssistUpdate: ca.update.bind(ca),
    };

    cam.computeCameraTargetPosition = (pos) => {
      if (cfgBool('cameraLock', false)) return pos;
      return hooks.computeCameraTargetPosition(pos);
    };
    cam.getObstacles = () => (cfgBool('viewClip', false) ? [] : hooks.getObstacles());

    ca.update = (e) => {
      if (PortalWalker.targetZone && !combatAssistBusy()) {
        const intent = PortalWalker.moveIntent(playerPos());
        if (intent) return intent;
      }
      return hooks.combatAssistUpdate(e);
    };
    ca.update.__srGameToolsWrapped = true;
  }

  function applySpin() {
    if (!spinSpeed) return;
    spinAngle += spinSpeed;
    gs.playerContainer.rotation.y = spinAngle;
  }

  let nametagsHidden = false;

  function applyNametags() {
    const hidden = cfgBool('hideNametags', false);
    if (!hidden) {
      // engine default is visible; only restore once after a hide
      if (nametagsHidden) {
        nametagsHidden = false;
        setNametagsHidden(false);
      }
      return;
    }
    // keep enforcing: players joining later must be hidden too
    nametagsHidden = true;
    setNametagsHidden(true);
  }

  let stripsNextAt = 0;

  function tick() {
    if (!gs) return;

    const now = Date.now();

    applySpin();
    applyZoom();
    applyNametags();
    PortalWalker.sync(effectiveWalkZone(), combatAssistBusy(), zoneId());

    const exp = gs.myStat?.exp;
    if (typeof exp === 'number') {
      if (!expStartAt) {
        expStart = exp;
        expStartAt = now;
      } else if (now - expStartAt >= 60_000) {
        expPerMin = exp - expStart;
        expStart = exp;
        expStartAt = now;
      }
    }

    pollChannels(now);
    pollPinnedQuest(now);
    // strips do layout-forcing DOM reads; 2 Hz is plenty for text refreshes
    if (now >= stripsNextAt) {
      stripsNextAt = now + 500;
      updateAllStrips();
    }
  }

  function sendEmote(id) {
    if (typeof gs.sendEmoteNow === 'function') gs.sendEmoteNow(id);
  }

  function setWalkZone(zone) {
    const n = Number(zone);
    if (!Number.isFinite(n) || n < 0) {
      runtimeWalkZone = null;
      return;
    }
    runtimeWalkZone = n;
    if (n === 0) {
      PortalWalker.targetZone = null;
      PortalWalker.seekTarget = null;
      if (window.__speakiCombatAssistOwner === MOD_ID) {
        window.__speakiCombatAssistOwner = null;
      }
    }
  }

  function clearWalkZone() {
    runtimeWalkZone = null;
    PortalWalker.targetZone = null;
    PortalWalker.seekTarget = null;
    if (window.__speakiCombatAssistOwner === MOD_ID) {
      window.__speakiCombatAssistOwner = null;
    }
  }

  function isWalkActive() {
    return PortalWalker.targetZone != null && PortalWalker.targetZone > 0;
  }

  function faceCamera() {
    gs.playerContainer.rotation.y = gs.cameraController.cameraYaw;
    gs.moveSendAccumulator = 1;
    spinAngle = gs.playerContainer.rotation.y;
  }

  function resetCamera() {
    if (gs?.cameraController) gs.cameraController.target = gs.playerContainer;
  }

  function watchPlayer(name) {
    const n = (name || cfg.spectatePlayer || '').trim();
    if (!n) {
      resetCamera();
      return;
    }
    try {
      const pi = [...gs.remotePlayers.remotePlayers.values()].find((p) => p.info?.name === n);
      if (pi) gs.cameraController.target = pi.container;
      else resetCamera();
    } catch {
      resetCamera();
    }
  }

  function onAction(action) {
    switch (action) {
      case 'dance':
        sendEmote(EMOTE_DANCE);
        break;
      case 'joayo':
        sendEmote(EMOTE_JOAYO);
        break;
      case 'faceCamera':
        faceCamera();
        break;
      case 'spinToggle':
        if (spinSpeed) spinSpeed = 0;
        else {
          spinAngle = gs.playerContainer.rotation.y;
          spinSpeed = (Math.PI * 2) / 180;
        }
        break;
      case 'spinFaster':
        if (!spinSpeed) break;
        spinSpeed += (Math.PI * 2) / 180;
        break;
      case 'spinSlower':
        if (!spinSpeed) break;
        spinSpeed -= (Math.PI * 2) / 360;
        if (spinSpeed < 0) spinSpeed = 0;
        break;
      case 'resetCamera':
        resetCamera();
        break;
      case 'watchPlayer':
        watchPlayer();
        break;
      default:
        break;
    }
  }

  function exportGameToolsApi() {
    window.__speakiGameTools = {
      emotes: { DANCE: EMOTE_DANCE, JOAYO: EMOTE_JOAYO },
      sendEmote,
      setWalkZone,
      clearWalkZone,
      resetCamera,
      isWalkActive,
    };
  }

  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, TICK_MS);
  }

  function init(gameState) {
    gs = gameState;
    reloadCfg();
    PortalWalker.loadCache();
    PortalWalker.attach(gs);
    installHooks();
    installQuestHook();
    applyZoom();
    exportGameToolsApi();
    startTick();
  }

  if (!SpeakiRPG.settings.captureGameState) {
    console.warn('[game-tools] enable gameState capture in Settings, then F5');
    return;
  }

  SpeakiRPG.bootGameStateMod('game-tools', init);

  SpeakiRPG.on('settings', () => {
    reloadCfg();
    applyZoom();
    updateAllStrips();
  });

  SpeakiRPG.on('modAction', (payload) => {
    if (!payload || payload.modId !== MOD_ID || !gs) return;
    onAction(payload.action);
  });
})();
