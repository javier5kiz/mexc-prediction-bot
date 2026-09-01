/**
 * WhatsAppAlerter — sends trade entry/win/loss alerts via WhatsApp using CallMeBot
 *
 * Setup:
 *   1. Go to https://callmebot.com/whatsapp.php
 *   2. Send the WhatsApp message "CallMeBot" to the number shown on the site
 *   3. You'll receive an API key
 *   4. Set WHATSAPP_PHONE and WHATSAPP_API_KEY in your env vars
 *
 * The free tier allows ~30 messages/day — enough for trade alerts.
 */

class WhatsAppAlerter {
  constructor({ phone, apiKey } = {}) {
    this.phone = phone || process.env.WHATSAPP_PHONE || '';
    this.apiKey = apiKey || process.env.WHATSAPP_API_KEY || '';
    this.enabled = !!(this.phone && this.apiKey);
    console.log(this.enabled ? '🔔 WhatsApp alerter: ENABLED' : '🔔 WhatsApp alerter: DISABLED (set WHATSAPP_PHONE + WHATSAPP_API_KEY to enable)');
  }

  async _send(text) {
    if (!this.enabled) return;
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(this.phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(this.apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) console.error(`[WhatsApp] Alert failed: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`[WhatsApp] Alert error: ${err.message}`);
    }
  }

  _fmt(trade) {
    const lines = [];
    for (const [k, v] of Object.entries(trade)) {
      if (v != null && v !== '') lines.push(`${k}: ${v}`);
    }
    return lines.join('\n');
  }

  async sendEntry({ assetId, side, band, buyPrice, upPrice, downPrice, instId, totalTrades }) {
    const msg = `🔥 ENTRY — ${assetId} ${side}\n` +
      `Setup: ${band}\n` +
      `Entry: $${buyPrice.toFixed(2)}\n` +
      `TP: $${upPrice.toFixed(2)}\n` +
      `SL: $${downPrice.toFixed(2)}\n` +
      `Contract: ${instId}\n` +
      `Trade #${totalTrades}`;
    await this._send(msg);
  }

  async sendWin({ assetId, side, band, buyPrice, sellPrice, profit, winrate, wins, losses, totalTrades }) {
    const msg = `🎉 WIN — ${assetId} ${side}\n` +
      `Setup: ${band}\n` +
      `Entry: $${buyPrice.toFixed(2)}\n` +
      `Exit: $${sellPrice.toFixed(2)}\n` +
      `Profit: $${profit.toFixed(4)}\n` +
      `Winrate: ${winrate.toFixed(1)}% (${wins}W/${losses}L)\n` +
      `Total Trades: ${totalTrades}`;
    await this._send(msg);
  }

  async sendLoss({ assetId, side, band, buyPrice, loss, winrate, wins, losses, totalTrades }) {
    const msg = `💀 LOSS — ${assetId} ${side}\n` +
      `Setup: ${band}\n` +
      `Entry: $${buyPrice.toFixed(2)}\n` +
      `Loss: $${Math.abs(loss).toFixed(4)}\n` +
      `Winrate: ${winrate.toFixed(1)}% (${wins}W/${losses}L)\n` +
      `Total Trades: ${totalTrades}`;
    await this._send(msg);
  }
}

module.exports = WhatsAppAlerter;
