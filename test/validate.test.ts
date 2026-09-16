import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Dialect } from "@origin89/equipment-schema/dialect";
import { Model } from "@origin89/equipment-schema/model";
import { RecordKind, type SnapshotPlan } from "@origin89/equipment-schema/releases";
import { build } from "../src/build.ts";
import { toCsv } from "../src/csv.ts";
import { loadRecords, type Records, writeRecords } from "../src/records.ts";
import { validate } from "../src/validate.ts";

function fixture(): Records {
  return {
    families: [{ id: "modbus-rs485", intro: "# T", order: ["a", "b"] }],
    dialects: [
      {
        id: "a",
        family: "modbus-rs485",
        driver: { status: "possible" },
        confidence: "vendor-doc",
        refuter: "checked",
        sources: [{ source: "s1", citation: "https://x/1" }],
        seeAlso: ["b"],
        models: [{ name: "A1" }],
      },
      {
        id: "b",
        family: "modbus-rs485",
        driver: { status: "shipped", id: "d" },
        confidence: "unverified",
        refuter: "not-checked",
        sources: [{ source: "s1", citation: "https://x/1" }],
      },
    ],
    sources: [{ id: "s1", url: "https://x/1" }],
    manufacturers: [],
    brands: [],
    models: [],
    specs: [],
    mappings: [],
    rejections: [],
  };
}

test("a consistent set of records validates with no errors", () => {
  assert.deepEqual(validate(fixture()).errors, []);
});

test("a see-also that names nothing is an error, not a dangling pointer somebody finds later", () => {
  const r = fixture();
  r.dialects[0].seeAlso = ["ghost"];
  assert.match(validate(r).errors.join("\n"), /see-also names ghost/);
});

test("a citation of a source that has no record is an error", () => {
  const r = fixture();
  r.dialects[0].sources[0].source = "nowhere";
  assert.match(validate(r).errors.join("\n"), /cites nowhere/);
});

test("a source nothing cites is an error, so a dead file cannot linger", () => {
  const r = fixture();
  r.sources.push({ id: "orphan", url: "https://x/2" });
  assert.match(validate(r).errors.join("\n"), /orphan is cited by nothing/);
});

test("a shipped driver with no id, and a driver id on an unshipped one, are both errors", () => {
  const r = fixture();
  delete r.dialects[1].driver.id;
  r.dialects[0].driver.id = "x";
  const errors = validate(r).errors.join("\n");
  assert.match(errors, /shipped with no driver id/);
  assert.match(errors, /driver id on a driver that has not shipped/);
});

