const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const TRADE_FILE = path.join(LOG_DIR, 'trades.jsonl');

/**
 * TradeLog — records every trade lifecycle event (entry, breakeven move, close)
 * and computes accurate winrate + PnL stats.
 */
class TradeLog {
  constructor() {
    this.trades = []; // in-memory cache of closed trades: { asset, side, entry, exit, sl, tp, result, pnl, rMultiple, time }
    this._loadExisting();
  }

  _loadExisting() {
    try {
      if (fs.existsSync(TRADE_FILE)) {
        const lines = fs.readFileSync(TRADE_FILE, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.event === 'CLOSE') this.trades.push(entry);
          } catch { /* skip bad line */ }
        }
        console.log(`📁 Loaded ${this.trades.length} historical closed trades from log`);
      }
    } catch (err) {
      console.warn('⚠️ Could not load trade history:', err.message);
    }
  }

  record(entry) {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
    fs.appendFileSync(TRADE_FILE, line + '\n');
  }

  recordEntry({ asset, side, entryPrice, slPrice, tpPrice, marginUSD, leverage, sz, instId }) {
    this.record({ event: 'ENTRY', asset, side, entryPrice, slPrice, tpPrice, marginUSD, leverage, sz, instId });
  }

  recordBreakeven({ asset, side, entryPrice, newSlPrice, instId }) {
    this.record({ event: 'BREAKEVEN', asset, side, entryPrice, newSlPrice, instId });
  }

  /**
   * Record a closed trade and update in-memory stats.
   * result: 'WIN' | 'LOSS' | 'BREAKEVEN'
   */
  recordClose({ asset, side, entryPrice, exitPrice, slPrice, tpPrice, pnl, result, marginUSD, leverage, instId, movedToBreakeven }) {
    const rMultiple = this._computeRMultiple(side, entryPrice, exitPrice, slPrice);
    const trade = {
      event: 'CLOSE', asset, side, entryPrice, exitPrice, slPrice, tpPrice,
      pnl, result, marginUSD, leverage, instId, movedToBreakeven, rMultiple,
    };
    this.record(trade);
    this.trades.push(trade);
    return trade;
  }

  _computeRMultiple(side, entry, exit, sl) {
    const risk = side === 'long' ? entry - sl : sl - entry;
    if (!risk || risk === 0) return 0;
    const moved = side === 'long' ? exit - entry : entry - exit;
    return moved / risk;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(assetFilter = null) {
    const trades = assetFilter ? this.trades.filter((t) => t.asset === assetFilter) : this.trades;
    const wins = trades.filter((t) => t.result === 'WIN').length;
    const losses = trades.filter((t) => t.result === 'LOSS').length;
    const breakevens = trades.filter((t) => t.result === 'BREAKEVEN').length;
    const decisive = wins + losses; // breakevens excluded from winrate denominator
    const winrate = decisive === 0 ? 0 : (wins / decisive) * 100;
    const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgR = trades.length ? trades.reduce((s, t) => s + (t.rMultiple || 0), 0) / trades.length : 0;

    return {
      totalTrades: trades.length,
      wins, losses, breakevens,
      winrate: parseFloat(winrate.toFixed(1)),
      totalPnL: parseFloat(totalPnL.toFixed(4)),
      avgRMultiple: parseFloat(avgR.toFixed(2)),
      recentTrades: trades.slice(-10).reverse(),
    };
  }
}

module.exports = TradeLog;
