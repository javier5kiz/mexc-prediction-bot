/**
 * indicators.js — EMA(50) calculation + Break-of-Structure (BOS) detection
 *
 * Candles must be passed CHRONOLOGICAL (oldest → newest).
 */

/**
 * Exponential Moving Average.
 * Returns an array aligned to `closes` — index < period-1 is undefined (not enough data).
 */
function calculateEMA(closes, period) {
  const emaArr = new Array(closes.length).fill(null);
  if (closes.length < period) return emaArr;

  const k = 2 / (period + 1);
  let sma = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaArr[period - 1] = sma;

  let prevEma = sma;
  for (let i = period; i < closes.length; i++) {
    const ema = closes[i] * k + prevEma * (1 - k);
    emaArr[i] = ema;
    prevEma = ema;
  }
  return emaArr;
}

/**
 * Find swing highs/lows using a symmetric lookback window.
 * A candle at index i is a swing high if its high is the max within [i-lookback, i+lookback].
 */
function findSwingPoints(candles, lookback = 3) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const isHigh = candles[i].high === Math.max(...window.map((c) => c.high));
    const isLow = candles[i].low === Math.min(...window.map((c) => c.low));
    if (isHigh) swings.push({ index: i, type: 'high', price: candles[i].high });
    if (isLow) swings.push({ index: i, type: 'low', price: candles[i].low });
  }
  return swings;
}

/**
 * Detect a Break of Structure on the most recent CONFIRMED candle.
 *
 * Bullish BOS: latest close breaks above the most recent confirmed swing high
 *              AND price is above EMA(50) → trend continuation long setup.
 * Bearish BOS: latest close breaks below the most recent confirmed swing low
 *              AND price is below EMA(50) → trend continuation short setup.
 *
 * @param candles    chronological array of {open,high,low,close,confirm}
 * @param emaValues  array aligned to candles (from calculateEMA)
 * @param lookback   swing detection window (default 3)
 * @returns {{direction: 'BULLISH'|'BEARISH'|null, level: number|null, ema: number|null, closePrice: number|null}}
 */
function detectBOS(candles, emaValues, lookback = 3) {
  const lastIdx = candles.length - 1;
  const lastEma = emaValues[lastIdx];
  const lastClose = candles[lastIdx].close;

  if (lastEma == null) return { direction: null, level: null, ema: null, closePrice: lastClose };

  // Only consider swings formed BEFORE the last candle (need confirmed structure to break)
  const priorCandles = candles.slice(0, lastIdx);
  const swings = findSwingPoints(priorCandles, lookback);

  const lastSwingHigh = [...swings].reverse().find((s) => s.type === 'high');
  const lastSwingLow = [...swings].reverse().find((s) => s.type === 'low');

  if (lastSwingHigh && lastClose > lastSwingHigh.price && lastClose > lastEma) {
    return { direction: 'BULLISH', level: lastSwingHigh.price, ema: lastEma, closePrice: lastClose };
  }
  if (lastSwingLow && lastClose < lastSwingLow.price && lastClose < lastEma) {
    return { direction: 'BEARISH', level: lastSwingLow.price, ema: lastEma, closePrice: lastClose };
  }
  return { direction: null, level: null, ema: lastEma, closePrice: lastClose };
}

module.exports = { calculateEMA, findSwingPoints, detectBOS };