test("a dialect missing from its family's order, or listed twice, is an error", () => {
  const r = fixture();
  r.families[0].order = ["a", "a"];
  const errors = validate(r).errors.join("\n");
  assert.match(errors, /lists a twice/);
  assert.match(errors, /b: not in modbus-rs485's order/);
});

test("records written to disk load back equal, and a file whose id disagrees with its name is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "offgrid-"));
  try {
    writeRecords(fixture(), dir);
    assert.deepEqual(loadRecords(dir), fixture());
    writeFileSync(
      join(dir, "sources", "wrong.json"),
      JSON.stringify({ id: "s9", url: "https://x/9" }),
    );
    assert.throws(() => loadRecords(dir), /does not match filename/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record with a field the schema does not know is refused, so a typo cannot hide as an extra key", () => {
  const dir = mkdtempSync(join(tmpdir(), "offgrid-"));
  try {
    writeRecords(fixture(), dir);
    const path = join(dir, "dialects", "modbus-rs485", "a.json");
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), gotcha: ["singular"] }),
    );
    assert.throws(() => loadRecords(dir), /gotcha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("csv quotes commas, quotes and newlines, and writes absent as empty", () => {
  assert.equal(
    toCsv(
      ["a", "b"],
      [
        { a: 'x,"y"', b: undefined },
        { a: "l1\nl2", b: true },
      ],
    ),
    'a,b\n"x,""y""",\n"l1\nl2",true\n',
  );
});

test("the build refuses invalid records and otherwise emits every table twice with matching row counts", () => {
  const dist = mkdtempSync(join(tmpdir(), "offgrid-dist-"));
  try {
    const bad = fixture();
    bad.dialects[0].seeAlso = ["ghost"];
    assert.throws(() => build(bad, dist), /refusing to build/);
    const manifest = build(fixture(), dist) as {
      counts: { sources: number };
      files: Record<string, { rows?: number; sha256: string }>;
      snapshots: SnapshotPlan;
    };
    assert.equal(
      manifest.counts.sources,
      manifest.files["sources.csv"].rows,
      "the source count is the published table's, feed files included",
    );
    assert.equal(manifest.files["dialects.csv"].rows, 2);
    assert.equal(manifest.files["dialects.parquet"].rows, 2);
    assert.equal(manifest.files["dialect_see_also.csv"].rows, 1);
    // Every record kind is in the snapshot plan; one with records has its part listed, and one
    // with none has no part rather than an empty one.
    assert.deepEqual(Object.keys(manifest.snapshots.kinds), RecordKind.options);
    assert.deepEqual(manifest.snapshots.kinds.dialects, {
      parts: ["records_dialects_0001.json"],
      rows: 2,
    });
    assert.deepEqual(manifest.snapshots.kinds.mappings, { parts: [], rows: 0 });
    assert.equal(manifest.files["records_dialects_0001.json"].rows, 2);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dist, "records_dialects_0001.json"), "utf8")).map(
        (d: { id: string }) => d.id,
      ),
      ["a", "b"],
    );
    const again = build(fixture(), dist) as { files: Record<string, { sha256: string }> };
    for (const [name, f] of Object.entries(manifest.files))
      assert.equal(
        again.files[name].sha256,
        f.sha256,
        `${name} changed between two builds of the same records`,
      );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("a model's link to a dialect needs a source it can name, and one the records hold (#84)", () => {
  const r = fixture();
  const link = {
    dialect: "a",
    evidence: { kind: "vendor-doc", sources: [{ source: "s1", citation: "https://x/1" }] },
    confidence: "vendor-doc",
  };
  r.manufacturers = [{ id: "m", name: "M", domains: [] }] as Records["manufacturers"];
  r.models = [Model.parse({ id: "m-a1", manufacturer: "m", name: "A1", dialects: [link] })];
  assert.deepEqual(validate(r).errors, []);
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [{ ...link, evidence: { kind: "vendor-doc", sources: [] } }],
      }),
    /sources/,
    "a link with no source is refused by the schema",
  );
  // A catalogue name cites nothing of its own: the dialect's sources stay on the dialect.
  const claim = Model.parse({
    id: "m-a1",
    manufacturer: "m",
    name: "A1",
    dialects: [{ ...link, evidence: { kind: "catalogue-name" }, confidence: "unverified" }],
  });
  assert.deepEqual(claim.dialects[0]?.evidence, { kind: "catalogue-name", sources: [] });
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [{ ...link, evidence: { kind: "catalogue-name" } }],
      }),
    /catalogue name supports nothing/,
    "a catalogue claim cannot carry the dialect's rating as its own",
  );
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [
          {
            ...link,
            evidence: {
              kind: "vendor-doc",
              sources: Array.from({ length: 17 }, (_, i) => ({ source: `s${i}`, citation: "p" })),
            },
          },
        ],
      }),
    /16/,
    "a link cites at most sixteen sources",
  );
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [
          { ...link, evidence: { kind: "catalogue-name", sources: link.evidence.sources } },
        ],
      }),
    /cites nothing of its own/,
    "a source copied onto a catalogue claim would read as evidence for the model",
  );
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [
          link,
          { ...link, evidence: { kind: "catalogue-name" }, confidence: "unverified" },
        ],
      }),
    /links each dialect once/,
    "two links to one dialect would publish two rows",
  );
  assert.throws(
    () =>
      Model.parse({
        id: "m-a1",
        manufacturer: "m",
        name: "A1",
        dialects: [{ ...link, firmware: {} }],
      }),
    /firmware range names a bound/,
  );
  r.models = [
    Model.parse({
      id: "m-a1",
      manufacturer: "m",
      name: "A1",
      dialects: [
        {
          ...link,
          evidence: { kind: "register-match", sources: [{ source: "nowhere", citation: "p. 4" }] },
        },
      ],
    }),
  ];
  assert.match(validate(r).errors.join("\n"), /link to a cites nowhere, which is not a source/);
  // A source only a link cites is cited: that is what register evidence on one model looks like.
  r.sources.push({ id: "register-map", url: "https://x/map" });
  r.models = [
    Model.parse({
      id: "m-a1",
      manufacturer: "m",
      name: "A1",
      dialects: [
        {
          ...link,
          evidence: {
            kind: "register-match",
            sources: [{ source: "register-map", citation: "p. 4" }],
          },
        },
      ],
    }),
  ];
  assert.deepEqual(validate(r).errors, []);
});

