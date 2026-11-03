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
