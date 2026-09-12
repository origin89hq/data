import assert from "node:assert/strict";
import { test } from "node:test";
import { Model } from "@origin89/equipment-schema/model";
import { applyChemistry, chemistryIn, chemistryOf } from "../src/chemistry.ts";

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

test("a variant or a family can name the chemistry; an alias cannot, since a seller's SKU lands there; nothing does for a bare part number", () => {
  assert.equal(chemistryOf(model("040-02223", { aliases: ["ROLLS-LFP-DEAL"] }), []), undefined);
  assert.deepEqual(chemistryOf(model("SC24150", { variant: "AGM" }), []), {
    chemistry: "agm",
    chemistryBasis: "name",
  });
  assert.equal(chemistryOf(model("12AVR100"), []), undefined);
});

test("a chemistry label in the document's language is read through its English translation, and its words are known", () => {
  assert.deepEqual(
    chemistryOf(model("ACME PT"), [
      {
        id: "acme-pt--quimica-da-bateria",
        name: "Química da bateria",
        english: "Battery chemistry",
        value: "chumbo-ácido",
      },
    ]),
    { chemistry: "lead-acid", chemistryBasis: "spec:acme-pt--quimica-da-bateria" },
  );
  assert.equal(chemistryIn("Fosfato de hierro y litio"), "lifepo4");
  assert.equal(chemistryIn("Plomo-ácido inundada"), "flooded");
  assert.equal(chemistryIn("Batterie au plomb ouverte"), "flooded");
});

test("a chemistry cited from a figure is read again when the figure changes its word", () => {
  const model = Model.parse({
    id: "acme-a",
    manufacturer: "acme",
    name: "ACME A",
    kind: "battery",
    aliases: [],
    dialects: [],
    chemistry: "lifepo4",
    chemistryBasis: "spec:acme-a--chemistry",
  });
  const written: Model[] = [];
  const outcome = applyChemistry(
    [model],
    [
      {
        id: "acme-a--chemistry",
        model: "acme-a",
        name: "Chemistry",
        value: "AGM",
        source: "doc-a",
        extractedBy: "ai:@cf/x@p1",
        confidence: "vendor-doc",
      },
    ],
    (m) => written.push(m),
  );
  assert.deepEqual(outcome, { set: 1, kept: 0, none: 0, cleared: 0 });
  assert.deepEqual(
    written.map((m) => [m.chemistry, m.chemistryBasis]),
    [["agm", "spec:acme-a--chemistry"]],
  );
});

test("a chemistry cited from a figure is read again when the figure is gone, and cleared when nothing else states it", () => {
  const battery = (id: string, name: string, over: Partial<Model> = {}) =>
    Model.parse({
      id,
      manufacturer: "acme",
      name,
      kind: "battery",
      aliases: [],
      dialects: [],
      ...over,
    });
  const spec = (model: string, id: string, name: string, value: string) => ({
    id,
    model,
    name,
    value,
    source: "doc-a",
    extractedBy: "ai:@cf/x@p1",
    confidence: "vendor-doc" as const,
  });
  const cited = battery("acme-a", "ACME A", {
    chemistry: "agm",
    chemistryBasis: "spec:acme-a--chemistry",
  });
  const named = battery("acme-b", "ACME B LFP", {
    chemistry: "agm",
    chemistryBasis: "spec:acme-b--chemistry",
  });
  const bare = battery("acme-c", "ACME C", {
    chemistry: "gel",
    chemistryBasis: "spec:acme-c--chemistry",
  });
  const written: Model[] = [];
  const outcome = applyChemistry(
    [cited, named, bare],
    [spec("acme-a", "acme-a--chemistry", "Chemistry", "AGM")],
    (m) => written.push(m),
  );
  assert.deepEqual(outcome, { set: 1, kept: 1, none: 0, cleared: 1 });
  assert.deepEqual(
    written.map((m) => [m.id, m.chemistry, m.chemistryBasis]),
    [
      ["acme-b", "lifepo4", "name"],
      ["acme-c", undefined, undefined],
    ],
  );
});
