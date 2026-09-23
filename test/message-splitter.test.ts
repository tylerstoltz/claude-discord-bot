import { test } from "node:test";
import assert from "node:assert/strict";
import { takeChunk, openFenceLang } from "../src/streaming/message-splitter.js";

function splitAll(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    const c = takeChunk(remaining, max);
    chunks.push(c.text);
    const rest = remaining.slice(c.consumed).trimStart();
    remaining = rest ? c.carry + rest : "";
  }
  return chunks;
}

test("short text is a single chunk", () => {
  assert.deepEqual(takeChunk("hi", 2000), { text: "hi", consumed: 2, carry: "" });
});

test("every chunk fits the limit, including worst-case boundaries", () => {
  const cases = [
    "word ".repeat(1000),
    "x".repeat(5000),
    ("para ".repeat(60) + "\n\n").repeat(30),
    ("a".repeat(1999) + "\n\n").repeat(3),
    ("line\n").repeat(1500),
  ];
  for (const text of cases) {
    for (const chunk of splitAll(text, 2000)) {
      assert.ok(chunk.length <= 2000, `chunk of ${chunk.length} chars`);
    }
  }
});

test("prefers paragraph breaks", () => {
  const text = "a".repeat(1500) + "\n\n" + "b".repeat(1000);
  const [first, second] = splitAll(text, 2000);
  assert.equal(first, "a".repeat(1500));
  assert.equal(second, "b".repeat(1000));
});

test("code fences are closed and reopened across a split", () => {
  const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const text = "Here:\n```ts\n" + code + "\n```\nDone.";
  const chunks = splitAll(text, 2000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(openFenceLang(chunk), null, "every chunk has balanced fences");
    assert.ok(chunk.length <= 2000);
  }
  assert.ok(chunks[1].startsWith("```ts\n"), "continuation reopens with the language");
});

test("openFenceLang", () => {
  assert.equal(openFenceLang("no code"), null);
  assert.equal(openFenceLang("```py\nx = 1"), "py");
  assert.equal(openFenceLang("```\nx\n```"), null);
  assert.equal(openFenceLang("```\nx"), "");
});
