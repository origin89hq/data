import assert from "node:assert/strict";

export interface TestAiInput {
  messages: {
    role: string;
    content: string | { type: string; text?: string; image_url?: { url: string } }[];
  }[];
  response_format: { json_schema: { name: string; schema: unknown } };
  chat_template_kwargs: { thinking: boolean };
}

import type { Work } from "../src/work.ts";

/**
 * Enough of R2, the queue and the model for the page reader and the supervisor: an archive in
 * memory, a record of every message sent and every model call made, and a model that answers
 * whatever `answer` returns for the nth call and its request (or throws, when that is an Error).
 */
export function world(
  objects: Record<string, string | Uint8Array> = {},
  answer: (call: number, input: TestAiInput) => unknown = () => ({
    choices: [{ message: { content: '{"products":[]}' } }],
  }),
) {
  const encode = (v: string | Uint8Array): Uint8Array =>
    typeof v === "string" ? new TextEncoder().encode(v) : v;
  const store = new Map<string, Uint8Array>(
    Object.entries(objects).map(([k, v]) => [k, encode(v)]),
  );
  const body = (bytes: Uint8Array) => ({
    size: bytes.length,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  });
  const sent: Work[] = [];
  const asked: { model: string; input: TestAiInput }[] = [];
  const env = {
    ARCHIVE: {
      head: async (key: string) => {
        const bytes = store.get(key);
        return bytes === undefined ? null : { key, size: bytes.length };
      },
      get: async (key: string) => {
        const bytes = store.get(key);
        return bytes === undefined ? null : body(bytes);
      },
      put: async (key: string, value: string | Uint8Array) => {
        store.set(key, encode(value));
      },
      list: async ({
        prefix = "",
        limit = 1000,
        cursor,
      }: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) => {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        return {
          objects: keys.slice(start, start + limit).map((key) => ({ key })),
          truncated: start + limit < keys.length,
          cursor: String(start + limit),
          delimitedPrefixes: [],
        };
      },
    },
    WORK: {
      send: async (message: Work) => void sent.push(message),
      sendBatch: async (batch: { body: Work }[]) => void sent.push(...batch.map((m) => m.body)),
    },
    AI: {
      run: async (model: string, input: TestAiInput) => {
        asked.push({ model, input });
        const reply = answer(asked.length, input);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  } as unknown as Env;
  const text = (key: string): string | undefined => {
    const bytes = store.get(key);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };
  const read = (key: string): unknown => {
    const value = text(key);
    return value === undefined ? undefined : JSON.parse(value);
  };
  const readObject = <T extends object>(key: string): T => {
    const value = read(key);
    assert.ok(value !== null && typeof value === "object", `Missing object: ${key}`);
    return value as T;
  };
  return { env, store, sent, asked, read, readObject, text };
}
