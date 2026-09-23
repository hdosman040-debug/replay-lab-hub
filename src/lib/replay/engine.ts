import { aggregateCandles } from "@/lib/market/aggregate";
import type { MarketDataProvider } from "@/lib/market/provider";
import { floorToTf, TF_SECONDS, type Candle, type Symbol, type Timeframe } from "@/lib/market/types";

/**
 * Replay engine core.
 *
 * The replay clock (`horizon`, UTC seconds) is the single source of truth.
 * A candle with open time `t` on timeframe `tf` is COMPLETE when t + tf <= horizon.
 * The candle whose bucket contains `horizon` is FORMING and is built only from
 * lower-timeframe data strictly before `horizon`. Nothing at or after the
 * horizon is ever requested for display.
 */

export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;

export interface ReplayView {
  /** completed candles, oldest → newest */
  completed: Candle[];
  /** forming candle for the current bucket, or null if no data yet */
  forming: Candle | null;
  /** first loaded time (for infinite-scroll left) */
  loadedFrom: number;
}

const DAY = 86400;

/** Load everything visible at `horizon` for `tf`, with roughly `lookback` completed candles. */
export async function loadReplayView(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  horizon: number,
  lookback: number,
): Promise<ReplayView> {
  const tfs = TF_SECONDS[tf];
  const bucket = floorToTf(horizon, tf);
  // pad for weekends / daily breaks so we still get ~lookback candles
  const span = lookback * tfs;
  const from = bucket - span - Math.max(2 * DAY, Math.ceil(span / (5 * DAY)) * 2 * DAY);
  const [completed, m1] = await Promise.all([
    provider.getCandles({ symbol, timeframe: tf, from, to: bucket }),
    horizon > bucket
      ? provider.getCandles({ symbol, timeframe: "M1", from: bucket, to: horizon })
      : Promise.resolve([] as Candle[]),
  ]);
  // Defensive: never trust a provider to respect `to`.
  const safeCompleted = completed.filter((c) => c.time + tfs <= horizon);
  const safeM1 = m1.filter((c) => c.time < horizon);
  const forming = safeM1.length ? (aggregateCandles(safeM1, tf)[0] ?? null) : null;
  return { completed: safeCompleted, forming, loadedFrom: from };
}

/**
 * Advance the horizon so that exactly one more `tf` candle becomes complete.
 * Skips market gaps. Returns `null` when there is no further data — the caller
 * must stop rather than tick into emptiness.
 *
 * Only candle OPEN TIMES are consulted here, never prices, so this cannot leak
 * future price information into anything the trader sees.
 */
export async function nextHorizon(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  horizon: number,
): Promise<number | null> {
  const tfs = TF_SECONDS[tf];
  const bucket = floorToTf(horizon, tf);
  // Is there any data in the current bucket? (only `time` is consulted, never price)
  const inBucket = await provider.getCandles({ symbol, timeframe: "M1", from: bucket, to: bucket + tfs });
  if (inBucket.length > 0) {
    // Guard the very last bucket of the dataset: if nothing follows it, we are done.
    if (bucket + tfs > horizon) return bucket + tfs;
  }
  // Gap (weekend / daily break) or end of data: find the next candle open time.
  const ahead = await provider.getCandles({
    symbol,
    timeframe: tf,
    from: bucket + tfs,
    to: bucket + tfs + 7 * DAY,
  });
  const next = ahead[0];
  if (!next) return null; // end of available history
  return next.time + tfs;
}

/** Step the horizon back so exactly one fewer `tf` candle is complete. Skips gaps. */
export async function prevHorizon(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  horizon: number,
  floor: number,
): Promise<number | null> {
  const tfs = TF_SECONDS[tf];
  const behind = await provider.getCandles({
    symbol,
    timeframe: tf,
    from: Math.max(floor - 7 * DAY, horizon - 7 * DAY),
    to: horizon,
  });
  // the newest candle that is already complete at `horizon`
  const complete = behind.filter((c) => c.time + tfs <= horizon);
  const last = complete[complete.length - 1];
  if (!last) return null;
  const target = Math.max(floor, last.time);
  return target >= horizon ? null : target;
}

export interface AdvanceResult {
  time: number;
  /** true when the requested steps could not all be taken (end of history) */
  atEnd: boolean;
}

