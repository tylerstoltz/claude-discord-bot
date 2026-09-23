import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mergeConfig, isUserAllowed, isChannelAllowed } from "../src/config.js";
import { FileUploadManager } from "../src/attachments/file-upload-manager.js";
import { PermissionHook } from "../src/agent/permission-hook.js";
import { fakeChannel, quietLogger, sleep } from "./helpers.js";

test("nested config sections keep their defaults when partially overridden", () => {
  const config = mergeConfig({ attachments: { enabled: false } } as any);
  assert.equal(config.attachments.enabled, false);
  assert.ok(config.attachments.supportedImageTypes.length > 0);
  assert.deepEqual(config.fileUpload.allowedDirs, ["./playground"]);
});

test("user and channel allowlists", () => {
  const open = mergeConfig({});
  assert.ok(isUserAllowed(open, "anyone"));
  const locked = mergeConfig({ allowedUsers: ["me"], allowedChannels: ["c1"] });
  assert.ok(isUserAllowed(locked, "me"));
  assert.ok(!isUserAllowed(locked, "stranger"));
  assert.ok(isChannelAllowed(locked, "c1"));
  assert.ok(isChannelAllowed(locked, "thread-9", "c1"), "threads inherit the parent channel");
  assert.ok(!isChannelAllowed(locked, "c2"));
});

test("uploads are limited to allowed dirs and never include bot secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    mkdirSync("playground");
    writeFileSync("playground/report.md", "ok");
    writeFileSync("config.json", "{\"discordToken\":\"secret\"}");
    writeFileSync("CLAUDE.local.md", "creds");
    writeFileSync("notes.md", "outside");
    symlinkSync(join(root, "config.json"), "playground/sneaky.json");

    const manager = new FileUploadManager(mergeConfig({}).fileUpload, quietLogger);
    assert.equal((await manager.validateFile("playground/report.md")).valid, true);
    assert.equal((await manager.validateFile("notes.md")).valid, false);
    assert.equal((await manager.validateFile("config.json")).valid, false);
    assert.equal((await manager.validateFile("playground/sneaky.json")).valid, false, "symlink escape");

    const anywhere = new FileUploadManager({ ...mergeConfig({}).fileUpload, allowedDirs: [] }, quietLogger);
    assert.equal((await anywhere.validateFile("notes.md")).valid, true);
    assert.equal((await anywhere.validateFile("CLAUDE.local.md")).valid, false, "secrets blocked even with no dir limit");
  } finally {
    process.chdir(cwd);
  }
});

function setupHook(allowedUsers: string[]) {
  const config = mergeConfig({ allowedUsers, permissionTimeoutMs: 5000 });
  const { channel, sent } = fakeChannel();
  const hook = new PermissionHook(config, () => channel as any, quietLogger);
  const handler = hook.createHookHandler("chan-1");
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any;
  return { hook, handler, input, sent };
}

function click(action: "approve" | "deny", userId: string) {
  const replies: unknown[] = [];
  return {
    replies,
    interaction: {
      customId: `perm_${action}_toolu_1`,
      user: { id: userId },
      reply: async (r: unknown) => { replies.push(r); },
      deferUpdate: async () => {},
    } as any,
  };
}

test("only allowed users can approve a dangerous tool", async () => {
  const { hook, handler, input } = setupHook(["owner"]);
  const decision = handler(input, "toolu_1", { signal: new AbortController().signal });
  await sleep(5);

  const stranger = click("approve", "stranger");
  await hook.handleButtonInteraction(stranger.interaction);
  assert.equal(stranger.replies.length, 1, "stranger gets an ephemeral refusal");
  hook.handleReaction("1", "✅", "stranger");

  await hook.handleButtonInteraction(click("approve", "owner").interaction);
  const result: any = await decision;
  assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
});

test("a denial does not stop the whole turn", async () => {
  const { hook, handler, input } = setupHook(["owner"]);
  const decision = handler(input, "toolu_1", { signal: new AbortController().signal });
  await sleep(5);
  await hook.handleButtonInteraction(click("deny", "owner").interaction);
  const result: any = await decision;
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(result.continue, undefined);
});

test("aborting the query or finishing it settles a pending approval", async () => {
  const a = setupHook([]);
  const ac = new AbortController();
  const aborted = a.handler(a.input, "toolu_1", { signal: ac.signal });
  await sleep(5);
  ac.abort();
  assert.equal(((await aborted) as any).hookSpecificOutput.permissionDecision, "deny");

  const b = setupHook([]);
  const cancelled = b.handler(b.input, "toolu_1", { signal: new AbortController().signal });
  await sleep(5);
  b.hook.cancelPendingApprovals("chan-1");
  assert.equal(((await cancelled) as any).hookSpecificOutput.permissionDecision, "deny");
});
