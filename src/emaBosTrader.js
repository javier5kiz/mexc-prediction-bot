/**
 * EmaBosTrader — 50 EMA + Break of Structure trend-continuation strategy
 * ═══════════════════════════════════════════════════════════════════
 *
 * Per asset (BTC-USDT-SWAP, ETH-USDT-SWAP), on every closed 5-minute candle:
 *
 *   1. Compute EMA(50) on closes.
 *   2. Detect BOS: price breaks the last swing high while ABOVE the EMA → bullish
 *                  price breaks the last swing low  while BELOW the EMA → bearish
 *   3. If a valid BOS forms and no position is open for this asset:
 *        - Entry: market order in BOS direction
 *        - Size: 1% of account balance as margin × 45x leverage → notional → contracts
 *        - Stop loss: at the EMA(50) value (the "human" reference level)
 *        - Take profit: entry + (entry - SL) × 2.5   [1:2.5 RR]
 *        - Attach both as OCO algo orders on the exchange (executes even if bot is down)
 *   4. While position is open, poll mark price:
 *        - At 1:1 RR reached → move SL to breakeven (entry price), keep TP unchanged
 *        - This is done ONCE per trade (mimics a human moving their stop to lock in a scratch)
 *   5. When position closes (SL/TP/BE hit) → determine WIN/LOSS/BREAKEVEN, log PnL + update winrate
 *
 * No blind machine-learning black box — this is a deterministic rule engine that
 * replicates exactly what a disciplined discretionary trader does staring at the
 * chart: read structure, respect the EMA, size correctly, never fat-finger a lot size,
 * and move to breakeven at 1R. That precision IS the "human, but with zero errors" part.
 */

const { calculateEMA, detectBOS } = require('./indicators');

const EMA_PERIOD = 50;
const BOS_LOOKBACK = 3;
const CANDLE_BAR = '5m';
const CANDLE_LIMIT = 150; // enough history for a stable EMA(50) + swing detection

const LEVERAGE = parseInt(process.env.LEVERAGE || '45', 10);
const RISK_PCT = parseFloat(process.env.RISK_PCT || '0.01');     // 1% of balance as margin
const RR_TARGET = parseFloat(process.env.RR_TARGET || '2.5');    // 1:2.5 reward:risk
const BREAKEVEN_AT_R = parseFloat(process.env.BREAKEVEN_AT_R || '1.0'); // move SL to BE at 1R
const MGN_MODE = 'isolated';

const POLL_MS = 2000;       // mark-price / position poll interval
const CANDLE_POLL_MS = 15000; // how often to refetch candles & re-check for BOS
const LOG_MS = 5000;

