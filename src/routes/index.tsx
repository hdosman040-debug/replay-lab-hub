import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { CandleChart } from "@/components/chart/CandleChart";
import { DrawingOverlay } from "@/components/chart/DrawingOverlay";
import { AppShell } from "@/components/layout/AppShell";
import { AnalysisPanel, TradePanel, WorkflowPanel } from "@/components/workspace/panels";
import { ToolStrip } from "@/components/workspace/ToolStrip";
import { TradeLevels } from "@/components/workspace/TradeLevels";
import { WorkspaceSheets } from "@/components/workspace/WorkspaceSheets";
import type { JournalRecord, TradePlan } from "@/lib/backtest/types";
import { getTool } from "@/lib/drawings/types";
import { TF_SECONDS, TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { SPEEDS } from "@/lib/replay/engine";
import { useReplay, useReplayControls } from "@/lib/replay/useReplay";
import { useStoresHydrated } from "@/lib/store/hydrate";
import { useJournalStore } from "@/lib/store/journalStore";
import { uid, useActiveSession, useSessionStore } from "@/lib/store/sessionStore";
import { useSettingsStore } from "@/lib/store/settingsStore";
import { useUIStore } from "@/lib/store/uiStore";
import { fmtDate, fmtTime, sessionAt, SESSION_LABEL } from "@/lib/time/ny";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ICT Trade Terminal — US30 replay workstation" },
      {
        name: "description",
        content:
          "Replay US30 history candle by candle, mark liquidity and structure by hand, plan trades and journal every decision.",
      },
      { property: "og:title", content: "ICT Trade Terminal — US30 replay workstation" },
      {
        property: "og:description",
        content: "A manual US30 historical replay and backtesting lab built for Android.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Workspace,
});

