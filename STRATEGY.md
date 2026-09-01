# Strategy Spec — 50 EMA + Break of Structure

## Setup (from chart reference)

The reference chart (BTC/USD, 1m, EMA(50) close) shows the pattern this bot trades:
- Price consolidates, then breaks structure (the highlighted boxes = prior range), continuing in the direction of the EMA slope
- Longs when price is above a rising EMA and breaks the last swing high
- Shorts when price is below a falling EMA and breaks the last swing low

## Rules

1. **Trend filter**: 5-minute candle closes above/below EMA(50)
2. **Trigger**: Break of Structure — close breaks the most recent confirmed swing high (long) or swing low (short), swing points detected with a 3-candle lookback on each side
3. **One position per asset at a time** (BTC and ETH tracked independently, can both be open simultaneously)
4. **Entry**: market order, immediately, in the BOS direction
5. **Position size**: `margin = balance × 1%`, `notional = margin × 45`, `contracts = floor(notional / markPrice / ctVal, lotSz)` — skipped if below exchange minimum size
6. **Stop loss**: EMA(50) value at signal time
7. **Take profit**: `entry + (entry − SL) × 2.5` (long) or `entry − (SL − entry) × 2.5` (short) — TP distance is derived from the SL distance, not fixed
8. **Breakeven**: when price reaches 1:1 RR, SL is moved to entry price (TP untouched) — done exactly once per trade
9. **Exit**: whichever of SL/TP/breakeven-SL hits first, executed by OKX's own OCO algo order (survives bot restarts)

## Result classification

- **WIN**: closed with positive realized PnL (TP hit, or breakeven-then-still-positive edge case)
- **LOSS**: closed with negative realized PnL (SL hit before breakeven)
- **BREAKEVEN**: stop was moved to entry and closed near zero PnL — excluded from the winrate ratio, tracked separately

## Notes on "machine learning"

This is a deterministic rule engine, not a trained model — there's no historical labeled dataset yet to train on. It mirrors what a disciplined discretionary trader does: read the EMA, read structure, size exactly 1%, never mis-click a lot size, move to breakeven at 1R without hesitation. Once enough real trades accumulate in `logs/trades.jsonl`, that data could be used to train a filter model on top of this rule engine (e.g. to skip low-quality BOS setups) — worth revisiting after a live sample size.
