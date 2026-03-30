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
  // Real trading selectors removed

  let cfg = {
    tickSize: 0.1,
    strategyMode: 'all', // Defaulting to all for backtest
    epsilon: 0.2,
    postTradeCooldownTicks: 0, // Reduced for backtest
    postTradeCooldownMs: 0,
    debugSignals: true,
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks = [];
  let speedHistory = [];
  let sHigh = 0, sLow = 0, speedMean = 0, speedStd = 0;
  let signals = [], sessionTradesAll = [];
  let tickSeq = 0, lastSignalTickIndex = -999, upStreak = 0, downStreak = 0;
  let lastTickProcessedAt = 0, lastSignalEvalAt = 0, watchdogInterval = null, evalErrorCount = 0;
  let paperWins = 0, paperLosses = 0;
  let ws = null, wsState = 'disconnected', reconnectTimer = null, resolvedSymbol = null, manualClose = false, reconnectDelay = RECONNECT_BASE, failCount = 0, usingFallback = false;

  // UI Cache to prevent redundant DOM updates
  let lastUI = { state: '', pnl: null, wins: -1, losses: -1, price: '', stats: '', dist: '', dirStreak: '' };

  // ── Overlay Build ─────────────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('tt-overlay')) return;
    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Backtest V1</span>
        <div class="tt-header-btns"><button id="tt-min-btn" title="Minimise">_</button><button id="tt-close-btn" title="Close">X</button></div>
      </div>
      <div id="tt-body">
        <div class="tt-row"><span class="tt-label">Status</span><span class="tt-val" id="tt-status">Disconnected</span></div>
        <div class="tt-row"><span class="tt-label">Last Price</span><span class="tt-val" id="tt-price">-</span></div>
        <div class="tt-row"><span class="tt-label">Dir / Streak</span><span class="tt-val" id="tt-dir-streak">- / 0</span></div>
        <div class="tt-row"><span class="tt-label">S_Low / S_High</span><span class="tt-val" id="tt-speed-stats">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Mean / Std</span><span class="tt-val" id="tt-speed-dist">0.00 / 0.00</span></div>
        <div class="tt-row"><span class="tt-label">Paper W/L</span><span class="tt-val"><span id="tt-wins">0</span> / <span id="tt-losses">0</span></span></div>
        <div id="tt-signals-list"></div>
        <button id="tt-config-toggle">Settings</button>
        <div id="tt-config">
          <div class="tt-config-row"><label>Mode</label><select id="tt-cfg-strategy-mode"><option value="all">All Strategies</option><option value="trendIgnition">Trend Ignition</option><option value="reversalIgnition">Reversal Ignition</option><option value="ignitionSuite">Full Ignition Suite</option><option value="ignition">Ignition</option><option value="structural3">Structural 3</option><option value="structural2">Structural 2</option><option value="structural">Structural</option><option value="hybrid">Hybrid</option><option value="momentum">Momentum</option><option value="reversal">Reversal</option></select></div>
          <div class="tt-config-row"><label>Intensity (Min)</label><input type="number" id="tt-cfg-intensity" min="0.5" max="3" step="0.1" value="1.2"></div>
          <div class="tt-config-row"><label>Epsilon</label><input type="number" id="tt-cfg-epsilon" min="0" max="1" step="0.01" value="0.2"></div>
          <div class="tt-config-row"><label>Debug Signals</label><input type="checkbox" id="tt-cfg-debug"></div>
        </div>
        <button id="tt-export">Download Backtest CSV</button>
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
    document.getElementById('tt-cfg-intensity').addEventListener('change', function () { cfg.minIntensity = parseFloat(this.value) || 1.2; saveCfg(); });
    document.getElementById('tt-cfg-epsilon').addEventListener('change', function () { cfg.epsilon = parseFloat(this.value) || 0.2; saveCfg(); });
    document.getElementById('tt-cfg-debug').addEventListener('change', function () { cfg.debugSignals = this.checked; saveCfg(); });
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
    const preSpeed = prevTick ? prevTick.speed : 0;
    const acceleration = speed - preSpeed;
    const accel = acceleration; // Alias for compatibility with previous updates
    const intensity = speedMean > 0 ? absSpeed / speedMean : 1;
    if (delta > 0) { upStreak++; downStreak = 0; } else if (delta < 0) { downStreak++; upStreak = 0; } else { upStreak = 0; downStreak = 0; }
    const state = { epoch, price, direction, deltaSteps, deltaTime, speed, absSpeed, speedTrend, upStreak, downStreak, lastDigit, deltaChange, receivedAt: now, accel, intensity, preSpeed, acceleration };
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
      if (sig.result === 'PENDING') {
        sig.ticksAfter.push(price);

        // T1 is the first tick after purchase confirmation (next-tick execution)
        // T2, T3, T4 follow. The contract settles on T4 (3 ticks passed from T1).
        if (sig.ticksAfter.length === 4) {
          const entryPrice = sig.ticksAfter[0]; // T1
          const exitPrice = sig.ticksAfter[3];  // T4
          sig.entryPrice = entryPrice;
          sig.exitPrice = exitPrice;

          if (sig.type === 'BUY') {
            sig.result = (exitPrice > entryPrice) ? 'WIN' : (exitPrice < entryPrice ? 'LOSS' : 'DRAW');
          } else if (sig.type === 'SELL') {
            sig.result = (exitPrice < entryPrice) ? 'WIN' : (exitPrice > entryPrice ? 'LOSS' : 'DRAW');
          }
          if (sig.result === 'WIN') paperWins++; else if (sig.result === 'LOSS') paperLosses++;
          updateSignalsUI();
          updateWinsLossesUI();
        }
      }
    });
  }

  // ── Signal Detection Logic (Updated with Ignition & Structural 3) ─────────
  function detectSignal() {
    const n = ticks.length; if (n < 2) return null;
    const t0 = ticks[n - 1], mode = cfg.strategyMode, eps = cfg.epsilon;
    const streak = Math.max(t0.upStreak, t0.downStreak), isEarly = streak <= 2, isLate = streak >= 4;
    const buyDigits = [0, 5, 6, 7], sellDigits = [2, 3, 4, 8];
    const buyDigitBias = buyDigits.includes(t0.lastDigit), sellDigitBias = sellDigits.includes(t0.lastDigit);

    // 1. ORIGINAL STRATEGIES
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

    // 2. STRUCTURAL 2 (Untouched - The original AI's working edge)
    const checkStructural2 = () => {
      const tMinus1 = n >= 2 ? ticks[n - 2] : null;
      if (!tMinus1) return null;

      const isCalm = (tMinus1.deltaTime >= 400 && tMinus1.deltaTime <= 1800) &&
                     (t0.deltaTime >= 400 && t0.deltaTime <= 1800);
      if (!isCalm) return null;

      if (t0.direction === 1 && tMinus1.direction === -1 && t0.deltaChange === 2) {
        if (tMinus1.lastDigit === 2) {
          return { type: 'BUY', conf: 90, triggerDigit: tMinus1.lastDigit, triggerDesc: 'Struct2: Flip+Accel(2.0)' };
        }
      }
      if (t0.direction === -1 && tMinus1.direction === 1 && t0.deltaChange === -2) {
        if (tMinus1.lastDigit === 2) {
          return { type: 'SELL', conf: 90, triggerDigit: tMinus1.lastDigit, triggerDesc: 'Struct2: Flip+Accel(-2.0)' };
        }
      }
      return null;
    };

    // 3. STRUCTURAL 3 (Modified Digit 2 Edge - Catches explosive moves off the digit 2)
    const checkStructural3 = () => {
      const tMinus1 = n >= 2 ? ticks[n - 2] : null;
      if (!tMinus1) return null;

      const isDigit2Edge = (t0.lastDigit === 2 || tMinus1.lastDigit === 2);
      const isPowerStep = Math.abs(t0.deltaSteps) >= 2;

      if (isDigit2Edge && isPowerStep) {
        if (t0.direction === 1) return { type: 'BUY', conf: 92, triggerDigit: 2, triggerDesc: 'Struct3: Digit2 PowerStep' };
        if (t0.direction === -1) return { type: 'SELL', conf: 92, triggerDigit: 2, triggerDesc: 'Struct3: Digit2 PowerStep' };
      }
      return null;
    };

    // 4. IGNITION (New Strategy - Intensity & Flow Based)
    const checkIgnition = () => {
      const tMinus1 = n >= 2 ? ticks[n - 2] : null;
      if (!tMinus1) return null;

      const flow = ticks.slice(-3).map(t => t.lastDigit).join('-');
      const minIntensity = cfg.minIntensity || 1.2;

      // Ignition A: Trend Continuation Surge
      if (streak >= 3 && t0.intensity > minIntensity && Math.abs(t0.accel) > 0.0001) {
        if (t0.direction === 1 && t0.accel > 0) return { type: 'BUY', conf: 88, triggerDesc: 'Ignition: Trend Surge' };
        if (t0.direction === -1 && t0.accel < 0) return { type: 'SELL', conf: 88, triggerDesc: 'Ignition: Trend Surge' };
      }

      // Ignition B: High-Probability Parity Flow Reversals
      const buyFlows = ['0-6-5', '0-1-2'];
      const sellFlows = ['2-3-4', '8-1-0'];
      if (t0.direction === 1 && tMinus1.direction === -1 && buyFlows.includes(flow)) {
        return { type: 'BUY', conf: 94, triggerDesc: `Ignition: Rev (${flow})` };
      }
      if (t0.direction === -1 && tMinus1.direction === 1 && sellFlows.includes(flow)) {
        return { type: 'SELL', conf: 94, triggerDesc: `Ignition: Rev (${flow})` };
      }
      return null;
    };

    // 5. TREND IGNITION (Continuation Entry)
    const checkTrendIgnition = () => {
      const streakVal = Math.max(t0.upStreak, t0.downStreak);
      const isSameDirection = Math.sign(t0.preSpeed) === Math.sign(t0.speed);
      const isCleanMove = Math.abs(t0.deltaSteps) === 1;
      const isStableAccel = t0.acceleration >= -0.0003;
      const isWeakMove = Math.abs(t0.speed) < 0.0007;

      if (streakVal <= 2 && isSameDirection && isCleanMove && isStableAccel && !isWeakMove) {
        return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 85, triggerDesc: `Trend Ignition (S:${streakVal})` };
      }
      return null;
    };

    // 6. REVERSAL IGNITION (Flip Entry)
    const checkReversalIgnition = () => {
      const streakVal = Math.max(t0.upStreak, t0.downStreak);
      const isFlip = Math.sign(t0.preSpeed) !== Math.sign(t0.speed);
      const isStrongAccel = Math.abs(t0.acceleration) > 0.0007;
      const isCleanMove = Math.abs(t0.deltaSteps) === 1;

      if (streakVal <= 2 && isFlip && isStrongAccel && isCleanMove) {
        return { type: t0.direction === 1 ? 'BUY' : 'SELL', conf: 90, triggerDesc: `Rev Ignition (Accel:${t0.acceleration.toFixed(4)})` };
      }
      return null;
    };

    const strategies = {
      trendIgnition: checkTrendIgnition,
      reversalIgnition: checkReversalIgnition,
      ignitionSuite: () => {
        if (Math.max(t0.upStreak, t0.downStreak) < 4) return checkReversalIgnition() || checkTrendIgnition();
        return null;
      },
      ignition: checkIgnition,
      structural3: checkStructural3,
      structural2: checkStructural2,
      structural: checkStructural,
      hybrid: checkHybrid,
      momentum: checkMomentum,
      reversal: checkReversal
    };

    Object.keys(strategies).forEach(stratName => {
      // If mode is 'all', we only run the base strategies to avoid redundancy
      if (mode === 'all') {
        if (['ignitionSuite'].includes(stratName)) return;
      } else if (mode !== stratName) {
        return;
      }

      const res = strategies[stratName]();
      if (res) {
        // Validation check similar to original logic
        const needsEpsCheck = !['ignition', 'structural3', 'structural2'].includes(stratName);
        if (needsEpsCheck && Math.abs(t0.deltaChange) < eps) return;

        let conf = res.conf;
        if (!res.triggerDesc && ((res.type === 'BUY' && !buyDigitBias) || (res.type === 'SELL' && !sellDigitBias))) conf -= 10;

        const sig = {
          type: res.type,
          price: t0.price,
          time: t0.epoch,
          result: 'PENDING',
          ticksAfter: [],
          confidence: Math.min(100, conf),
          strategy: stratName,
          triggerDigit: res.triggerDigit,
          triggerDesc: res.triggerDesc,
          startTickIndex: tickSeq + 1, // Contract starts on NEXT tick
          startTime: Date.now(),
          // Backtest metadata
          speed: t0.speed,
          absSpeed: t0.absSpeed,
          speedTrend: t0.speedTrend,
          accel: t0.accel,
          intensity: t0.intensity,
          upStreak: t0.upStreak,
          downStreak: t0.downStreak,
          deltaChange: t0.deltaChange,
          lastDigit: t0.lastDigit
        };
        signals.push(sig);
        if (signals.length > 50) signals.shift();
        recordSessionTrade(sig);
      }
    });
    updateSignalsUI();
    return null;
  }

  // ── Infrastructure ────────────────────────────────────────────────────────
  function updateWinsLossesUI() {
    if (lastUI.wins !== paperWins) {
      const we = document.getElementById('tt-wins');
      if (we) we.textContent = paperWins;
      lastUI.wins = paperWins;
    }
    if (lastUI.losses !== paperLosses) {
      const le = document.getElementById('tt-losses');
      if (le) le.textContent = paperLosses;
      lastUI.losses = paperLosses;
    }
  }
  function updateSignalsUI() {
    const el = document.getElementById('tt-signals-list'); if (!el) return;
    el.innerHTML = ''; signals.slice(-10).reverse().forEach(sig => {
      const div = document.createElement('div'); div.className = `tt-signal tt-signal-${sig.type.toLowerCase()}`;
      const badge = sig.result === 'WIN' ? '<span class="tt-badge tt-badge-win">WIN</span>' : sig.result === 'LOSS' ? '<span class="tt-badge tt-badge-loss">LOSS</span>' : '<span class="tt-badge tt-badge-pending">...</span>';
      div.innerHTML = `<span class="tt-signal-type">${sig.type}</span><span class="tt-signal-price">${(sig.price).toFixed(2)}</span><span class="tt-signal-time">${new Date(sig.time*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})} [${sig.confidence}%]</span>${badge}`;
      el.appendChild(div);
    });
  }
  function showAlert(msg) { const el = document.getElementById('tt-alert'); if (el) { el.textContent = msg; el.classList.add('tt-visible'); setTimeout(() => el.classList.remove('tt-visible'), 5000); } }
  function recordSessionTrade(sig) { sessionTradesAll.push(sig); if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift(); }
  function exportCSV() {
    if (!sessionTradesAll.length) return;
    const header = [
      'Time', 'Type', 'Strategy', 'Confidence', 'Signal Price', 'Entry Price', 'Exit Price',
      'Result', 'Trigger Digit', 'Trigger Desc', 'Start Tick Seq',
      'Speed', 'AbsSpeed', 'SpeedTrend', 'Accel', 'Intensity', 'UpStreak', 'DownStreak', 'DeltaChange', 'LastDigit'
    ];
    const rows = [header].concat(sessionTradesAll.map(s => [
      new Date(s.time * 1000).toLocaleTimeString(),
      s.type,
      s.strategy,
      s.confidence,
      s.price.toFixed(2),
      s.entryPrice ? s.entryPrice.toFixed(2) : '',
      s.exitPrice ? s.exitPrice.toFixed(2) : '',
      s.result,
      s.triggerDigit ?? '',
      s.triggerDesc ?? '',
      s.startTickIndex ?? '',
      s.speed.toFixed(4),
      s.absSpeed.toFixed(4),
      s.speedTrend.toFixed(4),
      s.accel.toFixed(4),
      s.intensity.toFixed(4),
      s.upStreak,
      s.downStreak,
      s.deltaChange,
      s.lastDigit
    ]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `3tick-backtest-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
    a.click();
  }
  function safeStorage(op, key, val) { try { if (op === 'get') return JSON.parse(localStorage.getItem(key)); if (op === 'set') localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } return null; }
  function saveCfg() { safeStorage('set', 'tt-cfg', cfg); }
  function loadCfg() { const stored = safeStorage('get', 'tt-cfg'); return Object.assign({ strategyMode: 'all', epsilon: 0.2, minIntensity: 1.2, postTradeCooldownTicks: 0, postTradeCooldownMs: 0, debugSignals: true }, stored || {}); }
  function applyConfigToUI() { const dbg = document.getElementById('tt-cfg-debug'), mode = document.getElementById('tt-cfg-strategy-mode'), eps = document.getElementById('tt-cfg-epsilon'), intensity = document.getElementById('tt-cfg-intensity'); if (dbg) dbg.checked = cfg.debugSignals; if (mode) mode.value = cfg.strategyMode; if (eps) eps.value = cfg.epsilon; if (intensity) intensity.value = cfg.minIntensity || 1.2; updateWinsLossesUI(); }
  function startWatchdog() { if (watchdogInterval) clearInterval(watchdogInterval); watchdogInterval = setInterval(() => { const now = Date.now(); if (wsState !== 'connected') return; if (lastTickProcessedAt > 0 && now - lastTickProcessedAt > WATCHDOG_TICK_TIMEOUT) { if (ws) ws.close(); scheduleReconnect(); } }, WATCHDOG_INTERVAL); }

  function init() { if (document.getElementById('tt-overlay')) return; cfg = loadCfg(); buildOverlay(); connect(); startWatchdog(); window._tt_cfg = cfg; window._tt_detect = detectSignal; }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
