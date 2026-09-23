import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionPersistence } from "../src/persistence/session-store.js";
import { projectDirName } from "../src/agent/session-manager.js";
import { quietLogger } from "./helpers.js";

const tmpStore = () => join(mkdtempSync(join(tmpdir(), "store-")), "sessions.json");

test("turns accumulate for a session and rewind sets the resume point", () => {
  const store = new SessionPersistence(tmpStore(), quietLogger);
  store.setSessionId("c", "s1");
  store.recordTurn("c", "u1");
  store.recordTurn("c", "u2");
  store.recordTurn("c", "u3");
  assert.equal(store.getTurnCount("c"), 3);

  assert.deepEqual(store.rewind("c", 1), { removed: 1, remaining: 2 });
  assert.equal(store.getResumeAt("c"), "u2");

  // Resuming the same session keeps the rewind point until the next turn is recorded
  store.setSessionId("c", "s1");
  assert.equal(store.getResumeAt("c"), "u2");
  store.recordTurn("c", "u4");
  assert.equal(store.getResumeAt("c"), undefined);
  assert.equal(store.getTurnCount("c"), 3);
});

test("rewinding past the start reports zero remaining", () => {
  const store = new SessionPersistence(tmpStore(), quietLogger);
  store.setSessionId("c", "s1");
  store.recordTurn("c", "u1");
  assert.deepEqual(store.rewind("c", 5), { removed: 1, remaining: 0 });
  assert.deepEqual(store.rewind("c", 1), { removed: 0, remaining: 0 });
});

test("a different session ID starts a fresh turn history", () => {
  const store = new SessionPersistence(tmpStore(), quietLogger);
  store.setSessionId("c", "s1");
  store.recordTurn("c", "u1");
  store.setSessionId("c", "s2");
  assert.equal(store.getTurnCount("c"), 0);
});

test("save is atomic and load drops the legacy messageHistory field", async () => {
  const path = tmpStore();
  writeFileSync(path, JSON.stringify({
    channels: { c: { sdkSessionId: "s1", lastActivity: "x", messageHistory: ["s1", "s1"] } },
  }));
  const store = new SessionPersistence(path, quietLogger);
  await store.load();
  assert.equal(store.getSessionId("c"), "s1");
  assert.equal(store.getTurnCount("c"), 0);
  await store.save();
  assert.ok(!existsSync(`${path}.tmp`));
  assert.ok(!readFileSync(path, "utf-8").includes("messageHistory"));
});

test("projectDirName matches Claude Code's transcript directory naming", () => {
  assert.equal(projectDirName("/Users/tyler/claude-discord-bot"), "-Users-tyler-claude-discord-bot");
  assert.equal(projectDirName("/home/me/my_bot.v2"), "-home-me-my-bot-v2");
});
