/**
 * DiscordAlerter — trade entry/win/loss alerts via Discord webhook (optional)
 */
class DiscordAlerter {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl || process.env.DISCORD_WEBHOOK_URL || '';
    this.enabled = !!this.webhookUrl;
    console.log(this.enabled ? '🔔 Discord alerter: ENABLED' : '🔔 Discord alerter: DISABLED (set DISCORD_WEBHOOK_URL to enable)');
  }

  async _send(payload) {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) console.error(`[Discord] Webhook failed: ${res.status}`);
    } catch (err) {
      console.error(`[Discord] Webhook error: ${err.message}`);
    }
  }

  async sendEntry({ assetId, side, band, buyPrice, upPrice, downPrice, instId, totalTrades }) {
    const embed = {
      title: `🔥 ENTRY — ${assetId} ${side}`,
      color: 0xffa500,
      fields: [
        { name: 'Asset', value: assetId, inline: true },
        { name: 'Direction', value: side, inline: true },
        { name: 'Setup', value: band, inline: true },
        { name: 'Entry', value: `$${buyPrice.toFixed(2)}`, inline: true },
        { name: 'TP', value: `$${upPrice.toFixed(2)}`, inline: true },
        { name: 'SL', value: `$${downPrice.toFixed(2)}`, inline: true },
        { name: 'Contract', value: `\`${instId}\``, inline: false },
      ],
      footer: { text: `OKX EMA+BOS Bot • Trade #${totalTrades}` },
      timestamp: new Date().toISOString(),
    };
    await this._send({ embeds: [embed] });
  }

  async sendWin({ assetId, side, band, buyPrice, sellPrice, profit, winrate, wins, losses, totalTrades }) {
    const embed = {
      title: `🎉 WIN — ${assetId} ${side}`,
      color: 0x00ff00,
      fields: [
        { name: 'Asset', value: assetId, inline: true },
        { name: 'Direction', value: side, inline: true },
        { name: 'Setup', value: band, inline: true },
        { name: 'Entry', value: `$${buyPrice.toFixed(2)}`, inline: true },
        { name: 'Exit', value: `$${sellPrice.toFixed(2)}`, inline: true },
        { name: 'Profit', value: `$${profit.toFixed(4)}`, inline: true },
        { name: 'Winrate', value: `${winrate.toFixed(1)}% (${wins}W/${losses}L)`, inline: true },
        { name: 'Total Trades', value: `${totalTrades}`, inline: true },
      ],
      footer: { text: `OKX EMA+BOS Bot` },
      timestamp: new Date().toISOString(),
    };
    await this._send({ embeds: [embed] });
  }

  async sendLoss({ assetId, side, band, buyPrice, loss, winrate, wins, losses, totalTrades }) {
    const embed = {
      title: `💀 LOSS — ${assetId} ${side}`,
      color: 0xff0000,
      fields: [
        { name: 'Asset', value: assetId, inline: true },
        { name: 'Direction', value: side, inline: true },
        { name: 'Setup', value: band, inline: true },
        { name: 'Entry', value: `$${buyPrice.toFixed(2)}`, inline: true },
        { name: 'Loss', value: `$${Math.abs(loss).toFixed(4)}`, inline: true },
        { name: 'Winrate', value: `${winrate.toFixed(1)}% (${wins}W/${losses}L)`, inline: true },
        { name: 'Total Trades', value: `${totalTrades}`, inline: true },
      ],
      footer: { text: `OKX EMA+BOS Bot` },
      timestamp: new Date().toISOString(),
    };
    await this._send({ embeds: [embed] });
  }
}

module.exports = DiscordAlerter;
