# Pump Fun Paper Sprint — Momentum Paper-Trading Bot

A pump.fun paper-trading bot for the make.fun competition
[u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b):
one program, `main.ts` on Node 22, momentum entries with stop-loss, trailing-stop and
max-hold exits, paper trading only (replay market data, never real funds).

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lindaayu1200/boothlord-pump-bot/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lindaayu1200/boothlord-pump-bot/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

## Strategy

- Entry: 30-slot rolling tape per curve; net inflow >= 4.5 SOL, >= 10 buys from >= 8
  distinct buyers, price up 12-30% over the window start and >= 98% of the window high,
  newer-half inflow >= older-half inflow (acceleration), real reserves 5-40 SOL,
  800+ slots past curve creation, max 5 open positions, 300-slot per-mint cooldown,
  max 3 entries per mint, 0.05 SOL per entry.
- Exits: whole-position sell on -10% stop loss, -15% trailing drop (armed at +2%),
  or 900-slot max hold. Crash-safe (try/catch around every market call), deterministic
  (no clock, no randomness), flat-safe at end (the harness flattens at Done).

The SDK shim is vendored byte-for-byte at `vendor/makefun-bot.ts`.

## Run

    node main.ts