test("a structured reading or code cites a document the records hold, or it is refused (#84)", () => {
  const r = fixture();
  const reading = {
    metric: "pv-voltage",
    at: "0x3100",
    unit: "V",
    scale: 0.01,
    origin: "measured",
    source: "s1",
  };
  const code = {
    table: "charge-stage",
    at: "0x3201 bits 3–2",
    code: "01",
    meaning: "Float.",
    source: "s1",
  };
  r.dialects[0] = Dialect.parse({ ...r.dialects[0], readings: [reading], codes: [code] });
  assert.match(
    validate(r).errors.join("\n"),
    /reading pv-voltage at 0x3100 is not among the metrics it reports/,
    "a structured reading has to be advertised",
  );
  r.dialects[0] = Dialect.parse({ ...r.dialects[0], reports: ["pv-voltage"] });
  assert.deepEqual(validate(r).errors, []);
  assert.throws(
    () => Dialect.parse({ ...r.dialects[0], readings: [{ ...reading, unit: undefined }] }),
    /a scale needs a unit/,
  );
  assert.throws(
    () => Dialect.parse({ ...r.dialects[0], readings: [{ ...reading, order: "low-first" }] }),
    /an order needs words/,
  );
  assert.throws(
    () => Dialect.parse({ ...r.dialects[0], readings: [{ ...reading, words: 2 }] }),
    /needs its word order/,
    "a value over several registers says which word comes first",
  );
  assert.throws(
    () => Dialect.parse({ ...r.dialects[0], codes: [{ ...code, source: undefined }] }),
    /source/,
  );
  r.dialects[0] = Dialect.parse({
    ...r.dialects[0],
    readings: [{ ...reading, source: "nowhere" }],
    codes: [{ ...code, source: "gone" }],
  });
  const errors = validate(r).errors.join("\n");
  assert.match(errors, /reading pv-voltage at 0x3100 cites nowhere, which does not exist/);
  assert.match(errors, /charge-stage code 01 cites gone, which does not exist/);
});

test("a dialect's readings and codes are bounded, and a reading may say which models give it", () => {
  const reading = {
    metric: "pv-voltage",
    at: "0x3100",
    unit: "V",
    origin: "measured",
    source: "s",
  };
  const base = {
    id: "d",
    family: "modbus-rs485",
    driver: { status: "not-planned" },
    confidence: "unverified",
    refuter: "unrecorded",
    sources: [{ source: "s", citation: "c" }],
    reports: ["pv-voltage"],
  };
  const parsed = Dialect.parse({
    ...base,
    readings: [{ ...reading, conditional: "models with a load output" }],
  });
  assert.equal(parsed.readings?.[0]?.conditional, "models with a load output");
  assert.throws(
    () => Dialect.parse({ ...base, readings: Array.from({ length: 257 }, () => reading) }),
    /256/,
    "more readings than a register map has is refused",
  );
  assert.throws(
    () =>
      Dialect.parse({
        ...base,
        codes: Array.from({ length: 513 }, (_, i) => ({
          table: "fault",
          code: String(i),
          meaning: "m",
          source: "s",
        })),
      }),
    /512/,
    "more code entries than a vendor table has is refused",
  );
});

