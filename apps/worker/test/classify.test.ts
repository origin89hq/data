import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import {
  BatchMisalignedError,
  CLASSIFIER_ID,
  contentOf,
  guessesFrom,
  promptFor,
} from "../src/classify.ts";

const s = (productId: string, title: string, extra: Partial<Sighting> = {}): Sighting => ({
  seller: "shop",
  productId,
  handle: productId,
  url: `https://shop.example/products/${productId}`,
  title,
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
  ...extra,
});
const batch = [
  s("1", "EPEver XTRA4210N 40A MPPT", { brand: "EPEver", sku: "XTRA4210N" }),
  s("2", "Cast iron skillet 12in", { brand: "Lodge" }),
];

test("answers are matched to listings by position, because a model asked to echo an id invents one", () => {
  const guesses = guessesFrom(batch, {
    items: [
      { kind: "charge-controller", model: "XTRA4210N", manufacturer: "EPEver" },
      { kind: "out-of-scope" },
    ],
  });
  assert.deepEqual(
    guesses.map((g) => g.productId),
    ["1", "2"],
  );
  assert.equal(guesses[0].model, "XTRA4210N");
  assert.equal(guesses[0].by, CLASSIFIER_ID);
  assert.equal(guesses[1].kind, "out-of-scope");
});

test("a short answer is refused whole rather than shifting every listing onto the wrong guess", () => {
  assert.throws(
    () => guessesFrom(batch, { items: [{ kind: "charge-controller" }] }),
    (e: unknown) => e instanceof BatchMisalignedError && e.received === 1 && e.expected === 2,
  );
  assert.throws(
    () =>
      guessesFrom(batch, {
        items: [{ kind: "battery" }, { kind: "battery" }, { kind: "battery" }],
      }),
    BatchMisalignedError,
  );
  assert.throws(() => guessesFrom(batch, "garbage"), BatchMisalignedError);
});

test("a kind outside the enum falls back to out-of-scope and is marked unreadable, never guessed at", () => {
  const [g] = guessesFrom([batch[0]], { items: [{ kind: "spaceship", model: "X" }] });
  assert.equal(g.kind, "out-of-scope");
  assert.equal(g.unreadable, true);
  assert.equal(g.model, "X");
});

test("empty strings from the model are absence, not a model number called empty", () => {
  const [g] = guessesFrom([batch[0]], {
    items: [{ kind: "charge-controller", model: "  ", manufacturer: "" }],
  });
  assert.equal(g.model, undefined);
  assert.equal(g.manufacturer, undefined);
  assert.equal(g.unreadable, undefined);
});

test("the prompt numbers each listing and carries only the fields with signal", () => {
  const p = promptFor(batch);
  assert.match(p, /^1\. title="EPEver XTRA4210N 40A MPPT" brand="EPEver" sku="XTRA4210N"$/m);
  assert.match(p, /^2\. title="Cast iron skillet 12in" brand="Lodge"$/m);
  assert.doesNotMatch(p, /https:/);
});

test("both Workers AI response shapes are read, and a fenced answer is unwrapped", () => {
  assert.equal(contentOf({ response: '{"a":1}' }), '{"a":1}');
  assert.equal(contentOf({ choices: [{ message: { content: '{"a":1}' } }] }), '{"a":1}');
  assert.equal(
    contentOf({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }),
    '{"a":1}',
  );
  assert.throws(() => contentOf({ choices: [] }), /no text/);
});
