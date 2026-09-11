import assert from "node:assert/strict";
import { test } from "node:test";
import type { Guess } from "@origin89/equipment-schema/guess";
import type { Sighting } from "@origin89/equipment-schema/sighting";
import { CLASSIFIER_ID, classifierKey } from "../src/classify.ts";
import { classifyPart } from "../src/guesses.ts";
import { inputKey, partKey } from "../src/work.ts";
import { type TestAiInput, world } from "./world.ts";

const listing = (title: string): Sighting => ({
  seller: "shop",
  productId: title,
  handle: title.toLowerCase().replaceAll(" ", "-"),
  url: `https://shop.test/products/${title.toLowerCase().replaceAll(" ", "-")}`,
  title,
  currency: "CAD",
  checkedAt: "2026-09-09",
  extractor: "shopify-feed",
});

const part = (sightings: Sighting[]) => ({
  kind: "classify" as const,
  seller: "shop",
  date: "2026-09-09",
  run: "2026-09-09-shop",
  part: 1,
  sightings,
});
const partAt = partKey.classify(classifierKey(), "shop", "2026-09-09-shop", 1);
const answerAt = async (title: string) =>
  partKey.classified(classifierKey(), await inputKey(listing(title)));

/** A classifier that calls every listing it is shown a battery, and says which titles it saw. */
function classifier(seen: string[][]) {
  return (_call: number, input: TestAiInput) => {
    const titles = String(input.messages[1].content)
      .split("\n")
      .map((line) => /title="([^"]*)"/.exec(line)?.[1] ?? "");
    seen.push(titles);
    return { response: JSON.stringify({ items: titles.map(() => ({ kind: "battery" })) }) };
  };
}

const guessesIn = (text: string | undefined): Guess[] =>
  (text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("a part whose listings were all answered before asks no model, and still writes each its guess", async () => {
  const seen: string[][] = [];
  const { env, text } = world(
    {
      [await answerAt("EPEver XTRA4210N")]: JSON.stringify({
        kind: "charge-controller",
        model: "XTRA4210N",
      }),
      [await answerAt("Renogy 100Ah")]: JSON.stringify({ kind: "battery" }),
    },
    classifier(seen),
  );
  await classifyPart(env, part([listing("EPEver XTRA4210N"), listing("Renogy 100Ah")]));
  assert.deepEqual(seen, [], "nothing asked");
  assert.deepEqual(guessesIn(text(partAt)), [
    {
      seller: "shop",
      productId: "EPEver XTRA4210N",
      kind: "charge-controller",
      model: "XTRA4210N",
      by: CLASSIFIER_ID,
    },
    { seller: "shop", productId: "Renogy 100Ah", kind: "battery", by: CLASSIFIER_ID },
  ]);
});

test("only the unanswered listings are asked, and each answer lands on its own listing", async () => {
  const seen: string[][] = [];
  const stored = JSON.stringify({ kind: "charge-controller", model: "XTRA4210N" });
  const { env, text } = world({ [await answerAt("EPEver XTRA4210N")]: stored }, classifier(seen));
  await classifyPart(
    env,
    part([listing("Cast iron skillet"), listing("EPEver XTRA4210N"), listing("Renogy 100Ah")]),
  );
  assert.deepEqual(seen, [["Cast iron skillet", "Renogy 100Ah"]]);
  assert.deepEqual(
    guessesIn(text(partAt)).map((g) => [g.productId, g.kind]),
    [
      ["Cast iron skillet", "battery"],
      ["EPEver XTRA4210N", "charge-controller"],
      ["Renogy 100Ah", "battery"],
    ],
  );
  assert.equal(text(await answerAt("Renogy 100Ah")), '{"kind":"battery"}', "a new answer is kept");
  assert.equal(text(await answerAt("EPEver XTRA4210N")), stored, "an old one is left as it was");
});

test("a listing whose rated figures changed is asked again, not given the answer to the old ones", async () => {
  const seen: string[][] = [];
  const bare = listing("Renogy 100Ah");
  const { env, text } = world(
    { [await answerAt("Renogy 100Ah")]: JSON.stringify({ kind: "charge-controller" }) },
    classifier(seen),
  );
  await classifyPart(env, part([{ ...bare, figures: "Rated capacity: 100 Ah" }]));
  assert.deepEqual(seen, [["Renogy 100Ah"]], "the figures are new evidence");
  assert.deepEqual(
    guessesIn(text(partAt)).map((g) => g.kind),
    ["battery"],
  );
});

test("a stored answer that no longer reads as a guess is asked again", async () => {
  const seen: string[][] = [];
  const { env, text } = world(
    {
      [await answerAt("Renogy 100Ah")]: JSON.stringify({ kind: "toaster" }),
      [await answerAt("EPEver XTRA4210N")]: "{ not json",
    },
    classifier(seen),
  );
  await classifyPart(env, part([listing("Renogy 100Ah"), listing("EPEver XTRA4210N")]));
  assert.deepEqual(seen, [["Renogy 100Ah", "EPEver XTRA4210N"]]);
  assert.deepEqual(
    guessesIn(text(partAt)).map((g) => g.kind),
    ["battery", "battery"],
  );
  assert.equal(text(await answerAt("Renogy 100Ah")), '{"kind":"battery"}', "and replaced");
});

test("an answer cut short is the model losing its place, so the batch is halved, not asked again whole", async () => {
  // What watts247's part 5 got every time: no items for ten, and past its tokens for five.
  const seen: string[][] = [];
  const answer = classifier(seen);
  const { env, text } = world({}, (call, input) => {
    const reply = answer(call, input) as { response: string };
    const asked = seen.at(-1)?.length ?? 0;
    if (asked === 10) return { response: JSON.stringify({ items: [] }) };
    if (asked === 5) return { response: reply.response.slice(0, -10) };
    return reply;
  });
  const titles = Array.from({ length: 10 }, (_, i) => `Jinko 385 W panel ${i + 1}`);
  await classifyPart(env, part(titles.map(listing)));
  assert.deepEqual(
    seen.map((batch) => batch.length),
    [10, 5, 5, 3, 2, 3, 2],
    "ten, then its halves, then theirs",
  );
  assert.deepEqual(
    guessesIn(text(partAt)).map((g) => g.productId),
    titles,
    "every listing has its guess, in the part's order",
  );
});

test("a call that fails is not halved, whatever it throws: the part is left for the queue to deliver again", async () => {
  for (const failure of [
    new Error("3040: capacity temporarily exceeded"),
    // A binding that could not read its provider's response, which is no answer from the model.
    new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"),
  ]) {
    const { env, asked, text } = world({}, () => failure);
    await assert.rejects(
      classifyPart(env, part([listing("Renogy 100Ah"), listing("EPEver XTRA4210N")])),
      failure,
    );
    assert.equal(asked.length, 1, failure.message);
    assert.equal(text(partAt), undefined);
  }
});