/** Magnum's MS4024PAE with a router setting read as its figure, and the file that rejects it. */
function withRejection(rejection: Records["rejections"][number]["rejections"][number]): Records {
  return {
    ...fixture(),
    manufacturers: [
      { id: "magnum-energy", name: "Magnum Energy", domains: [] },
    ] as Records["manufacturers"],
    models: [
      {
        id: "magnum-energy-ms4024pae",
        manufacturer: "magnum-energy",
        name: "MS4024PAE",
        aliases: ["MS4024 PAE"],
        dialects: [],
      },
    ],
    specs: [
      {
        id: "magnum-energy-ms4024pae--ac-in-soc-connect",
        model: "magnum-energy-ms4024pae",
        name: "AC In - SOC Connect",
        value: "80",
        unit: "%",
        source: "s1",
        extractedBy: "ai:@cf/test@p1",
        confidence: "vendor-doc",
      },
    ],
    rejections: [{ id: "magnum-energy", rejections: [rejection] }],
  };
}
const reviewed = { reviewedBy: "lemarier", checkedAt: "2026-09-14" };

test("a rejection of a figure or a product the records still hold is an error, and passes once it is gone", () => {
  const setting = {
    source: "s1",
    model: "magnum-energy-ms4024pae",
    name: "ac in -  soc connect",
    reason: "a router setting shown on p55, not a rating",
    ...reviewed,
  };
  const held = withRejection(setting);
  assert.deepEqual(validate(held).errors, [
    "rejections magnum-energy entry 1: rejects spec magnum-energy-ms4024pae--ac-in-soc-connect, which the records still hold",
  ]);
  assert.deepEqual(validate({ ...held, specs: [] }).errors, [], "the figure deleted with it");
  assert.deepEqual(
    validate(withRejection({ source: "s1", reason: "not this maker's ratings", ...reviewed }))
      .errors,
    [
      "rejections magnum-energy entry 1: rejects spec magnum-energy-ms4024pae--ac-in-soc-connect, which the records still hold",
    ],
    "a rejected document rejects every figure it gave",
  );
  assert.deepEqual(
    validate({ ...withRejection({ product: "MS4024-PAE", reason: "x", ...reviewed }), specs: [] })
      .errors,
    [
      "rejections magnum-energy entry 1: rejects MS4024-PAE, which is model magnum-energy-ms4024pae",
    ],
  );
});

test("a rejection file names a maker that exists, once, with a date that has happened and a document it can name", () => {
  const product = { product: "6TAGM Exide", reason: "an Exide battery", ...reviewed };
  const records = { ...withRejection(product), specs: [] };
  assert.deepEqual(validate(records).errors, []);
  assert.deepEqual(
    validate({ ...records, rejections: [{ id: "exide", rejections: [product] }] }).errors,
    ["rejections exide: names a manufacturer that does not exist"],
  );
  assert.deepEqual(
    validate({ ...records, rejections: [...records.rejections, ...records.rejections] }).errors,
    ["rejections magnum-energy: listed twice"],
  );
  assert.deepEqual(
    validate(withRejection({ ...product, checkedAt: "2999-01-01" })).errors.filter((e) =>
      e.includes("has not happened"),
    ),
    ["rejections magnum-energy entry 1: reviewed on 2999-01-01, which has not happened"],
  );
  const unnamed = { source: "not-a-document", reason: "x", ...reviewed };
  assert.deepEqual(validate({ ...withRejection(unnamed), specs: [] }).errors, [
    "rejections magnum-energy entry 1: not-a-document is neither a source nor a document's id",
  ]);
  const documentId = { source: "doc-0c5182fdcf174fd7bc5aa4435d69681f", reason: "x", ...reviewed };
  assert.deepEqual(
    validate({ ...withRejection(documentId), specs: [] }).errors,
    [],
    "a document with no source record left is still a document",
  );
  const figure = { source: "s1", name: "Power", reason: "x", ...reviewed };
  assert.deepEqual(
    validate({ ...withRejection({ ...figure, model: "victron-energy-x" }), specs: [] }).errors,
    ["rejections magnum-energy entry 1: victron-energy-x is not a model of magnum-energy"],
    "a model id of another maker rejects nothing, so it is refused",
  );
  const unheld = validate({
    ...withRejection({ ...figure, model: "magnum-energy-ms4024pae-x" }),
    specs: [],
  });
  assert.deepEqual(unheld.errors, [], "a model only a pull would mint can still be named");
  assert.equal(unheld.review["rejection of a figure on a model the records do not hold"], 1);
});
