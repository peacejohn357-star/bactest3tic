/* ====================================================
 * 3Tick Scalper – Step Index 100 Assistant
 * Content script for dtrader.deriv.com
 * ==================================================== */
(function () {
  'use strict';

  // ── Constants & config ────────────────────────────────────────────────────
  const WS_URL          = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  const WS_URL_FALLBACK = 'wss://ws.deriv.com/websockets/v3?app_id=1089';
  const FALLBACK_AFTER  = 3;     // consecutive failures before trying fallback endpoint
  const TICK_BUF        = 200;
  const SPEED_BUF       = 1000;   // Buffer for calculating speed percentiles
  const RECONNECT_BASE  = 4000;  // ms – initial reconnect delay
  const RECONNECT_MAX   = 64000; // ms – reconnect delay cap
  const SESSION_HISTORY_CAP    = 5000;  // maximum full-session trade history for CSV export
  const WATCHDOG_INTERVAL      = 5000;  // ms – watchdog check frequency
  const WATCHDOG_TICK_TIMEOUT  = 25000; // ms – connected but no tick → re-subscribe (stage 1)
  const WATCHDOG_EVAL_TIMEOUT  = 20000; // ms – ticks arriving but eval stalled → reset eval state

  // ── DOM Selectors for Real Execution ──────────────────────────────────────
  const SEL_SIDE_BTNS    = '.trade-params__option > button.item';
  const SEL_PURCHASE_BTN = 'button.purchase-button.purchase-button--single';
  const CLASS_RISE_ACTIVE = 'quill__color--primary-purchase';
  const CLASS_FALL_ACTIVE = 'quill__color--primary-sell';
  const SEL_FLYOUT       = '.dc-flyout';

  let cfg = {
    tickSize:          0.1,         // Step Index 100 minimum price movement
    strategyMode:      'hybrid',    // 'momentum' | 'reversal' | 'structural' | 'hybrid'
    epsilon:           0.015,       // threshold for "delta_change ≈ 0"
    // ── Real-trade execution settings ──────────────────────────────────────
    realTradeEnabled: false,   // master toggle for real trade execution
    realTimeoutMs:    40000,   // ms – wait for close confirmation before RECOVERY
    realCooldownMs:   5000,    // ms – minimum time between real trade executions
    postTradeCooldownTicks: 5, // ticks to wait after a trade closes before new entry
    postTradeCooldownMs:    5000, // ms to wait after a trade closes before new entry
    debugSignals:     true,    // log signal accept/reject reasons to console
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks       = [];  // { price, epoch, receivedAt, deltaSteps, direction, speed, lastDigit, deltaChange, upStreak, downStreak }
  let speedHistory = []; // [absSpeed, ...]
  let sHigh       = 0;
  let sLow        = 0;
  let signals     = [];  // { type, price, time, result, ticksAfter, priceAfter, confidence, strategy }
  let sessionTradesAll = []; // full session trade history for CSV export
  let wins        = 0;
  let losses      = 0;
  let tickSeq                 = 0;
  let lastSignalTickIndex     = -999;
  let upStreak = 0;
  let downStreak = 0;

  let lastTickProcessedAt  = 0;    // Date.now() of last tick received (for watchdog)
  let lastSignalEvalAt     = 0;    // Date.now() of last successful detectSignal() call (for watchdog)
  let watchdogInterval     = null; // setInterval handle for the watchdog
  let evalErrorCount       = 0;    // cumulative count of detectSignal() exceptions
  let lastSignalFiredAt    = 0;    // Date.now() of last successfully fired signal

  let flyoutObserver = null;

  // ── Real-trade state ──────────────────────────────────────────────────────
  let realExecState   = 'IDLE'; // IDLE | OPEN_PENDING | OPEN | CLOSE_PENDING | RECOVERY
  let realTrades      = [];     // { time, signal, side, result, pnl, ... }
  let realOpenCount   = 0;
  let realWins        = 0;
  let realLosses      = 0;
  let realPnl         = 0;
  let realLockReason  = '';     // reason for blocking trade (e.g. "OPEN_POSITION")
  let lastRealResult  = null;   // { result, pnl } from last closed real trade
  let realExecTimer   = null;   // timeout handle for RECOVERY transition
  let lastRealTradeAt = 0;      // Date.now() of last execution click
  let lastTradeClosedAt = 0;    // Date.now() when last trade finished
  let lastTradeClosedTick = -999; // tickSeq when last trade finished

  let ws             = null;
  let wsState        = 'disconnected';
  let reconnectTimer = null;
  let resolvedSymbol = null;
  let manualClose    = false;
  let reconnectDelay = RECONNECT_BASE;
  let failCount      = 0;
  let usingFallback  = false;

  // ── Overlay build ─────────────────────────────────────────────────────────
  function buildOverlay () {
    if (document.getElementById('tt-overlay')) return;

    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Timing V2</span>
        <div class="tt-header-btns">
          <button id="tt-min-btn"   title="Minimise">_</button>
          <button id="tt-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="tt-body">
        <div class="tt-row">
          <span class="tt-label">Status</span>
          <span class="tt-val" id="tt-status">
            <span class="tt-dot tt-dot-disconnected"></span>Disconnected
          </span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Last Price</span>
          <span class="tt-val" id="tt-price">–</span>
        </div>
        <div class="tt-row">
          <span class="tt-label">S_Low / S_High</span>
          <span class="tt-val" id="tt-speed-stats">0.00 / 0.00</span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Session W/L</span>
          <span class="tt-val">
            <span class="tt-wins"   id="tt-wins">0</span>
            &nbsp;/&nbsp;
            <span class="tt-losses" id="tt-losses">0</span>
          </span>
        </div>
        <div class="tt-row"><span class="tt-label">Signals</span></div>
        <div id="tt-signals-list"></div>

        <div class="tt-config-section-label">Real Execution</div>
        <div id="tt-real-panel">
          <div class="tt-row">
            <span class="tt-label">Exec State</span>
            <span class="tt-val" id="tt-real-state">IDLE</span>
          </div>
          <div class="tt-row">
            <span class="tt-label">Real W/L</span>
            <span class="tt-val">
              <span class="tt-wins"   id="tt-real-wins">0</span>
              &nbsp;/&nbsp;
              <span class="tt-losses" id="tt-real-losses">0</span>
            </span>
          </div>
          <div class="tt-row">
            <span class="tt-label">Real PnL</span>
            <span class="tt-val" id="tt-real-pnl">0.00</span>
          </div>
          <button id="tt-real-export">⬇ Export Real CSV</button>
          <button id="tt-real-reset" style="background:#3d1a1a;color:#e04040;margin-top:2px;">Reset Real Engine</button>
        </div>

        <button id="tt-config-toggle">⚙ settings</button>
        <div id="tt-config">
          <div class="tt-config-row">
            <label>Strategy Mode</label>
            <select id="tt-cfg-strategy-mode">
              <option value="momentum">Momentum</option>
              <option value="reversal">Reversal</option>
              <option value="structural">Structural</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </div>
          <div class="tt-config-row">
            <label>Epsilon (ε)</label>
            <input type="number" id="tt-cfg-epsilon" min="0" max="0.1" step="0.001" value="0.015">
          </div>
          <div class="tt-config-row">
            <label>Debug signals</label>
            <input type="checkbox" id="tt-cfg-debug">
          </div>
          <div class="tt-config-section-label">Real Trade Master</div>
          <div class="tt-config-row">
            <label style="color:#f0a060;font-weight:700;">Enable Real Execution</label>
            <label class="tt-switch">
              <input type="checkbox" id="tt-cfg-real-enabled">
              <span class="tt-slider"></span>
            </label>
          </div>
        </div>
        <button id="tt-export">⬇ Export CSV</button>
      </div>
      <div id="tt-alert"></div>
    `;

    document.body.appendChild(el);

    const saved = safeStorage('get', 'tt-pos');
    if (saved) {
      el.style.right = 'auto';
      el.style.left  = saved.left + 'px';
      el.style.top   = saved.top  + 'px';
    }

    makeDraggable(el);
    bindButtons(el);
  }

  function makeDraggable (el) {
    const header = document.getElementById('tt-header');
    let ox = 0, oy = 0;
    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
    function onMove (e) {
      const left = e.clientX - ox;
      const top  = e.clientY - oy;
      el.style.right = 'auto';
      el.style.left  = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  left)) + 'px';
      el.style.top   = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, top))  + 'px';
    }
    function onUp () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      safeStorage('set', 'tt-pos', { left: parseInt(el.style.left), top: parseInt(el.style.top) });
    }
  }

  function bindButtons (el) {
    document.getElementById('tt-min-btn').addEventListener('click', function () {
      el.classList.toggle('tt-minimized');
      this.textContent = el.classList.contains('tt-minimized') ? '□' : '_';
    });
    document.getElementById('tt-close-btn').addEventListener('click', function () {
      manualClose = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { ws.close(); ws = null; }
      el.remove();
    });
    document.getElementById('tt-config-toggle').addEventListener('click', function () {
      document.getElementById('tt-config').classList.toggle('tt-open');
    });

    document.getElementById('tt-cfg-strategy-mode').addEventListener('change', function () {
      cfg.strategyMode = this.value;
      saveCfg();
    });
    document.getElementById('tt-cfg-epsilon').addEventListener('change', function () {
      cfg.epsilon = parseFloat(this.value) || 0.015;
      saveCfg();
    });
    document.getElementById('tt-cfg-debug').addEventListener('change', function () {
      cfg.debugSignals = this.checked;
      saveCfg();
    });
    document.getElementById('tt-cfg-real-enabled').addEventListener('change', function () {
      cfg.realTradeEnabled = this.checked;
      saveCfg();
    });
    document.getElementById('tt-real-export').addEventListener('click', exportRealCSV);
    document.getElementById('tt-real-reset').addEventListener('click', function () {
      if (confirm('Reset real-trade engine to IDLE and clear lock?')) {
        realExecState = 'IDLE';
        realLockReason = '';
        realOpenCount = 0;
        clearTimeout(realExecTimer);
        realExecTimer = null;
        updateRealUI();
        showAlert('Real execution engine reset.');
      }
    });
    document.getElementById('tt-export').addEventListener('click', exportCSV);
    applyConfigToUI();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function resolveSymbol (symbols) {
    var candidates = ['stpRNG', 'STPRNG'];
    for (var i = 0; i < candidates.length; i++) {
      if (symbols.find(function (s) { return s.symbol === candidates[i]; })) {
        return candidates[i];
      }
    }
    var byName = symbols.find(function (s) {
      return /step\s*index\s*100/i.test(s.display_name) || /step\s*100/i.test(s.display_name);
    });
    return byName ? byName.symbol : (symbols.find(s => /step/i.test(s.display_name))?.symbol || null);
  }

  function connect () {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    var url = usingFallback ? WS_URL_FALLBACK : WS_URL;
    setWsState('connecting');
    ws = new WebSocket(url);
    ws.addEventListener('open', function () {
      setWsState('connected');
      reconnectDelay = RECONNECT_BASE;
      failCount = 0; usingFallback = false;
      lastTickProcessedAt = Date.now();
      lastSignalEvalAt    = Date.now();
      ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    });
    ws.addEventListener('message', function (e) {
      var msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.error) return;
      if (msg.msg_type === 'active_symbols') {
        var sym = resolveSymbol(msg.active_symbols || []);
        if (sym) {
          resolvedSymbol = sym;
          ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 }));
        }
        return;
      }
      if (msg.msg_type === 'tick') { handleTick(msg.tick); }
    });
    ws.addEventListener('close', function (e) {
      setWsState('disconnected');
      resolvedSymbol = null;
      if (!manualClose) scheduleReconnect();
    });
    ws.addEventListener('error', function (e) {
      setWsState('disconnected');
      ws.close();
    });
  }

  function scheduleReconnect () {
    if (reconnectTimer) return;
    failCount++;
    if (failCount >= FALLBACK_AFTER) { usingFallback = !usingFallback; failCount = 0; }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  function setWsState (state) {
    wsState = state;
    const el = document.getElementById('tt-status');
    if (!el) return;
    const dotClass = { connected: 'tt-dot-connected', connecting: 'tt-dot-connecting', disconnected: 'tt-dot-disconnected' };
    const label    = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
    el.innerHTML = `<span class="tt-dot ${dotClass[state]}"></span>${label[state]}`;
  }

  // ── Percentile Calculation ────────────────────────────────────────────────
  function calculatePercentiles() {
    if (speedHistory.length < 10) return;
    const sorted = speedHistory.slice().sort((a, b) => a - b);
    sLow  = sorted[Math.floor(sorted.length * 0.3)];
    sHigh = sorted[Math.floor(sorted.length * 0.7)];

    const statsEl = document.getElementById('tt-speed-stats');
    if (statsEl) statsEl.textContent = `${sLow.toFixed(4)} / ${sHigh.toFixed(4)}`;
  }

  // ── Tick handling ─────────────────────────────────────────────────────────
  function handleTick (tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote);
    const epoch = tick.epoch;
    const now   = Date.now();
    tickSeq++;

    const prevTick = ticks.length ? ticks[ticks.length - 1] : null;
    const delta = prevTick ? price - prevTick.price : 0;
    const deltaSteps = delta / 0.1;
    const direction = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    const deltaTime = prevTick ? (now - prevTick.receivedAt) : 1000;
    const speed = deltaTime > 0 ? deltaSteps / deltaTime : 0;
    const absSpeed = Math.abs(speed);
    const lastDigit = Math.floor(Math.round(price * 100) / 10) % 10;
    const deltaChange = prevTick ? deltaSteps - prevTick.deltaSteps : 0;

    if (delta > 0) { upStreak++; downStreak = 0; }
    else if (delta < 0) { downStreak++; upStreak = 0; }
    else { upStreak = 0; downStreak = 0; }

    const state = {
        epoch, price, direction, deltaSteps, deltaTime, speed, absSpeed,
        upStreak, downStreak, lastDigit, deltaChange,
        receivedAt: now
    };

    ticks.push(state);
    if (ticks.length > TICK_BUF) ticks.shift();

    speedHistory.push(absSpeed);
    if (speedHistory.length > SPEED_BUF) speedHistory.shift();
    calculatePercentiles();

    lastTickProcessedAt = Date.now();

    const priceEl = document.getElementById('tt-price');
    if (priceEl) priceEl.textContent = price.toFixed(2);

    try {
      detectSignal();
      lastSignalEvalAt = Date.now();
    } catch (e) {
      evalErrorCount++;
      console.error('[3Tick] eval error', e);
    }

    scorePendingSignals(price);
  }

  // ── Signal detection ──────────────────────────────────────────────────────
  function detectSignal () {
    const n = ticks.length;
    if (n < 2) return null;
    const t0 = ticks[n - 1];
    const mode = cfg.strategyMode;
    const eps = cfg.epsilon;

    let candidate = null;
    let confidence = 0;
    let rejectReason = '';

    // ────────────────────────────────────────────────────────────────────────
    if (mode === 'momentum') {
      // ✅ BUY
      if (t0.direction === 1 && t0.upStreak <= 3 && t0.deltaChange > 0 && t0.speed >= sHigh && [0, 6].includes(t0.lastDigit)) {
        candidate = 'BUY'; confidence = 80;
      }
      // ✅ SELL
      else if (t0.direction === -1 && t0.downStreak <= 3 && t0.deltaChange < 0 && Math.abs(t0.speed) >= sHigh && [2, 8].includes(t0.lastDigit)) {
        candidate = 'SELL'; confidence = 80;
      }
      // ❌ NO TRADE
      if (candidate) {
          if (Math.max(t0.upStreak, t0.downStreak) >= 5) { candidate = null; rejectReason = 'streak_too_high'; }
          else if (t0.absSpeed <= sHigh) { candidate = null; rejectReason = 'speed_not_high'; } // sHigh is top 30%
          else if (Math.abs(t0.deltaChange) < eps) { candidate = null; rejectReason = 'delta_change_low'; }
      }
    }
    // ────────────────────────────────────────────────────────────────────────
    else if (mode === 'reversal') {
      // ✅ BUY
      if (t0.direction === -1 && t0.downStreak >= 5 && t0.absSpeed <= sLow && t0.deltaChange >= 0 && [0, 5].includes(t0.lastDigit)) {
        candidate = 'BUY'; confidence = 85;
      }
      // ✅ SELL
      else if (t0.direction === 1 && t0.upStreak >= 5 && t0.absSpeed <= sLow && t0.deltaChange <= 0 && [3, 7].includes(t0.lastDigit)) {
        candidate = 'SELL'; confidence = 85;
      }
      // ❌ NO TRADE
      if (candidate) {
          if (t0.absSpeed >= sHigh) { candidate = null; rejectReason = 'speed_too_high'; }
          else if (Math.max(t0.upStreak, t0.downStreak) < 5) { candidate = null; rejectReason = 'streak_too_low'; }
          else if (candidate === 'BUY' ? t0.deltaChange < 0 : t0.deltaChange > 0) { candidate = null; rejectReason = 'momentum_increasing'; }
      }
    }
    // ────────────────────────────────────────────────────────────────────────
    else if (mode === 'structural') {
      // ✅ BUY
      if ([0, 5, 6].includes(t0.lastDigit) && t0.deltaChange >= 0) {
        candidate = 'BUY'; confidence = 90;
      }
      // ✅ SELL
      else if ([2, 3, 8].includes(t0.lastDigit) && t0.deltaChange <= 0) {
        candidate = 'SELL'; confidence = 90;
      }
      // ❌ NO TRADE
      if (candidate) {
          if ([1, 4, 7, 9].includes(t0.lastDigit)) { candidate = null; rejectReason = 'digit_excluded'; }
          else if (Math.abs(t0.deltaChange) < eps) { candidate = null; rejectReason = 'delta_change_low'; }
      }
    }
    // ────────────────────────────────────────────────────────────────────────
    else if (mode === 'hybrid') {
        // ✅ BUY
        if ([0, 5, 6].includes(t0.lastDigit) && t0.deltaChange > 0 && t0.upStreak <= 3) {
            candidate = 'BUY'; confidence = 95;
        }
        // ✅ SELL
        else if ([2, 3, 8].includes(t0.lastDigit) && t0.deltaChange < 0 && t0.downStreak <= 3) {
            candidate = 'SELL'; confidence = 95;
        }
        // ❌ NO TRADE
        if (candidate) {
            if (Math.max(t0.upStreak, t0.downStreak) >= 5) { candidate = null; rejectReason = 'streak_too_high'; }
            else if (Math.abs(t0.deltaChange) < eps) { candidate = null; rejectReason = 'delta_change_low'; }
            else if (t0.absSpeed > sLow && t0.absSpeed < sHigh) { candidate = null; rejectReason = 'speed_mid_range'; }
        }
    }

    if (candidate) {
        const currentTickIndex = tickSeq;
        if (currentTickIndex - lastSignalTickIndex < cfg.postTradeCooldownTicks) {
            if (cfg.debugSignals) console.log(`[3Tick][${mode}] rejected: cooldown ticks`);
            return null;
        }
        if (Date.now() - lastTradeClosedAt < cfg.postTradeCooldownMs) {
            if (cfg.debugSignals) console.log(`[3Tick][${mode}] rejected: cooldown ms`);
            return null;
        }
        if (realExecState !== 'IDLE') {
            if (cfg.debugSignals) console.log(`[3Tick][${mode}] rejected: engine busy (${realExecState})`);
            return null;
        }

        lastSignalTickIndex = currentTickIndex;
        const sig = { type: candidate, price: t0.price, time: t0.epoch, result: 'PENDING', ticksAfter: [], confidence, strategy: mode };
        signals.push(sig);
        if (signals.length > 50) signals.shift();
        recordSessionTrade(sig);
        updateSignalsUI();

        if (cfg.debugSignals) console.log(`[3Tick][${mode}] ACCEPTED ${candidate} score=${confidence}% digit=${t0.lastDigit} speed=${t0.speed.toFixed(4)} dc=${t0.deltaChange.toFixed(2)}`);

        if (cfg.realTradeEnabled) {
            realExecState = 'OPEN_PENDING';
            realLockReason = 'EXECUTING';
            updateRealUI();
            executeRealTrade(candidate);
        }
    } else if (rejectReason && cfg.debugSignals) {
        // Log rejection if it was a near-miss (optional, can be noisy)
    }

    return null;
  }

  function scorePendingSignals (currentPrice) {
    signals.forEach(function (sig) {
      if (sig.result !== 'PENDING') return;
      sig.ticksAfter.push(currentPrice);
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function updateWinsLossesUI () {
    const we = document.getElementById('tt-wins');
    const le = document.getElementById('tt-losses');
    if (we) we.textContent = realWins;
    if (le) le.textContent = realLosses;
  }

  function updateSignalsUI () {
    const el = document.getElementById('tt-signals-list');
    if (!el) return;
    el.innerHTML = '';
    const show = signals.slice(-10).reverse();
    show.forEach(function (sig) {
      const div  = document.createElement('div');
      const cls  = sig.type === 'BUY' ? 'tt-signal-buy' : 'tt-signal-sell';
      const badge = sig.result === 'WIN'     ? '<span class="tt-badge tt-badge-win">WIN</span>'
                  : sig.result === 'LOSS'    ? '<span class="tt-badge tt-badge-loss">LOSS</span>'
                  :                           '<span class="tt-badge tt-badge-pending">…</span>';
      div.className = `tt-signal ${cls}`;
      const fillPrice = sig.entryPriceReal !== undefined ? sig.entryPriceReal : sig.price;
      div.innerHTML = `
        <span class="tt-signal-type">${sig.type}</span>
        <span class="tt-signal-price">${fillPrice.toFixed(2)}</span>
        <span class="tt-signal-time">${fmtTime(sig.time)} [${sig.confidence}%]</span>
        ${badge}
      `;
      el.appendChild(div);
    });
  }

  function showAlert (msg) {
    const el = document.getElementById('tt-alert');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('tt-visible');
    setTimeout(function () { el.classList.remove('tt-visible'); }, 5000);
  }

  function fmtTime (epoch) {
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function recordSessionTrade (sig) {
    sessionTradesAll.push(sig);
    if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift();
  }

  function exportCSV () {
    const rows = [['Type', 'Strategy', 'Confidence', 'Signal Price', 'Fill Price', 'Time', 'Result', 'Exit Price']];
    sessionTradesAll.forEach(function (s) {
      rows.push([
        s.type, s.strategy, s.confidence,
        s.price.toFixed(2),
        s.entryPriceReal !== undefined ? s.entryPriceReal.toFixed(2) : s.price.toFixed(2),
        fmtTime(s.time),
        s.result,
        s.priceAfter !== undefined ? s.priceAfter.toFixed(2) : '',
      ]);
    });
    const csv  = rows.map(function (r) { return r.join(','); }).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = '3tick-signals-' + Date.now() + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportRealCSV () {
    if (!realTrades.length) { showAlert('No real-trade history.'); return; }
    const headers = ['Time', 'Signal', 'Side', 'Result', 'PnL'];
    const rows = [headers].concat(realTrades.map(t => [
        new Date(t.time).toISOString(), t.signal, t.side, t.result, t.pnl !== undefined ? t.pnl.toFixed(2) : ''
    ]));
    const csv  = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = '3tick-real-trades-' + Date.now() + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function safeStorage (op, key, value) {
    try {
      if (op === 'get')  return JSON.parse(localStorage.getItem(key));
      if (op === 'set')  localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {} return null;
  }

  function saveCfg () { safeStorage('set', 'tt-cfg', cfg); }
  function loadCfg () {
    const stored = safeStorage('get', 'tt-cfg');
    const def = { strategyMode: 'hybrid', epsilon: 0.015, realTradeEnabled: false, realTimeoutMs: 40000, realCooldownMs: 5000, postTradeCooldownTicks: 5, postTradeCooldownMs: 5000, debugSignals: true };
    return Object.assign(def, stored || {});
  }

  function updateRealUI () {
    const stEl = document.getElementById('tt-real-state'), winsEl = document.getElementById('tt-real-wins'), lossEl = document.getElementById('tt-real-losses'), pnlEl = document.getElementById('tt-real-pnl');
    if (stEl) {
        stEl.textContent = realExecState + (realLockReason ? ` (${realLockReason})` : '');
        const colors = { IDLE: '#3ecf60', RECOVERY: '#e04040', OPEN: '#f0c040', OPEN_PENDING: '#7ec8e3' };
        stEl.style.color = colors[realExecState] || '#fff';
    }
    if (winsEl) winsEl.textContent = realWins;
    if (lossEl) lossEl.textContent = realLosses;
    if (pnlEl) { pnlEl.textContent = realPnl.toFixed(2); pnlEl.style.color = realPnl >= 0 ? '#3ecf60' : '#e04040'; }
  }

  function applyConfigToUI () {
    const dbg = document.getElementById('tt-cfg-debug'), re = document.getElementById('tt-cfg-real-enabled'), mode = document.getElementById('tt-cfg-strategy-mode'), eps = document.getElementById('tt-cfg-epsilon');
    if (dbg) dbg.checked = cfg.debugSignals;
    if (re) re.checked = !!cfg.realTradeEnabled;
    if (mode) mode.value = cfg.strategyMode;
    if (eps) eps.value = cfg.epsilon;
    updateRealUI();
  }

  function startWatchdog () {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = setInterval(function () {
      const now = Date.now(); if (wsState !== 'connected') return;
      const tickAge = lastTickProcessedAt > 0 ? now - lastTickProcessedAt : -1;
      const evalAge = lastSignalEvalAt    > 0 ? now - lastSignalEvalAt    : -1;
      if (tickAge < 0 || tickAge > WATCHDOG_TICK_TIMEOUT) {
        if (ws) { try { ws.close(); } catch (_) {} ws = null; }
        scheduleReconnect();
      } else if (evalAge > WATCHDOG_EVAL_TIMEOUT) {
        lastSignalEvalAt = now;
      }
    }, WATCHDOG_INTERVAL);
  }

  function setupFlyoutObserver () {
    if (flyoutObserver) return;
    flyoutObserver = new MutationObserver(function () {
      const flyout = document.querySelector(SEL_FLYOUT);
      if (!flyout) { if (realOpenCount !== 0) { realOpenCount = 0; updateRealExecStateFromDOM(0, null); } return; }
      const text = flyout.innerText;
      let count = text.includes('no open positions') ? 0 : (text.match(/(\d+)\s+open\s+position/i) ? parseInt(text.match(/(\d+)\s+open\s+position/i)[1], 10) : realOpenCount);
      let closedResult = null;
      const pnlMatch = text.match(/Closed\s+([+-]?\d+\.?\d*)\s+USD/i);
      if (pnlMatch) closedResult = { pnl: parseFloat(pnlMatch[1]), result: parseFloat(pnlMatch[1]) >= 0 ? 'WIN' : 'LOSS' };
      else if (text.includes('no open positions') && realExecState === 'OPEN') closedResult = { pnl: 0, result: 'UNKNOWN' };
      if (count !== realOpenCount || closedResult) { realOpenCount = count; updateRealExecStateFromDOM(count, closedResult); }
    });
    flyoutObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function updateRealExecStateFromDOM (count, closedResult) {
    if (closedResult && ['OPEN', 'OPEN_PENDING', 'RECOVERY'].includes(realExecState)) { finalizeRealTrade(closedResult); realExecState = 'IDLE'; realLockReason = ''; }
    else if (count === 0 && ['OPEN', 'RECOVERY'].includes(realExecState)) { finalizeRealTrade({ pnl: 0, result: 'UNKNOWN' }); realExecState = 'IDLE'; realLockReason = ''; }
    if (count > 0 && ['IDLE', 'OPEN_PENDING'].includes(realExecState)) { realExecState = 'OPEN'; syncSimulatorEntryToMarket(); }
    updateRealUI();
  }

  function syncSimulatorEntryToMarket () {
    const pending = signals.find(s => s.result === 'PENDING' && !s.entryPriceReal);
    if (pending && ticks.length) { pending.entryPriceReal = ticks[ticks.length - 1].price; updateSignalsUI(); }
  }

  function finalizeRealTrade (res) {
    if (!realTrades.length) return;
    const last = realTrades[realTrades.length - 1]; if (last.result !== 'PENDING') return;
    last.result = res.result; last.pnl = res.pnl;
    if (res.result === 'WIN') realWins++; else if (res.result === 'LOSS') realLosses++;
    realPnl += res.pnl;
    const simTrade = signals.find(s => s.result === 'PENDING');
    if (simTrade) { simTrade.result = res.result; simTrade.priceAfter = ticks.length ? ticks[ticks.length - 1].price : simTrade.price; updateWinsLossesUI(); }
    lastTradeClosedAt = Date.now(); lastTradeClosedTick = tickSeq;
    clearTimeout(realExecTimer); realExecTimer = null; updateRealUI();
  }

  async function executeRealTrade (side) {
    if (Date.now() - lastRealTradeAt < cfg.realCooldownMs) return;
    const buyLabel = side === 'BUY' ? 'Rise' : 'Fall', activeClass = side === 'BUY' ? CLASS_RISE_ACTIVE : CLASS_FALL_ACTIVE;
    try {
      if (!await setRealTradeSide(buyLabel, activeClass)) throw new Error('side_failed');
      if (!await waitRealBuyReady()) throw new Error('not_ready');
      const btn = document.querySelector(SEL_PURCHASE_BTN); if (!btn || !btn.classList.contains(activeClass)) throw new Error('btn_mismatch');
      simulateExternalClick(btn); lastRealTradeAt = Date.now();
      realTrades.push({ time: Date.now(), signal: side, side: buyLabel, result: 'PENDING', open_seen_at: Date.now() });
      realExecTimer = setTimeout(() => { if (['OPEN_PENDING', 'OPEN'].includes(realExecState)) { realExecState = 'RECOVERY'; realLockReason = 'TIMEOUT'; updateRealUI(); } }, cfg.realTimeoutMs);
    } catch (e) {
      realLockReason = 'ERR:' + e.message; updateRealUI();
      setTimeout(() => { if (realExecState === 'OPEN_PENDING') { realExecState = 'IDLE'; realLockReason = ''; updateRealUI(); } }, 3000);
    }
  }

  async function setRealTradeSide (label, activeClass) {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 150));
      const btn = document.querySelector(SEL_PURCHASE_BTN); if (btn && btn.classList.contains(activeClass)) return true;
      const target = Array.from(document.querySelectorAll(SEL_SIDE_BTNS)).find(b => b.innerText.includes(label));
      if (target) { simulateExternalClick(target); await new Promise(r => setTimeout(r, 350)); }
    }
    return false;
  }

  function simulateExternalClick (el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseenter', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.focus(); el.dispatchEvent(new MouseEvent('mouseup', opts)); el.dispatchEvent(new MouseEvent('click', opts)); el.dispatchEvent(new MouseEvent('mouseleave', opts));
  }

  async function waitRealBuyReady () {
    for (let i = 0; i < 5; i++) {
      const btn = document.querySelector(SEL_PURCHASE_BTN);
      if (btn && btn.getAttribute('data-loading') !== 'true' && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  function init () { if (document.getElementById('tt-overlay')) return; cfg = loadCfg(); buildOverlay(); connect(); startWatchdog(); setupFlyoutObserver(); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
