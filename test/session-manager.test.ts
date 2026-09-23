import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mergeConfig } from "../src/config.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { quietLogger, sleep } from "./helpers.js";

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  return new SessionManager(mergeConfig({ sessionPersistPath: join(dir, "s.json") }), quietLogger);
}

test("tasks in one channel run one at a time, in arrival order", async () => {
  const sm = makeManager();
  const order: string[] = [];
  const task = (name: string, ms: number) => async () => {
    order.push(`start ${name}`);
    await sleep(ms);
    order.push(`end ${name}`);
  };

  const a = sm.runExclusive("c", task("a", 30));
  const b = sm.runExclusive("c", task("b", 5));
  const c = sm.runExclusive("c", task("c", 5));
  await sleep(5);
  const session = sm.getActiveSession("c")!;
  assert.equal(session.isProcessing, true);
  assert.equal(session.queued, 2);

  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(session.isProcessing, false);
  assert.equal(session.queued, 0);
});

test("a failing task doesn't block the queue", async () => {
  const sm = makeManager();
  const failed = sm.runExclusive("c", async () => { throw new Error("boom"); });
  const next = sm.runExclusive("c", async () => "ran");
  await assert.rejects(failed);
  assert.equal(await next, "ran");
});

test("different channels run concurrently", async () => {
  const sm = makeManager();
  let concurrent = 0;
  let peak = 0;
  const task = async () => {
    peak = Math.max(peak, ++concurrent);
    await sleep(20);
    concurrent--;
  };
  await Promise.all([sm.runExclusive("c1", task), sm.runExclusive("c2", task)]);
  assert.equal(peak, 2);
});

test("a message queued behind an aborted reply sees the rewind, not the old state", async () => {
  const sm = makeManager();
  const store = (sm as any).sessionStore;
  store.setSessionId("c", "s1");
  store.recordTurn("c", "u1");
  store.recordTurn("c", "u2");
  const session = sm.getOrCreateSession("c");
  session.sdkSessionId = "s1";

  // A reply is running; another message is queued behind it
  const running = sm.runExclusive("c", async () => {
    const ac = new AbortController();
    session.abortController = ac;
    await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve()));
  });
  let seenResumeAt: string | undefined = "not run";
  const queued = sm.runExclusive("c", async () => {
    seenResumeAt = store.getResumeAt("c");
  });
  await sleep(5);

  const result = await sm.rewindSession("c", 1);
  await Promise.all([running, queued]);
  assert.deepEqual(result, { success: true, removed: 1, remaining: 1 });
  assert.equal(seenResumeAt, "u1");
});

test("clearSession aborts the running task and waits for it to finish", async () => {
  const sm = makeManager();
  let finished = false;
  const running = sm.runExclusive("c", async () => {
    const session = sm.getActiveSession("c")!;
    const ac = new AbortController();
    session.abortController = ac;
    await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve()));
    await sleep(10);
    finished = true;
  });
  await sleep(5);
  await sm.clearSession("c");
  assert.equal(finished, true);
  await running;
});
