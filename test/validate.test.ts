import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Model } from "@origin89/equipment-schema/model";
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
    };
    assert.equal(
      manifest.counts.sources,
      manifest.files["sources.csv"].rows,
      "the source count is the published table's, feed files included",
    );
    assert.equal(manifest.files["dialects.csv"].rows, 2);
    assert.equal(manifest.files["dialects.parquet"].rows, 2);
    assert.equal(manifest.files["dialect_see_also.csv"].rows, 1);
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
