import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput, type OrderInput } from './vendor/makefun-bot.ts';
import type { BotState, Batch, TradeEventRecord } from './vendor/makefun-bot.ts';

type TapeTrade = { slot: number; is_buy: boolean; sol_amount: bigint; user: string; price: number };
const tape = new Map<string, TapeTrade[]>();
const peaks = new Map<string, bigint>();
const entered = new Map<string, number>();
const lastExit = new Map<string, number>();
const entryCount = new Map<string, number>();
const SLIPPAGE = 1500;
const TX_FEE = (s: BotState) => s.txFeeLamports();

function heldOrPending(s: BotState, mint: string): boolean {
  for (const p of s.pending.values()) if (p.order.mint === mint) return true;
  return false;
}

async function onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
  const orders: OrderInput[] = [];
  try {
    const pendingMints = new Set<string>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);
    for (const mint of state.positions.keys()) if (!entered.has(mint)) entered.set(mint, batch.slot);

    // Maintain one ordered rolling tape per mint; retain the boundary point for the 30-slot window.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      try {
        const tr = e as TradeEventRecord;
        const price = Number(BigInt(tr.virtual_quote_reserves)) / Number(BigInt(tr.virtual_token_reserves));
        if (!(price > 0) || !Number.isFinite(price)) continue;
        const list = tape.get(tr.mint) ?? [];
        list.push({ slot: tr.slot, is_buy: tr.is_buy, sol_amount: BigInt(tr.sol_amount), user: tr.user, price });
        while (list.length && list[0].slot < batch.slot - 30) list.shift();
        tape.set(tr.mint, list);
      } catch { /* Ignore malformed market data for this trade. */ }
    }

    // Exits take priority and reserve batch capacity before any entries are considered.
    for (const [mint, pos] of state.positions) {
      try {
        if (pendingMints.has(mint) || orders.length >= state.hello.caps.max_orders_per_batch) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.virtual_token_reserves <= 0n) continue;
        const value = pos.token_amount * curve.virtual_quote_reserves /
          (curve.virtual_token_reserves + pos.token_amount);
        const afterCurveFee = value * 9875n / 10000n;
        const netValue = afterCurveFee > TX_FEE(state) ? afterCurveFee - TX_FEE(state) : 0n;
        const peak = peaks.get(mint) ?? netValue;
        const nextPeak = netValue > peak ? netValue : peak;
        peaks.set(mint, nextPeak);
        const cost = pos.cost_lamports;
        const armed = nextPeak * 100n >= cost * 102n;
        const aged = batch.slot - (entered.get(mint) ?? batch.slot) > 900;
        if (netValue * 100n < cost * 90n || (armed && netValue * 100n < nextPeak * 85n) || aged) {
          const order: SellInput = { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE };
          orders.push(order);
        }
      } catch { /* Keep processing other positions. */ }
    }

    let committed = state.committedPositionCount();
    const occupied = new Set<string>(state.positions.keys());
    for (const m of pendingMints) occupied.add(m);
    for (const [mint, curve] of state.curves) {
      try {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (occupied.has(mint) || curve.complete || curve.created_slot === null || batch.slot - curve.created_slot < 800) continue;
        if ((lastExit.has(mint) && batch.slot - lastExit.get(mint)! < 300) || (entryCount.get(mint) ?? 0) >= 3) continue;
        const rows = (tape.get(mint) ?? []).filter(t => t.slot >= batch.slot - 30 && t.slot <= batch.slot);
        if (rows.length < 5) continue;
        let net = 0n;
        let oldNet = 0n;
        let newNet = 0n;
        const buyers = new Set<string>();
        let buyCount = 0;
        let high = 0;
        for (const t of rows) {
          net += t.is_buy ? t.sol_amount : -t.sol_amount;
          if (t.slot > batch.slot - 15) newNet += t.is_buy ? t.sol_amount : -t.sol_amount;
          else oldNet += t.is_buy ? t.sol_amount : -t.sol_amount;
          if (t.is_buy) { buyers.add(t.user); buyCount++; }
          if (t.price > high) high = t.price;
        }
        const startPrice = rows[0].price;
        const currentPrice = rows[rows.length - 1].price;
        if (net < 45n * LAMPORTS_PER_SOL / 10n || newNet <= 0n || newNet < oldNet || buyCount < 10 || buyers.size < 8 || currentPrice < startPrice * 1.12 || currentPrice > startPrice * 1.30 || currentPrice < high * 0.98) continue;
        if (curve.real_quote_reserves < 5n * LAMPORTS_PER_SOL || curve.real_quote_reserves > 40n * LAMPORTS_PER_SOL) continue;
        if (committed >= 5 || committed >= state.hello.caps.max_open_positions) continue;
        const fee = TX_FEE(state);
        const cap = state.maxBuyLamports(mint);
        const amount = [LAMPORTS_PER_SOL / 20n, cap > fee ? cap - fee : 0n, state.freeCashLamports() > fee ? state.freeCashLamports() - fee : 0n]
          .reduce((a, b) => a < b ? a : b);
        if (amount <= 0n) continue;
        const order: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE };
        orders.push(order);
        occupied.add(mint);
        committed++;
      } catch { /* Ignore this curve and retain orders already built. */ }
    }
  } catch { /* A batch-level data issue must not prevent returning the orders built so far. */ }
  return orders;
}

runBot({
  onBatch: async (state, batch) => {
    const before = new Set(state.positions.keys());
    for (const fill of batch.fills) {
      if (fill.side === 'sell' && fill.status === 'filled' && !fill.client_id.startsWith('_')) lastExit.set(fill.mint, fill.slot);
    }
    const orders = await onBatch(state, batch);
    for (const o of orders) {
      if (o.side === 'buy') {
        entered.set(o.mint, batch.slot);
        peaks.set(o.mint, 0n);
        entryCount.set(o.mint, (entryCount.get(o.mint) ?? 0) + 1);
      }
    }
    for (const mint of before) {
      if (!state.positions.has(mint) && !heldOrPending(state, mint)) { entered.delete(mint); peaks.delete(mint); }
    }
    return orders;
  },
}).catch(() => { /* Preserve a clean process exit on malformed protocol input. */ });
