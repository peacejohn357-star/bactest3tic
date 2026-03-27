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
  const TICK_LOG_MAX           = 5000;  // maximum in-memory tick log rows
  const SESSION_HISTORY_CAP    = 5000;  // maximum full-session trade history for CSV export
  const WATCHDOG_INTERVAL      = 5000;  // ms – watchdog check frequency
  const WATCHDOG_TICK_TIMEOUT  = 25000; // ms – connected but no tick → re-subscribe (stage 1)
  const WATCHDOG_EVAL_TIMEOUT  = 20000; // ms – ticks arriving but eval stalled → reset eval state
  const WATCHDOG_SETUP_STALE_MS = 20000; // ms – pending setup older than this is considered stuck
  const WATCHDOG_RESUB_GRACE    = 3;    // multiplier: resub window = WATCHDOG_TICK_TIMEOUT * this
  const WATCHDOG_RESUB_GRACE_MS = WATCHDOG_TICK_TIMEOUT * WATCHDOG_RESUB_GRACE; // escalation window before reconnect

  let cfg = {
    // ── Strategy mode ──────────────────────────────────────────────────────
    strategyMode:      'indicator', // 'indicator' | 'classic'
    indicatorPreset:   'balanced',  // 'aggressive' | 'balanced' | 'conservative'
    minIndicatorScore: 3,           // minimum combined indicator score to fire a signal (2–5)
    sameSideCooldownTicks: 5,       // minimum ticks before allowing another entry in the same direction
    chopHistThreshold: 0.0002,      // MACD histogram magnitude below which market is considered choppy
    nearZeroHistThreshold: 0.01,    // |hist| <= this → near-zero transition zone; requires alignMin+1 before entry
    entryProfile:      'balanced',  // 'early' | 'balanced' | 'strict' – maps to chop/alignment/two-stage thresholds
    macdTrendEpsilon:  0.00005,     // dead-zone half-width for tick-MACD trend classification
    macdTrendLookback: 3,           // number of recent ticks used to check histogram direction
    tickSize:          0.1,         // Step Index 100 minimum price movement (tick size)
    equalCountsAsWin:  true,        // equality at expiry counts as WIN for both BUY and SELL
    // ── Classic spike settings (used when strategyMode === 'classic') ──────
    spikeMode:        'auto',  // 'auto' | 'percent' | 'points'
    spikeThreshold:   0.001,   // minimum % price-move considered a spike (permissive default for calibration)
    minSpikePoints:   0.1,     // minimum absolute point-move for spike (used in 'points'/'auto' mode)
    reversalTicks:    1,       // consecutive opposite-direction ticks to confirm reversal
    minSnapbackRatio: 0.2,     // reversal must retrace >= this fraction of spike distance
    extremeLookback:  4,       // spike tip must be local high/low within last N ticks
    cooldownTicks:    1,       // minimum ticks between new signals
    minVolatilityPct: 0.005,   // skip signals when recent range is too flat (%)
    debugSignals:     true,    // log signal accept/reject reasons to console
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let ticks       = [];  // { price: number, time: number }
  let candles     = [];  // { open, high, low, close, time }
  let signals     = [];  // { type, price, time, result, ticksAfter, priceAfter } – UI display (capped at 50)
  let sessionTradesAll = []; // full session trade history for CSV export (capped at SESSION_HISTORY_CAP)
  let wins        = 0;
  let losses      = 0;
  let tickSeq                 = 0;    // monotonic tick sequence (never shrinks when tick buffer shifts)
  let lastSignalTickIndex     = -999; // tick sequence index of last fired signal (cooldown tracking)
  let lastSignalSide          = null; // 'BUY' | 'SELL' | null – for same-side cooldown
  let lastSignalSideTickIndex = -999; // tick sequence index of last same-side signal
  let pendingSetup            = null; // { side: 'BUY'|'SELL', tickIndex, hist, createdAt } where tickIndex is monotonic tickSeq

  let lastTickProcessedAt  = 0;    // Date.now() of last tick received (for watchdog)
  let lastSignalEvalAt     = 0;    // Date.now() of last successful detectSignal() call (for watchdog)
  let watchdogInterval     = null; // setInterval handle for the watchdog
  let evalErrorCount       = 0;    // cumulative count of detectSignal() exceptions (watchdog observability)
  let lastSignalFiredAt    = 0;    // Date.now() of last successfully fired signal (watchdog observability)
  let watchdogLastResubAt  = 0;    // Date.now() of last watchdog resubscribe action (two-stage recovery)
  let lastWatchdogEvent    = '';   // last watchdog recovery action name; consumed by next tick log entry

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
          <span class="tt-label">Trend</span>
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
            <label>Strategy mode</label>
            <select id="tt-cfg-strategy-mode">
              <option value="indicator">Indicator</option>
              <option value="classic">Classic</option>
            </select>
          </div>
          <div id="tt-indicator-controls">
            <div class="tt-config-row">
              <label>Entry profile</label>
              <select id="tt-cfg-entry-profile">
                <option value="early">Early (more entries)</option>
                <option value="balanced">Balanced (default)</option>
                <option value="strict">Strict (fewer, cleaner)</option>
              </select>
            </div>
            <div class="tt-config-row">
              <label>Indicator preset</label>
              <select id="tt-cfg-indicator-preset">
                <option value="aggressive">Aggressive (≥2)</option>
                <option value="balanced">Balanced (≥3)</option>
                <option value="conservative">Conservative (≥4)</option>
              </select>
            </div>
            <div class="tt-config-row">
              <label>Min indicator score (2–5)</label>
              <input type="number" id="tt-cfg-min-score" min="2" max="5" step="1" value="3">
            </div>
            <div class="tt-config-row">
              <label>Trend source</label>
              <span class="tt-val" style="font-size:11px;color:#7ec8e3;">tick_macd</span>
            </div>
            <div class="tt-config-row">
              <label>MACD trend epsilon</label>
              <input type="number" id="tt-cfg-macd-epsilon" min="0" max="0.01" step="0.00001" value="0.00005">
            </div>
            <div class="tt-config-row">
              <label>MACD trend lookback</label>
              <input type="number" id="tt-cfg-macd-lookback" min="2" max="10" step="1" value="3">
            </div>
          </div>
          <div id="tt-classic-controls">
            <div class="tt-config-section-label">Classic spike settings</div>
            <div class="tt-config-row">
              <label>Spike mode</label>
              <select id="tt-cfg-spike-mode">
                <option value="auto">auto</option>
                <option value="percent">percent</option>
                <option value="points">points</option>
              </select>
            </div>
            <div class="tt-config-row">
              <label>Spike % threshold</label>
              <input type="number" id="tt-cfg-spike" min="0.0001" max="5" step="0.0001" value="0.001">
            </div>
            <div class="tt-config-row">
              <label>Min spike points</label>
              <input type="number" id="tt-cfg-spike-points" min="0" max="100" step="0.01" value="0.1">
            </div>
            <div class="tt-config-row">
              <label>Reversal ticks</label>
              <input type="number" id="tt-cfg-rev" min="1" max="5" step="1" value="1">
            </div>
            <div class="tt-config-row">
              <label>Snapback ratio (0–1)</label>
              <input type="number" id="tt-cfg-snapback" min="0" max="1" step="0.05" value="0.2">
            </div>
            <div class="tt-config-row">
              <label>Extreme lookback</label>
              <input type="number" id="tt-cfg-lookback" min="1" max="50" step="1" value="4">
            </div>
            <div class="tt-config-row">
              <label>Cooldown ticks</label>
              <input type="number" id="tt-cfg-cooldown" min="0" max="20" step="1" value="1">
            </div>
            <div class="tt-config-row">
              <label>Min volatility %</label>
              <input type="number" id="tt-cfg-volpct" min="0" max="5" step="0.001" value="0.005">
            </div>
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
  function syncStrategyModeUI (mode) {
    const classicEl   = document.getElementById('tt-classic-controls');
    const indicatorEl = document.getElementById('tt-indicator-controls');
    if (classicEl)   classicEl.style.display   = mode === 'classic'    ? '' : 'none';
    if (indicatorEl) indicatorEl.style.display = mode === 'indicator'  ? '' : 'none';
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
      const cfg_el = document.getElementById('tt-config');
      cfg_el.classList.toggle('tt-open');
    });

    // ── Indicator-mode controls ──────────────────────────────────────────
    document.getElementById('tt-cfg-strategy-mode').addEventListener('change', function () {
      cfg.strategyMode = this.value;
      syncStrategyModeUI(cfg.strategyMode);
      saveCfg();
    });

    const entryProfileEl = document.getElementById('tt-cfg-entry-profile');
    if (entryProfileEl) {
      entryProfileEl.addEventListener('change', function () {
        cfg.entryProfile = this.value;
        saveCfg();
      });
    }

    document.getElementById('tt-cfg-indicator-preset').addEventListener('change', function () {
      cfg.indicatorPreset = this.value;
      const presetScores = { aggressive: 2, balanced: 3, conservative: 4 };
      cfg.minIndicatorScore = presetScores[cfg.indicatorPreset] || 3;
      const scoreEl = document.getElementById('tt-cfg-min-score');
      if (scoreEl) scoreEl.value = cfg.minIndicatorScore;
      saveCfg();
    });

    document.getElementById('tt-cfg-min-score').addEventListener('change', function () {
      const v = parseInt(this.value, 10);
      cfg.minIndicatorScore = (!isNaN(v) && v >= 2 && v <= 5) ? v : 3;
      saveCfg();
    });

    const macdEpsilonEl = document.getElementById('tt-cfg-macd-epsilon');
    if (macdEpsilonEl) {
      macdEpsilonEl.addEventListener('change', function () {
        const v = parseFloat(this.value);
        cfg.macdTrendEpsilon = (!isNaN(v) && v >= 0) ? v : 0.00005;
        saveCfg();
      });
    }

    const macdLookbackEl = document.getElementById('tt-cfg-macd-lookback');
    if (macdLookbackEl) {
      macdLookbackEl.addEventListener('change', function () {
        const v = parseInt(this.value, 10);
        cfg.macdTrendLookback = (!isNaN(v) && v >= 2) ? v : 3;
        saveCfg();
      });
    }

    // ── Classic spike controls ───────────────────────────────────────────
    document.getElementById('tt-cfg-spike-mode').addEventListener('change', function () {
      cfg.spikeMode = this.value;
      saveCfg();
    });

    document.getElementById('tt-cfg-spike').addEventListener('change', function () {
      cfg.spikeThreshold = parseFloat(this.value) || 0.001;
      saveCfg();
    });

    document.getElementById('tt-cfg-spike-points').addEventListener('change', function () {
      const v = parseFloat(this.value);
      cfg.minSpikePoints = (!isNaN(v) && v >= 0) ? v : 0.1;
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
      // Reset watchdog clocks from connection time so stale-tick detection starts immediately
      lastTickProcessedAt = Date.now();
      lastSignalEvalAt    = Date.now();
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
    tickSeq++;

    ticks.push({ price, time });
    if (ticks.length > TICK_BUF) ticks.shift();

    lastTickProcessedAt = Date.now(); // watchdog: record last tick arrival time

    // Update last-price display
    const priceEl = document.getElementById('tt-price');
    if (priceEl) priceEl.textContent = price.toFixed(2);

    // Check for new signal – wrapped in try/catch to prevent stalls on errors
    let detection = null;
    try {
      detection = detectSignal();
      lastSignalEvalAt = Date.now(); // watchdog: eval completed successfully
    } catch (e) {
      evalErrorCount++;
      console.error('[3Tick][handleTick] eval error #' + evalErrorCount + ' (skipping tick)', e);
    }

    // Update tick-MACD trend display
    updateTickMacdTrendUI();

    // Append to tick log when logging is active
    if (tickLogging) {
      const isIndicatorMode = (cfg.strategyMode || 'indicator') === 'indicator';
      // Consume watchdog event so only one tick log entry carries each event name
      const wdEvent = lastWatchdogEvent;
      lastWatchdogEvent = '';
      const row = {
        epoch:            time,
        iso_time:         new Date(time * 1000).toISOString(),
        symbol:           resolvedSymbol || '',
        price:            price,
        strategy_mode:    cfg.strategyMode || 'indicator',
        // indicator-mode fields
        buy_score:        (isIndicatorMode && detection && detection.buyScore  != null) ? detection.buyScore  : '',
        sell_score:       (isIndicatorMode && detection && detection.sellScore != null) ? detection.sellScore : '',
        score_components: isIndicatorMode && detection
          ? (detection.fired
              ? (detection.candidate === 'BUY' ? detection.buyComponents : detection.sellComponents)
              : (detection.buyScore >= detection.sellScore ? detection.buyComponents : detection.sellComponents))
          : '',
        indicator_reason: isIndicatorMode && detection
          ? (detection.fired
              ? 'accepted:' + detection.candidate
              : 'rejected:' + (detection.rejectReason || ''))
          : '',
        // tick-MACD observability fields (NaN → '' in CSV; NaN means warmup/insufficient data)
        trend_source: isIndicatorMode ? 'tick_macd' : 'classic',
        macd_line:    (function () {
          if (!isIndicatorMode || !detection) return '';
          var v = detection.macdLine;
          return (v != null && !isNaN(v)) ? (+v).toFixed(6) : '';
        }()),
        macd_signal:  (function () {
          if (!isIndicatorMode || !detection) return '';
          var v = detection.macdSignal;
          return (v != null && !isNaN(v)) ? (+v).toFixed(6) : '';
        }()),
        macd_hist:    (function () {
          if (!isIndicatorMode || !detection) return '';
          var v = detection.macdHist;
          return (v != null && !isNaN(v)) ? (+v).toFixed(6) : '';
        }()),
        macd_trend:   (isIndicatorMode && detection && detection.macdTrend) ? detection.macdTrend : '',
        // entry-quality observability fields
        entry_profile:        isIndicatorMode ? (cfg.entryProfile || 'balanced') : '',
        chop_score:           (isIndicatorMode && detection && detection.chopScore != null) ? detection.chopScore : '',
        alignment_score_buy:  (isIndicatorMode && detection && detection.alignmentScoreBuy  != null) ? detection.alignmentScoreBuy  : '',
        alignment_score_sell: (isIndicatorMode && detection && detection.alignmentScoreSell != null) ? detection.alignmentScoreSell : '',
        setup_state:          (isIndicatorMode && detection && detection.setupState)   ? detection.setupState   : '',
        entry_reason:         (isIndicatorMode && detection && detection.entryReason)  ? detection.entryReason  : '',
        // classic-mode fields
        spike_pct:        (!isIndicatorMode && detection && typeof detection.spikePct === 'number')
                            ? detection.spikePct.toFixed(5) : '',
        spike_points:     (!isIndicatorMode && detection && typeof detection.spikeAbs === 'number')
                            ? detection.spikeAbs.toFixed(5) : '',
        spike_threshold_used: (!isIndicatorMode && detection && typeof detection.spikeAbs === 'number')
                            ? (detection.spikeMode === 'percent'
                                ? cfg.spikeThreshold + '%'
                                : detection.spikeMode === 'points'
                                ? cfg.minSpikePoints + 'pts'
                                : cfg.minSpikePoints + 'pts/' + cfg.spikeThreshold + '%')
                            : '',
        spike_mode_used:  (!isIndicatorMode && detection && detection.spikeMode) ? detection.spikeMode : '',
        signal_candidate: (detection && detection.candidate) ? detection.candidate : '',
        reject_reason:    (detection && detection.rejectReason) ? detection.rejectReason : '',
        signal_fired:     detection ? detection.fired : false,
        // watchdog observability fields (appended; do not break existing CSV columns)
        watchdog_event:   wdEvent,
        ws_state:         wsState,
        tick_age_ms:      Math.max(0, Date.now() - (time * 1000)),
        eval_age_ms:      lastSignalEvalAt > 0 ? Date.now() - lastSignalEvalAt : '',
        eval_error_count: evalErrorCount,
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
   *
   * When cfg.strategyMode === 'indicator', delegates to detectSignalIndicator() instead.
   */
  function detectSignal () {
    // Route to indicator mode when configured
    if ((cfg.strategyMode || 'indicator') === 'indicator') {
      return detectSignalIndicator();
    }

    const n = ticks.length;
    if (n < cfg.reversalTicks + 2) return null;

    // The spike is between tick[n - reversalTicks - 2] and tick[n - reversalTicks - 1]
    const spikeFrom = ticks[n - cfg.reversalTicks - 2].price;
    const spikeTo   = ticks[n - cfg.reversalTicks - 1].price;
    if (spikeFrom === 0) return null;
    const spikeAbs  = Math.abs(spikeTo - spikeFrom);
    const spikePct  = spikeAbs / spikeFrom * 100;

    // Determine spike pass based on configured mode
    const mode = cfg.spikeMode || 'auto';
    let spikePass;
    if (mode === 'percent') {
      spikePass = spikePct >= cfg.spikeThreshold;
    } else if (mode === 'points') {
      spikePass = spikeAbs >= cfg.minSpikePoints;
    } else {
      // auto: pass if either condition is met
      spikePass = spikeAbs >= cfg.minSpikePoints || spikePct >= cfg.spikeThreshold;
    }

    if (!spikePass) {
      if (cfg.debugSignals) console.log(`[3Tick][signal] rejected: spike too small -- mode=${mode} spikeAbs=${spikeAbs.toFixed(5)} (need ${cfg.minSpikePoints}pts) spikePct=${spikePct.toFixed(5)}% (need ${cfg.spikeThreshold}%)`);
      return { spikePct, spikeAbs, spikeMode: mode, candidate: null, rejectReason: 'spike_threshold', fired: false };
    }

    const spikeDir  = spikeTo > spikeFrom ? 1 : -1; // +1 = up spike, -1 = down spike
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
    const currentTickIndex = tickSeq;
    const ticksSinceLast = currentTickIndex - lastSignalTickIndex;
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

    lastSignalTickIndex = currentTickIndex;

    const sig = { type: sigType, price: sigPrice, time: sigTime, result: 'PENDING', ticksAfter: [] };
    signals.push(sig);
    if (signals.length > 50) signals.shift();
    recordSessionTrade(sig);

    if (cfg.debugSignals) console.log(`[3Tick][signal] ACCEPTED ${sigType} at price ${sigPrice} time ${sigTime}`);

    lastSignalFiredAt = Date.now(); // watchdog: track last fired signal
    updateSignalsUI();
    return { spikePct, spikeAbs, spikeMode: mode, candidate, rejectReason: null, fired: true };
  }

  // ── Centralised trade-result settlement ─────────────────────────────────
  // Single authoritative function used by all settlement and export paths.
  // Uses raw numeric prices directly — no intermediate conversion layers.
  //
  // Validation examples:
  //   SELL 7978.40 -> 7978.20 => WIN   (exit < entry)
  //   SELL 7977.90 -> 7977.90 => WIN   (exit == entry, equality counts as WIN)
  //   SELL 7977.80 -> 7978.00 => LOSS  (exit > entry)
  //   BUY  7978.50 -> 7978.70 => WIN   (exit > entry)
  //   BUY  7978.50 -> 7978.50 => WIN   (exit == entry, equality counts as WIN)
  //   BUY  7978.60 -> 7978.40 => LOSS  (exit < entry)
  function computeTradeResult (side, entryPrice, exitPrice) {
    const entry = Number(entryPrice);
    const exit  = Number(exitPrice);

    // Guard: if either price is not a valid finite number, treat as unsettled.
    if (!isFinite(entry) || !isFinite(exit)) {
      if (cfg.debugSignals) {
        console.warn('[3Tick][computeTradeResult] invalid prices — entry=' + entryPrice + ' exit=' + exitPrice);
      }
      return { isWin: false, result: 'LOSS', comparator: '?' };
    }

    const isBuy  = side === 'BUY';
    const isWin  = isBuy ? (exit >= entry) : (exit <= entry);
    const result = isWin ? 'WIN' : 'LOSS';

    if (cfg.debugSignals) {
      const comparator = isBuy ? '>=' : '<=';
      console.log(
        '[3Tick][computeTradeResult] source=computeTradeResult' +
        ' side='           + side       +
        ' entryPrice='     + entry      +
        ' exitPrice='      + exit       +
        ' comparator='     + comparator +
        ' computedResult=' + result
      );
    }

    return { isWin, result };
  }

  function scorePendingSignals (currentPrice) {
    let changed = false;

    signals.forEach(function (sig) {
      if (sig.result !== 'PENDING') return;

      sig.ticksAfter.push(currentPrice);

      if (sig.ticksAfter.length >= 3) {
        const entry  = sig.price;
        const exit   = sig.ticksAfter[2];
        const { isWin, result } = computeTradeResult(sig.type, entry, exit);

        sig.result     = result;
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

  // ── Indicator helper functions ────────────────────────────────────────────

  // Exponential Moving Average; returns array of same length (NaN until enough data)
  function calcEMA (period, data) {
    const k = 2 / (period + 1);
    const result = [];
    let ema = NaN;
    for (let i = 0; i < data.length; i++) {
      if (isNaN(ema)) {
        if (i + 1 === period) {
          let sum = 0;
          for (let j = 0; j < period; j++) sum += data[j];
          ema = sum / period;
        }
      } else {
        ema = data[i] * k + ema * (1 - k);
      }
      result.push(isNaN(ema) ? NaN : ema);
    }
    return result;
  }

  // Simple Moving Average; returns array of same length (NaN until enough data)
  function calcSMA (period, data) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i + 1 < period) {
        result.push(NaN);
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        result.push(sum / period);
      }
    }
    return result;
  }

  // MACD(12,26,9) using an array of close prices
  // Returns null if insufficient data, otherwise { macdLine, signalLine, histogram, histogramRising, macdAboveSignal }
  function calcMACD (closes) {
    if (closes.length < 26) return null;
    const ema12arr = calcEMA(12, closes);
    const ema26arr = calcEMA(26, closes);
    const macdArr  = [];
    for (let i = 0; i < closes.length; i++) {
      const v12 = ema12arr[i], v26 = ema26arr[i];
      macdArr.push((isNaN(v12) || isNaN(v26)) ? NaN : v12 - v26);
    }
    const validMacd = macdArr.filter(function (v) { return !isNaN(v); });
    if (validMacd.length < 9) return null;
    const sigArr = calcEMA(9, validMacd);
    const n = validMacd.length;
    const latestMacd  = validMacd[n - 1];
    const prevMacd    = validMacd[n - 2];
    const latestSig   = sigArr[sigArr.length - 1];
    const prevSig     = sigArr[sigArr.length - 2];
    if (isNaN(latestSig)) return null;
    const histogram     = latestMacd - latestSig;
    const prevHistogram = isNaN(prevSig) ? histogram : (prevMacd - prevSig);
    return {
      macdLine:        latestMacd,
      signalLine:      latestSig,
      histogram,
      histogramRising: histogram > prevHistogram,
      macdAboveSignal: latestMacd > latestSig,
    };
  }

  // RSI(14) using an array of close prices
  // Returns null if insufficient data, otherwise { value, prev, rising }
  function calcRSI (closes) {
    const period = 14;
    if (closes.length < period + 2) return null;
    const slice = closes.slice(-Math.min(closes.length, 60));
    function computeRSI (arr) {
      let avgGain = 0, avgLoss = 0;
      for (let i = 1; i <= period; i++) {
        const diff = arr[i] - arr[i - 1];
        if (diff > 0) avgGain += diff;
        else          avgLoss += Math.abs(diff);
      }
      avgGain /= period;
      avgLoss /= period;
      for (let i = period + 1; i < arr.length; i++) {
        const diff = arr[i] - arr[i - 1];
        const g = diff > 0 ? diff : 0;
        const l = diff < 0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    }
    const current = computeRSI(slice);
    const prev    = computeRSI(slice.slice(0, -1));
    return { value: current, prev, rising: current > prev };
  }

  // Bollinger Bands(14, 2) with EMA basis using an array of close prices
  // Returns null if insufficient data, otherwise { basis, upper, lower }
  function calcBollinger (closes) {
    const period = 14;
    const mult   = 2;
    if (closes.length < period) return null;
    const slice  = closes.slice(-Math.min(closes.length, period * 3));
    const emaArr = calcEMA(period, slice);
    const basis  = emaArr[emaArr.length - 1];
    if (isNaN(basis)) return null;
    const last14   = closes.slice(-period);
    const mean     = last14.reduce(function (a, b) { return a + b; }, 0) / period;
    const variance = last14.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / period;
    const stddev   = Math.sqrt(variance);
    return { basis, upper: basis + mult * stddev, lower: basis - mult * stddev };
  }

  // MA(4) using recent tick prices
  // Returns null if insufficient data, otherwise { value, rising }
  function calcMA4 (prices) {
    const period = 4;
    if (prices.length < period) return null;
    const cur  = prices.slice(-period).reduce(function (a, b) { return a + b; }, 0) / period;
    const prev = prices.length >= period + 1
      ? prices.slice(-period - 1, -1).reduce(function (a, b) { return a + b; }, 0) / period
      : cur;
    return { value: cur, rising: cur > prev };
  }

  // Stochastic Momentum proxy (10,3,3) using candle data
  // Note: Exact Stch Mtm internals are approximated here as Stochastic Oscillator
  // with smoothed %K and %D; logged in debug as inferred calculation.
  // Returns null if insufficient data, otherwise { k, d, kAboveD, kRising }
  function calcStochMtm (candleData) {
    const periodK = 10;
    const smoothK = 3;
    const smoothD = 3;
    const needed  = periodK + smoothK + smoothD;
    if (candleData.length < needed) return null;
    const kRaw = [];
    for (let i = periodK - 1; i < candleData.length; i++) {
      const window = candleData.slice(i - periodK + 1, i + 1);
      const lowestLow   = Math.min.apply(null, window.map(function (c) { return c.low; }));
      const highestHigh = Math.max.apply(null, window.map(function (c) { return c.high; }));
      const range = highestHigh - lowestLow;
      kRaw.push(range > 0 ? (candleData[i].close - lowestLow) / range * 100 : 50);
    }
    if (kRaw.length < smoothK + smoothD) return null;
    const kSmooth = calcSMA(smoothK, kRaw);
    const validK  = kSmooth.filter(function (v) { return !isNaN(v); });
    if (validK.length < smoothD) return null;
    const dSmooth   = calcSMA(smoothD, validK);
    const latestK   = validK[validK.length - 1];
    const prevK     = validK.length >= 2 ? validK[validK.length - 2] : latestK;
    const latestD   = dSmooth[dSmooth.length - 1];
    if (isNaN(latestD)) return null;
    if (cfg.debugSignals) console.log('[3Tick][indicator] StochMtm proxy (inferred calc): K=' + latestK.toFixed(2) + ' D=' + latestD.toFixed(2));
    return { k: latestK, d: latestD, kAboveD: latestK > latestD, kRising: latestK > prevK };
  }

  // Derive short-term trend from MA4 slope and recent candle close direction
  // Returns 'up', 'down', or 'flat'
  function deriveTrend () {
    // Need enough data for MA4 and at least 1 candle for direction
    if (ticks.length < 4 || candles.length < 1) return 'flat';

    const tickPrices = ticks.map(function (t) { return t.price; });
    const ma4 = calcMA4(tickPrices);

    // Count bullish vs bearish candles among last 3
    let bullishCandles = 0, bearishCandles = 0;
    const last3 = candles.slice(-3);
    last3.forEach(function (c) {
      if (c.close > c.open) bullishCandles++;
      else if (c.close < c.open) bearishCandles++;
    });

    const ma4Up   = ma4 && ma4.rising;
    const ma4Down = ma4 && !ma4.rising;

    // Strong up: MA4 rising AND most recent candles bullish
    if (ma4Up && bullishCandles >= 2)   return 'up';
    // Strong down: MA4 falling AND most recent candles bearish
    if (ma4Down && bearishCandles >= 2) return 'down';
    // Candle direction without MA4 contradiction
    if (bullishCandles >= 2 && !ma4Down) return 'up';
    if (bearishCandles >= 2 && !ma4Up)   return 'down';
    return 'flat';
  }

  // Derive short-term trend from tick-level MACD(12,26,9)
  // Uses tick prices as the input series (not 1m candles) for finer resolution.
  // Returns { trend: 'up'|'down'|'flat', macdLine, signalLine, hist }
  function deriveTickMacdTrend () {
    const tickPrices = ticks.map(function (t) { return t.price; });
    const epsilon    = (cfg.macdTrendEpsilon  != null) ? cfg.macdTrendEpsilon  : 0.00005;
    const lookback   = (cfg.macdTrendLookback != null) ? cfg.macdTrendLookback : 3;

    // Need at least 26 (slow EMA) + 9 (signal EMA warmup) + lookback ticks
    if (tickPrices.length < 35) {
      return { trend: 'flat', macdLine: NaN, signalLine: NaN, hist: NaN };
    }

    const ema12arr = calcEMA(12, tickPrices);
    const ema26arr = calcEMA(26, tickPrices);
    const macdArr  = [];
    for (let i = 0; i < tickPrices.length; i++) {
      const v12 = ema12arr[i], v26 = ema26arr[i];
      macdArr.push((isNaN(v12) || isNaN(v26)) ? NaN : v12 - v26);
    }

    const validMacd = macdArr.filter(function (v) { return !isNaN(v); });
    if (validMacd.length < 9) {
      return { trend: 'flat', macdLine: NaN, signalLine: NaN, hist: NaN };
    }

    const sigArr = calcEMA(9, validMacd);
    const n = validMacd.length;

    const macdLine   = validMacd[n - 1];
    const signalLine = sigArr[n - 1];

    if (isNaN(signalLine) || !isFinite(macdLine) || !isFinite(signalLine)) {
      return { trend: 'flat', macdLine: NaN, signalLine: NaN, hist: NaN };
    }

    const hist = macdLine - signalLine;

    // Collect recent histogram values over the lookback window for direction check
    const recentHist = [];
    for (let i = Math.max(0, n - lookback); i < n; i++) {
      const sl = sigArr[i];
      if (!isNaN(sl) && isFinite(sl)) recentHist.push(validMacd[i] - sl);
    }
    const histRising  = recentHist.length >= 2 &&
                        recentHist[recentHist.length - 1] > recentHist[0];
    const histFalling = recentHist.length >= 2 &&
                        recentHist[recentHist.length - 1] < recentHist[0];

    // Classify trend with hysteresis dead-zone around zero.
    // Two-stage: prefer confirmation from both MACD position AND histogram direction;
    // fall back to MACD position only when histogram direction is ambiguous.
    let trend;
    if      (macdLine > signalLine + epsilon && histRising)  { trend = 'up';   }
    else if (macdLine < signalLine - epsilon && histFalling) { trend = 'down'; }
    else if (Math.abs(hist) <= epsilon)                      { trend = 'flat'; } // dead-zone: treat as flat
    else if (macdLine > signalLine + epsilon)                { trend = 'up';   } // directional fallback (no hist confirmation)
    else if (macdLine < signalLine - epsilon)                { trend = 'down'; } // directional fallback
    else                                                     { trend = 'flat'; }

    return { trend, macdLine, signalLine, hist, histSeries: recentHist };
  }

  // Update the Trend display using tick-level MACD (called from handleTick)
  function updateTickMacdTrendUI () {
    if ((cfg.strategyMode || 'indicator') !== 'indicator') return; // classic mode uses candle-based updateTrend
    const el = document.getElementById('tt-trend');
    if (!el) return;
    const r = deriveTickMacdTrend();
    if (isNaN(r.macdLine)) { el.textContent = '– (warm)'; el.className = 'tt-val'; return; }
    const histStr = isFinite(r.hist) ? ' h:' + r.hist.toFixed(5) : '';
    if (r.trend === 'up')   { el.textContent = '▲ Up'   + histStr; el.className = 'tt-val tt-trend-up';   }
    else if (r.trend === 'down') { el.textContent = '▼ Down' + histStr; el.className = 'tt-val tt-trend-down'; }
    else                    { el.textContent = '↔ Side' + histStr; el.className = 'tt-val tt-trend-side'; }
  }

  // Map entryProfile to internal thresholds
  // chopThreshold  – chop score must reach this value to block entry (higher = less blocking)
  // alignMin       – minimum alignment score required to enter
  // setupTimeoutTicks – ticks before a pending setup is discarded and restarted
  // twoStage       – whether to require a 1-tick trigger confirmation before firing
  function getProfileThresholds () {
    const profile = cfg.entryProfile || 'balanced';
    const map = {
      early:    { chopThreshold: 4, alignMin: 2, setupTimeoutTicks: 3, twoStage: false },
      balanced: { chopThreshold: 3, alignMin: 3, setupTimeoutTicks: 2, twoStage: true  },
      strict:   { chopThreshold: 2, alignMin: 4, setupTimeoutTicks: 1, twoStage: true  },
    };
    return map[profile] || map.balanced;
  }

  // Compute a chop score from multiple sideways/indecision indicators.
  // Returns { chopScore, reasons[] }.
  // Higher chopScore → more chop. Profile chopThreshold determines when to block entry.
  function isChopZone (tickMacd, ind, closes) {
    const { rsi, bb, stoch } = ind;
    let chopScore = 0;
    const reasons = [];

    // 1. RSI in neutral band (45–55)
    if (rsi && rsi.value >= 45 && rsi.value <= 55) {
      chopScore++;
      reasons.push('rsi_neutral');
    }

    // 2. Tick-MACD histogram near zero (flat / indecision)
    const chopHistThresh = cfg.chopHistThreshold != null ? cfg.chopHistThreshold : 0.0002;
    if (isFinite(tickMacd.hist) && Math.abs(tickMacd.hist) <= chopHistThresh) {
      chopScore++;
      reasons.push('macd_hist_flat');
    }

    // 3. MACD histogram sign-flip count over recent series → frequent crosses = chop
    const histSeries = tickMacd.histSeries || [];
    if (histSeries.length >= 3) {
      let flips = 0;
      for (let i = 1; i < histSeries.length; i++) {
        if ((histSeries[i] > 0) !== (histSeries[i - 1] > 0)) flips++;
      }
      if (flips >= 2) {
        chopScore++;
        reasons.push('macd_flipping');
      }
    }

    // 4. Bollinger Band not expanding (or very compressed)
    if (bb && closes && closes.length >= 14) {
      const curWidth = bb.upper - bb.lower;
      const prevBb   = calcBollinger(closes.slice(0, -1));
      if (prevBb) {
        const prevWidth = prevBb.upper - prevBb.lower;
        if (curWidth <= prevWidth) {
          chopScore++;
          reasons.push('bb_not_expanding');
        }
      }
      // BB very narrow relative to price (< 0.05% of mid)
      if (bb.basis > 0 && (curWidth / bb.basis) < 0.0005) {
        chopScore++;
        reasons.push('bb_compressed');
      }
    }

    // 5. Stoch K/D near cross (potential whipsaw zone)
    if (stoch && Math.abs(stoch.k - stoch.d) < 8) {
      chopScore++;
      reasons.push('stoch_near_cross');
    }

    return { chopScore, reasons };
  }

  // Compute alignment scores for BUY and SELL.
  // Each condition that aligns with the direction adds 1 point (max 6).
  // BB expansion adds 1 to both sides (direction-agnostic volatility expansion).
  function calcAlignmentScores (tickMacd, ind, currentPrice, closes) {
    const { rsi, bb, ma4, stoch } = ind;
    let buyAlignment  = 0;
    let sellAlignment = 0;

    // 1. Tick-MACD trend aligned
    if (tickMacd.trend === 'up')   buyAlignment++;
    if (tickMacd.trend === 'down') sellAlignment++;

    // 2. MACD histogram direction and sign aligned (compare last two values for recency)
    const histSeries = tickMacd.histSeries || [];
    const histRising  = histSeries.length >= 2 &&
      histSeries[histSeries.length - 1] > histSeries[histSeries.length - 2] && tickMacd.hist > 0;
    const histFalling = histSeries.length >= 2 &&
      histSeries[histSeries.length - 1] < histSeries[histSeries.length - 2] && tickMacd.hist < 0;
    if (histRising)  buyAlignment++;
    if (histFalling) sellAlignment++;

    // 3. BB width expanding (volatility expansion favours entries in both directions)
    if (bb && closes && closes.length >= 14) {
      const curWidth = bb.upper - bb.lower;
      const prevBb   = calcBollinger(closes.slice(0, -1));
      if (prevBb && curWidth > prevBb.upper - prevBb.lower) {
        buyAlignment++;
        sellAlignment++;
      }
    }

    // 4. Price vs MA4 – aligned with direction
    if (ma4) {
      if (currentPrice > ma4.value && ma4.rising)  buyAlignment++;
      if (currentPrice < ma4.value && !ma4.rising) sellAlignment++;
    }

    // 5. RSI directional alignment
    if (rsi) {
      if (rsi.value > 50 && rsi.rising)  buyAlignment++;
      if (rsi.value < 50 && !rsi.rising) sellAlignment++;
    }

    // 6. Stoch momentum aligned
    // Note: buy uses OR (early/emerging signal); sell uses AND (both K<D and falling)
    // This asymmetry intentionally matches the scoring logic in scoreIndicators().
    if (stoch) {
      if (stoch.kAboveD || stoch.kRising)   buyAlignment++;
      if (!stoch.kAboveD && !stoch.kRising) sellAlignment++;
    }

    return { buyAlignment, sellAlignment };
  }


  // Returns { buyScore, sellScore, buyComponents, sellComponents, ...rawIndicators }
  function scoreIndicators () {
    const closes      = candles.map(function (c) { return c.close; });
    const tickPrices  = ticks.map(function (t) { return t.price; });
    const n           = tickPrices.length;
    const currentPrice = n > 0 ? tickPrices[n - 1] : (closes.length ? closes[closes.length - 1] : 0);
    const prevPrice    = n > 1 ? tickPrices[n - 2] : currentPrice;

    const macd  = calcMACD(closes);
    const rsi   = calcRSI(closes);
    const bb    = calcBollinger(closes);
    const ma4   = calcMA4(tickPrices);
    const stoch = calcStochMtm(candles);

    let buyScore  = 0;
    let sellScore = 0;
    const buyParts  = [];
    const sellParts = [];

    // 1. Bollinger Bands: price near lower/mid BB and bouncing up (BUY) or near upper/mid and bouncing down (SELL)
    if (bb) {
      if (currentPrice <= bb.basis && currentPrice > prevPrice) { buyScore++;  buyParts.push('BB↑'); }
      if (currentPrice >= bb.basis && currentPrice < prevPrice) { sellScore++; sellParts.push('BB↓'); }
    }

    // 2. MA(4): slope up or price above MA (BUY); slope down AND price below MA (SELL)
    if (ma4) {
      if (ma4.rising || currentPrice > ma4.value) { buyScore++;  buyParts.push('MA4↑'); }
      if (!ma4.rising && currentPrice < ma4.value) { sellScore++; sellParts.push('MA4↓'); }
    }

    // 3. MACD(12,26,9): histogram rising or MACD above signal (BUY); both falling AND below signal (SELL)
    if (macd) {
      if (macd.histogramRising || macd.macdAboveSignal)    { buyScore++;  buyParts.push('MACD↑'); }
      if (!macd.histogramRising && !macd.macdAboveSignal)  { sellScore++; sellParts.push('MACD↓'); }
    }

    // 4. RSI(14): rising (BUY); falling (SELL)
    if (rsi) {
      if (rsi.rising)  { buyScore++;  buyParts.push('RSI↑'); }
      if (!rsi.rising) { sellScore++; sellParts.push('RSI↓'); }
    }

    // 5. Stochastic Momentum: K above D or K rising (BUY); K below D AND K falling (SELL)
    if (stoch) {
      if (stoch.kAboveD || stoch.kRising)   { buyScore++;  buyParts.push('STCH↑'); }
      if (!stoch.kAboveD && !stoch.kRising) { sellScore++; sellParts.push('STCH↓'); }
    }

    return {
      buyScore, sellScore,
      buyComponents:  buyParts.join('+'),
      sellComponents: sellParts.join('+'),
      macd, rsi, bb, ma4, stoch,
    };
  }

  // ── Indicator-mode signal detection ──────────────────────────────────────
  function detectSignalIndicator () {
    const n = ticks.length;
    if (n < 5) return null;

    const ind = scoreIndicators();
    const { buyScore, sellScore, buyComponents, sellComponents, macd, rsi } = ind;

    const minScore = cfg.minIndicatorScore != null ? cfg.minIndicatorScore : 3;
    const preset   = cfg.indicatorPreset || 'balanced';
    const requiredMargin = preset === 'conservative' ? 2 : 1;

    // Derive trend from tick-level MACD (primary trend gate)
    const tickMacd = deriveTickMacdTrend();
    const trend    = tickMacd.trend;

    const baseResult = {
      buyScore, sellScore, buyComponents, sellComponents,
      macdLine:   tickMacd.macdLine,
      macdSignal: tickMacd.signalLine,
      macdHist:   tickMacd.hist,
      macdTrend:  trend,
    };

    // 1. Tie / ambiguous – never default to BUY
    if (buyScore === sellScore) {
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: tie_ambiguous buy=' + buyScore + ' sell=' + sellScore);
      return Object.assign(baseResult, { candidate: null, rejectReason: 'tie_ambiguous', fired: false });
    }

    // 2. Determine raw winner
    let candidate, score, components, loserScore;
    if (buyScore > sellScore) {
      candidate = 'BUY'; score = buyScore; components = buyComponents; loserScore = sellScore;
    } else {
      candidate = 'SELL'; score = sellScore; components = sellComponents; loserScore = buyScore;
    }

    // 3. Minimum score gate
    if (score < minScore) {
      const reason = 'buy=' + buyScore + ' sell=' + sellScore + ' need>=' + minScore;
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: score too low – ' + reason);
      return Object.assign(baseResult, { candidate: null, rejectReason: 'score_threshold', fired: false });
    }

    // 4. Score margin gate (anti-ambiguity)
    if ((score - loserScore) < requiredMargin) {
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: score_margin buy=' + buyScore + ' sell=' + sellScore + ' need margin>=' + requiredMargin);
      return Object.assign(baseResult, { candidate: null, rejectReason: 'score_margin', fired: false });
    }

    // 5. Hard trend gate (tick-MACD trend)
    if (trend === 'down' && candidate === 'BUY') {
      // Allow strong counter-trend BUY only if margin >= 2 and RSI/Stoch turning
      const strongCounterTrend = (buyScore >= sellScore + 2) && rsi && rsi.rising && rsi.value < 45; // RSI below oversold threshold
      if (!strongCounterTrend) {
        if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: trend_block_buy (tick_macd trend=down, buy=' + buyScore + ' sell=' + sellScore + ' macdLine=' + (isFinite(tickMacd.macdLine) ? tickMacd.macdLine.toFixed(6) : 'n/a') + ')');
        return Object.assign(baseResult, { candidate: null, rejectReason: 'trend_block_buy', fired: false });
      }
    }
    if (trend === 'up' && candidate === 'SELL') {
      const strongCounterTrend = (sellScore >= buyScore + 2) && rsi && !rsi.rising && rsi.value > 55; // RSI above overbought threshold
      if (!strongCounterTrend) {
        if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: trend_block_sell (tick_macd trend=up, buy=' + buyScore + ' sell=' + sellScore + ' macdLine=' + (isFinite(tickMacd.macdLine) ? tickMacd.macdLine.toFixed(6) : 'n/a') + ')');
        return Object.assign(baseResult, { candidate: null, rejectReason: 'trend_block_sell', fired: false });
      }
    }
    if (trend === 'flat') {
      // Stricter in choppy/flat market: require minScore+1 or margin>=2
      const flatMinScore = minScore + 1;
      const flatMargin   = 2;
      if (score < flatMinScore || (score - loserScore) < flatMargin) {
        if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: score_margin (tick_macd flat trend, need score>=' + flatMinScore + ' margin>=' + flatMargin + ')');
        return Object.assign(baseResult, { candidate: null, rejectReason: 'score_margin', fired: false });
      }
    }

    // 6. Anti-chop filter: RSI neutral band AND MACD histogram near zero
    const chopHistThresh = cfg.chopHistThreshold != null ? cfg.chopHistThreshold : 0.0002;
    if (rsi && rsi.value >= 45 && rsi.value <= 55) { // RSI in neutral band (45–55)
      if (macd && Math.abs(macd.histogram) <= chopHistThresh) {
        if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: chop_filter (RSI=' + rsi.value.toFixed(1) + ' hist=' + macd.histogram.toFixed(5) + ')');
        return Object.assign(baseResult, { candidate: null, rejectReason: 'chop_filter', fired: false });
      }
    }

    // 7. Global cooldown guard
    const currentTickIndex = tickSeq;
    const ticksSinceLast = currentTickIndex - lastSignalTickIndex;
    if (ticksSinceLast < cfg.cooldownTicks) {
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: cooldown (' + ticksSinceLast + ' ticks since last, need ' + cfg.cooldownTicks + ')');
      return Object.assign(baseResult, { candidate, rejectReason: 'cooldown', fired: false });
    }

    // 8. Same-side cooldown guard
    const sameSideCooldown = cfg.sameSideCooldownTicks != null ? cfg.sameSideCooldownTicks : 5;
    if (lastSignalSide === candidate) {
      const ticksSinceLastSameSide = currentTickIndex - lastSignalSideTickIndex;
      if (ticksSinceLastSameSide < sameSideCooldown) {
        if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: same_side_cooldown (' + candidate + ' ' + ticksSinceLastSameSide + ' ticks since last, need ' + sameSideCooldown + ')');
        return Object.assign(baseResult, { candidate, rejectReason: 'same_side_cooldown', fired: false });
      }
    }

    // ── Entry-quality gates (profile-driven) ─────────────────────────────
    const closes     = candles.map(function (c) { return c.close; });
    const thresholds = getProfileThresholds();

    // 9. Full chop-zone blocker (multi-condition scoring)
    const chopResult = isChopZone(tickMacd, ind, closes);
    if (chopResult.chopScore >= thresholds.chopThreshold) {
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: chop_zone score=' + chopResult.chopScore + ' reasons=[' + chopResult.reasons.join(',') + '] profile=' + (cfg.entryProfile || 'balanced'));
      return Object.assign(baseResult, {
        candidate, rejectReason: 'chop_zone', fired: false,
        chopScore: chopResult.chopScore, entryReason: 'chop_zone',
      });
    }

    // 10. Expansion+alignment filter
    const currentPrice = ticks[n - 1].price;
    const alignScores  = calcAlignmentScores(tickMacd, ind, currentPrice, closes);
    const { buyAlignment, sellAlignment } = alignScores;
    const alignScore = candidate === 'BUY' ? buyAlignment : sellAlignment;

    // Near-zero histogram guard: require +1 alignment when MACD hist is near zero (transition zone).
    const isNearZeroHist = Math.abs(tickMacd.hist) <= cfg.nearZeroHistThreshold;
    const effectiveAlignMin = isNearZeroHist ? thresholds.alignMin + 1 : thresholds.alignMin;

    if (alignScore < effectiveAlignMin) {
      const rejectReason = isNearZeroHist ? 'alignment_insufficient_near_zero' : 'alignment_insufficient';
      if (cfg.debugSignals) console.log('[3Tick][indicator] rejected: ' + rejectReason + ' ' + candidate + ' align=' + alignScore + ' need>=' + effectiveAlignMin + ' is_near_zero_hist=' + isNearZeroHist + ' effective_align_min=' + effectiveAlignMin + ' profile=' + (cfg.entryProfile || 'balanced'));
      return Object.assign(baseResult, {
        candidate, rejectReason, fired: false,
        chopScore: chopResult.chopScore, alignmentScoreBuy: buyAlignment, alignmentScoreSell: sellAlignment,
        entryReason: rejectReason,
        ...(cfg.debugSignals ? { is_near_zero_hist: isNearZeroHist, effective_align_min: effectiveAlignMin } : {}),
      });
    }

    // 11. Two-stage setup → trigger confirmation (balanced/strict profiles only)
    if (thresholds.twoStage) {
      if (pendingSetup && pendingSetup.side === candidate) {
        const ticksSinceSetup = currentTickIndex - pendingSetup.tickIndex;
        if (ticksSinceSetup > thresholds.setupTimeoutTicks) {
          // Setup expired – restart with this tick as new setup
          pendingSetup = { side: candidate, tickIndex: currentTickIndex, hist: tickMacd.hist, createdAt: Date.now() };
          if (cfg.debugSignals) console.log('[3Tick][indicator] setup_timeout for ' + candidate + ', restarting setup');
          return Object.assign(baseResult, {
            candidate, rejectReason: 'setup_timeout', fired: false,
            chopScore: chopResult.chopScore, alignmentScoreBuy: buyAlignment, alignmentScoreSell: sellAlignment,
            setupState: 'pending_' + candidate.toLowerCase(), entryReason: 'setup_timeout',
          });
        }
        // Trigger confirmation: MACD hist must not have regressed since setup tick
        const histDelta = (isFinite(tickMacd.hist) && isFinite(pendingSetup.hist))
          ? (tickMacd.hist - pendingSetup.hist) : 0;
        const triggerConfirmed = candidate === 'BUY' ? (histDelta >= 0) : (histDelta <= 0);
        if (!triggerConfirmed) {
          if (cfg.debugSignals) console.log('[3Tick][indicator] trigger_pending for ' + candidate + ' hist=' + (isFinite(tickMacd.hist) ? tickMacd.hist.toFixed(6) : 'n/a') + ' setupHist=' + (isFinite(pendingSetup.hist) ? pendingSetup.hist.toFixed(6) : 'n/a'));
          return Object.assign(baseResult, {
            candidate, rejectReason: 'trigger_pending', fired: false,
            chopScore: chopResult.chopScore, alignmentScoreBuy: buyAlignment, alignmentScoreSell: sellAlignment,
            setupState: 'pending_' + candidate.toLowerCase(), entryReason: 'trigger_pending',
          });
        }
        // Trigger confirmed – clear setup and proceed to fire
        pendingSetup = null;
      } else {
        // No matching pending setup (new or opposite side) – set setup for this tick
        if (pendingSetup && pendingSetup.side !== candidate) {
          if (cfg.debugSignals) console.log('[3Tick][indicator] setup_side_flip: discarding ' + pendingSetup.side + ' setup, starting ' + candidate + ' setup');
        }
        pendingSetup = { side: candidate, tickIndex: currentTickIndex, hist: tickMacd.hist, createdAt: Date.now() };
        if (cfg.debugSignals) console.log('[3Tick][indicator] setup_pending for ' + candidate + ' at tick_seq ' + currentTickIndex);
        return Object.assign(baseResult, {
          candidate, rejectReason: 'setup_pending', fired: false,
          chopScore: chopResult.chopScore, alignmentScoreBuy: buyAlignment, alignmentScoreSell: sellAlignment,
          setupState: 'pending_' + candidate.toLowerCase(), entryReason: 'setup_pending',
        });
      }
    }

    const sigPrice = ticks[n - 1].price;
    const sigTime  = ticks[n - 1].time;

    // Duplicate timestamp guard
    if (signals.length && signals[signals.length - 1].time === sigTime) {
      return Object.assign(baseResult, { candidate, rejectReason: 'duplicate', fired: false });
    }

    lastSignalTickIndex     = currentTickIndex;
    lastSignalSide          = candidate;
    lastSignalSideTickIndex = currentTickIndex;

    const sig = { type: candidate, price: sigPrice, time: sigTime, result: 'PENDING', ticksAfter: [] };
    signals.push(sig);
    if (signals.length > 50) signals.shift();
    recordSessionTrade(sig);

    if (cfg.debugSignals) console.log('[3Tick][indicator] ACCEPTED ' + candidate + ' score=' + score + ' (' + components + ') align=' + alignScore + ' chop=' + chopResult.chopScore + ' tick_macd_trend=' + trend + ' macdLine=' + (isFinite(tickMacd.macdLine) ? tickMacd.macdLine.toFixed(6) : 'n/a') + ' hist=' + (isFinite(tickMacd.hist) ? tickMacd.hist.toFixed(6) : 'n/a') + ' profile=' + (cfg.entryProfile || 'balanced') + ' at price ' + sigPrice + ' time ' + sigTime);

    lastSignalFiredAt = Date.now(); // watchdog: track last fired signal
    updateSignalsUI();
    return Object.assign(baseResult, {
      candidate, rejectReason: null, fired: true,
      chopScore: chopResult.chopScore, alignmentScoreBuy: buyAlignment, alignmentScoreSell: sellAlignment,
      setupState: 'none', entryReason: 'alignment_trigger',
    });
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

  // ── Session trade history (full-run store for CSV export) ─────────────────
  function recordSessionTrade (sig) {
    sessionTradesAll.push(sig);
    if (sessionTradesAll.length > SESSION_HISTORY_CAP) sessionTradesAll.shift();
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  function exportCSV () {
    const rows = [['Type', 'Entry Price', 'Time', 'Result', 'Exit Price']];
    sessionTradesAll.forEach(function (s) {
      rows.push([
        s.type,
        s.price.toFixed(2),
        fmtTime(s.time),
        s.result,
        s.priceAfter !== undefined ? s.priceAfter.toFixed(2) : '',
      ]);
    });
    console.log('[3Tick][export] visibleCount=' + signals.length + ' fullHistoryCount=' + sessionTradesAll.length + ' exportedCount=' + (rows.length - 1));
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
    const headers = ['epoch', 'iso_time', 'symbol', 'price', 'strategy_mode', 'buy_score', 'sell_score', 'score_components', 'indicator_reason', 'trend_source', 'macd_line', 'macd_signal', 'macd_hist', 'macd_trend', 'entry_profile', 'chop_score', 'alignment_score_buy', 'alignment_score_sell', 'setup_state', 'entry_reason', 'spike_pct', 'spike_points', 'spike_threshold_used', 'spike_mode_used', 'signal_candidate', 'reject_reason', 'signal_fired', 'watchdog_event', 'ws_state', 'tick_age_ms', 'eval_age_ms', 'eval_error_count'];
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
      strategyMode:      'indicator',
      indicatorPreset:   'balanced',
      minIndicatorScore: 3,
      sameSideCooldownTicks: 5,
      chopHistThreshold: 0.0002,
      entryProfile:      'balanced',
      macdTrendEpsilon:  0.00005,
      macdTrendLookback: 3,
      spikeMode:        'auto',
      spikeThreshold:   0.001,
      minSpikePoints:   0.1,
      reversalTicks:    1,
      minSnapbackRatio: 0.2,
      extremeLookback:  4,
      cooldownTicks:    1,
      minVolatilityPct: 0.005,
      debugSignals:     true,
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
    const strat = document.getElementById('tt-cfg-strategy-mode');
    if (strat) strat.value = cfg.strategyMode || 'indicator';
    const ep = document.getElementById('tt-cfg-entry-profile');
    if (ep) ep.value = cfg.entryProfile || 'balanced';
    const preset = document.getElementById('tt-cfg-indicator-preset');
    if (preset) preset.value = cfg.indicatorPreset || 'balanced';
    const ms = document.getElementById('tt-cfg-min-score');
    if (ms) ms.value = cfg.minIndicatorScore != null ? cfg.minIndicatorScore : 3;
    const sm  = document.getElementById('tt-cfg-spike-mode');
    if (sm)  sm.value     = cfg.spikeMode || 'auto';
    const s   = document.getElementById('tt-cfg-spike');
    if (s)   s.value     = cfg.spikeThreshold;
    const sp  = document.getElementById('tt-cfg-spike-points');
    if (sp)  sp.value    = cfg.minSpikePoints;
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
    const macdEpsilonInputEl = document.getElementById('tt-cfg-macd-epsilon');
    if (macdEpsilonInputEl) macdEpsilonInputEl.value = cfg.macdTrendEpsilon  != null ? cfg.macdTrendEpsilon  : 0.00005;
    const macdLookbackInputEl = document.getElementById('tt-cfg-macd-lookback');
    if (macdLookbackInputEl) macdLookbackInputEl.value = cfg.macdTrendLookback != null ? cfg.macdTrendLookback : 3;
    syncStrategyModeUI(cfg.strategyMode || 'indicator');
  }

  // ── Watchdog (freeze/stall recovery) ─────────────────────────────────────

  // Re-send tick subscription on an open WS (idempotent; falls back to full reconnect)
  function resubscribe () {
    if (!ws || ws.readyState !== WebSocket.OPEN || !resolvedSymbol) {
      // WS not ready – trigger a fresh reconnect
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      scheduleReconnect();
      return;
    }
    try {
      ws.send(JSON.stringify({ ticks: resolvedSymbol, subscribe: 1 }));
      console.log('[3Tick][watchdog] re-sent tick subscription for', resolvedSymbol);
    } catch (e) {
      console.error('[3Tick][watchdog] resubscribe send error', e);
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    }
  }

  // Reset signal-evaluator state without touching WS (safe partial recovery)
  function resetEvalState () {
    lastSignalTickIndex     = -999;
    lastSignalSide          = null;
    lastSignalSideTickIndex = -999;
    pendingSetup            = null;
    console.log('[3Tick][watchdog] watchdog_recover_eval: eval state reset');
  }

  // Start (or restart) the watchdog timer; idempotent – clears any existing interval first
  function startWatchdog () {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    watchdogInterval = setInterval(function () {
      try {
        const now = Date.now();
        if (wsState !== 'connected') return;

        const tickAge = lastTickProcessedAt > 0 ? now - lastTickProcessedAt : -1;
        const evalAge = lastSignalEvalAt    > 0 ? now - lastSignalEvalAt    : -1;

        // Compact debug snapshot every watchdog cycle
        if (cfg.debugSignals) {
          console.log(
            '[3Tick][watchdog] snap' +
            ' ws=' + wsState +
            ' ws_ready=' + (ws ? ws.readyState : 'null') +
            ' tick_age=' + (tickAge >= 0 ? tickAge + 'ms' : 'never') +
            ' eval_age=' + (evalAge >= 0 ? evalAge + 'ms' : 'never') +
            ' eval_errors=' + evalErrorCount +
            ' fired_ago=' + (lastSignalFiredAt > 0 ? (now - lastSignalFiredAt) + 'ms' : 'never') +
            ' pending=' + (pendingSetup
              ? pendingSetup.side + ' age=' + (pendingSetup.createdAt ? (now - pendingSetup.createdAt) + 'ms' : '?')
              : 'none')
          );
        }

        // 1. Connected but no tick within threshold → two-stage recovery
        //    Stage 1: resubscribe; Stage 2 (next stale cycle): full reconnect
        //    tickAge < 0 means lastTickProcessedAt is still 0 (no tick ever received on this session)
        if (tickAge < 0 || tickAge > WATCHDOG_TICK_TIMEOUT) {
          const resubRecently = watchdogLastResubAt > 0 &&
                                (now - watchdogLastResubAt) < WATCHDOG_RESUB_GRACE_MS;
          if (resubRecently) {
            // Already resubscribed but still stale → escalate to full reconnect
            console.warn('[3Tick][watchdog] watchdog_recover_reconnect: still no tick after resubscribe, reconnecting');
            if (cfg.debugSignals) showAlert('Watchdog: reconnecting (stale after resub)');
            lastWatchdogEvent   = 'watchdog_recover_reconnect';
            watchdogLastResubAt = 0;
            lastTickProcessedAt = now; // prevent rapid retrigger
            lastSignalEvalAt    = now;
            if (ws) { try { ws.close(); } catch (_) {} ws = null; }
            scheduleReconnect();
          } else {
            // First stale trigger → resubscribe
            const ageStr = tickAge >= 0 ? tickAge + 'ms' : 'never';
            console.warn('[3Tick][watchdog] watchdog_recover_resubscribe: no tick for ' + ageStr + ', re-subscribing');
            if (cfg.debugSignals) showAlert('Watchdog: re-subscribing (tick stale ' + (tickAge >= 0 ? Math.round(tickAge / 1000) + 's' : 'n/a') + ')');
            lastWatchdogEvent   = 'watchdog_recover_resubscribe';
            watchdogLastResubAt = now;
            lastTickProcessedAt = now; // prevent repeated triggers on same stall
            resubscribe();
          }
          return;
        }

        // Ticks flowing normally – reset resubscribe tracker
        watchdogLastResubAt = 0;

        // 2. Ticks arriving but eval stalled → reset eval state only
        if (evalAge > WATCHDOG_EVAL_TIMEOUT) {
          console.warn('[3Tick][watchdog] watchdog_recover_eval: eval stalled for ' + evalAge + 'ms');
          lastWatchdogEvent = 'watchdog_recover_eval';
          resetEvalState();
          lastSignalEvalAt = now;
        }

        // 3. Pending setup stuck longer than stale threshold → clear it
        if (pendingSetup && pendingSetup.createdAt &&
            (now - pendingSetup.createdAt) > WATCHDOG_SETUP_STALE_MS) {
          const staleMs = now - pendingSetup.createdAt;
          console.warn('[3Tick][watchdog] watchdog_clear_stuck_setup: ' + pendingSetup.side + ' setup stale ' + staleMs + 'ms, clearing');
          lastWatchdogEvent = 'watchdog_clear_stuck_setup';
          pendingSetup = null;
        }
      } catch (e) {
        console.error('[3Tick][watchdog] watchdog timer error', e);
      }
    }, WATCHDOG_INTERVAL);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init () {
    if (document.getElementById('tt-overlay')) return; // already injected
    cfg = loadCfg();
    buildOverlay();
    connect();
    startWatchdog(); // idempotent – safe to call on every init
  }

  // Wait until the page body is available, then inject
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
