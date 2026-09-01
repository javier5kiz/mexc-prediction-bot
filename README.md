---
title: OKX EMA+BOS Bot
emoji: 🤖
colorFrom: yellow
colorTo: red
sdk: docker
app_file: Dockerfile
pinned: false
---

# OKX EMA(50) + BOS Perpetual Futures Bot

BTC + ETH perpetual swaps on OKX — 50 EMA + Break of Structure strategy, 45x leverage, 1% risk, 1:2.5 RR, breakeven at 1R.

## Quick Start

Set your secrets in HuggingFace Space Settings → Repository secrets:

- `OKX_API_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`
- `IS_DEMO` = `true` (start with demo!)
- `DISCORD_WEBHOOK_URL` (optional)

The bot listens on port 7860 (HuggingFace default). Dashboard available at `/`, stats JSON at `/api/stats`.
