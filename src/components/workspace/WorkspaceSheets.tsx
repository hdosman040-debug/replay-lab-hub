import { memo } from "react";

import {
  JumpToSheet,
  NewSessionSheet,
  NoTradeSheet,
  RecordResultSheet,
  SessionsSheet,
} from "./sheets";
import type { JournalRecord, ReplaySession } from "@/lib/backtest/types";
import type { Timeframe } from "@/lib/market/types";
import type { SessionWindows } from "@/lib/time/ny";
import type { UIState } from "@/lib/store/uiStore";

interface Props {
  sheet: UIState["sheet"];
  session: ReplaySession | undefined;
  sessionsList: ReplaySession[];
  activeId: string | null;
  tz: string;
  sessionWindows: SessionWindows;
  defaultTimeframe: Timeframe;
  defaultSpeed: number;
  onClose: () => void;
  onCreateSession: (v: { name?: string; timeframe: Timeframe; startTime: number; speed: number }) => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewSession: () => void;
  onJump: (t: number) => void;
  onResetToStart: () => void;
  onSaveRecord: (record: JournalRecord, keepTrade: boolean) => void;
}

/**
 * All workspace sheets in one stable component. Keeping this OUT of the
 * workspace render body matters: a component declared inside another
 * component is a new type on every render, which unmounts and remounts the
 * whole subtree — losing whatever the trader was typing on every replay tick.
 */
export const WorkspaceSheets = memo(function WorkspaceSheets({
  sheet,
  session,
  sessionsList,
  activeId,
  tz,
  sessionWindows,
  defaultTimeframe,
  defaultSpeed,
  onClose,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onNewSession,
  onJump,
  onResetToStart,
  onSaveRecord,
}: Props) {
  return (
    <>
      <NewSessionSheet
        open={sheet === "newSession"}
        tz={tz}
        defaultTimeframe={defaultTimeframe}
        defaultSpeed={defaultSpeed}
        onClose={onClose}
        onCreate={onCreateSession}
      />
      <SessionsSheet
        open={sheet === "sessions"}
        sessions={sessionsList}
        activeId={activeId}
        tz={tz}
        onClose={onClose}
        onSelect={onSelectSession}
        onDelete={onDeleteSession}
        onNew={onNewSession}
      />
      {session && (
        <>
          <JumpToSheet
            open={sheet === "jumpTo"}
            current={session.currentTime}
            tz={tz}
            onClose={onClose}
            onJump={onJump}
            onReset={onResetToStart}
          />
          <RecordResultSheet
            open={sheet === "recordResult"}
            session={session}
            sessions={sessionWindows}
            tz={tz}
            onClose={onClose}
            onSave={(record) => onSaveRecord(record, true)}
          />
          <NoTradeSheet
            open={sheet === "noTrade"}
            session={session}
            sessions={sessionWindows}
            tz={tz}
            onClose={onClose}
            onSave={(record) => onSaveRecord(record, false)}
          />
        </>
      )}
    </>
  );
});
