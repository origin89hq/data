import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
 * memory, a record of every message sent, every prefix listed and every model call made, and a
 * model that answers whatever `answer` returns for the nth call and its request (or throws, when
 * that is an Error).
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
    get body() {
      return new Blob([bytes]).stream();
    },
    httpEtag: `"${createHash("md5").update(bytes).digest("hex")}"`,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  });
  // The digest an object was written with. R2 keeps one only when the writer declared it.
  const sha256s = new Map<string, string>();
  const sent: Work[] = [];
  const listed: string[] = [];
  const asked: { model: string; input: TestAiInput }[] = [];
  const env = {
    ARCHIVE: {
      head: async (key: string) => {
        const bytes = store.get(key);
        const sha256 = sha256s.get(key);
        return bytes === undefined
          ? null
          : { key, size: bytes.length, checksums: { toJSON: () => (sha256 ? { sha256 } : {}) } };
      },
      get: async (key: string) => {
        const bytes = store.get(key);
        return bytes === undefined ? null : body(bytes);
      },
      put: async (
        key: string,
        value: string | Uint8Array | ReadableStream<Uint8Array>,
        options?: { sha256?: string },
      ) => {
        const bytes =
          value instanceof ReadableStream
            ? new Uint8Array(await new Response(value).arrayBuffer())
            : encode(value);
        const digest = createHash("sha256").update(bytes).digest("hex");
        // What R2 does with a declared digest: refuse the write, keep the old object, and end the
        // message with its code. Checked against `wrangler dev`.
        if (options?.sha256 !== undefined && options.sha256 !== digest)
          throw new Error(
            `put: The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: ${options.sha256}\nActual SHA-256 was: ${digest} (10037)`,
          );
        store.set(key, bytes);
        if (options?.sha256 === undefined) sha256s.delete(key);
        else sha256s.set(key, digest);
        return { key, size: bytes.length };
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          store.delete(key);
          sha256s.delete(key);
        }
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
        listed.push(prefix);
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
  return { env, store, sent, listed, asked, read, readObject, text };
}
