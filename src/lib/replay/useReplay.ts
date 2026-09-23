import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  advanceCandles,
  extendReplayView,
  loadReplayView,
  rewindCandles,
  type ReplayView,
} from "./engine";
import type { ReplaySession } from "@/lib/backtest/types";
import { getMarketDataProvider } from "@/lib/market";
import type { Candle, Symbol, Timeframe } from "@/lib/market/types";

interface ViewCache {
  symbol: Symbol;
  tf: Timeframe;
  lookback: number;
  horizon: number;
  view: ReplayView;
}

/**
 * Binds a replay session to market data. The session's `currentTime` is the
 * replay clock — nothing at or after it is ever loaded for display.
 *
 * Stepping forward reuses the already-loaded window and only requests the
 * newly-completed candles, so a replay step is O(1) instead of re-reading the
 * whole lookback window.
 */
export function useReplay(
  session: ReplaySession | undefined,
  viewTf: Timeframe,
  lookback: number,
) {
  const [view, setView] = useState<ReplayView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<ViewCache | null>(null);
  const symbol = session?.symbol;
  const horizon = session?.currentTime ?? 0;

  useEffect(() => {
    if (!symbol || !horizon) {
      cache.current = null;
      setView(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const provider = getMarketDataProvider();
    const prev = cache.current;
    const canExtend =
      !!prev &&
      prev.symbol === symbol &&
      prev.tf === viewTf &&
      prev.lookback === lookback &&
      horizon > prev.horizon &&
      prev.view.completed.length > 0;

    // Only show the blocking loading state for a cold load, not for a step.
    if (!canExtend) setLoading(true);

    const work = canExtend
      ? extendReplayView(provider, symbol, viewTf, prev!.view, horizon, lookback)
      : loadReplayView(provider, symbol, viewTf, horizon, lookback);

    work
      .then((v) => {
        if (cancelled) return;
        cache.current = { symbol, tf: viewTf, lookback, horizon, view: v };
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        cache.current = null;
        setView(null);
        setError(e instanceof Error ? e.message : "Could not load market data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, viewTf, horizon, lookback]);

  const candles = useMemo<Candle[]>(() => {
    if (!view) return [];
    return view.forming ? [...view.completed, view.forming] : view.completed;
  }, [view]);

  const last = candles.length ? candles[candles.length - 1]! : null;

  return { candles, loading, error, lastCandle: last };
}

export interface ReplayControls {
  /** step forward n candles; resolves false when the end of history is reached */
  forward: (n: number) => Promise<boolean>;
  /** step back n candles (never before the session start) */
  back: (n: number) => Promise<void>;
}

/** Stepping helpers that are safe to call repeatedly (no overlapping requests). */
export function useReplayControls(
  session: ReplaySession | undefined,
  viewTf: Timeframe,
  onTime: (t: number) => void,
  onEnd?: () => void,
): ReplayControls {
  const busy = useRef(false);
  const ref = useRef({ session, viewTf, onTime, onEnd });
  ref.current = { session, viewTf, onTime, onEnd };

  const forward = useCallback(async (n: number) => {
    const { session: s, viewTf: tf, onTime: cb, onEnd: end } = ref.current;
    if (!s || busy.current) return true;
    busy.current = true;
    try {
      const r = await advanceCandles(getMarketDataProvider(), s.symbol, tf, s.currentTime, n);
      if (r.time !== s.currentTime) cb(r.time);
      if (r.atEnd) end?.();
      return !r.atEnd;
    } finally {
      busy.current = false;
    }
  }, []);

  const back = useCallback(async (n: number) => {
    const { session: s, viewTf: tf, onTime: cb } = ref.current;
    if (!s || busy.current) return;
    busy.current = true;
    try {
      const t = await rewindCandles(
        getMarketDataProvider(),
        s.symbol,
        tf,
        s.currentTime,
        n,
        s.startTime,
      );
      if (t !== s.currentTime) cb(t);
    } finally {
      busy.current = false;
    }
  }, []);

  return useMemo(() => ({ forward, back }), [forward, back]);
}
