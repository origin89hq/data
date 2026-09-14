import assert from "node:assert/strict";
import { test } from "node:test";
import { Rejection, Rejections } from "@origin89/equipment-schema/rejection";
import { rejectionsOf, rejectsDocument, rejectsFigure, rejectsProduct } from "../src/rejections.ts";

const reviewed = { reviewedBy: "lemarier", checkedAt: "2026-09-14" };
const document: Rejection = {
  source: "doc-0c5182fdcf174fd7bc5aa4435d69681f",
  reason: "Morningstar's note on a Deka Duration battery: settings for another maker's product",
  ...reviewed,
};
const figure: Rejection = {
  source: "doc-90b14882b7428b66e0286aec3f86a08b",
  model: "magnum-energy-ms4024pae",
  name: "AC In - SOC Connect",
  reason: "A router setting shown on p55, not a rating",
  ...reviewed,
};
const product: Rejection = {
  product: "6TAGM Exide",
  reason: "An Exide battery named in a USMC slide deck",
  ...reviewed,
};

test("a rejection names a document, one figure of a document, or a product, and nothing in between", () => {
  for (const shape of [document, figure, product]) Rejection.parse(shape);
  Rejection.parse({ ...product, source: document.source });
  for (const [bad, why] of [
    [{ ...figure, name: undefined }, "a model with no name"],
    [{ ...figure, model: undefined }, "a name with no model"],
    [{ ...product, model: figure.model }, "a product with a model"],
    [{ reason: "x", ...reviewed }, "nothing named at all"],
    [{ ...document, reviewedBy: undefined }, "no reviewer"],
  ] as const)
    assert.equal(Rejection.safeParse(bad).success, false, why);
  assert.equal(Rejections.safeParse({ id: "morningstar", rejections: [] }).success, false);
});

test("a rejected document rejects every figure it gives, and only its own", () => {
  const rejections = [document, figure];
  assert.equal(rejectsDocument(rejections, document.source ?? ""), true);
  assert.equal(
    rejectsDocument(rejections, figure.source ?? ""),
    false,
    "a figure's rejection does not reject its document",
  );
  const fromDocument = { source: document.source ?? "", model: "morningstar-dd5300", name: "Any" };
  assert.equal(rejectsFigure(rejections, fromDocument), true);
  assert.equal(
    rejectsFigure(rejections, { ...fromDocument, source: "doc-ffffffffffffffffffffffffffffffff" }),
    false,
  );
});

test("a rejected figure is matched by its document, model and printed name, whatever its case or spacing", () => {
  const read = {
    source: figure.source ?? "",
    model: figure.model ?? "",
    name: "ac in -  soc connect",
  };
  assert.equal(rejectsFigure([figure], read), true);
  assert.equal(rejectsFigure([figure], { ...read, name: "AC In - SOC Disconnect" }), false);
  assert.equal(rejectsFigure([figure], { ...read, model: "magnum-energy-ms4024" }), false);
  assert.equal(
    rejectsFigure([figure], { ...read, source: document.source ?? "" }),
    false,
    "the same name in another document is not rejected",
  );
  assert.equal(rejectsFigure([product], read), false, "a product's rejection rejects no figure");
});

test("a rejected product is refused through punctuation and case, and a figure's rejection refuses none", () => {
  assert.equal(rejectsProduct([product], "6TAGM-EXIDE"), true);
  assert.equal(rejectsProduct([product], "6TAGM Hawker"), false);
  assert.equal(rejectsProduct([figure, document], "AC In - SOC Connect"), false);
});

test("a maker's rejections are its own file's, and a maker with no file has none", () => {
  const files: Rejections[] = [
    { id: "morningstar", rejections: [document] },
    { id: "pulsetech", rejections: [product] },
  ];
  assert.deepEqual(rejectionsOf(files, "pulsetech"), [product]);
  assert.deepEqual(rejectionsOf(files, "victron-energy"), []);
  assert.deepEqual(rejectionsOf([], "pulsetech"), []);
});
