import { Logger } from "../src/logging/logger.js";

export const quietLogger = new Logger("error", false, false);

export interface FakeMessage {
  id: string;
  content: string;
  edits: number;
  edit(content: unknown): Promise<FakeMessage>;
  reply(content: unknown): Promise<FakeMessage>;
  react(emoji: string): Promise<void>;
}

/** Minimal stand-in for a Discord channel that records every message it sends. */
export function fakeChannel() {
  const sent: FakeMessage[] = [];
  let nextId = 1;

  const makeMessage = (content: unknown): FakeMessage => {
    const msg: FakeMessage = {
      id: String(nextId++),
      content: typeof content === "string" ? content : JSON.stringify(content),
      edits: 0,
      async edit(c) {
        msg.content = typeof c === "string" ? c : JSON.stringify(c);
        msg.edits++;
        return msg;
      },
      async reply(c) {
        const reply = makeMessage(c);
        sent.push(reply);
        return reply;
      },
      async react() {},
    };
    return msg;
  };

  const channel = {
    id: "chan-1",
    messages: { fetch: async () => { throw new Error("not found"); } },
    async send(c: unknown) {
      const msg = makeMessage(c);
      sent.push(msg);
      return msg;
    },
  };

  const userMessage = makeMessage("hello bot");
  return { channel, sent, userMessage };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
