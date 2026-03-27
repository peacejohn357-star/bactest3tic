# 3Tick Scalper – Step Index 100 Assistant

A Chrome extension that overlays a real-time trading assistant on [dtrader.deriv.com](https://dtrader.deriv.com) for **Step Index 100** manual scalping using 3-tick contract logic.

---

## Features

| Feature | Details |
|---|---|
| **Live tick feed** | Streams Step Index 100 ticks via the public Deriv WebSocket (`wss://ws.deriv.com/websockets/v3?app_id=1089`). Buffers the latest 200 ticks. |
| **1-minute candle feed** | Subscribes to 1-min candles and buffers the latest 200. Auto-reconnects on disconnect. |
| **3-tick signal detection** | Detects spike → reversal patterns (configurable spike % threshold and reversal-tick count) and fires BUY / SELL alerts. |
| **Win / Loss tracking** | Scores each signal after 3 ticks and updates session W / L counters in real time. |
| **S/R zones** | Scans a rolling window of recent candles for local high / low extrema and displays the top Resistance and Support levels. |
| **1-min trend indicator** | Reads the last 3 closed candles and shows ▲ Up / ▼ Down / ↔ Side. |
| **Draggable overlay** | Floating panel on the chart page; position is saved to `localStorage`. Minimise or close with header buttons. |
| **CSV export** | One-click export of all signals (type, entry, time, result, exit price) as a `.csv` file. |
| **Settings panel** | Adjust spike-% threshold and reversal-tick count without reloading. |

---

## Installation (unpacked extension)

1. **Download / clone this repository.**
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. Navigate to [https://dtrader.deriv.com](https://dtrader.deriv.com).  
   The **3Tick Scalper** panel appears in the top-right corner of the page.

> **Note:** The extension runs only on `https://dtrader.deriv.com/*` and does not require any Deriv login or private API key.

---

## File structure

```
3tick/
├── manifest.json   Chrome extension manifest (Manifest V3)
├── content.js      Content script – WebSocket, signal logic, overlay UI
├── styles.css      Overlay CSS
└── README.md       This file
```

---

## How signals work

1. **Spike detection** – when the price moves ≥ `spikeThreshold` % in a single tick, a spike is recorded.  
2. **Reversal confirmation** – if the next `reversalTicks` ticks move in the *opposite* direction, a signal is fired.  
   - Spike **up** then reversal ticks **down** → **SELL**  
   - Spike **down** then reversal ticks **up** → **BUY**  
3. **Scoring** – after 3 more ticks the entry price is compared with the 3rd-tick price using integer tick units (`Math.round(price / tickSize)`) to avoid floating-point noise:  
   - BUY: exitTicks ≥ entryTicks → **WIN**, else **LOSS** (equality counts as WIN)  
   - SELL: exitTicks ≤ entryTicks → **WIN**, else **LOSS** (equality counts as WIN)

---

## Customising

All thresholds can be tweaked in the **⚙ settings** panel inside the overlay, or by editing the `cfg` object at the top of `content.js`:

```js
let cfg = {
  spikeThreshold: 0.30,  // minimum % price-move to call a spike
  reversalTicks:  1,     // consecutive opposite-direction ticks to confirm reversal
};
```

To change the Deriv `app_id`, edit the `WS_URL` constant near the top of `content.js`.

---

## Cautions / rate-limit notes

- Only **one WebSocket** is opened at a time; it is reused for both tick and candle subscriptions.
- The extension never issues more than two `subscribe` calls per connection (ticks + candles).
- Reconnection uses a fixed 4-second back-off to avoid hammering the server.
- No private API methods are used; all data comes from the public feed.

---

## License

MIT
