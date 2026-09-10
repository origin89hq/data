import type { Work } from "../src/work.ts";

/**
 * Enough of R2, the queue and the model for the page reader and the supervisor: an archive in
 * memory, a record of every message sent and every model call made, and a model that answers
 * whatever `answer` returns for the nth call and its request (or throws, when that is an Error).
 */
export function world(objects: Record<string, string | Uint8Array> = {}, answer: (call: number, input: any) => unknown = () => ({ choices: [{ message: { content: '{"products":[]}' } }] })) {
  const encode = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : v);
  const store = new Map<string, Uint8Array>(Object.entries(objects).map(([k, v]) => [k, encode(v)]));
  const body = (bytes: Uint8Array) => ({
    size: bytes.length,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  });
  const sent: Work[] = [];
  const asked: { model: string; input: any }[] = [];
  const env = {
    ARCHIVE: {
      head: async (key: string) => (store.has(key) ? { key, size: store.get(key)!.length } : null),
      get: async (key: string) => (store.has(key) ? body(store.get(key)!) : null),
      put: async (key: string, value: string | Uint8Array) => {
        store.set(key, encode(value));
      },
      list: async ({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string }) => {
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        return { objects: keys.slice(start, start + limit).map((key) => ({ key })), truncated: start + limit < keys.length, cursor: String(start + limit), delimitedPrefixes: [] };
      },
    },
    WORK: {
      send: async (message: Work) => void sent.push(message),
      sendBatch: async (batch: { body: Work }[]) => void sent.push(...batch.map((m) => m.body)),
    },
    AI: {
      run: async (model: string, input: unknown) => {
        asked.push({ model, input });
        const reply = answer(asked.length, input);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  } as unknown as Env;
  const text = (key: string): string | undefined => (store.has(key) ? new TextDecoder().decode(store.get(key)!) : undefined);
  const read = (key: string): any => (store.has(key) ? JSON.parse(text(key)!) : undefined);
  return { env, store, sent, asked, read, text };
}
