import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brand } from "@origin89/equipment-schema/brand";
import type { Manufacturer } from "@origin89/equipment-schema/manufacturer";
import { VISION_EXTRACTOR_ID } from "@origin89/equipment-schema/provenance";
import { CONVERTER, PAGE_CONVERTER } from "../apps/worker/src/reading.ts";
import { TABLE_READER } from "../apps/worker/src/spec-table.ts";
import { creditedReadings, namesAny, retailerNames, textKey } from "../tools/gate/retailer.ts";

const shop: Manufacturer = {
  id: "the-cabin-depot",
  name: "The Cabin Depot (retailer house brands)",
  domains: ["thecabindepot.ca"],
  retailer: true,
};
const maker: Manufacturer = { id: "bluetti", name: "BLUETTI", domains: ["bluettipower.com"] };
const brand = (name: string, manufacturer: string): Brand =>
  ({ id: name.toLowerCase(), brand: name, decision: "manufacturer", manufacturer }) as Brand;
const brands = [
  brand("The Cabin Depot", "the-cabin-depot"),
  brand("Kedron", "the-cabin-depot"),
  brand("BLUETTI", "bluetti"),
];

const reading = (sha: string, products = 1) => ({
  sha256: sha.repeat(64),
  url: `https://thecabindepot.ca/cdn/shop/files/${sha}.pdf`,
  products: Array.from({ length: products }, () => ({ model: "X", specs: [] })),
});

test("a retailer answers to its own name without the note, and to every brand resolved to it", () => {
  assert.deepEqual(retailerNames(shop, brands), ["The Cabin Depot", "Kedron"]);
});

test("a name is found whole, in any case and across any spacing, and not inside a longer word", () => {
  assert.equal(namesAny("KEDRON 12VDC 5.0GPM Diaphragm Water Pump", ["Kedron"]), true);
  assert.equal(namesAny("Sold by the\ncabin  depot", ["The Cabin Depot"]), true);
  assert.equal(namesAny("Kedrons are not a brand", ["Kedron"]), false);
  assert.equal(namesAny("BLUETTI EP500 Pro user manual", ["The Cabin Depot", "Kedron"]), false);
});

test("a retailer keeps a document that names its label, and withholds one that names only its supplier", async () => {
  const texts: Record<string, string> = {
    [reading("a").sha256]: "# KEDRON PowerGEN Transfer Switch\n\n| Rated current | 30 A |",
    [reading("b").sha256]: "# BLUETTI EP500 Pro\n\n| Capacity | 5100 Wh |",
  };
  const { keep, withheld } = await creditedReadings(
    shop,
    brands,
    [reading("a", 2), reading("b", 3)],
    async (r) => texts[r.sha256],
  );
  assert.deepEqual(
    keep.map((r) => r.sha256),
    [reading("a").sha256],
  );
  assert.deepEqual(withheld, [
    {
      url: reading("b").url,
      sha256: reading("b").sha256,
      products: 3,
      reason: "it names none of The Cabin Depot, Kedron",
    },
  ]);
});

test("a retailer's document whose text cannot be read is withheld, and one with no products costs no read", async () => {
  const asked: string[] = [];
  const { keep, withheld } = await creditedReadings(
    shop,
    brands,
    [reading("c"), reading("d", 0)],
    async (r) => {
      asked.push(r.sha256);
      return undefined;
    },
  );
  assert.deepEqual(asked, [reading("c").sha256], "the empty reading's text was not fetched");
  assert.deepEqual(
    keep.map((r) => r.sha256),
    [reading("d").sha256],
  );
  assert.equal(withheld[0]?.reason, "its text is not in the archive");
});

test("any other maker is credited with every reading, and no text is fetched", async () => {
  let asked = 0;
  const readings = [reading("e"), reading("f", 4)];
  const { keep, withheld } = await creditedReadings(maker, brands, readings, async () => {
    asked += 1;
    return "nothing that names BLUETTI";
  });
  assert.deepEqual(keep, readings);
  assert.deepEqual(withheld, []);
  assert.equal(asked, 0);
  const unknown = await creditedReadings(undefined, brands, readings, async () => undefined);
  assert.deepEqual(unknown.keep, readings, "a maker with no record is not filtered either");
});

test("a retailer's specification table is withheld without a read: its own site names it on every page", async () => {
  let asked = 0;
  const table = { ...reading("g", 5), extractedBy: TABLE_READER };
  const { keep, withheld } = await creditedReadings(shop, brands, [table], async () => {
    asked += 1;
    return "The Cabin Depot | Anker SOLIX F3800 | 6000 W";
  });
  assert.deepEqual(keep, []);
  assert.equal(asked, 0, "nothing is fetched for it");
  assert.equal(withheld[0]?.products, 5);
  assert.match(withheld[0]?.reason ?? "", /retailer's own site/);
});

test("a reading's text is the conversion or the page transcript, a whole object name", () => {
  const sha = "9".repeat(64);
  assert.equal(textKey({ sha256: sha }), `archive/${sha}.${CONVERTER}.md`);
  assert.equal(
    textKey({ sha256: sha, extractedBy: VISION_EXTRACTOR_ID }),
    `archive/${sha}.${PAGE_CONVERTER}.md`,
  );
  // The archive reads by prefix. The bare document key would also bring back every conversion,
  // transcript and reading under the same hash, and a name in any of them would pass the check.
  assert.notEqual(textKey({ sha256: sha, extractedBy: TABLE_READER }), `archive/${sha}`);
});
