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
  const CANDLE_BUF      = 200;
  const SR_WINDOW       = 30;    // candles used for S/R scan
  const SR_COUNT        = 3;     // how many R and S levels to show
  const RECONNECT_BASE  = 4000;  // ms – initial reconnect delay
  const RECONNECT_MAX   = 64000; // ms – reconnect delay cap
  const TICK_LOG_MAX    = 5000;  // maximum in-memory tick log rows

  let cfg = {
    spikeThreshold:   0.30,  // minimum % price-move considered a spike
    reversalTicks:    1,     // consecutive opposite-direction ticks to confirm reversal
    minSnapbackRatio: 0.5,   // reversal must retrace >= this fraction of spike distance
    extremeLookback:  10,    // spike tip must be local high/low within last N ticks
    cooldownTicks:    2,     // minimum ticks between new signals
    minVolatilityPct: 0.03,  // skip signals when recent range is too flat (%)
    debugSignals:     false, // log signal accept/reject reasons to console
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks       = [];  // { price: number, time: number }
  let candles     = [];  // { open, high, low, close, time }
  let signals     = [];  // { type, price, time, result, ticksAfter, priceAfter }
  let wins        = 0;
  let losses      = 0;
  let lastSignalTickIndex = -999; // tick buffer index of last fired signal (cooldown tracking)

  let tickLog     = [];    // in-memory tick log rows for diagnostics
  let tickLogging = false; // true when user has started tick logging

  let ws             = null;
  let wsState        = 'disconnected';
  let reconnectTimer = null;
  let resolvedSymbol = null;  // resolved after active_symbols handshake
  let manualClose    = false; // set true when user clicks Close; suppresses reconnect
  let reconnectDelay = RECONNECT_BASE; // grows with each failed attempt
  let failCount      = 0;     // consecutive connection failures for fallback logic
  let usingFallback  = false; // true when currently trying the fallback endpoint

  // ── Overlay build ─────────────────────────────────────────────────────────
  function buildOverlay () {
    if (document.getElementById('tt-overlay')) return;

    const el = document.createElement('div');
    el.id = 'tt-overlay';
    el.innerHTML = `
      <div id="tt-header">
        <span class="tt-title">3Tick Scalper</span>
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
          <span class="tt-label">1m Trend</span>
          <span class="tt-val" id="tt-trend">–</span>
        </div>
        <div class="tt-row">
          <span class="tt-label">Session W/L</span>
          <span class="tt-val">
            <span class="tt-wins"   id="tt-wins">0</span>
            &nbsp;/&nbsp;
            <span class="tt-losses" id="tt-losses">0</span>
          </span>
        </div>
        <div class="tt-row"><span class="tt-label">S/R Levels</span></div>
        <div id="tt-sr-list"></div>
        <div class="tt-row"><span class="tt-label">Signals</span></div>
        <div id="tt-signals-list"></div>
        <button id="tt-config-toggle">⚙ settings</button>
        <div id="tt-config">
          <div class="tt-config-row">
            <label>Spike % threshold</label>
            <input type="number" id="tt-cfg-spike" min="0.01" max="5" step="0.01" value="0.30">
          </div>
          <div class="tt-config-row">
            <label>Reversal ticks</label>
            <input type="number" id="tt-cfg-rev" min="1" max="5" step="1" value="1">
          </div>
          <div class="tt-config-row">
            <label>Snapback ratio (0–1)</label>
            <input type="number" id="tt-cfg-snapback" min="0" max="1" step="0.05" value="0.5">
          </div>
          <div class="tt-config-row">
            <label>Extreme lookback</label>
            <input type="number" id="tt-cfg-lookback" min="1" max="50" step="1" value="10">
          </div>
          <div class="tt-config-row">
            <label>Cooldown ticks</label>
            <input type="number" id="tt-cfg-cooldown" min="0" max="20" step="1" value="2">
          </div>
          <div class="tt-config-row">
            <label>Min volatility %</label>
            <input type="number" id="tt-cfg-volpct" min="0" max="5" step="0.01" value="0.03">
          </div>
          <div class="tt-config-row">
            <label>Debug signals</label>
            <input type="checkbox" id="tt-cfg-debug">
          </div>
        </div>
        <button id="tt-export">⬇ Export CSV</button>
        <button id="tt-log-toggle">▶ Start tick log</button>
        <button id="tt-log-export">⬇ Export tick log</button>
      </div>
      <div id="tt-alert"></div>
    `;

    document.body.appendChild(el);

    // Restore saved position
    const saved = safeStorage('get', 'tt-pos');
    if (saved) {
      el.style.right = 'auto';
      el.style.left  = saved.left + 'px';
      el.style.top   = saved.top  + 'px';
    }

    makeDraggable(el);
    bindButtons(el);
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function makeDraggable (el) {
    const header = document.getElementById('tt-header');
    let ox = 0, oy = 0, sx = 0, sy = 0;

    header.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      sx = rect.left;
      sy = rect.top;
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

  // ── Button bindings ───────────────────────────────────────────────────────
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
      const cfg_el = document.getElementById('tt-config');
      cfg_el.classList.toggle('tt-open');
    });

    document.getElementById('tt-cfg-spike').addEventListener('change', function () {
      cfg.spikeThreshold = parseFloat(this.value) || 0.30;
      saveCfg();
    });

    document.getElementById('tt-cfg-rev').addEventListener('change', function () {
      cfg.reversalTicks = parseInt(this.value, 10) || 1;
      saveCfg();
    });

    document.getElementById('tt-cfg-snapback').addEventListener('change', function () {
      const v = parseFloat(this.value);
      cfg.minSnapbackRatio = (!isNaN(v) && v >= 0) ? v : 0.5;
      saveCfg();
    });

    document.getElementById('tt-cfg-lookback').addEventListener('change', function () {
      const v = parseInt(this.value, 10);
      cfg.extremeLookback = (!isNaN(v) && v >= 1) ? v : 10;
      saveCfg();
    });

    document.getElementById('tt-cfg-cooldown').addEventListener('change', function () {
      const v = parseInt(this.value, 10);
      cfg.cooldownTicks = (!isNaN(v) && v >= 0) ? v : 2;
      saveCfg();
    });

    document.getElementById('tt-cfg-volpct').addEventListener('change', function () {
      const v = parseFloat(this.value);
      cfg.minVolatilityPct = (!isNaN(v) && v >= 0) ? v : 0.03;
      saveCfg();
    });

    document.getElementById('tt-cfg-debug').addEventListener('change', function () {
      cfg.debugSignals = this.checked;
      saveCfg();
    });

    document.getElementById('tt-export').addEventListener('click', exportCSV);

    const logToggleBtn = document.getElementById('tt-log-toggle');
    if (logToggleBtn) {
      logToggleBtn.addEventListener('click', function () {
        tickLogging = !tickLogging;
        if (tickLogging) tickLog = []; // clear log on each new start
        this.textContent = tickLogging ? '⏹ Stop tick log' : '▶ Start tick log';
      });
    }

    const logExportBtn = document.getElementById('tt-log-export');
    if (logExportBtn) {
      logExportBtn.addEventListener('click', exportTickLog);
    }

    applyConfigToUI();
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  // Pick the Step Index 100 symbol from an active_symbols response array.
  function resolveSymbol (symbols) {
    // Prefer known Deriv symbol identifiers for Step Index 100
    var candidates = ['stpRNG', 'STPRNG'];
    for (var i = 0; i < candidates.length; i++) {
      if (symbols.find(function (s) { return s.symbol === candidates[i]; })) {
        return candidates[i];
      }
    }
    // Fallback: match by display_name
    var byName = symbols.find(function (s) {
      return /step\s*index\s*100/i.test(s.display_name) || /step\s*100/i.test(s.display_name);
    });
    if (byName) return byName.symbol;
    // Broader fallback: any symbol with "step" in the display name
    var step = symbols.find(function (s) {
      return /step/i.test(s.display_name);
    });
    return step ? step.symbol : null;
  }

  function connect () {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    if (location.protocol !== 'https:') {
      console.warn('[3Tick] page is not HTTPS – WebSocket connection may be blocked by the browser');
    }

    var url = usingFallback ? WS_URL_FALLBACK : WS_URL;
    setWsState('connecting');
    console.log('[3Tick] connecting to', url, usingFallback ? '(fallback)' : '');

    ws = new WebSocket(url);

    ws.addEventListener('open', function () {
      console.log('[3Tick] WebSocket open – requesting active_symbols');
      setWsState('connected');
      reconnectDelay = RECONNECT_BASE; // reset backoff on successful connection
      failCount     = 0;
      usingFallback = false;
      // Discover the correct symbol before subscribing
      ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' }));
    });

    ws.addEventListener('message', function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }

      if (msg.error) {
        console.error('[3Tick] API error', msg.error.code, msg.error.message, msg);
        showAlert('API error: ' + (msg.error.message || msg.error.code || 'unknown'));
        return;
      }

      if (msg.msg_type === 'active_symbols') {
        var sym = resolveSymbol(msg.active_symbols || []);
        if (!sym) {
          console.error('[3Tick] Step Index 100 not found in active_symbols', msg.active_symbols);
          showAlert('Step Index 100 not available on this account/region. Check console for details.');
          return;
        }
        resolvedSymbol = sym;
        console.log('[3Tick] resolved symbol:', resolvedSymbol);
        // Subscribe to live ticks
        ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 }));
        // Request candle history + live OHLC stream
        ws.send(JSON.stringify({
          ticks_history: resolvedSymbol, subscribe: 1,
          granularity: 60, style: 'candles', count: CANDLE_BUF, end: 'latest',
        }));
        return;
      }

      if (msg.msg_type === 'tick')         { handleTick(msg.tick); }
      else if (msg.msg_type === 'ohlc')    { handleOHLC(msg.ohlc); }
      else if (msg.msg_type === 'candles') { handleHistoryCandles(msg.candles); }
    });

    ws.addEventListener('close', function (e) {
      var info = `code=${e.code} wasClean=${e.wasClean}${e.reason ? ' reason=' + e.reason : ''}`;
      console.warn('[3Tick] WebSocket closed –', info);
      setWsState('disconnected');
      resolvedSymbol = null;
      if (!manualClose) {
        showAlert('Disconnected (' + info + '). Reconnecting…');
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', function (e) {
      console.error('[3Tick] WebSocket error', e);
      setWsState('disconnected');
      ws.close(); // triggers the close handler which schedules reconnect
    });
  }

  function scheduleReconnect () {
    if (reconnectTimer) return; // already waiting
    failCount++;
    // After FALLBACK_AFTER consecutive failures on the primary, try the fallback endpoint once
    if (!usingFallback && failCount >= FALLBACK_AFTER) {
      usingFallback = true;
      failCount = 0; // restart counter to track fallback failures independently
      console.warn('[3Tick] switching to fallback endpoint after', FALLBACK_AFTER, 'failures');
    } else if (usingFallback && failCount >= FALLBACK_AFTER) {
      // Fallback also failing – revert to primary and keep retrying with backoff
      usingFallback = false;
      failCount = 0;
      console.warn('[3Tick] fallback endpoint also failed; reverting to primary');
    }
    var delay = reconnectDelay;
    console.log('[3Tick] reconnecting in', delay, 'ms');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
    // Exponential backoff, capped at RECONNECT_MAX
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

  // ── Tick handling ─────────────────────────────────────────────────────────
  function handleTick (tick) {
    if (!tick || tick.symbol !== resolvedSymbol) return;
    const price = parseFloat(tick.quote);
    const time  = tick.epoch;

    ticks.push({ price, time });
    if (ticks.length > TICK_BUF) ticks.shift();

    // Update last-price display
    const priceEl = document.getElementById('tt-price');
    if (priceEl) priceEl.textContent = price.toFixed(2);

    // Check for new signal
    const detection = detectSignal();

    // Append to tick log when logging is active
    if (tickLogging) {
      const row = {
        epoch:            time,
        iso_time:         new Date(time * 1000).toISOString(),
        symbol:           resolvedSymbol || '',
        price:            price,
        spike_pct:        (detection && typeof detection.spikePct === 'number')
                            ? detection.spikePct.toFixed(5) : '',
        signal_candidate: (detection && detection.candidate) ? detection.candidate : '',
        reject_reason:    (detection && detection.rejectReason) ? detection.rejectReason : '',
        signal_fired:     detection ? detection.fired : false,
      };
      tickLog.push(row);
      if (tickLog.length > TICK_LOG_MAX) tickLog.shift();
    }

    // Score pending signals
    scorePendingSignals(price);
  }

  // ── Candle handling ───────────────────────────────────────────────────────
  function handleHistoryCandles (batch) {
    if (!Array.isArray(batch)) return;
    batch.forEach(function (c) {
      candles.push({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, time: +c.epoch });
    });
    candles.sort(function (a, b) { return a.time - b.time; });
    if (candles.length > CANDLE_BUF) candles.splice(0, candles.length - CANDLE_BUF);
    updateTrend();
    updateSR();
  }

  function handleOHLC (ohlc) {
    if (!ohlc || ohlc.symbol !== resolvedSymbol) return;
    const c = { open: +ohlc.open, high: +ohlc.high, low: +ohlc.low, close: +ohlc.close, time: +ohlc.open_time };
    // Replace last candle if same epoch, otherwise push new
    if (candles.length && candles[candles.length - 1].time === c.time) {
      candles[candles.length - 1] = c;
    } else {
      candles.push(c);
      if (candles.length > CANDLE_BUF) candles.shift();
    }
    updateTrend();
    updateSR();
  }

  // ── Signal detection (3-tick reversal logic) ──────────────────────────────
  /*
   * Logic:
   *  - A "spike" occurs when the most-recent tick differs from the previous tick
   *    by >= cfg.spikeThreshold %.
   *  - A "reversal" is confirmed when cfg.reversalTicks consecutive ticks then
   *    move in the OPPOSITE direction from the spike.
   *  - BUY  signal: spike was DOWN  then reversal tick(s) move UP
   *  - SELL signal: spike was UP    then reversal tick(s) move DOWN
   *
   * Quality gates (applied after base checks):
   *  1. Snapback strength  – reversal distance >= cfg.minSnapbackRatio * spike distance
   *  2. Local extreme      – spike tip must be the local high/low in cfg.extremeLookback window
   *  3. Volatility         – recent range must exceed cfg.minVolatilityPct %
   *  4. Cooldown           – at least cfg.cooldownTicks ticks since last signal
   */
  function detectSignal () {
    const n = ticks.length;
    if (n < cfg.reversalTicks + 2) return null;

    // The spike is between tick[n - reversalTicks - 2] and tick[n - reversalTicks - 1]
    const spikeFrom = ticks[n - cfg.reversalTicks - 2].price;
    const spikeTo   = ticks[n - cfg.reversalTicks - 1].price;
    if (spikeFrom === 0) return null;
    const spikePct  = Math.abs(spikeTo - spikeFrom) / spikeFrom * 100;
    if (spikePct < cfg.spikeThreshold) {
      if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: spike too small ${spikePct.toFixed(4)}% < threshold ${cfg.spikeThreshold}`);
      return { spikePct, candidate: null, rejectReason: 'spike_threshold', fired: false };
    }

    const spikeDir  = spikeTo > spikeFrom ? 1 : -1; // +1 = up spike, -1 = down spike
    const spikeAbs  = Math.abs(spikeTo - spikeFrom);
    const candidate = spikeDir === 1 ? 'SELL' : 'BUY';

    // Verify reversal ticks all move opposite to spike
    for (let i = 0; i < cfg.reversalTicks; i++) {
      const a = ticks[n - cfg.reversalTicks - 1 + i].price;
      const b = ticks[n - cfg.reversalTicks     + i].price;
      const dir = b > a ? 1 : b < a ? -1 : 0;
      if (dir !== -spikeDir) {
        if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: reversal tick wrong direction at i=${i}`);
        return { spikePct, candidate, rejectReason: 'reversal_dir', fired: false };
      }
    }

    // ── Gate 1: Snapback strength ─────────────────────────────────────────
    const tipPrice        = spikeTo;
    const latestPrice     = ticks[n - 1].price;
    const reversalDistance = Math.abs(latestPrice - tipPrice);
    if (spikeAbs > 0 && (reversalDistance / spikeAbs) < cfg.minSnapbackRatio) {
      if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: snapback ${(reversalDistance / spikeAbs).toFixed(3)} < ratio ${cfg.minSnapbackRatio}`);
      return { spikePct, candidate, rejectReason: 'snapback', fired: false };
    }

    // ── Gate 2: Local extreme ─────────────────────────────────────────────
    // Look back extremeLookback ticks around the spike window (excluding reversal ticks)
    const lookEnd   = n - cfg.reversalTicks;
    const lookStart = Math.max(0, lookEnd - cfg.extremeLookback);
    const lookPrices = [];
    for (let i = lookStart; i < lookEnd; i++) {
      lookPrices.push(ticks[i].price);
    }
    if (lookPrices.length > 0) {
      if (spikeDir === 1) {
        // Up spike → SELL setup: spike tip must be >= local high
        const localHigh = Math.max.apply(null, lookPrices);
        if (tipPrice < localHigh) {
          if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: local-extreme (up spike tip ${tipPrice} < localHigh ${localHigh})`);
          return { spikePct, candidate, rejectReason: 'extreme', fired: false };
        }
      } else {
        // Down spike → BUY setup: spike tip must be <= local low
        const localLow = Math.min.apply(null, lookPrices);
        if (tipPrice > localLow) {
          if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: local-extreme (down spike tip ${tipPrice} > localLow ${localLow})`);
          return { spikePct, candidate, rejectReason: 'extreme', fired: false };
        }
      }
    }

    // ── Gate 3: Volatility ────────────────────────────────────────────────
    const volStart  = Math.max(0, n - cfg.extremeLookback);
    const volPrices = [];
    for (let i = volStart; i < n; i++) {
      volPrices.push(ticks[i].price);
    }
    if (volPrices.length > 1) {
      const refPrice = volPrices[0] || 1;
      const volRange = (Math.max.apply(null, volPrices) - Math.min.apply(null, volPrices)) / refPrice * 100;
      if (volRange < cfg.minVolatilityPct) {
        if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: volatility ${volRange.toFixed(4)}% < minVolatilityPct ${cfg.minVolatilityPct}`);
        return { spikePct, candidate, rejectReason: 'volatility', fired: false };
      }
    }

    // ── Gate 4: Cooldown ──────────────────────────────────────────────────
    const ticksSinceLast = (n - 1) - lastSignalTickIndex;
    if (ticksSinceLast < cfg.cooldownTicks) {
      if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: cooldown (${ticksSinceLast} ticks since last, need ${cfg.cooldownTicks})`);
      return { spikePct, candidate, rejectReason: 'cooldown', fired: false };
    }

    const sigType  = candidate;
    const sigPrice = ticks[n - 1].price;
    const sigTime  = ticks[n - 1].time;

    // Avoid duplicate signal at same timestamp
    if (signals.length && signals[signals.length - 1].time === sigTime) {
      return { spikePct, candidate, rejectReason: 'duplicate', fired: false };
    }

    lastSignalTickIndex = n - 1;

    const sig = { type: sigType, price: sigPrice, time: sigTime, result: 'PENDING', ticksAfter: [] };
    signals.push(sig);
    if (signals.length > 50) signals.shift();

    if (cfg.debugSignals) console.log(`[3Tick][signal] ACCEPTED ${sigType} at price ${sigPrice} time ${sigTime}`);

    updateSignalsUI();
    return { spikePct, candidate, rejectReason: null, fired: true };
  }

  function scorePendingSignals (currentPrice) {
    let changed = false;

    signals.forEach(function (sig) {
      if (sig.result !== 'PENDING') return;

      sig.ticksAfter.push(currentPrice);

      if (sig.ticksAfter.length >= 3) {
        const entry  = sig.price;
        const exit   = sig.ticksAfter[2];
        const isWin  = sig.type === 'BUY' ? exit > entry : exit < entry;
        sig.result   = isWin ? 'WIN' : 'LOSS';
        sig.priceAfter = exit;
        if (isWin) { wins++;   updateWinsLossesUI(); }
        else       { losses++; updateWinsLossesUI(); }
        changed = true;
      }
    });

    if (changed) updateSignalsUI();
  }

  // ── 1-minute trend ────────────────────────────────────────────────────────
  function updateTrend () {
    const el = document.getElementById('tt-trend');
    if (!el) return;
    const n = candles.length;
    if (n < 3) { el.textContent = '–'; el.className = 'tt-val'; return; }

    const last3 = candles.slice(n - 3);
    const ups   = last3.filter(function (c) { return c.close > c.open; }).length;
    const downs = last3.filter(function (c) { return c.close < c.open; }).length;

    if (ups >= 2)   { el.textContent = '▲ Up';    el.className = 'tt-val tt-trend-up'; }
    else if (downs >= 2) { el.textContent = '▼ Down'; el.className = 'tt-val tt-trend-down'; }
    else            { el.textContent = '↔ Side';  el.className = 'tt-val tt-trend-side'; }
  }

  // ── S/R detection ─────────────────────────────────────────────────────────
  function updateSR () {
    const el = document.getElementById('tt-sr-list');
    if (!el) return;

    const slice = candles.slice(-SR_WINDOW);
    if (slice.length < 5) return;

    const highs = slice.map(function (c) { return c.high; });
    const lows  = slice.map(function (c) { return c.low;  });

    // Find local maxima (resistance) and local minima (support)
    const res = findLocalExtrema(highs, 'max').slice(0, SR_COUNT);
    const sup = findLocalExtrema(lows,  'min').slice(0, SR_COUNT);

    el.innerHTML = '';

    res.forEach(function (v) {
      const div = document.createElement('div');
      div.className = 'tt-sr-item';
      div.innerHTML = `<span class="tt-sr-label tt-sr-res">R</span><span class="tt-sr-price">${v.toFixed(2)}</span>`;
      el.appendChild(div);
    });

    sup.forEach(function (v) {
      const div = document.createElement('div');
      div.className = 'tt-sr-item';
      div.innerHTML = `<span class="tt-sr-label tt-sr-sup">S</span><span class="tt-sr-price">${v.toFixed(2)}</span>`;
      el.appendChild(div);
    });
  }

  function findLocalExtrema (arr, type) {
    const results = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (type === 'max' && arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) results.push(arr[i]);
      if (type === 'min' && arr[i] < arr[i - 1] && arr[i] < arr[i + 1]) results.push(arr[i]);
    }
    // Deduplicate close values (within 0.05%) and sort
    const deduped = [];
    const sorted  = type === 'max'
      ? results.sort(function (a, b) { return b - a; })
      : results.sort(function (a, b) { return a - b; });

    sorted.forEach(function (v) {
      const last = deduped[deduped.length - 1];
      if (!deduped.length || (last !== 0 && Math.abs(v - last) / last * 100 > 0.05)) {
        deduped.push(v);
      }
    });
    return deduped;
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function updateWinsLossesUI () {
    const we = document.getElementById('tt-wins');
    const le = document.getElementById('tt-losses');
    if (we) we.textContent = wins;
    if (le) le.textContent = losses;
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
      div.innerHTML = `
        <span class="tt-signal-type">${sig.type}</span>
        <span class="tt-signal-price">${sig.price.toFixed(2)}</span>
        <span class="tt-signal-time">${fmtTime(sig.time)}</span>
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

  // ── CSV export ────────────────────────────────────────────────────────────
  function exportCSV () {
    const rows = [['Type', 'Entry Price', 'Time', 'Result', 'Exit Price']];
    signals.forEach(function (s) {
      rows.push([
        s.type,
        s.price.toFixed(2),
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

  // ── Tick log CSV export ───────────────────────────────────────────────────
  function exportTickLog () {
    if (!tickLog.length) {
      showAlert('No tick log data to export. Start logging first.');
      return;
    }
    const headers = ['epoch', 'iso_time', 'symbol', 'price', 'spike_pct', 'signal_candidate', 'reject_reason', 'signal_fired'];
    const rows = [headers].concat(tickLog.map(function (r) {
      return headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; });
    }));
    const csv  = rows.map(function (r) { return r.join(','); }).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = '3tick-log-' + Date.now() + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Local-storage helpers (wrapped to avoid exceptions) ───────────────────
  function safeStorage (op, key, value) {
    try {
      if (op === 'get')  return JSON.parse(localStorage.getItem(key));
      if (op === 'set')  localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
    return null;
  }

  // ── Config persistence ────────────────────────────────────────────────────
  function getDefaultCfg () {
    return {
      spikeThreshold:   0.30,
      reversalTicks:    1,
      minSnapbackRatio: 0.5,
      extremeLookback:  10,
      cooldownTicks:    2,
      minVolatilityPct: 0.03,
      debugSignals:     false,
    };
  }

  function loadCfg () {
    const stored = safeStorage('get', 'tt-cfg');
    const def    = getDefaultCfg();
    if (stored && typeof stored === 'object') {
      Object.keys(def).forEach(function (k) {
        if (k in stored && stored[k] !== null && stored[k] !== undefined) {
          def[k] = stored[k];
        }
      });
    }
    return def;
  }

  function saveCfg () {
    safeStorage('set', 'tt-cfg', cfg);
  }

  // ── Apply loaded config values to UI inputs ───────────────────────────────
  function applyConfigToUI () {
    const s   = document.getElementById('tt-cfg-spike');
    if (s)   s.value     = cfg.spikeThreshold;
    const r   = document.getElementById('tt-cfg-rev');
    if (r)   r.value     = cfg.reversalTicks;
    const sb  = document.getElementById('tt-cfg-snapback');
    if (sb)  sb.value    = cfg.minSnapbackRatio;
    const lb  = document.getElementById('tt-cfg-lookback');
    if (lb)  lb.value    = cfg.extremeLookback;
    const cd  = document.getElementById('tt-cfg-cooldown');
    if (cd)  cd.value    = cfg.cooldownTicks;
    const vp  = document.getElementById('tt-cfg-volpct');
    if (vp)  vp.value    = cfg.minVolatilityPct;
    const dbg = document.getElementById('tt-cfg-debug');
    if (dbg) dbg.checked = cfg.debugSignals;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init () {
    if (document.getElementById('tt-overlay')) return; // already injected
    cfg = loadCfg();
    buildOverlay();
    connect();
  }

  // Wait until the page body is available, then inject
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
