import { test } from "node:test";
import assert from "node:assert/strict";
import { guessesFrom, promptFor, CLASSIFIER_ID } from "../src/classify.ts";
import type { Sighting } from "../../schema/sighting.ts";

const s = (productId: string, title: string, extra: Partial<Sighting> = {}): Sighting => ({
  seller: "shop", productId, handle: productId, url: `https://shop.example/products/${productId}`, title, currency: "CAD", checkedAt: "2026-09-09", extractor: "shopify-feed", ...extra,
});
const batch = [s("1", "EPEver XTRA4210N 40A MPPT", { brand: "EPEver", sku: "XTRA4210N" }), s("2", "Cast iron skillet 12in", { brand: "Lodge" })];

test("a well-formed answer becomes one guess per listing, stamped with the classifier id", () => {
  const { guesses, missing } = guessesFrom(batch, { items: [{ productId: "1", kind: "charge-controller", model: "XTRA4210N", manufacturer: "EPEver" }, { productId: "2", kind: "out-of-scope" }] });
  assert.equal(guesses.length, 2);
  assert.equal(guesses[0].model, "XTRA4210N");
  assert.equal(guesses[0].by, CLASSIFIER_ID);
  assert.equal(guesses[1].model, undefined);
  assert.deepEqual(missing, []);
});

test("an id the model invented, a kind outside the enum and a duplicate answer are all dropped", () => {
  const { guesses, missing } = guessesFrom(batch, { items: [{ productId: "99", kind: "battery" }, { productId: "1", kind: "spaceship" }, { productId: "2", kind: "out-of-scope" }, { productId: "2", kind: "battery" }] });
  assert.equal(guesses.length, 1);
  assert.equal(guesses[0].productId, "2");
  assert.equal(guesses[0].kind, "out-of-scope");
  assert.deepEqual(missing, ["1"]);
});

test("empty strings from the model are absence, not a model called empty", () => {
  const { guesses } = guessesFrom(batch, { items: [{ productId: "1", kind: "charge-controller", model: "  ", manufacturer: "" }] });
  assert.equal(guesses[0].model, undefined);
  assert.equal(guesses[0].manufacturer, undefined);
});

test("a malformed answer yields no guesses and every listing missing, never a throw that hides which", () => {
  const { guesses, missing } = guessesFrom(batch, "garbage");
  assert.deepEqual(guesses, []);
  assert.deepEqual(missing, ["1", "2"]);
});

test("the prompt carries only the fields with signal, one listing per line", () => {
  const p = promptFor(batch);
  assert.equal(p.split("\n").length, 2);
  assert.match(p, /id=1 title="EPEver XTRA4210N 40A MPPT" brand="EPEver" sku="XTRA4210N"/);
  assert.doesNotMatch(p, /https:/);
});
