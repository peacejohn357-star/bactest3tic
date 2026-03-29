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
  let realExecState = 'IDLE', realTrades = [], realOpenCount = 0, realWins = 0, realLosses = 0, realPnl = 0, realLockReason = '', lastRealTradeAt = 0, lastTradeClosedAt = 0, lastTradeClosedTick = -999, realExecTimer = null;
  let flyoutObserver = null, ws = null, wsState = 'disconnected', reconnectTimer = null, resolvedSymbol = null, manualClose = false, reconnectDelay = RECONNECT_BASE, failCount = 0, usingFallback = false;

  // ── Overlay Build ─────────────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('tt-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Timing V2</span>
        <div class="tt-header-btns"><button id="tt-min-btn" title="Minimise">_</button><button id="tt-close-btn" title="Close">✕</button></div>
      </div>
      <div id="tt-body">
        <div class="tt-row"><span class="tt-label">Status</span><span class="tt-val" id="tt-status">Disconnected</span></div>
        <div class="tt-row"><span class="tt-label">Last Price</span><span class="tt-val" id="tt-price">–</span></div>
        <div class="tt-row"><span class="tt-label">S_Low / S_High</span><span class="tt-val" id="tt-speed-stats">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Mean / Std</span><span class="tt-val" id="tt-speed-dist">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Session W/L</span><span class="tt-val"><span id="tt-wins">0</span> / <span id="tt-losses">0</span></span></div>
        <div id="tt-signals-list"></div>
        <div class="tt-config-section-label">Real Execution</div>
        <div id="tt-real-panel">
          <div class="tt-row"><span class="tt-label">Exec State</span><span class="tt-val" id="tt-real-state">IDLE</span></div>
          <div class="tt-row"><span class="tt-label">Real PnL</span><span class="tt-val" id="tt-real-pnl">0.00</span></div>
          <button id="tt-real-export">⬇ Export Real CSV</button>
          <button id="tt-real-reset" style="background:#3d1a1a;color:#e04040;margin-top:2px;">Reset Engine</button>
        </div>
        <button id="tt-config-toggle">⚙ settings</button>
        <div id="tt-config">
          <div class="tt-config-row"><label>Mode</label><select id="tt-cfg-strategy-mode"><option value="structural">Structural</option><option value="hybrid">Hybrid</option><option value="momentum">Momentum</option><option value="reversal">Reversal</option></select></div>
          <div class="tt-config-row"><label>Epsilon</label><input type="number" id="tt-cfg-epsilon" min="0" max="1" step="0.01" value="0.2"></div>
          <div class="tt-config-row"><label>Debug Signals</label><input type="checkbox" id="tt-cfg-debug"></div>
          <div class="tt-config-section-label">Real Trade Master</div>
          <div class="tt-config-row"><label style="color:#f0a060;font-weight:700;">Enable Real Execution</label><label class="tt-switch"><input type="checkbox" id="tt-cfg-real-enabled"><span class="tt-slider"></span></label></div>
        </div>
        <button id="tt-export">⬇ Export CSV</button>
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
    const statsEl = document.getElementById('tt-speed-stats'), distEl = document.getElementById('tt-speed-dist');
    if (statsEl) statsEl.textContent = `${sLow.toFixed(4)} / ${sHigh.toFixed(4)}`;
    if (distEl) distEl.textContent = `${speedMean.toFixed(4)} / ${speedStd.toFixed(4)}`;
  }

  function handleTick(tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote), epoch = tick.epoch, now = Date.now(); tickSeq++;
    const prevTick = ticks.length ? ticks[ticks.length - 1] : null;
    const delta = prevTick ? price - prevTick.price : 0, deltaSteps = delta / 0.1, direction = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    const deltaTime = prevTick ? (now - prevTick.receivedAt) : 1000;
    const speed = deltaTime > 0 ? deltaSteps / deltaTime : 0, absSpeed = Math.abs(speed);
    const speedTrend = prevTick ? (absSpeed - prevTick.absSpeed) : 0;
    const lastDigit = Math.floor(Math.round(price * 100) / 10) % 10, deltaChange = prevTick ? deltaSteps - prevTick.deltaSteps : 0;
    if (delta > 0) { upStreak++; downStreak = 0; } else if (delta < 0) { downStreak++; upStreak = 0; } else { upStreak = 0; downStreak = 0; }
    const state = { epoch, price, direction, deltaSteps, deltaTime, speed, absSpeed, speedTrend, upStreak, downStreak, lastDigit, deltaChange, receivedAt: now };
    ticks.push(state); if (ticks.length > TICK_BUF) ticks.shift();
    speedHistory.push(absSpeed); if (speedHistory.length > SPEED_BUF) speedHistory.shift();
    calculatePercentiles(); lastTickProcessedAt = Date.now();
    const priceEl = document.getElementById('tt-price'); if (priceEl) priceEl.textContent = price.toFixed(2);
    try { detectSignal(); lastSignalEvalAt = Date.now(); } catch (e) { evalErrorCount++; }
    signals.forEach(sig => { if (sig.result === 'PENDING') sig.ticksAfter.push(price); });
  }

  // ── Signal Detection Logic (Final Corrected Model) ────────────────────────
  function detectSignal() {
    const n = ticks.length; if (n < 2) return null;
    const t0 = ticks[n - 1], mode = cfg.strategyMode, eps = cfg.epsilon;
    const streak = Math.max(t0.upStreak, t0.downStreak), isEarly = streak <= 2, isLate = streak >= 5;
    const buyDigits = [0, 5, 6], sellDigits = [2, 3, 8], buyDigitBias = buyDigits.includes(t0.lastDigit), sellDigitBias = sellDigits.includes(t0.lastDigit);

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

    let res = null;
    // Evaluation Priority: Structural → Hybrid → Momentum → Reversal
    if (mode === 'structural') res = checkStructural();
    else if (mode === 'hybrid') res = checkHybrid() || checkStructural();
    else if (mode === 'momentum') res = checkMomentum() || checkHybrid() || checkStructural();
    else if (mode === 'reversal') res = checkReversal();

    if (res) {
      // Global NO-TRADE filters
      if ([3, 4].includes(streak) || Math.abs(t0.deltaChange) < eps || (t0.absSpeed > sLow && t0.absSpeed < sHigh && Math.abs(t0.speedTrend) < 0.001)) res = null;
      if (res) {
        const currentTickIndex = tickSeq;
        if (currentTickIndex - lastSignalTickIndex < cfg.postTradeCooldownTicks || Date.now() - lastTradeClosedAt < cfg.postTradeCooldownMs || realExecState !== 'IDLE') return null;
        lastSignalTickIndex = currentTickIndex;
        let conf = res.conf; if ((res.type === 'BUY' && !buyDigitBias) || (res.type === 'SELL' && !sellDigitBias)) conf -= 10;
        const sig = { type: res.type, price: t0.price, time: t0.epoch, result: 'PENDING', ticksAfter: [], confidence: Math.min(100, conf), strategy: mode };
        signals.push(sig); if (signals.length > 50) signals.shift(); recordSessionTrade(sig); updateSignalsUI();
        if (cfg.realTradeEnabled) { realExecState = 'OPEN_PENDING'; realLockReason = 'EXECUTING'; updateRealUI(); executeRealTrade(res.type); }
      }
    }
    return null;
  }

  // ── Infrastructure ────────────────────────────────────────────────────────
  function updateWinsLossesUI() {
    const we = document.getElementById('tt-wins'), le = document.getElementById('tt-losses');
    if (we) we.textContent = realWins; if (le) le.textContent = realLosses;
  }
  function updateSignalsUI() {
    const el = document.getElementById('tt-signals-list'); if (!el) return;
    el.innerHTML = ''; signals.slice(-10).reverse().forEach(sig => {
      const div = document.createElement('div'); div.className = `tt-signal tt-signal-${sig.type.toLowerCase()}`;
      const badge = sig.result === 'WIN' ? '<span class="tt-badge tt-badge-win">WIN</span>' : sig.result === 'LOSS' ? '<span class="tt-badge tt-badge-loss">LOSS</span>' : '<span class="tt-badge tt-badge-pending">…</span>';
      div.innerHTML = `<span class="tt-signal-type">${sig.type}</span><span class="tt-signal-price">${(sig.entryPriceReal || sig.price).toFixed(2)}</span><span class="tt-signal-time">${new Date(sig.time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})} [${sig.confidence}%]</span>${badge}`;
      el.appendChild(div);
    });
  }
  function updateRealUI() {
    const stEl = document.getElementById('tt-real-state'), pnlEl = document.getElementById('tt-real-pnl');
    if (stEl) { stEl.textContent = realExecState + (realLockReason ? ` (${realLockReason})` : ''); stEl.style.color = { IDLE: '#3ecf60', RECOVERY: '#e04040', OPEN: '#f0c040', OPEN_PENDING: '#7ec8e3' }[realExecState] || '#fff'; }
    if (pnlEl) { pnlEl.textContent = realPnl.toFixed(2); pnlEl.style.color = realPnl >= 0 ? '#3ecf60' : '#e04040'; }
    updateWinsLossesUI();
  }
  function showAlert(msg) { const el = document.getElementById('tt-alert'); if (el) { el.textContent = msg; el.classList.add('tt-visible'); setTimeout(() => el.classList.remove('tt-visible'), 5000); } }
  function recordSessionTrade(sig) { sessionTradesAll.push(sig); if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift(); }
  function exportCSV() {
    if (!sessionTradesAll.length) return;
    const rows = [['Type', 'Strategy', 'Confidence', 'Price', 'Time', 'Result']].concat(sessionTradesAll.map(s => [s.type, s.strategy, s.confidence, s.price.toFixed(2), s.time, s.result]));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-signals.csv'; a.click();
  }
  function exportRealCSV() {
    if (!realTrades.length) return;
    const rows = [['Time', 'Signal', 'Side', 'Result', 'PnL']].concat(realTrades.map(t => [new Date(t.time).toISOString(), t.signal, t.side, t.result, t.pnl || '']));
    const csv = rows.map(r => r.join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '3tick-real.csv'; a.click();
  }
  function safeStorage(op, key, val) { try { if (op === 'get') return JSON.parse(localStorage.getItem(key)); if (op === 'set') localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } return null; }
  function saveCfg() { safeStorage('set', 'tt-cfg', cfg); }
  function loadCfg() { const stored = safeStorage('get', 'tt-cfg'); return Object.assign({ strategyMode: 'hybrid', epsilon: 0.2, realTradeEnabled: false, realTimeoutMs: 40000, realCooldownMs: 5000, postTradeCooldownTicks: 5, postTradeCooldownMs: 5000, debugSignals: true }, stored || {}); }
  function applyConfigToUI() { const dbg = document.getElementById('tt-cfg-debug'), re = document.getElementById('tt-cfg-real-enabled'), mode = document.getElementById('tt-cfg-strategy-mode'), eps = document.getElementById('tt-cfg-epsilon'); if (dbg) dbg.checked = cfg.debugSignals; if (re) re.checked = !!cfg.realTradeEnabled; if (mode) mode.value = cfg.strategyMode; if (eps) eps.value = cfg.epsilon; updateRealUI(); }
  function startWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = setInterval(() => { const now = Date.now(); if (wsState !== 'connected') return; if (lastTickProcessedAt > 0 && now - lastTickProcessedAt > WATCHDOG_TICK_TIMEOUT) { if (ws) ws.close(); scheduleReconnect(); } }, WATCHDOG_INTERVAL); }
  function setupFlyoutObserver() {
    if (flyoutObserver) return;
    flyoutObserver = new MutationObserver(() => {
      const flyout = document.querySelector(SEL_FLYOUT); if (!flyout) { if (realOpenCount !== 0) { realOpenCount = 0; updateRealExecStateFromDOM(0, null); } return; }
      const text = flyout.innerText; let count = text.includes('no open positions') ? 0 : (text.match(/(\d+)\s+open\s+position/i) ? parseInt(text.match(/(\d+)\s+open\s+position/i)[1], 10) : realOpenCount);
      let closedResult = null; const pnlMatch = text.match(/Closed\s+([+-]?\d+\.?\d*)\s+USD/i); if (pnlMatch) closedResult = { pnl: parseFloat(pnlMatch[1]), result: parseFloat(pnlMatch[1]) >= 0 ? 'WIN' : 'LOSS' };
      else if (text.includes('no open positions') && realExecState === 'OPEN') closedResult = { pnl: 0, result: 'UNKNOWN' };
      if (count !== realOpenCount || closedResult) { realOpenCount = count; updateRealExecStateFromDOM(count, closedResult); }
    }); flyoutObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function updateRealExecStateFromDOM(count, closedResult) {
    if (closedResult && ['OPEN', 'OPEN_PENDING', 'RECOVERY'].includes(realExecState)) { finalizeRealTrade(closedResult); realExecState = 'IDLE'; realLockReason = ''; }
    else if (count === 0 && ['OPEN', 'RECOVERY'].includes(realExecState)) { finalizeRealTrade({ pnl: 0, result: 'UNKNOWN' }); realExecState = 'IDLE'; realLockReason = ''; }
    if (count > 0 && ['IDLE', 'OPEN_PENDING'].includes(realExecState)) { realExecState = 'OPEN'; const pending = signals.find(s => s.result === 'PENDING' && !s.entryPriceReal); if (pending && ticks.length) { pending.entryPriceReal = ticks[ticks.length - 1].price; updateSignalsUI(); } } updateRealUI();
  }
  function finalizeRealTrade(res) {
    if (!realTrades.length) return; const last = realTrades[realTrades.length - 1]; if (last.result !== 'PENDING') return;
    last.result = res.result; last.pnl = res.pnl; if (res.result === 'WIN') realWins++; else if (res.result === 'LOSS') realLosses++; realPnl += res.pnl;
    const simTrade = signals.find(s => s.result === 'PENDING'); if (simTrade) { simTrade.result = res.result; simTrade.priceAfter = ticks.length ? ticks[ticks.length - 1].price : simTrade.price; }
    lastTradeClosedAt = Date.now(); lastTradeClosedTick = tickSeq; clearTimeout(realExecTimer); realExecTimer = null; updateRealUI();
  }
  async function executeRealTrade(side) {
    if (Date.now() - lastRealTradeAt < cfg.realCooldownMs) return;
    const buyLabel = side === 'BUY' ? 'Rise' : 'Fall', activeClass = side === 'BUY' ? CLASS_RISE_ACTIVE : CLASS_FALL_ACTIVE;
    try {
      if (!await setRealTradeSide(buyLabel, activeClass)) throw new Error('side_failed');
      if (!await waitRealBuyReady()) throw new Error('not_ready');
      const btn = document.querySelector(SEL_PURCHASE_BTN); if (!btn || !btn.classList.contains(activeClass)) throw new Error('btn_mismatch');
      simulateExternalClick(btn); lastRealTradeAt = Date.now(); realTrades.push({ time: Date.now(), signal: side, side: buyLabel, result: 'PENDING' });
      realExecTimer = setTimeout(() => { if (['OPEN_PENDING', 'OPEN'].includes(realExecState)) { realExecState = 'RECOVERY'; realLockReason = 'TIMEOUT'; updateRealUI(); } }, cfg.realTimeoutMs);
    } catch (e) { realLockReason = 'ERR:' + e.message; updateRealUI(); setTimeout(() => { if (realExecState === 'OPEN_PENDING') { realExecState = 'IDLE'; realLockReason = ''; updateRealUI(); } }, 3000); }
  }
  async function setRealTradeSide(label, activeClass) { for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 150)); const btn = document.querySelector(SEL_PURCHASE_BTN); if (btn && btn.classList.contains(activeClass)) return true; const target = Array.from(document.querySelectorAll(SEL_SIDE_BTNS)).find(b => b.innerText.includes(label)); if (target) { simulateExternalClick(target); await new Promise(r => setTimeout(r, 350)); } } return false; }
  function simulateExternalClick(el) { const opts = { bubbles: true, cancelable: true, view: window }; el.dispatchEvent(new MouseEvent('mouseenter', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts)); el.focus(); el.dispatchEvent(new MouseEvent('mouseup', opts)); el.dispatchEvent(new MouseEvent('click', opts)); el.dispatchEvent(new MouseEvent('mouseleave', opts)); }
  async function waitRealBuyReady() { for (let i = 0; i < 5; i++) { const btn = document.querySelector(SEL_PURCHASE_BTN); if (btn && btn.getAttribute('data-loading') !== 'true' && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true; await new Promise(r => setTimeout(r, 300)); } return false; }
  function init() { if (document.getElementById('tt-overlay')) return; cfg = loadCfg(); buildOverlay(); connect(); startWatchdog(); setupFlyoutObserver(); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
