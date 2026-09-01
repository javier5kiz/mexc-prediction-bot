const crypto = require('crypto');

/**
 * OKXClient — Perpetual Swap (Futures) trading client
 * Supports: BTC-USDT-SWAP, ETH-USDT-SWAP with isolated margin, cross leverage,
 * attached TP/SL algo orders, breakeven amendment, position + PnL tracking.
 */
class OKXClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.OKX_API_KEY || '';
    this.secretKey = config.secretKey || process.env.OKX_SECRET_KEY || '';
    this.passphrase = config.passphrase || process.env.OKX_PASSPHRASE || '';
    this.isSimulated = config.isSimulated || process.env.IS_DEMO === 'true' || false;
    this.baseURL = config.baseURL || process.env.OKX_BASE_URL || 'https://www.okx.com';
    this._accountMode = null;
    this._instrumentCache = {}; // instId -> { ctVal, lotSz, minSz }
  }

  _getHeaders(method, requestPath, body = '') {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const message = timestamp + method.toUpperCase() + requestPath + bodyStr;
    const signature = crypto.createHmac('sha256', this.secretKey).update(message).digest('base64');

    const headers = {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': signature,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
    };
    if (this.isSimulated) headers['x-simulated-trading'] = '1';
    return headers;
  }

  async _request(method, path, data = null, isPrivate = false) {
    try {
      const url = `${this.baseURL}${path}`;
      const headers = isPrivate ? this._getHeaders(method, path, data) : { 'Content-Type': 'application/json' };
      const options = { method, headers };
      if (data && (method === 'POST' || method === 'PUT')) options.body = JSON.stringify(data);
      const res = await fetch(url, options);
      return await res.json();
    } catch (err) {
      console.error(`[OKXClient Error] ${method} ${path}:`, err.message);
      return { code: '-1', msg: err.message || String(err), data: [] };
    }
  }

  async throttle(ms = 200) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════
  //  Account Setup
  // ═══════════════════════════════════════════════════════════════

  async auth() {
    console.log('🔑 Authenticating with OKX API...');
    const res = await this.getUSDTBalanceRaw();
    if (res && res.code === '0') {
      console.log('✅ OKX Authentication successful!');
      await this.getAccountConfig();
      return true;
    }
    console.error('❌ OKX Authentication failed:', res?.msg || 'Unknown error');
    return false;
  }

  async getAccountConfig() {
    if (this._accountMode !== null) return this._accountMode;
    const res = await this._request('GET', '/api/v5/account/config', null, true);
    if (res && res.code === '0' && res.data && res.data[0]) {
      const config = res.data[0];
      this._accountMode = {
        acctLv: parseInt(config.acctLv || '1', 10),
        posMode: config.posMode,
      };
      const lvNames = { 1: 'Spot', 2: 'Single-margin', 3: 'Multi-margin', 4: 'Portfolio' };
      console.log(`📋 Account: mode=${this._accountMode.acctLv} (${lvNames[this._accountMode.acctLv] || '?'}), posMode=${this._accountMode.posMode}`);
      if (this._accountMode.acctLv === 1) {
        console.warn('⚠️  Account is in SPOT mode — perpetual SWAP trading with leverage requires Single-currency margin mode or higher.');
        console.warn('⚠️  Switch it in OKX (demo) → Settings → Account mode, otherwise leveraged orders will fail.');
      }
    } else {
      console.warn('⚠️ Could not fetch account config.');
      this._accountMode = { acctLv: 1 };
    }
    return this._accountMode;
  }

  /**
   * Ensure account is in long_short_mode (hedge mode) so posSide can be used.
   * Position mode is account-wide (applies to all SWAP instruments), not per-instrument.
   */
  async ensureHedgeMode() {
    const body = { posMode: 'long_short_mode' };
    const res = await this._request('POST', '/api/v5/account/set-position-mode', body, true);
    if (res && res.code === '0') {
      console.log('✅ Position mode set to long_short_mode (hedge mode)');
    } else {
      console.warn(`⚠️ Could not set position mode: ${res?.msg} (code=${res?.code}) — may already be set, or positions are open.`);
    }
    return res;
  }

  async setLeverage(instId, lever, mgnMode = 'isolated', posSide = null) {
    const body = { instId, lever: String(lever), mgnMode };
    if (posSide) body.posSide = posSide;
    const res = await this._request('POST', '/api/v5/account/set-leverage', body, true);
    if (res && res.code === '0') {
      console.log(`✅ Leverage set: ${instId} ${posSide || ''} ${lever}x (${mgnMode})`);
    } else {
      console.warn(`⚠️ setLeverage failed for ${instId} ${posSide || ''}: ${res?.msg} (code=${res?.code})`);
    }
    return res;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Instrument Specs
  // ═══════════════════════════════════════════════════════════════

  async getInstrumentSpecs(instId) {
    if (this._instrumentCache[instId]) return this._instrumentCache[instId];
    const path = `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const res = await this._request('GET', path, null, false);
    if (res && res.code === '0' && res.data && res.data[0]) {
      const d = res.data[0];
      const specs = {
        ctVal: parseFloat(d.ctVal || '0.01'),
        ctValCcy: d.ctValCcy,
        lotSz: parseFloat(d.lotSz || '1'),
        minSz: parseFloat(d.minSz || '1'),
        tickSz: parseFloat(d.tickSz || '0.1'),
      };
      this._instrumentCache[instId] = specs;
      return specs;
    }
    console.warn(`⚠️ Could not fetch instrument specs for ${instId}, using fallback`);
    return { ctVal: 0.01, lotSz: 1, minSz: 1, tickSz: 0.1 };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Market Data
  // ═══════════════════════════════════════════════════════════════

  async getKlineCandles(instId, bar = '5m', limit = 100) {
    const path = `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
    const res = await this._request('GET', path, null, false);
    if (res && res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
      return res.data.map((c) => ({
        ts: parseInt(c[0], 10),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        vol: parseFloat(c[5]),
        confirm: parseInt(c[8] || '0', 10),
      }));
    }
    return [];
  }

  async getMarkPrice(instId) {
    const path = `/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instId)}`;
    const res = await this._request('GET', path, null, false);
    if (res && res.code === '0' && res.data && res.data[0]) {
      return parseFloat(res.data[0].markPx);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Balance
  // ═══════════════════════════════════════════════════════════════

  async getUSDTBalanceRaw() {
    return this._request('GET', '/api/v5/account/balance', null, true);
  }

  async getUSDTBalance() {
    const res = await this.getUSDTBalanceRaw();
    if (res && res.code === '0' && Array.isArray(res.data)) {
      const detail = res.data[0]?.details?.find((d) => d.ccy === 'USDT');
      return detail ? parseFloat(detail.availBal || detail.eq || '0') : 0;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Orders — Entry with Attached TP/SL
  // ═══════════════════════════════════════════════════════════════

  /**
   * Place a market entry order with an attached TP/SL (OCO) that OKX manages natively.
   * side: 'buy' (open long) | 'sell' (open short)
   * posSide: 'long' | 'short'
   */
  async placeSwapEntryOrder({ instId, side, posSide, sz, tpTriggerPx, slTriggerPx, mgnMode = 'isolated' }) {
    const clOrdId = `bos${Date.now()}`.slice(0, 32);
    const body = {
      instId,
      tdMode: mgnMode,
      side,
      posSide,
      ordType: 'market',
      sz: String(sz),
      attachAlgoOrds: [
        {
          attachAlgoClOrdId: clOrdId,
          tpTriggerPx: String(tpTriggerPx),
          tpOrdPx: '-1',
          tpTriggerPxType: 'last',
          slTriggerPx: String(slTriggerPx),
          slOrdPx: '-1',
          slTriggerPxType: 'last',
        },
      ],
    };
    return this._request('POST', '/api/v5/trade/order', body, true);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Algo Orders (standalone TP/SL, used for breakeven adjustment)
  // ═══════════════════════════════════════════════════════════════

  async getPendingAlgoOrders(instId) {
    const path = `/api/v5/trade/orders-algo-pending?ordType=conditional,oco&instId=${encodeURIComponent(instId)}`;
    const res = await this._request('GET', path, null, true);
    if (res && res.code === '0' && Array.isArray(res.data)) return res.data;
    return [];
  }

  async cancelAlgoOrder(instId, algoId) {
    const body = [{ instId, algoId }];
    return this._request('POST', '/api/v5/trade/cancel-algos', body, true);
  }

  /**
   * Place a standalone conditional order carrying BOTH a TP leg and SL leg (OCO-style).
   * Used to re-establish the SL/TP pair after moving stop to breakeven.
   */
  async placeAlgoOrder({ instId, side, posSide, sz, tpTriggerPx, slTriggerPx, mgnMode = 'isolated', reduceOnly = true }) {
    const body = {
      instId,
      tdMode: mgnMode,
      side,
      posSide,
      ordType: 'oco',
      sz: String(sz),
      reduceOnly: String(reduceOnly),
      tpTriggerPx: String(tpTriggerPx),
      tpOrdPx: '-1',
      tpTriggerPxType: 'last',
      slTriggerPx: String(slTriggerPx),
      slOrdPx: '-1',
      slTriggerPxType: 'last',
    };
    return this._request('POST', '/api/v5/trade/order-algo', body, true);
  }

  /**
   * Attempt to amend an existing algo order's SL trigger price directly (fast path).
   * Falls back to cancel + re-place if amendment isn't supported for this order type.
   */
  async amendAlgoOrder(instId, algoId, { newSlTriggerPx, newTpTriggerPx } = {}) {
    const body = [{ instId, algoId }];
    if (newSlTriggerPx != null) body[0].newSlTriggerPx = String(newSlTriggerPx);
    if (newTpTriggerPx != null) body[0].newTpTriggerPx = String(newTpTriggerPx);
    return this._request('POST', '/api/v5/trade/amend-algos', body, true);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Positions
  // ═══════════════════════════════════════════════════════════════

  async getPositions(instId = null) {
    const path = instId
      ? `/api/v5/account/positions?instType=SWAP&instId=${encodeURIComponent(instId)}`
      : `/api/v5/account/positions?instType=SWAP`;
    const res = await this._request('GET', path, null, true);
    if (res && res.code === '0' && Array.isArray(res.data)) {
      return res.data.filter((p) => parseFloat(p.pos || '0') !== 0);
    }
    return [];
  }

  /**
   * Fetch recently closed position history to determine realized PnL after a close.
   */
  async getPositionsHistory(instId, limit = 5) {
    const path = `/api/v5/account/positions-history?instType=SWAP&instId=${encodeURIComponent(instId)}&limit=${limit}`;
    const res = await this._request('GET', path, null, true);
    if (res && res.code === '0' && Array.isArray(res.data)) return res.data;
    return [];
  }

  async closePosition(instId, posSide, mgnMode = 'isolated') {
    const body = { instId, posSide, mgnMode };
    return this._request('POST', '/api/v5/trade/close-position', body, true);
  }
}

module.exports = OKXClient;