function Workspace() {
  const ready = useStoresHydrated();
  const session = useActiveSession();

  /* Narrow store subscriptions: the workspace re-renders on every replay tick,
     so it must not also re-render for unrelated store writes. */
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const createSession = useSessionStore((s) => s.createSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const setActive = useSessionStore((s) => s.setActive);
  const patchActive = useSessionStore((s) => s.patchActive);
  const addDrawing = useSessionStore((s) => s.addDrawing);
  const updateDrawing = useSessionStore((s) => s.updateDrawing);
  const removeDrawing = useSessionStore((s) => s.removeDrawing);
  const undo = useSessionStore((s) => s.undo);
  const redo = useSessionStore((s) => s.redo);
  const setAnalysis = useSessionStore((s) => s.setAnalysis);
  const setTrade = useSessionStore((s) => s.setTrade);
  const toggleWorkflowStep = useSessionStore((s) => s.toggleWorkflowStep);

  const settings = useSettingsStore((s) => s.settings);
  const addRecord = useJournalStore((s) => s.add);

  const playing = useUIStore((s) => s.playing);
  const setPlaying = useUIStore((s) => s.setPlaying);
  const viewTimeframe = useUIStore((s) => s.viewTimeframe);
  const setViewTimeframe = useUIStore((s) => s.setViewTimeframe);
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const selectedDrawingId = useUIStore((s) => s.selectedDrawingId);
  const setSelectedDrawing = useUIStore((s) => s.setSelectedDrawing);
  const panelTab = useUIStore((s) => s.panelTab);
  const setPanelTab = useUIStore((s) => s.setPanelTab);
  const sheet = useUIStore((s) => s.sheet);
  const setSheet = useUIStore((s) => s.setSheet);
  const setCrosshairPrice = useUIStore((s) => s.setCrosshairPrice);

  const tz = settings.sessionTimezone;
  const viewTf: Timeframe = viewTimeframe ?? session?.timeframe ?? settings.defaultTimeframe;
  const { candles, loading, error, lastCandle } = useReplay(session, viewTf, settings.lookbackCandles);

  const [panelOpen, setPanelOpen] = useState(false);
  const [atEnd, setAtEnd] = useState(false);

  const onTime = useCallback((t: number) => patchActive({ currentTime: t }), [patchActive]);
  const onEnd = useCallback(() => {
    setAtEnd(true);
    setPlaying(false);
  }, [setPlaying]);
  const { forward, back } = useReplayControls(session, viewTf, onTime, onEnd);

  const endedRef = useRef(false);
  useEffect(() => {
    if (atEnd && !endedRef.current) {
      endedRef.current = true;
      toast.info("End of available history for this timeframe.");
    }
    if (!atEnd) endedRef.current = false;
  }, [atEnd]);

  const step = useCallback(
    (n: number) => {
      setAtEnd(false);
      if (n > 0) void forward(n);
      else void back(-n);
    },
    [forward, back],
  );

  /* Playback loop. Depends only on identity + speed — never on the session
     object itself, or the interval would be torn down on every tick. */
  const sessionId = session?.id;
  const speed = session?.speed ?? 1;
  useEffect(() => {
    if (!playing || !sessionId) return;
    const id = window.setInterval(() => void forward(1), Math.max(60, 1000 / (speed || 1)));
    return () => window.clearInterval(id);
  }, [playing, sessionId, speed, forward]);

  /* Reaching the end of history stops playback. */
  useEffect(() => {
    if (atEnd && playing) setPlaying(false);
  }, [atEnd, playing, setPlaying]);

  useEffect(() => {
    setAtEnd(false);
  }, [sessionId, viewTf]);

  useEffect(() => {
    if (session && !viewTimeframe) setViewTimeframe(session.timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const tool = activeTool ? (getTool(activeTool) ?? null) : null;

  const sessionsList = useMemo(
    () => Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  /* ---- stable sheet handlers ---- */
  const closeSheet = useCallback(() => setSheet(null), [setSheet]);
  const handleCreateSession = useCallback(
    (v: { name?: string; timeframe: Timeframe; startTime: number; speed: number }) => {
      createSession({ ...v, symbol: "US30" });
      setViewTimeframe(v.timeframe);
      setSheet(null);
    },
    [createSession, setViewTimeframe, setSheet],
  );
  const handleSelectSession = useCallback(
    (id: string) => {
      setActive(id);
      const s = useSessionStore.getState().sessions[id];
      if (s) setViewTimeframe(s.timeframe);
      setSheet(null);
    },
    [setActive, setViewTimeframe, setSheet],
  );
  const handleJump = useCallback(
    (t: number) => {
      setPlaying(false);
      patchActive({ currentTime: t });
      setSheet(null);
    },
    [setPlaying, patchActive, setSheet],
  );
  const handleReset = useCallback(() => {
    setPlaying(false);
    const s = useSessionStore.getState();
    const cur = s.activeSessionId ? s.sessions[s.activeSessionId] : undefined;
    if (cur) patchActive({ currentTime: cur.startTime });
    setSheet(null);
  }, [setPlaying, patchActive, setSheet]);
  const handleSaveRecord = useCallback(
    (record: JournalRecord, keepTrade: boolean) => {
      addRecord(record);
      if (keepTrade) setTrade(record.trade);
      setSheet(null);
    },
    [addRecord, setTrade, setSheet],
  );

  const sheets = (
    <WorkspaceSheets
      sheet={sheet}
      session={session}
      sessionsList={sessionsList}
      activeId={activeSessionId}
      tz={tz}
      sessionWindows={settings.sessions}
      defaultTimeframe={settings.defaultTimeframe}
      defaultSpeed={settings.defaultSpeed}
      onClose={closeSheet}
      onCreateSession={handleCreateSession}
      onSelectSession={handleSelectSession}
      onDeleteSession={deleteSession}
      onNewSession={() => setSheet("newSession")}
      onJump={handleJump}
      onResetToStart={handleReset}
      onSaveRecord={handleSaveRecord}
    />
  );

  if (!ready) {
    return (
      <AppShell chrome={false}>
        <div className="flex h-full items-center justify-center">
          <div className="eyebrow animate-pulse">Loading workspace…</div>
        </div>
      </AppShell>
    );
  }

  if (!session) {
    return (
      <AppShell>
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <h1 className="text-xl font-semibold">ICT Trade Terminal</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              A US30 historical laboratory. You mark everything, the terminal only replays price
              and measures what you decided.
            </p>
          </div>
          <button
            type="button"
            className="touch-btn w-full max-w-xs font-semibold"
            style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
            onClick={() => setSheet("newSession")}
          >
            Start a replay session
          </button>
          {sessionsList.length > 0 && (
            <button
              type="button"
              className="touch-btn w-full max-w-xs border border-border text-sm"
              onClick={() => setSheet("sessions")}
            >
              Continue a saved session ({sessionsList.length})
            </button>
          )}
        </div>
        {sheets}
      </AppShell>
    );
  }

  const nySession = SESSION_LABEL[sessionAt(session.currentTime, settings.sessions, tz)];

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-hidden">
        {/* top bar */}
        <header className="shrink-0 border-b border-border bg-surface px-2 py-1.5">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <button
              type="button"
              className="chip shrink-0"
              aria-label="Sessions"
              onClick={() => setSheet("sessions")}
            >
              ☰
            </button>
            <button type="button" className="min-w-0 text-left" onClick={() => setSheet("jumpTo")}>
              <div className="num truncate text-sm font-semibold">
                {fmtTime(session.currentTime, tz)}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {fmtDate(session.currentTime, tz)}
                </span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {session.symbol} · {nySession} ·{" "}
                {error ? "data error" : loading ? "loading…" : `${candles.length} candles`}
                {atEnd ? " · end" : ""}
              </div>
            </button>
            {lastCandle && (
              <span
                className="num shrink-0 text-sm font-semibold tabular-nums"
                style={{ color: lastCandle.close >= lastCandle.open ? "var(--bull)" : "var(--bear)" }}
              >
                {lastCandle.close.toFixed(1)}
              </span>
            )}
          </div>
          <div className="no-scrollbar mt-1.5 flex gap-1.5 overflow-x-auto">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                className="chip num shrink-0"
                data-active={viewTf === tf}
                onClick={() => setViewTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </header>

        {/* chart */}
        <div className="relative min-h-0 flex-1">
          <CandleChart
            candles={candles}
            barSeconds={TF_SECONDS[viewTf]}
            timezone={tz}
            onClickEmpty={() => setSelectedDrawing(null)}
            onCrosshairPrice={setCrosshairPrice}
          >
            <DrawingOverlay
              drawings={session.drawings}
              selectedId={selectedDrawingId}
              tool={tool}
              magnet={settings.magnetToOHLC}
              replayTime={session.currentTime}
              candles={candles}
              timezone={tz}
              sessions={settings.sessions}
              showSessions={settings.showSessions}
              showTradingWindow={settings.showTradingWindow}
              onCreate={(d) => addDrawing({ ...d, id: uid() })}
              onUpdate={(id, patch, commit) => updateDrawing(id, patch, commit)}
              onSelect={setSelectedDrawing}
              onToolConsumed={() => {
                if (!settings.keepToolActive) setActiveTool(null);
              }}
            />
            <TradeLevels
              trade={session.trade}
              onChange={(patch) => session.trade && setTrade({ ...session.trade, ...patch })}
            />
          </CandleChart>

          {loading && candles.length === 0 && !error && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
              <span className="chip animate-pulse">Loading candles…</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/80 px-6 text-center">
              <p className="text-sm text-muted-foreground">Market data could not be loaded.</p>
              <p className="text-xs text-muted-foreground/80">{error}</p>
              <button
                type="button"
                className="touch-btn border border-border px-4 text-sm"
                onClick={() => patchActive({ currentTime: session.currentTime })}
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* replay controls */}
        <div className="flex shrink-0 items-center gap-1 border-t border-border bg-surface px-2 py-2">
          <button
            type="button"
            className="touch-btn num shrink-0 border border-border px-2.5 text-xs"
            aria-label="Back 10 candles"
            onClick={() => step(-10)}
          >
            −10
          </button>
          <button
            type="button"
            className="touch-btn num shrink-0 border border-border px-3 text-xs"
            aria-label="Back one candle"
            onClick={() => step(-1)}
          >
            −1
          </button>
          <button
            type="button"
            className="touch-btn min-w-0 flex-1 font-semibold"
            style={{
              backgroundColor: playing ? "var(--surface-3)" : "var(--primary)",
              color: playing ? "var(--foreground)" : "var(--primary-foreground)",
            }}
            onClick={() => {
              setAtEnd(false);
              setPlaying(!playing);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="touch-btn num shrink-0 border border-border px-3 text-xs"
            aria-label="Forward one candle"
            onClick={() => step(1)}
          >
            +1
          </button>
          <button
            type="button"
            className="touch-btn num shrink-0 border border-border px-2.5 text-xs"
            aria-label="Forward 10 candles"
            onClick={() => step(10)}
          >
            +10
          </button>
          <select
            className="panel-input num w-16 shrink-0 px-1 text-center text-xs"
            aria-label="Replay speed"
            value={session.speed}
            onChange={(e) => patchActive({ speed: Number(e.target.value) })}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>

        <ToolStrip
          activeTool={activeTool}
          onPick={setActiveTool}
          onUndo={undo}
          onRedo={redo}
          hasSelection={!!selectedDrawingId}
          onDeleteSelected={() => {
            if (selectedDrawingId) {
              removeDrawing(selectedDrawingId);
              setSelectedDrawing(null);
            }
          }}
        />

        {/* analysis / trade panel */}
        <div className="shrink-0 border-t border-border bg-surface">
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            {(["workflow", "analysis", "trade"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="chip capitalize"
                data-active={panelOpen && panelTab === t}
                onClick={() => {
                  setPanelTab(t);
                  setPanelOpen(!(panelOpen && panelTab === t));
                }}
              >
                {t}
              </button>
            ))}
            <span className="flex-1" />
            {panelOpen && (
              <button type="button" className="chip" onClick={() => setPanelOpen(false)}>
                Hide
              </button>
            )}
          </div>
          {panelOpen && (
            <div className="max-h-[45dvh] overflow-y-auto overscroll-contain border-t border-border">
              {panelTab === "workflow" && <WorkflowPanel session={session} onToggle={toggleWorkflowStep} />}
              {panelTab === "analysis" && <AnalysisPanel analysis={session.analysis} onChange={setAnalysis} />}
              {panelTab === "trade" && (
                <TradePanel
                  trade={session.trade}
                  lastPrice={lastCandle?.close ?? null}
                  onCreate={(direction) => {
                    const p = lastCandle?.close ?? 0;
                    const risk = Math.max(10, p * 0.001);
                    const plan: TradePlan = {
                      id: uid(),
                      direction,
                      entry: Math.round(p * 10) / 10,
                      stopLoss: Math.round((direction === "long" ? p - risk : p + risk) * 10) / 10,
                      takeProfit: Math.round((direction === "long" ? p + risk * 2 : p - risk * 2) * 10) / 10,
                      status: "planned",
                      plannedAt: session.currentTime,
                    };
                    setTrade(plan);
                  }}
                  onPatch={(patch) => session.trade && setTrade({ ...session.trade, ...patch })}
                  onRemove={() => setTrade(null)}
                  onRecord={() => setSheet("recordResult")}
                  onNoTrade={() => setSheet("noTrade")}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {sheets}
    </AppShell>
  );
}
