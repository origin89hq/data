import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { HEADLINES, HERO_QUERY } from "../src/hero.ts";

/** model, key, status, value, unit, fuel, page, claim */
type Property = [
  string,
  string,
  string,
  number | null,
  string,
  string | null,
  number | null,
  string,
];

const literal = (value: unknown) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
const values = (rows: unknown[][]) =>
  rows.map((row) => `(${row.map(literal).join(", ")})`).join(", ");

/**
 * What `HERO_QUERY` picks from these tables, run by the DuckDB CLI the build already needs. The
 * tables carry only the columns the query reads. The rows come back as one JSON string: the CLI's
 * JSON mode prints `[{]` for an empty result.
 */
function pick({
  models,
  makers = [["acme", "Acme", "https://data.example/logos/acme-128.png"]],
  doubts = [],
  properties,
}: {
  models: [string, string, string][];
  makers?: [string, string, string | null][];
  doubts?: [string, string][];
  properties: Property[];
}): Record<string, unknown>[] {
  const claims = properties.map(({ 7: claim }) => [
    claim,
    doubts.find(([id]) => id === claim)?.[1] ?? null,
  ]);
  const tables = [
    `models(id, kind, manufacturer_id) AS (VALUES ${values(models)})`,
    `manufacturers(id, name, logo) AS (VALUES ${values(makers)})`,
    `specs(id, doubt) AS (VALUES ${values(claims)})`,
    `properties(model_id, key, status, value, unit, fuel, page, basis, claim_id) AS (VALUES ${values(
      properties.map((p) => [...p.slice(0, 7), "extracted", p[7]]),
    )})`,
  ];
  const out = execFileSync(
    "duckdb",
    [
      "-list",
      "-noheader",
      "-c",
      `WITH ${tables.join(", ")} SELECT coalesce(to_json(list(q)), '[]') FROM (${HERO_QUERY}) q`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as Record<string, unknown>[];
}

test("each kind names one headline", () => {
  assert.equal(new Set(HEADLINES.map(({ kind }) => kind)).size, HEADLINES.length);
});

test("a generator is preferred to a battery, by its largest running power across fuels", () => {
  const rows = pick({
    models: [
      ["acme-100", "battery", "acme"],
      ["acme-gen", "generator", "acme"],
    ],
    properties: [
      ["acme-100", "battery.capacity", "value", 100, "Ah", null, 2, "c1"],
      ["acme-gen", "generator.power.running", "value", 6300, "W", "lpg", 35, "c2"],
      ["acme-gen", "generator.power.running", "value", 7000, "W", "gasoline", 35, "c3"],
    ],
  });
  assert.deepEqual(rows, [
    {
      model_id: "acme-gen",
      kind: "generator",
      value: 7000,
      unit: "W",
      fuel: "gasoline",
      page: 35,
      basis: "extracted",
      maker: "Acme",
      logo: "https://data.example/logos/acme-128.png",
    },
  ]);
});

test("between two qualifying models of one kind, the lower model id leads, whatever its figure", () => {
  const [row] = pick({
    models: [
      ["gen-b", "generator", "acme"],
      ["gen-a", "generator", "acme"],
    ],
    properties: [
      ["gen-b", "generator.power.running", "value", 9000, "W", "gasoline", 12, "c1"],
      ["gen-a", "generator.power.running", "value", 3000, "W", "gasoline", 4, "c2"],
    ],
  });
  assert.equal(row?.model_id, "gen-a");
  assert.equal(row?.value, 3000);
});

test("a generator's starter battery is not its headline: the key has to be its kind's", () => {
  const [row] = pick({
    models: [
      ["champ-gen", "generator", "acme"],
      ["acme-100", "battery", "acme"],
    ],
    properties: [
      ["champ-gen", "battery.capacity", "value", 9, "Ah", null, 38, "c1"],
      ["acme-100", "battery.capacity", "value", 100, "Ah", null, 2, "c2"],
    ],
  });
  assert.equal(row?.model_id, "acme-100");
});

test("a doubted figure, one read off no page, and one that is not a single value are passed over", () => {
  const [row] = pick({
    models: [
      ["gen-a", "generator", "acme"],
      ["gen-b", "generator", "acme"],
      ["gen-c", "generator", "acme"],
      ["acme-100", "battery", "acme"],
    ],
    doubts: [["c1", "the table and the text disagree"]],
    properties: [
      ["gen-a", "generator.power.running", "value", 7000, "W", "gasoline", 35, "c1"],
      ["gen-b", "generator.power.running", "value", 5000, "W", "gasoline", null, "c2"],
      ["gen-c", "generator.power.running", "range", null, "W", "gasoline", 12, "c3"],
      ["acme-100", "battery.capacity", "value", 100, "Ah", null, 2, "c4"],
    ],
  });
  assert.equal(row?.model_id, "acme-100");
});

test("a maker with no mark still gives its figure; nothing that qualifies gives no row", () => {
  const [row] = pick({
    models: [["bolt-gen", "generator", "bolt"]],
    makers: [["bolt", "Bolt", null]],
    properties: [["bolt-gen", "generator.power.running", "value", 3500, "W", null, 4, "c1"]],
  });
  assert.equal(row?.maker, "Bolt");
  assert.equal(row?.logo, null);

  assert.deepEqual(
    pick({
      models: [["bolt-gen", "generator", "bolt"]],
      properties: [["bolt-gen", "generator.power.running", "value", 3500, "W", null, null, "c1"]],
    }),
    [],
  );
});