export async function advanceCandles(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  horizon: number,
  n: number,
): Promise<AdvanceResult> {
  let h = horizon;
  for (let i = 0; i < n; i++) {
    const next = await nextHorizon(provider, symbol, tf, h);
    if (next === null) return { time: h, atEnd: true };
    h = next;
  }
  return { time: h, atEnd: false };
}

export async function rewindCandles(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  horizon: number,
  n: number,
  floor: number,
): Promise<number> {
  let h = horizon;
  for (let i = 0; i < n; i++) {
    const prev = await prevHorizon(provider, symbol, tf, h, floor);
    if (prev === null) return h;
    h = prev;
  }
  return h;
}

/**
 * Extend an existing view to a later horizon without re-reading the whole
 * lookback window. Strictly causal: only data in [previous horizon, horizon)
 * is requested, and the result is identical to a fresh `loadReplayView`.
 */
export async function extendReplayView(
  provider: MarketDataProvider,
  symbol: Symbol,
  tf: Timeframe,
  prev: ReplayView,
  horizon: number,
  lookback: number,
): Promise<ReplayView> {
  const tfs = TF_SECONDS[tf];
  const bucket = floorToTf(horizon, tf);
  const lastDone = prev.completed[prev.completed.length - 1];
  const from = lastDone ? lastDone.time + tfs : bucket;
  const [fresh, m1] = await Promise.all([
    from < bucket
      ? provider.getCandles({ symbol, timeframe: tf, from, to: bucket })
      : Promise.resolve([] as Candle[]),
    horizon > bucket
      ? provider.getCandles({ symbol, timeframe: "M1", from: bucket, to: horizon })
      : Promise.resolve([] as Candle[]),
  ]);
  const added = fresh.filter((c) => c.time + tfs <= horizon && (!lastDone || c.time > lastDone.time));
  let completed = added.length ? [...prev.completed, ...added] : prev.completed;
  let loadedFrom = prev.loadedFrom;
  const cap = lookback + 240;
  if (completed.length > cap) {
    completed = completed.slice(completed.length - (lookback + 120));
    loadedFrom = completed[0]?.time ?? loadedFrom;
  }
  const safeM1 = m1.filter((c) => c.time < horizon);
  const forming = safeM1.length ? (aggregateCandles(safeM1, tf)[0] ?? null) : null;
  if (completed === prev.completed && sameCandle(forming, prev.forming)) return prev;
  return { completed, forming, loadedFrom };
}

function sameCandle(a: Candle | null, b: Candle | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close
  );
}

export interface TradeObservation {
  hit: "tp" | "sl" | null;
  hitAt: number | null;
  mfeR: number;
  maeR: number;
  lastPrice: number | null;
}

/** Inspect M1 data between activation and horizon (exclusive) for SL/TP touches. Informational only. */
export async function observeTrade(
  provider: MarketDataProvider,
  symbol: Symbol,
  trade: { direction: "long" | "short"; entry: number; stopLoss: number; takeProfit: number },
  from: number,
  horizon: number,
): Promise<TradeObservation> {
  const m1 = await provider.getCandles({ symbol, timeframe: "M1", from, to: horizon });
  const risk = Math.abs(trade.entry - trade.stopLoss) || 1;
  let mfe = 0;
  let mae = 0;
  let hit: "tp" | "sl" | null = null;
  let hitAt: number | null = null;
  let lastPrice: number | null = null;
  for (const c of m1) {
    if (c.time >= horizon) break;
    lastPrice = c.close;
    const fav = trade.direction === "long" ? c.high - trade.entry : trade.entry - c.low;
    const adv = trade.direction === "long" ? trade.entry - c.low : c.high - trade.entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    if (!hit) {
      const slHit = trade.direction === "long" ? c.low <= trade.stopLoss : c.high >= trade.stopLoss;
      const tpHit = trade.direction === "long" ? c.high >= trade.takeProfit : c.low <= trade.takeProfit;
      if (slHit && tpHit) {
        // ambiguous within one minute — conservative: stop first
        hit = "sl";
        hitAt = c.time;
      } else if (slHit) {
        hit = "sl";
        hitAt = c.time;
      } else if (tpHit) {
        hit = "tp";
        hitAt = c.time;
      }
      if (hit) break;
    }
  }
  return { hit, hitAt, mfeR: mfe, maeR: mae, lastPrice };
}
