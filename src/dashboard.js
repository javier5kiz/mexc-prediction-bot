/**
 * dashboard.js — Small stats dashboard (self-contained HTML, no build step)
 * Served by the bot's own HTTP server at "/". Stats JSON at "/api/stats".
 */

function renderStatsJSON(traders, tradeLog) {
  const combined = tradeLog.getStats();
  const perAsset = {};
  for (const t of traders) {
    perAsset[t.config.id] = {
      ...tradeLog.getStats(t.config.id),
      ema: t.ema,
      position: t.position ? {
        side: t.position.side,
        entryPrice: t.position.entryPrice,
        slPrice: t.position.slPrice,
        tpPrice: t.position.tpPrice,
        movedToBreakeven: t.position.movedToBreakeven,
      } : null,
    };
  }
  return { combined, assets: perAsset, updatedAt: new Date().toISOString() };
}

function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OKX EMA+BOS Bot — Live Dashboard</title>
<style>
  :root { --bg:#0b0e14; --card:#141821; --border:#242a38; --text:#e6e9f0; --muted:#8b93a7; --green:#22c55e; --red:#ef4444; --accent:#f0b90b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 700; }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .accent { color: var(--accent); }
  .asset-section { margin-bottom: 24px; }
  .asset-title { font-size: 16px; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--border); color: var(--muted); }
  .badge.long { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge.short { background: rgba(239,68,68,0.15); color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
  .result-WIN { color: var(--green); font-weight: 600; }
  .result-LOSS { color: var(--red); font-weight: 600; }
  .result-BREAKEVEN { color: var(--muted); font-weight: 600; }
  .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
  <h1>🤖 OKX EMA(50) + BOS Bot</h1>
  <div class="sub">BTC + ETH · 45x isolated · 1% risk · 1:2.5 RR · breakeven @1R · <span id="updated">loading...</span></div>

  <div class="grid" id="combined-cards"></div>

  <div id="asset-sections"></div>

  <div class="footer">Auto-refreshes every 5s</div>

<script>
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    render(data);
  } catch (e) {
    console.error('Failed to load stats', e);
  }
}

function render(data) {
  document.getElementById('updated').textContent = 'Updated: ' + new Date(data.updatedAt).toLocaleTimeString();

  const c = data.combined;
  document.getElementById('combined-cards').innerHTML = \`
    <div class="card"><div class="label">Winrate</div><div class="value \${c.winrate >= 50 ? 'green' : 'red'}">\${c.winrate}%</div></div>
    <div class="card"><div class="label">Total PnL</div><div class="value \${c.totalPnL >= 0 ? 'green' : 'red'}">$\${c.totalPnL}</div></div>
    <div class="card"><div class="label">Trades</div><div class="value">\${c.totalTrades}</div></div>
    <div class="card"><div class="label">W / L / BE</div><div class="value">\${c.wins}/\${c.losses}/\${c.breakevens}</div></div>
    <div class="card"><div class="label">Avg R-Multiple</div><div class="value accent">\${c.avgRMultiple}R</div></div>
  \`;

  const assetsHtml = Object.entries(data.assets).map(([asset, s]) => {
    const posHtml = s.position ? \`
      <span class="badge \${s.position.side}">\${s.position.side.toUpperCase()} OPEN</span>
      entry $\${s.position.entryPrice?.toFixed(2)} · SL $\${s.position.slPrice?.toFixed(2)} · TP $\${s.position.tpPrice?.toFixed(2)}
      \${s.position.movedToBreakeven ? ' · <span class="accent">BE locked</span>' : ''}
    \` : '<span class="badge">No open position</span>';

    const rows = s.recentTrades.map(t => \`
      <tr>
        <td>\${new Date(t.ts).toLocaleString()}</td>
        <td>\${t.side?.toUpperCase()}</td>
        <td>$\${t.entryPrice?.toFixed(2)}</td>
        <td>$\${t.exitPrice?.toFixed(2)}</td>
        <td class="result-\${t.result}">\${t.result}</td>
        <td class="\${t.pnl >= 0 ? 'green' : 'red'}">$\${t.pnl?.toFixed(4)}</td>
        <td>\${t.rMultiple?.toFixed(2)}R</td>
      </tr>
    \`).join('');

    return \`
      <div class="asset-section">
        <div class="asset-title">\${asset} — EMA(50): $\${s.ema ? s.ema.toFixed(2) : 'N/A'} — \${posHtml}</div>
        <div class="grid">
          <div class="card"><div class="label">Winrate</div><div class="value \${s.winrate >= 50 ? 'green' : 'red'}">\${s.winrate}%</div></div>
          <div class="card"><div class="label">PnL</div><div class="value \${s.totalPnL >= 0 ? 'green' : 'red'}">$\${s.totalPnL}</div></div>
          <div class="card"><div class="label">Trades</div><div class="value">\${s.totalTrades}</div></div>
        </div>
        <table>
          <thead><tr><th>Time</th><th>Side</th><th>Entry</th><th>Exit</th><th>Result</th><th>PnL</th><th>R</th></tr></thead>
          <tbody>\${rows || '<tr><td colspan="7" style="color:#8b93a7">No trades yet</td></tr>'}</tbody>
        </table>
      </div>
    \`;
  }).join('');

  document.getElementById('asset-sections').innerHTML = assetsHtml;
}

loadStats();
setInterval(loadStats, 5000);
</script>
</body>
</html>`;
}

module.exports = { renderStatsJSON, renderDashboardHTML };
