# OKX EMA(50) + BOS Perpetual Futures Bot

A long-term trend-continuation bot for OKX **perpetual swaps** (BTC-USDT-SWAP, ETH-USDT-SWAP), built around a simple, disciplined discretionary strategy: 50 EMA + Break of Structure.

## Strategy

**Entry (long):**
1. Price closes above the 50 EMA (5-minute candles)
2. Price breaks above the most recent swing high (Break of Structure) → confirms trend continuation
3. Enter market long

**Entry (short):** mirrored — price below EMA(50) + breaks below the last swing low.

**Risk & sizing:**
- Margin = **1% of account balance** (no fat fingers — computed precisely every trade)
- Leverage = **45x isolated**
- Notional = margin × 45, converted to contracts using the instrument's contract value, rounded down to the exchange lot size

**Exit:**
- **Stop loss** = the EMA(50) value at entry (the level a discretionary trader would actually use)
- **Take profit** = entry + (entry − SL) × **2.5** → the TP distance is derived FROM the SL distance, so it adjusts automatically with how tight or wide the EMA is at signal time
- **Breakeven**: once price reaches **1:1 RR**, the stop is moved to entry (locks in a scratch, mimics a human moving their stop instead of watching a winner round-trip to a loss) — TP stays untouched
- Both SL and TP are placed as exchange-side OCO orders, so they execute even if the bot process restarts

**Why not literal ML?** There's no historical labeled dataset to train a model on yet. What's here is a deterministic rule engine that replicates exactly what a disciplined human would do reading the same chart — track EMA, track structure, size correctly, move to breakeven — with zero fat-finger risk. That precision *is* the "human, but with no errors" part. If you want, we can later log enough trades to actually train a filter model on top of this.

## Winrate & PnL

Every trade lifecycle (entry → breakeven move → close) is logged to `logs/trades.jsonl`. Stats are computed from CLOSE events only:
- **Winrate** = wins / (wins + losses) — breakevens are tracked separately, not counted as a loss
- **PnL** = realized PnL pulled from OKX position history after each close
- **R-multiple** per trade and average R across all trades

## Dashboard

A live stats dashboard is served by the bot itself:
- `/` — HTML dashboard (combined + per-asset winrate, PnL, open position, recent trades table)
- `/api/stats` — raw JSON
- `/health` — basic liveness check

Auto-refreshes every 5 seconds. No separate deploy needed — same process, same port.

## Setup

```bash
git clone https://github.com/javier5kiz/mexc-prediction-bot.git
cd mexc-prediction-bot
npm install
cp .env.example .env
# Edit .env with your OKX API credentials — start with IS_DEMO=true
npm start
```

Open the dashboard at `http://localhost:8080` (or your deployed URL).

## ⚠️ Before running

Your OKX account must be in **Single-currency margin mode** (or higher) — perpetual futures with leverage don't work in plain Spot mode. Check this in OKX (demo or live) under Settings → Account mode. The bot warns on startup if it detects Spot mode.

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX API credentials | Required |
| `IS_DEMO` | `true` = demo/paper, `false` = LIVE | `true` |
| `LEVERAGE` | Leverage multiplier | `45` |
| `RISK_PCT` | Margin as fraction of balance | `0.01` (1%) |
| `RR_TARGET` | Reward:risk ratio for TP | `2.5` |
| `BREAKEVEN_AT_R` | Move SL to breakeven at this R multiple | `1.0` |
| `DISCORD_WEBHOOK_URL` | Optional trade alerts | — |
| `PORT` | Dashboard port | `8080` |

## File Structure

```
src/
├── bot.js            — Entry point: OKX auth, dashboard server, starts BTC + ETH traders
├── okxClient.js       — OKX perpetual swap API client (leverage, orders, algo TP/SL, positions)
├── indicators.js      — EMA(50) + swing/BOS detection
├── emaBosTrader.js    — Core strategy: signal detection, entry, breakeven, close/PnL
├── tradeLog.js        — JSONL trade logging + winrate/PnL stats
├── dashboard.js        — Stats dashboard HTML + JSON API
├── alerter.js         — Optional Discord webhook alerts
└── logger.js          — File + console logger (legacy, available if needed)
```

## Deployment

Railway (this repo already has `railway.json` + `Procfile`):
```bash
railway up
```
Set env vars in the Railway dashboard, keep `IS_DEMO=true` until you've verified a healthy run.