class EmaBosTrader {
  constructor(client, tradeLog, alerter, assetConfig) {
    this.client = client;
    this.tradeLog = tradeLog;
    this.alerter = alerter;
    this.config = assetConfig; // { id: 'BTC', instId: 'BTC-USDT-SWAP' }
    this.isRunning = false;

    this.ema = null;
    this.lastBOS = null;
    this.lastCandleCheck = 0;

    this.position = null; // { side, entryPrice, slPrice, tpPrice, sz, marginUSD, algoId, movedToBreakeven, openedAt }
    this.instrumentSpecs = null;

    this.lastLog = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Setup
  // ═══════════════════════════════════════════════════════════════

  async setup() {
    this.instrumentSpecs = await this.client.getInstrumentSpecs(this.config.instId);
    console.log(`[${this.config.id}] Specs: ctVal=${this.instrumentSpecs.ctVal} lotSz=${this.instrumentSpecs.lotSz} minSz=${this.instrumentSpecs.minSz}`);

    await this.client.setLeverage(this.config.instId, LEVERAGE, MGN_MODE, 'long');
    await this.client.setLeverage(this.config.instId, LEVERAGE, MGN_MODE, 'short');

    // Detect if a position is already open (bot restart recovery)
    const positions = await this.client.getPositions(this.config.instId);
    if (positions.length > 0) {
      const p = positions[0];
      console.log(`[${this.config.id}] ⚠️ Found existing open position on startup: ${p.posSide} ${p.pos} contracts @ ${p.avgPx}`);
      console.log(`[${this.config.id}]   Bot will monitor it for breakeven/close but did not set the original SL/TP (unknown).`);
      this.position = {
        side: p.posSide,
        entryPrice: parseFloat(p.avgPx),
        slPrice: null,
        tpPrice: null,
        sz: parseFloat(p.pos),
        marginUSD: parseFloat(p.margin || '0'),
        algoId: null,
        movedToBreakeven: true, // unknown history — don't attempt to move an SL we didn't set
        openedAt: Date.now(),
        recovered: true,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Strategy — Candle Analysis
  // ═══════════════════════════════════════════════════════════════

  async checkForSignal() {
    const candles = await this.client.getKlineCandles(this.config.instId, CANDLE_BAR, CANDLE_LIMIT);
    if (!candles || candles.length < EMA_PERIOD + BOS_LOOKBACK + 2) {
      console.warn(`[${this.config.id}] Not enough candle history yet (${candles?.length || 0})`);
      return null;
    }

    // OKX returns newest-first — reverse to chronological for indicator math
    const chronological = [...candles].reverse();
    // Drop the last (still-forming) candle — only act on CONFIRMED candles
    const confirmed = chronological.filter((c) => c.confirm === 1);

    const closes = confirmed.map((c) => c.close);
    const emaValues = calculateEMA(closes, EMA_PERIOD);
    this.ema = emaValues[emaValues.length - 1];

    const bos = detectBOS(confirmed, emaValues, BOS_LOOKBACK);
    this.lastBOS = bos;
    return bos;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Position Sizing
  // ═══════════════════════════════════════════════════════════════

  async computeSize(marginUSD, markPrice) {
    const notionalUSD = marginUSD * LEVERAGE;
    const specs = this.instrumentSpecs;
    const rawContracts = notionalUSD / markPrice / specs.ctVal;

    // Round DOWN to the nearest lotSz (never over-size — precision matters, no fat fingers)
    const contracts = Math.floor(rawContracts / specs.lotSz) * specs.lotSz;

    if (contracts < specs.minSz) {
      return { sz: 0, reason: `Position size ${contracts} below exchange minimum ${specs.minSz} (balance too low for this leverage)` };
    }
    return { sz: contracts, reason: null };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Trade Execution
  // ═══════════════════════════════════════════════════════════════

  async openPosition(direction, bos) {
    const markPrice = await this.client.getMarkPrice(this.config.instId);
    if (!markPrice) {
      console.warn(`[${this.config.id}] Could not fetch mark price — skipping entry`);
      return;
    }

    const balance = await this.client.getUSDTBalance();
    if (!balance || balance <= 0) {
      console.warn(`[${this.config.id}] No balance available — skipping entry`);
      return;
    }

    const marginUSD = balance * RISK_PCT;
    const side = direction === 'BULLISH' ? 'long' : 'short';
    const entryPrice = markPrice;
    const slPrice = bos.ema; // stop loss at the EMA(50) — the human reference level

    const risk = side === 'long' ? entryPrice - slPrice : slPrice - entryPrice;
    if (risk <= 0) {
      console.warn(`[${this.config.id}] Invalid risk (${risk.toFixed(2)}) — EMA too close to entry, skipping`);
      return;
    }

    const tpPrice = side === 'long' ? entryPrice + risk * RR_TARGET : entryPrice - risk * RR_TARGET;

    const { sz, reason } = await this.computeSize(marginUSD, markPrice);
    if (sz <= 0) {
      console.warn(`[${this.config.id}] ${reason}`);
      return;
    }

    console.log(`\n🎯 [${this.config.id}] BOS ${direction} — opening ${side.toUpperCase()}`);
    console.log(`   Entry≈$${entryPrice.toFixed(2)}  SL(EMA)=$${slPrice.toFixed(2)}  TP(1:${RR_TARGET})=$${tpPrice.toFixed(2)}  risk=$${risk.toFixed(2)}`);
    console.log(`   Balance=$${balance.toFixed(2)}  Margin(1%)=$${marginUSD.toFixed(4)}  Notional(${LEVERAGE}x)=$${(marginUSD * LEVERAGE).toFixed(2)}  sz=${sz} contracts`);

    const orderRes = await this.client.placeSwapEntryOrder({
      instId: this.config.instId,
      side: side === 'long' ? 'buy' : 'sell',
      posSide: side,
      sz,
      tpTriggerPx: tpPrice,
      slTriggerPx: slPrice,
      mgnMode: MGN_MODE,
    });

    if (!orderRes || orderRes.code !== '0') {
      console.error(`   ❌ [${this.config.id}] Entry order FAILED: ${orderRes?.msg || JSON.stringify(orderRes?.data?.[0] || orderRes)}`);
      return;
    }

    console.log(`   ✅ [${this.config.id}] Entry placed with attached TP/SL. ordId=${orderRes.data?.[0]?.ordId}`);

    this.position = {
      side, entryPrice, slPrice, tpPrice, sz, marginUSD,
      algoId: null, // will be resolved by looking up pending algo orders shortly after
      movedToBreakeven: false,
      openedAt: Date.now(),
      structureLevel: bos.level,
    };

    this.tradeLog.recordEntry({
      asset: this.config.id, side, entryPrice, slPrice, tpPrice, marginUSD, leverage: LEVERAGE, sz, instId: this.config.instId,
    });

    if (this.alerter?.sendEntry) {
      await this.alerter.sendEntry({
        assetId: this.config.id, side: side.toUpperCase(), band: 'BOS + EMA50',
        buyPrice: entryPrice, upPrice: tpPrice, downPrice: slPrice,
        instId: this.config.instId, totalTrades: this.tradeLog.trades.length + 1,
      });
    }

    // Give OKX a moment to register the attached algo, then resolve its algoId for later amendment
    await this.client.throttle(1500);
    const pending = await this.client.getPendingAlgoOrders(this.config.instId);
    const matched = pending.find((a) => a.posSide === side);
    if (matched) this.position.algoId = matched.algoId;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Breakeven Management
  // ═══════════════════════════════════════════════════════════════

  async checkBreakeven(markPrice) {
    const pos = this.position;
    if (!pos || pos.movedToBreakeven || pos.slPrice == null || pos.tpPrice == null) return;

    const risk = pos.side === 'long' ? pos.entryPrice - pos.slPrice : pos.slPrice - pos.entryPrice;
    if (risk <= 0) return;

    const targetPrice = pos.side === 'long'
      ? pos.entryPrice + risk * BREAKEVEN_AT_R
      : pos.entryPrice - risk * BREAKEVEN_AT_R;

    const reached = pos.side === 'long' ? markPrice >= targetPrice : markPrice <= targetPrice;
    if (!reached) return;

    console.log(`\n🔒 [${this.config.id}] 1:${BREAKEVEN_AT_R} RR reached ($${markPrice.toFixed(2)}) — moving SL to breakeven ($${pos.entryPrice.toFixed(2)})`);

    // Try direct amend first
    let amended = false;
    if (pos.algoId) {
      const res = await this.client.amendAlgoOrder(this.config.instId, pos.algoId, { newSlTriggerPx: pos.entryPrice });
      if (res && res.code === '0') amended = true;
    }

    if (!amended) {
      // Fallback: cancel the existing OCO and re-place with the new SL (same TP)
      if (pos.algoId) {
        await this.client.cancelAlgoOrder(this.config.instId, pos.algoId);
      }
      const res = await this.client.placeAlgoOrder({
        instId: this.config.instId,
        side: pos.side === 'long' ? 'sell' : 'buy', // closing side
        posSide: pos.side,
        sz: pos.sz,
        tpTriggerPx: pos.tpPrice,
        slTriggerPx: pos.entryPrice,
        mgnMode: MGN_MODE,
      });
      if (res && res.code === '0') {
        amended = true;
        pos.algoId = res.data?.[0]?.algoId || pos.algoId;
      } else {
        console.error(`   ❌ [${this.config.id}] Breakeven move FAILED: ${res?.msg || JSON.stringify(res)}`);
      }
    }

    if (amended) {
      pos.slPrice = pos.entryPrice;
      pos.movedToBreakeven = true;
      console.log(`   ✅ [${this.config.id}] SL moved to breakeven. TP unchanged at $${pos.tpPrice.toFixed(2)}`);
      this.tradeLog.recordBreakeven({ asset: this.config.id, side: pos.side, entryPrice: pos.entryPrice, newSlPrice: pos.entryPrice, instId: this.config.instId });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Position Close Detection + Winrate/PnL
  // ═══════════════════════════════════════════════════════════════

  async checkPositionClosed() {
    if (!this.position) return;

    const positions = await this.client.getPositions(this.config.instId);
    const stillOpen = positions.some((p) => p.posSide === this.position.side);
    if (stillOpen) return;

    // Position closed — figure out how (win/loss/breakeven) via positions-history realized PnL
    await this.client.throttle(1000);
    const history = await this.client.getPositionsHistory(this.config.instId, 3);
    const closedPos = history.find((h) => h.posSide === this.position.side && Math.abs(parseInt(h.uTime || '0', 10) - Date.now()) < 10 * 60 * 1000);

    const pos = this.position;
    let pnl = 0;
    let exitPrice = pos.tpPrice;

    if (closedPos) {
      pnl = parseFloat(closedPos.pnl || closedPos.realizedPnl || '0');
      exitPrice = parseFloat(closedPos.closeAvgPx || closedPos.avgPx || exitPrice);
    } else {
      console.warn(`[${this.config.id}] Could not confirm exact PnL from position history — estimating from SL/TP`);
    }

    let result;
    if (pos.movedToBreakeven && Math.abs(pnl) < 0.0005 * (pos.marginUSD || 1)) {
      result = 'BREAKEVEN';
    } else if (pnl > 0) {
      result = 'WIN';
    } else {
      result = 'LOSS';
    }

    console.log(`\n${result === 'WIN' ? '🎉' : result === 'LOSS' ? '💀' : '➖'} [${this.config.id}] Position CLOSED — ${result}  PnL=$${pnl.toFixed(4)}`);

    const trade = this.tradeLog.recordClose({
      asset: this.config.id, side: pos.side, entryPrice: pos.entryPrice, exitPrice,
      slPrice: pos.slPrice, tpPrice: pos.tpPrice, pnl, result,
      marginUSD: pos.marginUSD, leverage: LEVERAGE, instId: this.config.instId,
      movedToBreakeven: pos.movedToBreakeven,
    });

    const stats = this.tradeLog.getStats(this.config.id);
    console.log(`   [${this.config.id}] Winrate: ${stats.winrate}% (${stats.wins}W/${stats.losses}L/${stats.breakevens}BE)  Total PnL: $${stats.totalPnL}`);

    if (this.alerter) {
      if (result === 'WIN' && this.alerter.sendWin) {
        await this.alerter.sendWin({
          assetId: this.config.id, side: pos.side.toUpperCase(), band: 'BOS+EMA50',
          buyPrice: pos.entryPrice, sellPrice: exitPrice, profit: pnl,
          outcome: pos.side, instId: this.config.instId,
          winrate: stats.winrate, wins: stats.wins, losses: stats.losses,
          totalTrades: stats.totalTrades, settled: true,
        });
      } else if (result === 'LOSS' && this.alerter.sendLoss) {
        await this.alerter.sendLoss({
          assetId: this.config.id, side: pos.side.toUpperCase(), band: 'BOS+EMA50',
          buyPrice: pos.entryPrice, loss: pnl,
          outcome: pos.side, instId: this.config.instId,
          winrate: stats.winrate, wins: stats.wins, losses: stats.losses,
          totalTrades: stats.totalTrades,
        });
      }
    }

    this.position = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Main Loop
  // ═══════════════════════════════════════════════════════════════

  async start() {
    this.isRunning = true;
    await this.setup();

    console.log(`[${this.config.id}] EmaBosTrader started — ${this.config.instId}, EMA(${EMA_PERIOD}), BOS lookback=${BOS_LOOKBACK}, ${LEVERAGE}x, risk=${RISK_PCT * 100}%, RR=1:${RR_TARGET}, BE@${BREAKEVEN_AT_R}R`);

    while (this.isRunning) {
      try {
        const now = Date.now();

        if (this.position) {
          const markPrice = await this.client.getMarkPrice(this.config.instId);
          if (markPrice) {
            await this.checkBreakeven(markPrice);
            if (now - this.lastLog >= LOG_MS) {
              const pos = this.position;
              const rr = pos.slPrice != null
                ? ((pos.side === 'long' ? markPrice - pos.entryPrice : pos.entryPrice - markPrice) / Math.abs(pos.entryPrice - pos.slPrice)).toFixed(2)
                : 'N/A';
              console.log(`[${this.config.id} POSITION] ${pos.side.toUpperCase()} entry=$${pos.entryPrice.toFixed(2)} mark=$${markPrice.toFixed(2)} SL=$${pos.slPrice?.toFixed(2)} TP=$${pos.tpPrice?.toFixed(2)} R=${rr} BE=${pos.movedToBreakeven}`);
              this.lastLog = now;
            }
          }
          await this.checkPositionClosed();
        } else {
          if (now - this.lastCandleCheck >= CANDLE_POLL_MS) {
            const bos = await this.checkForSignal();
            this.lastCandleCheck = now;

            if (now - this.lastLog >= LOG_MS) {
              const status = bos?.direction || (bos?.ema ? 'no signal' : 'warming up');
              console.log(`[${this.config.id} SCAN] EMA(50)=$${this.ema?.toFixed(2) || 'N/A'}  BOS=${status}  Position: none`);
              this.lastLog = now;
            }

            if (bos && bos.direction) {
              await this.openPosition(bos.direction, bos);
            }
          }
        }

        await this.client.throttle(POLL_MS);
      } catch (err) {
        console.error(`[${this.config.id} ERROR]`, err.message);
        await this.client.throttle(3000);
      }
    }
  }

  async stop() {
    this.isRunning = false;
    console.log(`[${this.config.id}] Stopping...`);
  }
}

module.exports = EmaBosTrader;
