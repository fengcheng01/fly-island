import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAgentTiming,
  createAgentTimingMap,
  formatAgentDuration,
  isAgentHoldEcho,
  isNewAgentCompletion,
  isNewAgentRun,
} from "../src/agentStatus.ts";

const IDLE = { phase: "idle", updatedAt: 0 };

function snapshot(overrides = {}) {
  return {
    codex: IDLE,
    claudeCode: IDLE,
    zcode: IDLE,
    dsh: IDLE,
    updatedAt: 0,
    statusPath: "",
    ...overrides,
  };
}

test("a running phase records the prompt submission time as the start", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const { timings, finished } = advanceAgentTiming(
    createAgentTimingMap(),
    null,
    running,
  );

  assert.equal(timings.zcode.startedAt, 1000);
  assert.equal(timings.zcode.durationMs, null);
  assert.equal(timings.zcode.finishedAt, null);
  assert.deepEqual(finished, []);
});

test("the start time of a run survives an older snapshot value", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 90000 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);
  assert.equal(started.timings.zcode.startedAt, 90000);

  // The marker file is gone while the persisted status still reports the run,
  // so the snapshot falls back to an older timestamp.
  const older = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const result = advanceAgentTiming(started.timings, running, older);

  assert.equal(result.timings.zcode.startedAt, 90000);
});

test("a finished run freezes the duration from the remembered start", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);

  const done = snapshot({ zcode: { phase: "completed", updatedAt: 73000 } });
  const result = advanceAgentTiming(started.timings, running, done);

  assert.equal(result.timings.zcode.durationMs, 72000);
  assert.equal(result.timings.zcode.startedAt, null);
  assert.equal(result.timings.zcode.finishedAt, 73000);
  assert.equal(result.finished.length, 1);
  assert.equal(result.finished[0].provider, "zcode");
  assert.equal(result.finished[0].phase, "completed");
  assert.equal(result.finished[0].durationMs, 72000);
});

test("a completion that was already finished when the app started has no duration", () => {
  const done = snapshot({ zcode: { phase: "completed", updatedAt: 73000 } });
  const result = advanceAgentTiming(
    createAgentTimingMap(),
    snapshot(),
    done,
  );

  assert.equal(result.timings.zcode.durationMs, null);
  assert.deepEqual(result.finished, []);
});

test("a failed run reports the duration as well", () => {
  const running = snapshot({ dsh: { phase: "running", updatedAt: 500 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);

  const failed = snapshot({ dsh: { phase: "failed", updatedAt: 4500 } });
  const result = advanceAgentTiming(started.timings, running, failed);

  assert.equal(result.timings.dsh.durationMs, 4000);
  assert.equal(result.finished[0].phase, "failed");
});

test("starting a new run clears the frozen duration", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);
  const done = snapshot({ zcode: { phase: "completed", updatedAt: 73000 } });
  const finished = advanceAgentTiming(started.timings, running, done);

  const restarted = snapshot({ zcode: { phase: "running", updatedAt: 90000 } });
  const result = advanceAgentTiming(finished.timings, done, restarted);

  assert.equal(result.timings.zcode.durationMs, null);
  assert.equal(result.timings.zcode.startedAt, 90000);
  assert.deepEqual(result.finished, []);
});

test("a stalled run keeps its start time so the timer keeps counting", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);

  const stale = snapshot({ zcode: { phase: "stale", updatedAt: 1000 } });
  const result = advanceAgentTiming(started.timings, running, stale);

  assert.equal(result.timings.zcode.startedAt, 1000);
  assert.deepEqual(result.finished, []);
});

test("the timing map is reused when no provider changed", () => {
  const timings = createAgentTimingMap();
  const idle = snapshot();
  const result = advanceAgentTiming(timings, idle, idle);

  assert.equal(result.timings, timings);
});

