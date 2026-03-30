/* ====================================================
 * 3Tick Scalper – Step Index 100 Assistant
 * Content script for dtrader.deriv.com
 * ==================================================== */
(function () {
  'use strict';

  // ── Constants & Config ────────────────────────────────────────────────────
  const WS_URL          = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  const WS_URL_FALLBACK = 'wss://ws.deriv.com/websockets/v3?app_id=1089';
  const FALLBACK_AFTER  = 3;
  const TICK_BUF        = 200;
  const SPEED_BUF       = 100;
  const RECONNECT_BASE  = 4000;
  const RECONNECT_MAX   = 64000;
  const SESSION_HISTORY_CAP = 5000;
  const WATCHDOG_INTERVAL   = 5000;
  const WATCHDOG_TICK_TIMEOUT = 25000;

  // ── DOM Selectors ─────────────────────────────────────────────────────────
  const SEL_SIDE_BTNS    = '.trade-params__option > button.item';
  const SEL_PURCHASE_BTN = 'button.purchase-button.purchase-button--single';
  const CLASS_RISE_ACTIVE = 'quill__color--primary-purchase';
  const CLASS_FALL_ACTIVE = 'quill__color--primary-sell';
  const SEL_FLYOUT       = '.dc-flyout';

  let cfg = {
    tickSize: 0.1,
    strategyMode: 'hybrid',
    epsilon: 0.2,
    realTradeEnabled: false,
    realTimeoutMs: 40000,
    realCooldownMs: 5000,
    postTradeCooldownTicks: 5,
    postTradeCooldownMs: 5000,
    debugSignals: true,
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks = [];
  let speedHistory = [];
  let sHigh = 0, sLow = 0, speedMean = 0, speedStd = 0;
  let signals = [], sessionTradesAll = [];
  let tickSeq = 0, lastSignalTickIndex = -999, upStreak = 0, downStreak = 0;
  let lastTickProcessedAt = 0, lastSignalEvalAt = 0, watchdogInterval = null, evalErrorCount = 0;
  let realExecState = 'IDLE', realTrades = [], realOpenCount = 0, realWins = 0, realLosses = 0, realPnl = 0, realLockReason = '', lastRealTradeAt = 0, lastTradeClosedAt = 0, lastTradeClosedTick = -999, realExecTimer = null, lastSeenPnL = 0;
  let flyoutObserver = null, ws = null, wsState = 'disconnected', reconnectTimer = null, resolvedSymbol = null, manualClose = false, reconnectDelay = RECONNECT_BASE, failCount = 0, usingFallback = false;

  // UI Cache to prevent redundant DOM updates
  let lastUI = { state: '', pnl: null, wins: -1, losses: -1, price: '', stats: '', dist: '', dirStreak: '' };

  // ── Overlay Build ─────────────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('tt-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Timing V2</span>
        <div class="tt-header-btns"><button id="tt-min-btn" title="Minimise">_</button><button id="tt-close-btn" title="Close">X</button></div>
      </div>
      <div id="tt-body">
        <div class="tt-row"><span class="tt-label">Status</span><span class="tt-val" id="tt-status">Disconnected</span></div>
        <div class="tt-row"><span class="tt-label">Last Price</span><span class="tt-val" id="tt-price">-</span></div>
        <div class="tt-row"><span class="tt-label">Dir / Streak</span><span class="tt-val" id="tt-dir-streak">- / 0</span></div>
        <div class="tt-row"><span class="tt-label">S_Low / S_High</span><span class="tt-val" id="tt-speed-stats">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Mean / Std</span><span class="tt-val" id="tt-speed-dist">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Session W/L</span><span class="tt-val"><span id="tt-wins">0</span> / <span id="tt-losses">0</span></span></div>
        <div id="tt-signals-list"></div>
        <div class="tt-config-section-label">Real Execution</div>
        <div id="tt-real-panel">
          <div class="tt-row"><span class="tt-label">Exec State</span><span class="tt-val" id="tt-real-state">IDLE</span></div>
          <div class="tt-row"><span class="tt-label">Real PnL</span><span class="tt-val" id="tt-real-pnl">0.00</span></div>
          <button id="tt-real-export">Download Real CSV</button>
          <button id="tt-real-reset" style="background:#3d1a1a;color:#e04040;margin-top:2px;">Reset Engine</button>
        </div>
        <button id="tt-config-toggle">Settings</button>
        <div id="tt-config">
          <div class="tt-config-row"><label>Mode</label><select id="tt-cfg-strategy-mode"><option value="structural">Structural</option><option value="structural2">Structural 2</option><option value="hybrid">Hybrid</option><option value="momentum">Momentum</option><option value="reversal">Reversal</option></select></div>
          <div class="tt-config-row"><label>Epsilon</label><input type="number" id="tt-cfg-epsilon" min="0" max="1" step="0.01" value="0.2"></div>
          <div class="tt-config-row"><label>Debug Signals</label><input type="checkbox" id="tt-cfg-debug"></div>
          <div class="tt-config-section-label">Real Trade Master</div>
          <div class="tt-config-row"><label style="color:#f0a060;font-weight:700;">Enable Real Execution</label><label class="tt-switch"><input type="checkbox" id="tt-cfg-real-enabled"><span class="tt-slider"></span></label></div>
        </div>
        <button id="tt-export">Download Signals CSV</button>
      </div>
      <div id="tt-alert"></div>
    `;
    document.body.appendChild(el);
    const saved = safeStorage('get', 'tt-pos');
    if (saved) { el.style.right = 'auto'; el.style.left = saved.left + 'px'; el.style.top = saved.top + 'px'; }
    makeDraggable(el); bindButtons(el);
  }

  function makeDraggable(el) {
    const header = document.getElementById('tt-header');
    let ox = 0, oy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault(); const rect = el.getBoundingClientRect(); ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      const left = e.clientX - ox, top = e.clientY - oy;
      el.style.right = 'auto';
      el.style.left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, left)) + 'px';
      el.style.top = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, top)) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      safeStorage('set', 'tt-pos', { left: parseInt(el.style.left), top: parseInt(el.style.top) });
    }
  }

  function bindButtons(el) {
    document.getElementById('tt-min-btn').addEventListener('click', () => el.classList.toggle('tt-minimized'));
    document.getElementById('tt-close-btn').addEventListener('click', () => { manualClose = true; if (reconnectTimer) clearTimeout(reconnectTimer); if (ws) ws.close(); el.remove(); });
    document.getElementById('tt-config-toggle').addEventListener('click', () => document.getElementById('tt-config').classList.toggle('tt-open'));
    document.getElementById('tt-cfg-strategy-mode').addEventListener('change', function () { cfg.strategyMode = this.value; saveCfg(); });
    document.getElementById('tt-cfg-epsilon').addEventListener('change', function () { cfg.epsilon = parseFloat(this.value) || 0.2; saveCfg(); });
    document.getElementById('tt-cfg-debug').addEventListener('change', function () { cfg.debugSignals = this.checked; saveCfg(); });
    document.getElementById('tt-cfg-real-enabled').addEventListener('change', function () { cfg.realTradeEnabled = this.checked; saveCfg(); });
    document.getElementById('tt-real-export').addEventListener('click', exportRealCSV);
    document.getElementById('tt-real-reset').addEventListener('click', () => { if (confirm('Reset real-trade engine to IDLE and clear lock?')) { realExecState = 'IDLE'; realLockReason = ''; realOpenCount = 0; clearTimeout(realExecTimer); updateRealUI(); } });
    document.getElementById('tt-export').addEventListener('click', exportCSV);
    applyConfigToUI();
  }

  // ── WebSocket & Percentiles ───────────────────────────────────────────────
  function resolveSymbol(symbols) {
    var candidates = ['stpRNG', 'STPRNG'];
    for (var i = 0; i < candidates.length; i++) if (symbols.find(s => s.symbol === candidates[i])) return candidates[i];
    var byName = symbols.find(s => /step\s*index\s*100/i.test(s.display_name));
    return byName ? byName.symbol : (symbols.find(s => /step/i.test(s.display_name))?.symbol || null);
  }

  function connect() {
    if (ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(ws.readyState)) return;
    var url = usingFallback ? WS_URL_FALLBACK : WS_URL; setWsState('connecting');
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      setWsState('connected'); reconnectDelay = RECONNECT_BASE; failCount = 0; usingFallback = false;
      lastTickProcessedAt = Date.now(); lastSignalEvalAt = Date.now();
      ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    });
    ws.addEventListener('message', (e) => {
      var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.error) return;
      if (msg.msg_type === 'active_symbols') { var sym = resolveSymbol(msg.active_symbols || []); if (sym) { resolvedSymbol = sym; ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 })); } return; }
      if (msg.msg_type === 'tick') handleTick(msg.tick);
    });
    ws.addEventListener('close', () => { setWsState('disconnected'); resolvedSymbol = null; if (!manualClose) scheduleReconnect(); });
    ws.addEventListener('error', () => { setWsState('disconnected'); ws.close(); });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return; failCount++;
    if (failCount >= FALLBACK_AFTER) { usingFallback = !usingFallback; failCount = 0; }
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  function setWsState(state) {
    wsState = state; const el = document.getElementById('tt-status');
    if (el) el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }

  function calculatePercentiles() {
    if (speedHistory.length < 10) return;
    const sorted = speedHistory.slice().sort((a, b) => a - b);
    const p30 = sorted[Math.floor(sorted.length * 0.3)], p70 = sorted[Math.floor(sorted.length * 0.7)];
    const sum = speedHistory.reduce((a, b) => a + b, 0); speedMean = sum / speedHistory.length;
    const sqDiff = speedHistory.map(v => Math.pow(v - speedMean, 2)); speedStd = Math.sqrt(sqDiff.reduce((a, b) => a + b, 0) / speedHistory.length);
    sHigh = Math.max(p70, speedMean + speedStd); sLow = Math.min(p30, Math.max(0, speedMean - speedStd));

    // Throttle UI updates for stats
    if (tickSeq % 5 === 0) {
      const statsVal = `${sLow.toFixed(4)} / ${sHigh.toFixed(4)}`;
      const distVal = `${speedMean.toFixed(4)} / ${speedStd.toFixed(4)}`;
      if (lastUI.stats !== statsVal) {
        const el = document.getElementById('tt-speed-stats');
        if (el) el.textContent = statsVal;
        lastUI.stats = statsVal;
      }
      if (lastUI.dist !== distVal) {
        const el = document.getElementById('tt-speed-dist');
        if (el) el.textContent = distVal;
        lastUI.dist = distVal;
      }
    }
  }

  function handleTick(tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote), epoch = tick.epoch, now = Date.now(); tickSeq++;
    const prevTick = ticks.length ? ticks[ticks.length - 1] : null;
    const delta = prevTick ? price - prevTick.price : 0, deltaSteps = Math.round(delta / 0.1), direction = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    const deltaTime = prevTick ? (now - prevTick.receivedAt) : 1000;
    const speed = deltaTime > 0 ? deltaSteps / deltaTime : 0, absSpeed = Math.abs(speed);
    const speedTrend = prevTick ? (absSpeed - prevTick.absSpeed) : 0;
    const lastDigit = Math.floor(Math.round(price * 100) / 10) % 10, deltaChange = prevTick ? deltaSteps - prevTick.deltaSteps : 0;
    if (delta > 0) { upStreak++; downStreak = 0; } else if (delta < 0) { downStreak++; upStreak = 0; } else { upStreak = 0; downStreak = 0; }
    const state = { epoch, price, direction, deltaSteps, deltaTime, speed, absSpeed, speedTrend, upStreak, downStreak, lastDigit, deltaChange, receivedAt: now };
    ticks.push(state); if (ticks.length > TICK_BUF) ticks.shift();
    speedHistory.push(absSpeed); if (speedHistory.length > SPEED_BUF) speedHistory.shift();
    calculatePercentiles(); lastTickProcessedAt = Date.now();

    const priceStr = price.toFixed(2);
    if (lastUI.price !== priceStr) {
      const el = document.getElementById('tt-price');
      if (el) el.textContent = priceStr;
      lastUI.price = priceStr;
    }

    const dirStr = direction === 1 ? 'UP' : (direction === -1 ? 'DOWN' : 'FLAT');
    const streakStr = `${dirStr} / ${Math.max(upStreak, downStreak)}`;
    if (lastUI.dirStreak !== streakStr) {
      const el = document.getElementById('tt-dir-streak');
      if (el) {
        el.textContent = streakStr;
        el.style.color = direction === 1 ? '#3ecf60' : (direction === -1 ? '#e04040' : '#fff');
      }
      lastUI.dirStreak = streakStr;
    }

    try { detectSignal(); lastSignalEvalAt = Date.now(); } catch (e) { evalErrorCount++; }

    // Update pending signals for strict Deriv 3-Tick simulation/logging
    signals.forEach(sig => {
      if (sig.result === 'PENDING' && !sig.isReal) { // Only auto-resolve paper trades
        sig.ticksAfter.push(price);

        // Wait for exactly 4 ticks after the signal (T1, T2, T3, T4)
        if (sig.ticksAfter.length === 4) {
          const entryPrice = sig.ticksAfter[0]; // T1: The official start tick
          const exitPrice = sig.ticksAfter[3];  // T4: The official exit tick

          if (sig.type === 'BUY') {
            sig.result = (exitPrice > entryPrice) ? 'WIN' : (exitPrice < entryPrice ? 'LOSS' : 'DRAW');
          } else if (sig.type === 'SELL') {
            sig.result = (exitPrice < entryPrice) ? 'WIN' : (exitPrice > entryPrice ? 'LOSS' : 'DRAW');
          }
          updateSignalsUI();
        }
      } else if (sig.result === 'PENDING' && sig.isReal) {
        sig.ticksAfter.push(price); // Real trades are resolved by the Flyout Observer
      }
    });
  }

  // ── Signal Detection Logic (Final Corrected Model) ────────────────────────
  function detectSignal() {
    const n = ticks.length; if (n < 2) return null;
    const t0 = ticks[n - 1], mode = cfg.strategyMode, eps = cfg.epsilon;
    const streak = Math.max(t0.upStreak, t0.downStreak), isEarly = streak <= 2, isLate = streak >= 4;
    const buyDigits = [0, 5, 6, 7], sellDigits = [2, 3, 4, 8], buyDigitBias = buyDigits.includes(t0.lastDigit), sellDigitBias = sellDigits.includes(t0.lastDigit);

    const checkStructural = () => {
      if (buyDigitBias && t0.deltaChange > eps) return { type: 'BUY', conf: 70 };
      if (sellDigitBias && t0.deltaChange < -eps) return { type: 'SELL', conf: 70 };
      return null;
    };
    const checkHybrid = () => {
      if (buyDigitBias && t0.deltaChange > eps && isEarly && t0.speedTrend > 0) return { type: 'BUY', conf: 95 };
      if (sellDigitBias && t0.deltaChange < -eps && isEarly && t0.speedTrend > 0) return { type: 'SELL', conf: 95 };
      return null;
    };
    const checkMomentum = () => {
      if (t0.direction === 1 && isEarly && t0.deltaChange > eps && t0.speedTrend > 0 && t0.absSpeed < sHigh) return { type: 'BUY', conf: 85 };
      if (t0.direction === -1 && isEarly && t0.deltaChange < -eps && t0.speedTrend > 0 && t0.absSpeed < sHigh) return { type: 'SELL', conf: 85 };
      return null;
    };
    const checkReversal = () => {
      if (t0.direction === -1 && isLate && t0.absSpeed <= sLow && t0.deltaChange > -eps && t0.speedTrend < 0) return { type: 'BUY', conf: 75 };
      if (t0.direction === 1 && isLate && t0.absSpeed <= sLow && t0.deltaChange < eps && t0.speedTrend < 0) return { type: 'SELL', conf: 75 };
      return null;
    };
    const checkStructural2 = () => {
      const tMinus1 = n >= 2 ? ticks[n - 2] : null;
      if (!tMinus1) return null;

      // "Calm Before the Storm" Timing Check: ~1000ms delay, avoid spikes < 400ms
      // Both Setup (T-1) and Trigger (T0) should be in the "Steady" timing zone (avg 1032ms and 991ms)
      const isCalm = (tMinus1.deltaTime >= 400 && tMinus1.deltaTime <= 1800) &&
                     (t0.deltaTime >= 400 && t0.deltaTime <= 1800);
      if (!isCalm) return null;

      // BUY DNA (Catching 5+ UP Streaks)
      // SETUP (T-1): Normal Speed + Digit 2
      // TRIGGER (T0): Direction Flip (DOWN->UP) + Accel 2.0
      if (t0.direction === 1 && tMinus1.direction === -1 && t0.deltaChange === 2) {
        if (tMinus1.lastDigit === 2) {
          return { type: 'BUY', conf: 90, triggerDigit: tMinus1.lastDigit, triggerDesc: 'Flip+Accel(2.0)' };
        }
      }

      // SELL DNA (Catching 5+ DOWN Streaks)
      // SETUP (T-1): Normal Speed + Digit 2
      // TRIGGER (T0): Direction Flip (UP->DOWN) + Accel -2.0
      if (t0.direction === -1 && tMinus1.direction === 1 && t0.deltaChange === -2) {
        if (tMinus1.lastDigit === 2) {
          return { type: 'SELL', conf: 90, triggerDigit: tMinus1.lastDigit, triggerDesc: 'Flip+Accel(-2.0)' };
        }
      }
      return null;
    };

    let res = null;
    // Evaluation Priority: Structural 2 → Structural → Hybrid → Momentum → Reversal
    if (mode === 'structural2') res = checkStructural2();
    else if (mode === 'structural') res = checkStructural();
    else if (mode === 'hybrid') res = checkHybrid() || checkStructural2() || checkStructural();
    else if (mode === 'momentum') res = checkMomentum() || checkHybrid() || checkStructural2() || checkStructural();
    else if (mode === 'reversal') res = checkReversal();

    if (res) {
      // Global NO-TRADE filters (Removed streak 3,4 blocking as per latest data)
      if (Math.abs(t0.deltaChange) < eps) res = null;
      if (res) {
        const currentTickIndex = tickSeq;
        if (currentTickIndex - lastSignalTickIndex < cfg.postTradeCooldownTicks || Date.now() - lastTradeClosedAt < cfg.postTradeCooldownMs || realExecState !== 'IDLE') return null;
        lastSignalTickIndex = currentTickIndex;
        let conf = res.conf; if ((res.type === 'BUY' && !buyDigitBias) || (res.type === 'SELL' && !sellDigitBias)) conf -= 10;
        const sig = {
          type: res.type,
          price: t0.price,
          time: t0.epoch,
          result: 'PENDING',
          ticksAfter: [],
          confidence: Math.min(100, conf),
          strategy: mode,
          isReal: cfg.realTradeEnabled,
          triggerDigit: res.triggerDigit,
          triggerDesc: res.triggerDesc,
          startTickIndex: null,
          startTime: null
        };
        signals.push(sig); if (signals.length > 50) signals.shift(); recordSessionTrade(sig); updateSignalsUI();
        if (cfg.realTradeEnabled) { realExecState = 'OPEN_PENDING'; realLockReason = 'EXECUTING'; updateRealUI(); executeRealTrade(res.type); }
      }
    }
    return null;
  }

  // ── Infrastructure ────────────────────────────────────────────────────────
  function updateWinsLossesUI() {
    if (lastUI.wins !== realWins) {
      const we = document.getElementById('tt-wins');
      if (we) we.textContent = realWins;
      lastUI.wins = realWins;
    }
    if (lastUI.losses !== realLosses) {
      const le = document.getElementById('tt-losses');
      if (le) le.textContent = realLosses;
      lastUI.losses = realLosses;
    }
  }
  function updateSignalsUI() {
    const el = document.getElementById('tt-signals-list'); if (!el) return;
    el.innerHTML = ''; signals.slice(-10).reverse().forEach(sig => {
      const div = document.createElement('div'); div.className = `tt-signal tt-signal-${sig.type.toLowerCase()}`;
      const badge = sig.result === 'WIN' ? '<span class="tt-badge tt-badge-win">WIN</span>' : sig.result === 'LOSS' ? '<span class="tt-badge tt-badge-loss">LOSS</span>' : '<span class="tt-badge tt-badge-pending">...</span>';
      div.innerHTML = `<span class="tt-signal-type">${sig.type}</span><span class="tt-signal-price">${(sig.entryPriceReal || sig.price).toFixed(2)}</span><span class="tt-signal-time">${new Date(sig.time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})} [${sig.confidence}%]</span>${badge}`;
      el.appendChild(div);
    });
  }
  function updateRealUI() {
    const stateStr = realExecState + (realLockReason ? ` (${realLockReason})` : '');
    if (lastUI.state !== stateStr) {
      const stEl = document.getElementById('tt-real-state');
      if (stEl) {
        stEl.textContent = stateStr;
        stEl.style.color = { IDLE: '#3ecf60', RECOVERY: '#e04040', OPEN: '#f0c040', OPEN_PENDING: '#7ec8e3' }[realExecState] || '#fff';
      }
      lastUI.state = stateStr;
    }
    const pnlEl = document.getElementById('tt-real-pnl');
    if (pnlEl) {
      pnlEl.textContent = realPnl.toFixed(2);
      pnlEl.style.color = realPnl >= 0 ? '#3ecf60' : '#e04040';
    }
    updateWinsLossesUI();
  }
  function showAlert(msg) { const el = document.getElementById('tt-alert'); if (el) { el.textContent = msg; el.classList.add('tt-visible'); setTimeout(() => el.classList.remove('tt-visible'), 5000); } }
  function recordSessionTrade(sig) { sessionTradesAll.push(sig); if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift(); }
  function exportCSV() {
    if (!sessionTradesAll.length) return;
    const rows = [['Type', 'Strategy', 'Confidence', 'Price', 'Time', 'Result', 'Trigger Digit', 'Trigger Desc', 'Start Tick', 'Confirm Time']].concat(sessionTradesAll.map(s => [s.type, s.strategy, s.confidence, s.price.toFixed(2), s.time, s.result, s.triggerDigit ?? '', s.triggerDesc ?? '', s.startTickIndex ?? '', s.startTime ? new Date(s.startTime).toISOString() : '']));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-signals.csv'; a.click();
  }
  function exportRealCSV() {
    if (!realTrades.length) return;
    const rows = [['Time', 'Signal', 'Side', 'Result', 'PnL', 'Trigger Digit', 'Trigger Desc', 'Start Tick', 'Confirm Time']].concat(realTrades.map(t => {
      const s = t.signalRef || {};
      return [new Date(t.time).toISOString(), t.signal, t.side, t.result, t.pnl || '', s.triggerDigit ?? '', s.triggerDesc ?? '', t.startTickIndex ?? '', t.startTime ? new Date(t.startTime).toISOString() : ''];
    }));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-real.csv'; a.click();
  }
  function safeStorage(op, key, val) { try { if (op === 'get') return JSON.parse(localStorage.getItem(key)); if (op === 'set') localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } return null; }
  function saveCfg() { safeStorage('set', 'tt-cfg', cfg); }
  function loadCfg() { const stored = safeStorage('get', 'tt-cfg'); return Object.assign({ strategyMode: 'hybrid', epsilon: 0.2, realTradeEnabled: false, realTimeoutMs: 40000, realCooldownMs: 5000, postTradeCooldownTicks: 5, postTradeCooldownMs: 5000, debugSignals: true }, stored || {}); }
  function applyConfigToUI() { const dbg = document.getElementById('tt-cfg-debug'), re = document.getElementById('tt-cfg-real-enabled'), mode = document.getElementById('tt-cfg-strategy-mode'), eps = document.getElementById('tt-cfg-epsilon'); if (dbg) dbg.checked = cfg.debugSignals; if (re) re.checked = !!cfg.realTradeEnabled; if (mode) mode.value = cfg.strategyMode; if (eps) eps.value = cfg.epsilon; updateRealUI(); }
  function startWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = setInterval(() => { const now = Date.now(); if (wsState !== 'connected') return; if (lastTickProcessedAt > 0 && now - lastTickProcessedAt > WATCHDOG_TICK_TIMEOUT) { if (ws) ws.close(); scheduleReconnect(); } }, WATCHDOG_INTERVAL); }
  let subObserver = null, lastFlyoutNode = null;
  function setupFlyoutObserver() {
    if (flyoutObserver) return;
    flyoutObserver = new MutationObserver(() => {
      const flyout = document.querySelector(SEL_FLYOUT);
      if (flyout) {
        if (flyout !== lastFlyoutNode) {
          if (subObserver) subObserver.disconnect();
          lastFlyoutNode = flyout;
          subObserver = new MutationObserver(() => processFlyout(flyout));
          subObserver.observe(flyout, { childList: true, subtree: true, characterData: true });
          processFlyout(flyout);
        }
      } else {
        if (subObserver) { subObserver.disconnect(); subObserver = null; lastFlyoutNode = null; }
        if (realOpenCount !== 0) {
          realOpenCount = 0;
          updateRealExecStateFromDOM(0, { pnl: lastSeenPnL, result: lastSeenPnL > 0 ? 'WIN' : 'LOSS' });
        }
      }
    });
    flyoutObserver.observe(document.body, { childList: true, subtree: true });
  }

  function processFlyout(flyout) {
      const text = flyout.innerText;

      // Error Correction: Check if this is a PURCHASE confirmation
      if (text.includes("Contract bought") || text.includes("ID:")) {
        const sig = signals.find(s => s.result === 'PENDING' && s.isReal && !s.startTickIndex);
        if (sig) {
          // Corrected: The contract starts on the NEXT tick, not the current one
          sig.startTickIndex = tickSeq + 1;
          sig.startTime = Date.now();
          console.log(`[System] Contract Confirmed. Start Tick anchored at: ${sig.startTickIndex}`);

          const real = realTrades.find(t => t.result === 'PENDING' && !t.startTickIndex);
          if (real) {
            real.startTickIndex = sig.startTickIndex;
            real.startTime = sig.startTime;
          }
        }
      }
      const hasProfitClass = !!flyout.querySelector('.dc-contract-card--profit, .dc-contract-card__profit-loss--is-profit, .dc-contract-card-item__body--profit');
      const hasLossClass = !!flyout.querySelector('.dc-contract-card--loss, .dc-contract-card__profit-loss--is-loss, .dc-contract-card-item__body--loss');

      // Track real-time PnL from the flyout while trade is open
      // Use specific selectors if possible, otherwise regex on innerText
      const pnlEl = flyout.querySelector('.dc-contract-card__profit-loss-label, .dc-status-colored-text, .dc-contract-card-item__body--profit span[data-testid="dt_span"], .dc-contract-card-item__body--loss span[data-testid="dt_span"]');
      const profitValEl = flyout.querySelector('.dc-contract-card-item__body--profit span[data-testid="dt_span"]');
      const lossValEl = flyout.querySelector('.dc-contract-card-item__body--loss span[data-testid="dt_span"]');

      if (profitValEl || lossValEl) {
        const val = parseFloat((profitValEl || lossValEl).innerText.replace(/[^-0-9.]/g, ''));
        if (!isNaN(val)) lastSeenPnL = val;
      } else if (pnlEl) {
        const val = parseFloat(pnlEl.innerText.replace(/[^-0-9.]/g, ''));
        if (!isNaN(val)) lastSeenPnL = val;
      } else {
        const pnlRegex = /(?:Total\s+profit\/loss|Profit\/Loss)[:\s]*([+-]?\d+\.?\d*)/i;
        const pnlMatch = text.match(pnlRegex);
        if (pnlMatch) {
          lastSeenPnL = parseFloat(pnlMatch[1]);
        }
      }

      let count = text.includes('no open positions') ? 0 : (text.match(/(\d+)\s+open\s+position/i) ? parseInt(text.match(/(\d+)\s+open\s+position/i)[1], 10) : realOpenCount);
      let closedResult = null;

      // EXPLICIT WIN/LOSS DETECTION
      // Definite Win: Profit class or positive lastSeenPnL
      const isDefiniteWin = hasProfitClass || lastSeenPnL > 0;
      // Definite Loss: Contract value 0.00, Loss class, "Loss" text, or non-positive lastSeenPnL
      const isDefiniteLoss = hasLossClass || /Contract\s+value:\s*0\.00/i.test(text) || /Loss/i.test(text) || lastSeenPnL < 0 || (lastSeenPnL === 0 && !isDefiniteWin);

      // Detection of terminal state
      // 'Total profit/loss' is present while open, so only use it if 'Closed' or '0.00' is also present
      const isClosed = text.includes('Closed') || /Contract\s+value:\s*0\.00/i.test(text);

      if (isClosed) {
        closedResult = { pnl: lastSeenPnL, result: isDefiniteWin ? 'WIN' : 'LOSS' };
      } else if (text.includes('no open positions') && realExecState === 'OPEN') {
        closedResult = { pnl: lastSeenPnL, result: isDefiniteWin ? 'WIN' : 'LOSS' };
      }

      if (count !== realOpenCount || closedResult) {
        realOpenCount = count;
        updateRealExecStateFromDOM(count, closedResult);
      }
  }
  function updateRealExecStateFromDOM(count, closedResult) {
    if (closedResult && (realExecState === 'OPEN' || realExecState === 'OPEN_PENDING' || realExecState === 'RECOVERY')) {
      finalizeRealTrade(closedResult);
      realExecState = 'IDLE';
      realLockReason = '';
      lastSeenPnL = 0;
    } else if (count === 0 && (realExecState === 'OPEN' || realExecState === 'RECOVERY')) {
      // Final fallback if flyout disappears and we didn't catch a closed result
      finalizeRealTrade({ pnl: lastSeenPnL, result: lastSeenPnL > 0 ? 'WIN' : 'LOSS' });
      realExecState = 'IDLE';
      realLockReason = '';
      lastSeenPnL = 0;
    }
    if (count > 0 && ['IDLE', 'OPEN_PENDING'].includes(realExecState)) {
      realExecState = 'OPEN';
      lastSeenPnL = 0;
      const pending = signals.find(s => s.result === 'PENDING' && !s.entryPriceReal);
      if (pending && ticks.length) {
        pending.entryPriceReal = ticks[ticks.length - 1].price;
        updateSignalsUI();
      }
    }
    updateRealUI();
  }
  function finalizeRealTrade(res) {
    if (!realTrades.length) return;
    const last = realTrades[realTrades.length - 1];
    if (last.result !== 'PENDING') return;
    last.result = res.result || 'LOSS';
    last.pnl = res.pnl || 0;
    if (last.result === 'WIN') realWins++;
    else realLosses++;
    realPnl += last.pnl;
    const simTrade = last.signalRef || signals.find(s => s.result === 'PENDING' && s.isReal);
    if (simTrade) {
      simTrade.result = res.result;
      simTrade.priceAfter = ticks.length ? ticks[ticks.length - 1].price : simTrade.price;
    }
    lastTradeClosedAt = Date.now();
    lastTradeClosedTick = tickSeq;
    if (realExecTimer) { clearTimeout(realExecTimer); realExecTimer = null; }
    updateRealUI();
    updateSignalsUI();
  }
  async function executeRealTrade(side) {
    if (Date.now() - lastRealTradeAt < cfg.realCooldownMs) return;
    const buyLabel = side === 'BUY' ? 'Rise' : 'Fall', activeClass = side === 'BUY' ? CLASS_RISE_ACTIVE : CLASS_FALL_ACTIVE;
    try {
      if (!await setRealTradeSide(buyLabel, activeClass)) throw new Error('side_failed');
      if (!await waitRealBuyReady()) throw new Error('not_ready');
      const btn = document.querySelector(SEL_PURCHASE_BTN); if (!btn || !btn.classList.contains(activeClass)) throw new Error('btn_mismatch');
      simulateExternalClick(btn); lastRealTradeAt = Date.now();
      const signalToMark = signals.find(s => s.result === 'PENDING' && s.isReal);
      realTrades.push({ time: Date.now(), signal: side, side: buyLabel, result: 'PENDING', signalRef: signalToMark, startTickIndex: null, startTime: null });
      realExecTimer = setTimeout(() => { if (['OPEN_PENDING', 'OPEN'].includes(realExecState)) { realExecState = 'RECOVERY'; realLockReason = 'TIMEOUT'; updateRealUI(); } }, cfg.realTimeoutMs);
    } catch (e) { realLockReason = 'ERR:' + e.message; updateRealUI(); setTimeout(() => { if (realExecState === 'OPEN_PENDING') { realExecState = 'IDLE'; realLockReason = ''; updateRealUI(); } }, 3000); }
  }
  async function setRealTradeSide(label, activeClass) {
    for (let i = 0; i < 3; i++) {
      const btn = document.querySelector(SEL_PURCHASE_BTN);
      if (btn && btn.classList.contains(activeClass)) return true;
      const target = Array.from(document.querySelectorAll(SEL_SIDE_BTNS)).find(b => b.innerText.includes(label));
      if (target) {
        simulateExternalClick(target);
        await new Promise(r => setTimeout(r, 150)); // Faster response
      } else {
        await new Promise(r => setTimeout(r, 50));
      }
    }
    return false;
  }
  function simulateExternalClick(el) { const opts = { bubbles: true, cancelable: true, view: window }; el.dispatchEvent(new MouseEvent('mouseenter', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts)); el.focus(); el.dispatchEvent(new MouseEvent('mouseup', opts)); el.dispatchEvent(new MouseEvent('click', opts)); el.dispatchEvent(new MouseEvent('mouseleave', opts)); }
  async function waitRealBuyReady() {
    for (let i = 0; i < 5; i++) {
      const btn = document.querySelector(SEL_PURCHASE_BTN);
      if (btn && btn.getAttribute('data-loading') !== 'true' && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      await new Promise(r => setTimeout(r, 100)); // Shorter wait increments
    }
    return false;
  }
  function init() { if (document.getElementById('tt-overlay')) return; cfg = loadCfg(); buildOverlay(); connect(); startWatchdog(); setupFlyoutObserver(); window._tt_cfg = cfg; window._tt_detect = detectSignal; }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
