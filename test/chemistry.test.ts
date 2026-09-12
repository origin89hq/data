import assert from "node:assert/strict";
import { test } from "node:test";
import { chemistryIn, chemistryOf } from "../src/chemistry.ts";

const model = (
  name: string,
  over: { variant?: string; family?: string; aliases?: string[] } = {},
) => ({
  name,
  aliases: [],
  ...over,
});
const figure = (id: string, name: string, value: string) => ({ id, name, value });

test("the words makers use for a chemistry are read from a name, and a part number says nothing", () => {
  assert.equal(chemistryIn("12V 100AH LiFePO4 Battery"), "lifepo4");
  assert.equal(chemistryIn("RX-LFP48100"), "lifepo4");
  assert.equal(chemistryIn("KEDRON24V200AHLiFePO"), "lifepo4");
  assert.equal(chemistryIn("BAT-LIT-VIC-SMART-12V-50AH"), "lithium");
  assert.equal(chemistryIn("Lithium NMC"), "lithium");
  assert.equal(chemistryIn("BAT-AGM-VIC-12V-240AH"), "agm");
  assert.equal(chemistryIn("HL12-580WAGM"), "agm");
  assert.equal(chemistryIn("31-GEL"), "gel");
  assert.equal(chemistryIn("Flooded deep cycle"), "flooded");
  assert.equal(chemistryIn("Sealed lead-acid"), "lead-acid");
  assert.equal(chemistryIn("12AVR100"), undefined);
  assert.equal(chemistryIn("Magma 200"), undefined, "a word that merely contains agm is not AGM");
  assert.equal(chemistryIn("Split gel-coat"), "gel");
});

test("a figure on the sheet that states the chemistry comes before the name, and is cited", () => {
  const specs = [
    figure("acme-x--weight", "Weight", "30 kg"),
    figure("acme-x--battery-type", "Battery Type", "LFP (Lithium Iron Phosphate)"),
  ];
  assert.deepEqual(chemistryOf(model("ACME X AGM"), specs), {
    chemistry: "lifepo4",
    chemistryBasis: "spec:acme-x--battery-type",
  });
  assert.deepEqual(
    chemistryOf(model("ACME X AGM"), [figure("acme-x--weight", "Weight", "30 kg")]),
    {
      chemistry: "agm",
      chemistryBasis: "name",
    },
  );
  // A figure named like one but saying nothing readable leaves the name to decide.
  assert.deepEqual(
    chemistryOf(model("ACME X GEL"), [figure("acme-x--type", "Type", "Deep cycle")]),
    { chemistry: "gel", chemistryBasis: "name" },
  );
});

test("an alias, a variant or a family can name the chemistry; nothing does for a bare part number", () => {
  assert.deepEqual(chemistryOf(model("040-02223", { aliases: ["Rolls S48-100LFP ESS"] }), []), {
    chemistry: "lifepo4",
    chemistryBasis: "name",
  });
  assert.deepEqual(chemistryOf(model("SC24150", { variant: "AGM" }), []), {
    chemistry: "agm",
    chemistryBasis: "name",
  });
  assert.equal(chemistryOf(model("12AVR100"), []), undefined);
});