test("a completion is new when the phase becomes finished or a finished status advances", () => {
  const running = { phase: "running", updatedAt: 1000 };
  const done = { phase: "completed", updatedAt: 2000 };
  const idle = { phase: "idle", updatedAt: 0 };

  assert.equal(isNewAgentCompletion(running, done, null), true);
  assert.equal(isNewAgentCompletion(idle, done, null), true);
  assert.equal(isNewAgentCompletion(undefined, done, null), true);
  assert.equal(isNewAgentCompletion(done, done, null), false);
  assert.equal(isNewAgentCompletion({ phase: "completed", updatedAt: 3000 }, done, null), false);
  // A second completion lands while the status already reports a finished run.
  assert.equal(isNewAgentCompletion(done, { phase: "completed", updatedAt: 3500 }, 2000), true);
  // The same finished turn reported again after a hold marker is already handled.
  assert.equal(isNewAgentCompletion(running, done, 2000), false);
  assert.equal(isNewAgentCompletion(running, { phase: "failed", updatedAt: 2500 }, null), true);
  assert.equal(isNewAgentCompletion(done, running, null), false);
});

test("the hold marker around a fast task is not mistaken for a new run", () => {
  const done = { phase: "completed", updatedAt: 2000, message: "finished text" };
  const echo = { phase: "running", updatedAt: 2500, message: "finished text" };
  const nextRun = { phase: "running", updatedAt: 2600, message: "next prompt" };

  assert.equal(isAgentHoldEcho(done, echo), true);
  assert.equal(isNewAgentRun(done, echo), false);
  assert.equal(isAgentHoldEcho(done, nextRun), false);
  assert.equal(isNewAgentRun(done, nextRun), true);
  // A new prompt without captured text still differs from the finished turn.
  assert.equal(isAgentHoldEcho(done, { phase: "running", updatedAt: 2700 }), false);
  // The marker file time moves while the run is in progress.
  assert.equal(isNewAgentRun({ phase: "running", updatedAt: 1000 }, nextRun), false);
  assert.equal(isNewAgentRun(undefined, nextRun), true);
  // Without any captured text only the hold window decides.
  assert.equal(
    isAgentHoldEcho({ phase: "completed", updatedAt: 1000 }, { phase: "running", updatedAt: 1400 }),
    true,
  );
  assert.equal(
    isAgentHoldEcho({ phase: "completed", updatedAt: 1000 }, { phase: "running", updatedAt: 60000 }),
    false,
  );
});

test("a hold echo keeps the frozen duration and reports no second completion", () => {
  const running = snapshot({ zcode: { phase: "running", updatedAt: 1000 } });
  const started = advanceAgentTiming(createAgentTimingMap(), null, running);

  const done = snapshot({ zcode: { phase: "completed", updatedAt: 1500, message: "quick" } });
  const finished = advanceAgentTiming(started.timings, running, done);
  assert.equal(finished.timings.zcode.durationMs, 500);

  const echo = snapshot({ zcode: { phase: "running", updatedAt: 1600, message: "quick" } });
  const afterEcho = advanceAgentTiming(finished.timings, done, echo);
  assert.equal(afterEcho.timings.zcode.durationMs, 500);
  assert.equal(afterEcho.timings.zcode.startedAt, null);

  const again = snapshot({ zcode: { phase: "completed", updatedAt: 1500, message: "quick" } });
  const afterExpiry = advanceAgentTiming(afterEcho.timings, echo, again);
  assert.equal(afterExpiry.timings.zcode.durationMs, 500);
  assert.deepEqual(afterExpiry.finished, []);
});

test("durations are formatted as mm:ss and grow to h:mm:ss", () => {
  assert.equal(formatAgentDuration(0), "00:00");
  assert.equal(formatAgentDuration(999), "00:00");
  assert.equal(formatAgentDuration(1000), "00:01");
  assert.equal(formatAgentDuration(42000), "00:42");
  assert.equal(formatAgentDuration(73000), "01:13");
  assert.equal(formatAgentDuration(3600000), "1:00:00");
  assert.equal(formatAgentDuration(3723000), "1:02:03");
  assert.equal(formatAgentDuration(-5000), "00:00");
});
