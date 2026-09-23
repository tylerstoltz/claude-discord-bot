import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkedUpdater } from "../src/streaming/chunked-updater.js";
import { fakeChannel, quietLogger, sleep } from "./helpers.js";

function makeUpdater(intervalMs = 10, uploads?: { tracked: string[] }) {
  const { channel, sent, userMessage } = fakeChannel();
  const fileUploadManager = uploads && {
    trackFile: (p: string) => uploads.tracked.push(p),
    uploadTrackedFiles: async () => 0,
    uploadFiles: async () => 0,
  };
  const updater = new ChunkedUpdater(
    channel as any,
    userMessage as any,
    intervalMs,
    2000,
    quietLogger,
    undefined,
    fileUploadManager as any
  );
  return { updater, sent };
}

test("short reply is one message with the full text", async () => {
  const { updater, sent } = makeUpdater();
  updater.appendContent("Hello ");
  updater.appendContent("world");
  await updater.finalize();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "Hello world");
});

test("long streamed reply rolls over into new messages instead of freezing", async () => {
  const { updater, sent } = makeUpdater(5);
  for (let i = 0; i < 60; i++) {
    updater.appendContent(`Sentence number ${i} is here. `.repeat(5) + "\n\n");
    await sleep(2);
  }
  await sleep(20);
  const whileStreaming = sent.length;
  assert.ok(whileStreaming > 1, "rolled over during streaming");
  await updater.finalize();

  for (const m of sent) assert.ok(m.content.length <= 2000);
  const joined = sent.map((m) => m.content).join("\n\n");
  assert.ok(joined.includes("Sentence number 0 is here."));
  assert.ok(joined.includes("Sentence number 59 is here."));
  assert.ok(!joined.includes("(continuing)"));
});

test("a timer pending at finalize cannot overwrite the final text", async () => {
  const { updater, sent } = makeUpdater(30);
  updater.appendContent("first");
  await sleep(40); // first render
  updater.appendContent(" second"); // schedules another render
  await updater.finalize();
  const finalContent = sent[0].content;
  await sleep(80); // let any stray timer fire
  assert.equal(sent[0].content, finalContent);
  assert.equal(finalContent, "first second");
  updater.appendContent(" late");
  await sleep(40);
  assert.equal(sent[0].content, "first second", "content after finalize is ignored");
});

test("fail() appends the error without truncating it away", async () => {
  const { updater, sent } = makeUpdater();
  updater.appendContent("x ".repeat(1200));
  await updater.fail("boom");
  const last = sent[sent.length - 1].content;
  assert.ok(last.endsWith("**Error:** boom"));
});

test("Write output is only uploaded when the tool result succeeds", async () => {
  const uploads = { tracked: [] as string[] };
  const { updater } = makeUpdater(10, uploads);
  updater.onToolUse("Write", { file_path: "/tmp/ok.txt" }, "t1");
  updater.onToolUse("Write", { file_path: "/tmp/denied.txt" }, "t2");
  updater.onToolResult("t1", false);
  updater.onToolResult("t2", true);
  await updater.finalize();
  assert.deepEqual(uploads.tracked, ["/tmp/ok.txt"]);
});
