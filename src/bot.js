/**
 * bot.js — Entry point: OKX EMA(50) + BOS perpetual futures bot
 *
 * BTC-USDT-SWAP + ETH-USDT-SWAP, 45x isolated leverage, 1% risk per trade,
 * SL at EMA(50), TP at 1:2.5 RR, breakeven move at 1R.
 * Demo trading by default (IS_DEMO=true) — flip to false for live later.
 *
 * Serves a stats dashboard + JSON API on PORT (default 8080, Railway sets its own).
 */

const http = require('http');
const OKXClient = require('./okxClient');
const EmaBosTrader = require('./emaBosTrader');
const TradeLog = require('./tradeLog');
const DiscordAlerter = require('./alerter');
const { renderStatsJSON, renderDashboardHTML } = require('./dashboard');

const PORT = process.env.PORT || 8080;

const ASSETS = [
  { id: 'BTC', instId: 'BTC-USDT-SWAP' },
  { id: 'ETH', instId: 'ETH-USDT-SWAP' },
];

let traders = [];
let tradeLog = null;

async function main() {
  console.log('\n==================================================');
  console.log('🤖 OKX EMA(50) + BOS Trend-Continuation Bot');
  console.log('==================================================');
  console.log('📈 Markets: BTC-USDT-SWAP + ETH-USDT-SWAP');
  console.log('📊 Strategy: 50 EMA + Break of Structure');
  console.log(`💰 Risk: 1% of balance as margin × 45x leverage`);
  console.log('🎯 SL: at EMA(50)   TP: 1:2.5 RR   Breakeven move: @1R');
  console.log(`🧪 Mode: ${process.env.IS_DEMO === 'true' ? 'DEMO (paper, simulated)' : '🔴 LIVE'}`);
  console.log(`🌐 Dashboard: port ${PORT}`);
  console.log('==================================================\n');

  tradeLog = new TradeLog();
  const alerter = new DiscordAlerter(process.env.DISCORD_WEBHOOK_URL);

  // ── HTTP server: dashboard + JSON API ──────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(renderStatsJSON(traders, tradeLog)));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', assets: ASSETS.map(a => a.id) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderDashboardHTML());
  });

  server.listen(PORT, () => console.log(`🌐 Dashboard listening on port ${PORT}`));

  // ── OKX Auth ────────────────────────────────────────────────────────
  const apiKey     = process.env.OKX_API_KEY     || '';
  const secretKey  = process.env.OKX_SECRET_KEY  || '';
  const passphrase = process.env.OKX_PASSPHRASE  || '';
  const isDemo     = process.env.IS_DEMO === 'true';

  if (!apiKey || !secretKey || !passphrase) {
    console.error('❌ Missing OKX API credentials. Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE');
    console.error('   Dashboard will stay up but the bot will not trade.');
    return;
  }

  const client = new OKXClient({ apiKey, secretKey, passphrase, isSimulated: isDemo });
  const authOk = await client.auth();
  if (!authOk) {
    console.error('❌ OKX authentication failed. Check credentials.');
    return;
  }

  await client.ensureHedgeMode();

  // ── Start one trader per asset, running in parallel ────────────────
  traders = ASSETS.map((a) => new EmaBosTrader(client, tradeLog, alerter, a));

  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 ${signal} received. Shutting down...`);
    await Promise.all(traders.map((t) => t.stop()));
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await Promise.all(traders.map((t) => t.start()));
}

if (require.main === module) {
  main().catch((err) => { console.error('💥 Fatal:', err); process.exit(1); });
}

module.exports = { main };
