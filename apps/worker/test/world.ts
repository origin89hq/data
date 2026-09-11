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
 * memory, a record of every message sent (with its delay), every prefix listed and every model
 * call made, a model that answers whatever `answer` returns for the nth call and its request (or
 * throws, when that is an Error), and a page reader's pace that lets every page through until
 * `pace.allow` says otherwise.
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
  // When each object was written: the fixtures a second apart in the order given, and every put
  // after them. A reader that orders runs by when they wrote sees the order a test wrote them in.
  const EPOCH = Date.UTC(2026, 8, 1);
  const uploads = new Map<string, Date>(
    [...store.keys()].map((key, i) => [key, new Date(EPOCH + i * 1000)]),
  );
  const etag = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
  const body = (bytes: Uint8Array) => ({
    size: bytes.length,
    get body() {
      return new Blob([bytes]).stream();
    },
    etag: etag(bytes),
    httpEtag: `"${etag(bytes)}"`,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer,
  });
  // The digest an object was written with. R2 keeps one only when the writer declared it.
  const sha256s = new Map<string, string>();
  const sent: Work[] = [];
  const delays: (number | undefined)[] = [];
  const listed: string[] = [];
  const headed: string[] = [];
  const asked: { model: string; input: TestAiInput }[] = [];
  const pace = { allow: () => true, asked: 0 };
  // The maker workflow's instances, by id, for a supervisor that asks how a silent run is doing.
  const instances = new Map<
    string,
    { status: string; error?: { name: string; message: string } }
  >();
  const env = {
    MANUFACTURER_CRAWL: {
      get: async (id: string) => {
        const status = instances.get(id);
        if (!status) throw new Error(`instance.not_found: ${id}`);
        return { status: async () => status };
      },
    },
    ARCHIVE: {
      head: async (key: string) => {
        headed.push(key);
        const bytes = store.get(key);
        const sha256 = sha256s.get(key);
        return bytes === undefined
          ? null
          : {
              key,
              size: bytes.length,
              uploaded: uploads.get(key) ?? new Date(EPOCH),
              checksums: { toJSON: () => (sha256 ? { sha256 } : {}) },
            };
      },
      get: async (key: string) => {
        const bytes = store.get(key);
        return bytes === undefined ? null : body(bytes);
      },
      put: async (
        key: string,
        value: string | Uint8Array | ReadableStream<Uint8Array>,
        options?: { sha256?: string; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
      ) => {
        const bytes =
          value instanceof ReadableStream
            ? new Uint8Array(await new Response(value).arrayBuffer())
            : encode(value);
        // What R2 does with a condition that fails: store nothing and answer null. "*" stands for
        // any object at all. Checked against `wrangler dev`.
        const held = store.get(key);
        const { etagMatches, etagDoesNotMatch } = options?.onlyIf ?? {};
        if (etagMatches !== undefined && (held === undefined || etag(held) !== etagMatches))
          return null;
        if (
          etagDoesNotMatch !== undefined &&
          held !== undefined &&
          (etagDoesNotMatch === "*" || etag(held) === etagDoesNotMatch)
        )
          return null;
        const digest = createHash("sha256").update(bytes).digest("hex");
        // What R2 does with a declared digest: refuse the write, keep the old object, and end the
        // message with its code. Checked against `wrangler dev`.
        if (options?.sha256 !== undefined && options.sha256 !== digest)
          throw new Error(
            `put: The SHA-256 checksum you specified did not match what we received.\nYou provided a SHA-256 checksum with value: ${options.sha256}\nActual SHA-256 was: ${digest} (10037)`,
          );
        store.set(key, bytes);
        uploads.set(key, new Date(EPOCH + uploads.size * 1000));
        if (options?.sha256 === undefined) sha256s.delete(key);
        else sha256s.set(key, digest);
        return { key, size: bytes.length, etag: etag(bytes) };
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
        delimiter,
      }: {
        prefix?: string;
        limit?: number;
        cursor?: string;
        delimiter?: string;
      }) => {
        listed.push(prefix);
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        // What R2 does with a delimiter: a key with one past the prefix is folded into the prefix
        // up to it, once, and a page counts objects and folded prefixes alike.
        const entries: ({ key: string } | { folded: string })[] = [];
        for (const key of keys) {
          const at = delimiter === undefined ? -1 : key.indexOf(delimiter, prefix.length);
          if (at < 0) entries.push({ key });
          else {
            const folded = key.slice(0, at + (delimiter?.length ?? 0));
            const last = entries.at(-1);
            if (!(last && "folded" in last && last.folded === folded)) entries.push({ folded });
          }
        }
        const start = cursor ? Number(cursor) : 0;
        const page = entries.slice(start, start + limit);
        return {
          objects: page.flatMap((e) => ("key" in e ? [{ key: e.key }] : [])),
          truncated: start + limit < entries.length,
          cursor: String(start + limit),
          delimitedPrefixes: page.flatMap((e) => ("folded" in e ? [e.folded] : [])),
        };
      },
    },
    WORK: {
      send: async (message: Work, options?: { delaySeconds?: number }) => {
        sent.push(message);
        delays.push(options?.delaySeconds);
      },
      sendBatch: async (batch: { body: Work; delaySeconds?: number }[]) => {
        sent.push(...batch.map((m) => m.body));
        delays.push(...batch.map((m) => m.delaySeconds));
      },
    },
    PAGE_READER_PACE: {
      limit: async () => {
        pace.asked += 1;
        return { success: pace.allow() };
      },
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
  return {
    env,
    store,
    sent,
    delays,
    listed,
    headed,
    asked,
    pace,
    instances,
    read,
    readObject,
    text,
  };
}

/**
 * A world's archive made to answer each call a turn of the event loop later, as R2 answers over
 * the network, so calls made at once are outstanding together. It records the key or prefix of
 * every call, and what was outstanding when each went out. `refuse` names the calls that fail.
 */
export function watched(archive: R2Bucket, refuse: (key: string) => boolean = () => false) {
  const asked: string[] = [];
  const outstanding: string[] = [];
  const moments: string[][] = [];
  const later =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>, keyOf: (...args: A) => string) =>
    async (...args: A): Promise<R> => {
      const key = keyOf(...args);
      asked.push(key);
      outstanding.push(key);
      moments.push([...outstanding]);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (refuse(key)) throw new Error(`R2 refused ${key}`);
        return await call(...args);
      } finally {
        outstanding.splice(outstanding.indexOf(key), 1);
      }
    };
  const get = archive.get.bind(archive);
  const head = archive.head.bind(archive);
  const list = archive.list.bind(archive);
  Object.assign(archive, {
    get: later(get, (key: string) => key),
    head: later(head, (key: string) => key),
    list: later(list, (options?: { prefix?: string }) => options?.prefix ?? ""),
  });
  /** The most groups with a call outstanding at one moment. A key `group` places in none is left out. */
  const peak = (group: (key: string) => string | undefined): number =>
    Math.max(
      0,
      ...moments.map((keys) => new Set(keys.map(group).filter((g) => g !== undefined)).size),
    );
  return { asked, peak };
}
