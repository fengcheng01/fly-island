export type AgentProvider = "codex" | "claudeCode" | "zcode" | "dsh";
export type AgentTaskPhase = "idle" | "running" | "completed" | "failed" | "stale";

export const AGENT_PROVIDERS: AgentProvider[] = ["codex", "claudeCode", "zcode", "dsh"];

export const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: "Codex",
  claudeCode: "Claude Code",
  zcode: "ZCode",
  dsh: "DSH",
};

export type AgentTaskStatus = {
  phase: AgentTaskPhase;
  taskId?: string;
  updatedAt: number;
  message?: string;
};

export type AgentStatusSnapshot = Record<AgentProvider, AgentTaskStatus> & {
  updatedAt: number;
  statusPath: string;
};

// Timing state kept in the frontend. The Rust side never persists a start
// timestamp: while a task runs, `status.updatedAt` carries the marker file
// modification time, which is the moment the prompt was submitted. The hook
// deletes that marker when the turn ends, so the frozen duration has to be
// computed from the start time the frontend remembered.
export type AgentTiming = {
  startedAt: number | null;
  durationMs: number | null;
  finishedAt: number | null;
};

export type AgentTimingMap = Record<AgentProvider, AgentTiming>;

export function createAgentTimingMap(): AgentTimingMap {
  return {
    codex: { startedAt: null, durationMs: null, finishedAt: null },
    claudeCode: { startedAt: null, durationMs: null, finishedAt: null },
    zcode: { startedAt: null, durationMs: null, finishedAt: null },
    dsh: { startedAt: null, durationMs: null, finishedAt: null },
  };
}

export type AgentRunFinished = {
  provider: AgentProvider;
  phase: "completed" | "failed";
  durationMs: number | null;
  updatedAt: number;
};

export type AgentTimingAdvance = {
  timings: AgentTimingMap;
  finished: AgentRunFinished[];
};

// The hook keeps the status light red for at least this long after a fast task
// stops, by reporting the finished turn as running again.
export const AGENT_HOLD_WINDOW_MS = 1000;

// How long a finished badge stays on the collapsed island before it steps
// aside and lets the pending todo count come back.
export const AGENT_FINISHED_BADGE_VISIBLE_MS = 5 * 60 * 1000;

export function isFinishedBadgeVisible(finishedAt: number, now: number): boolean {
  return (
    finishedAt > 0 && now - finishedAt < AGENT_FINISHED_BADGE_VISIBLE_MS
  );
}

// The hook writes a short-lived "running" hold right after a fast task stops so
// the status light stays visible for a moment. It reuses the finished turn's
// message and reports the current time, so it must not be mistaken for a new
// run. A real new run carries the new prompt and starts later.
export function isAgentHoldEcho(
  previous: AgentTaskStatus | undefined,
  next: AgentTaskStatus,
): boolean {
  if (next.phase !== "running") {
    return false;
  }

  if (previous?.phase !== "completed" && previous?.phase !== "failed") {
    return false;
  }

  // The hold copies the finished turn's message, while a real new run carries
  // the new prompt, so the messages decide whenever either side has one.
  if (previous.message || next.message) {
    return previous.message === next.message;
  }

  // Neither side carries text: only the hook's short hold window separates a
  // repeated report from a real new run.
  return next.updatedAt - previous.updatedAt <= AGENT_HOLD_WINDOW_MS;
}

// A completion is new when the phase just became finished, or when a finished
// status advanced past the last handled one. The second case covers a
// completion that lands while the status already reports another finished run,
// which would otherwise be dropped as an unchanged phase. lastFinishedAt is the
// watermark of the completion already handled for this provider.
export function isNewAgentCompletion(
  previous: AgentTaskStatus | undefined,
  next: AgentTaskStatus,
  lastFinishedAt: number | null,
): boolean {
  if (next.phase !== "completed" && next.phase !== "failed") {
    return false;
  }

  if (lastFinishedAt !== null && next.updatedAt <= lastFinishedAt) {
    return false;
  }

  return (
    previous?.phase !== next.phase || (previous?.updatedAt ?? 0) < next.updatedAt
  );
}

// A run is new only when the phase turns running; the marker file time moves
// while the run is in progress and must not restart the live prompt card.
export function isNewAgentRun(
  previous: AgentTaskStatus | undefined,
  next: AgentTaskStatus,
): boolean {
  return (
    next.phase === "running" &&
    previous?.phase !== "running" &&
    !isAgentHoldEcho(previous, next)
  );
}

// Advances the timing state for every provider. Returns the same map object
// when nothing changed so callers can skip a state update.
export function advanceAgentTiming(
  timings: AgentTimingMap,
  previous: AgentStatusSnapshot | null,
  next: AgentStatusSnapshot,
): AgentTimingAdvance {
  let changed = false;
  const nextTimings: AgentTimingMap = {
    codex: timings.codex,
    claudeCode: timings.claudeCode,
    zcode: timings.zcode,
    dsh: timings.dsh,
  };
  const finished: AgentRunFinished[] = [];

  for (const provider of AGENT_PROVIDERS) {
    const status = next[provider];
    const current = timings[provider];

    if (status.phase === "running") {
      // The hold marker the hook writes around a fast task reports the finished
      // turn again; treating it as a new run would clear the frozen duration.
      if (isAgentHoldEcho(previous?.[provider], status)) {
        continue;
      }

      // The snapshot carries the marker file time while a task runs, but the
      // persisted status can report an older value once that marker is gone.
      // The start time of a run is therefore taken once and never replaced.
      const startedAt = status.updatedAt > 0 ? status.updatedAt : null;
      if (current.startedAt === null && startedAt !== null) {
        nextTimings[provider] = { startedAt, durationMs: null, finishedAt: null };
        changed = true;
      } else if (current.startedAt === null && current.durationMs !== null) {
        // A new run started before its start time was known.
        nextTimings[provider] = {
          startedAt: null,
          durationMs: null,
          finishedAt: null,
        };
        changed = true;
      }
      continue;
    }

    if (status.phase !== "completed" && status.phase !== "failed") {
      continue;
    }

    // The same finished turn can be reported more than once around a hold
    // marker; only a write newer than the handled one is a new completion.
    if (current.finishedAt !== null && status.updatedAt <= current.finishedAt) {
      continue;
    }

    // A completion that was already in the snapshot when the app started has
    // no known start time, so no duration is invented for it.
    if (previous?.[provider]?.phase !== "running") {
      continue;
    }

    const startedAt = current.startedAt;
    const durationMs =
      startedAt !== null && startedAt > 0
        ? Math.max(0, status.updatedAt - startedAt)
        : null;

    if (
      current.durationMs !== durationMs ||
      current.startedAt !== null ||
      current.finishedAt !== status.updatedAt
    ) {
      nextTimings[provider] = {
        startedAt: null,
        durationMs,
        finishedAt: status.updatedAt,
      };
      changed = true;
    }

    finished.push({
      provider,
      phase: status.phase,
      durationMs,
      updatedAt: status.updatedAt,
    });
  }

  return { timings: changed ? nextTimings : timings, finished };
}

// Formats a duration as mm:ss, or h:mm:ss once it passes an hour.
export function formatAgentDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
