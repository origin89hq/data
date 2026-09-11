import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  attachMakers,
  type Feed,
  type FeedModel,
  feedSource,
  parseCsv,
  readFeeds,
  readSam,
  uniqueIds,
} from "../src/feeds.ts";

const sam: Feed = {
  id: "sam-cec",
  title: "SAM component libraries",
  publisher: "NREL",
  license: "BSD-3-Clause",
  repository: "https://github.com/NatLabRockies/SAM",
  commit: "abc123",
  retrievedAt: "2026-09-01",
  files: [],
};

/** A library file shaped like SAM's: names, then units, then internal keys, then rows. */
function library(rows: string[][]): { dir: string; sha256: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), "offgrid-feed-"));
  const text = rows.map((r) => r.join(",")).join("\n");
  writeFileSync(join(dir, "CEC Modules.csv"), text);
  return {
    dir,
    name: "CEC Modules.csv",
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

test("a quoted field keeps its commas, and a doubled quote is one quote", () => {
  assert.deepEqual(parseCsv('a,b\n"x,y","he said ""hi"""\n'), [
    ["a", "b"],
    ["x,y", 'he said "hi"'],
  ]);
  assert.deepEqual(parseCsv(""), []);
});

test("the pinned feed reads, and every figure carries the unit its own units row states", () => {
  const [{ feed, models }] = readFeeds();
  assert.equal(feed.license, "BSD-3-Clause");
  assert.ok(models.length > 20_000, "the SAM libraries hold tens of thousands of products");
  const panel = models.find((m) => m.kind === "panel");
  assert.ok(panel?.specs.some((s) => s.name === "Nameplate power at standard test conditions"));
  const inverter = models.find((m) => m.kind === "inverter");
  assert.ok(inverter?.specs.some((s) => s.name === "Maximum AC power output" && s.unit === "W"));
  assert.ok(inverter);
  assert.doesNotMatch(
    inverter.name,
    /^[A-Za-z ]+:/,
    "an inverter's maker is not left glued to the front of its model name",
  );
});

test("the feed holds no repeated id, every figure cites a file source, and STC figures say so (#81)", () => {
  const [{ feed, models }] = readFeeds();
  const ids = new Set(models.map((m) => m.id));
  assert.equal(ids.size, models.length, "one id per row, so a keyed store keeps every row");
  const sources = new Set(feed.files.map((file) => feedSource(feed, file).id));
  assert.ok(
    models.every((m) => sources.has(m.source)),
    "every row cites one of the feed's files",
  );
  const panel = models.find((m) => m.kind === "panel");
  assert.ok(panel);
  const by = (name: string) => panel.specs.find((s) => s.name === name);
  assert.deepEqual(
    [by("Nameplate power at standard test conditions")?.unit, by("Open-circuit voltage")?.unit],
    [undefined, "V"],
    "a unit the units row leaves blank stays blank; Voc keeps the one it states",
  );
  assert.equal(by("Open-circuit voltage")?.conditions, "STC");
  assert.equal(by("Power at PVUSA test conditions")?.conditions, "PTC");
  assert.equal(by("Cells in series")?.conditions, undefined, "a count has no test condition");
  assert.equal(by("Temperature coefficient of open-circuit voltage")?.unit, "V/K");
  assert.equal(by("Temperature coefficient of maximum power")?.unit, "%/K");
});

test("a name the library lists twice keeps both rows under distinct ids, in file order", () => {
  const lib = library([
    ["Name", "Manufacturer", "STC", "V_oc_ref"],
    ["Units", "", "", "V"],
    ["[0]", "lib_manufacturer", "", "cec_v_oc_ref"],
    ["Acme A-100", "Acme", "100", "21.9"],
    ["Acme A-100", "Acme", "105", "22.1"],
    ["Acme A-100 2", "Acme", "110", "22.3"],
    ["Acme A-100", "Acme", "115", "22.5"],
  ]);
  try {
    const feed = { ...sam, files: [{ ...lib, kind: "panel" as const }] };
    const rows = readSam(lib.dir, feed.files[0], feed);
    assert.deepEqual(
      rows.map((m) => [m.id, m.specs[0].value]),
      [
        ["sam-cec-acme-acme-a-100", "100"],
        ["sam-cec-acme-acme-a-100-3", "105"],
        ["sam-cec-acme-acme-a-100-2", "110"],
        ["sam-cec-acme-acme-a-100-4", "115"],
      ],
      "the second row skips the suffix a real product already uses",
    );
    assert.equal(rows[0].source, "sam-cec-cec-modules");
    assert.equal(rows[0].specs[0].unit, undefined, "the file states no unit for STC power");
    assert.equal(rows[0].specs[1].conditions, "STC");
  } finally {
    rmSync(lib.dir, { recursive: true, force: true });
  }
});

test("a cell that states nothing is no figure, whichever of the library's three ways it says so", () => {
  const lib = library([
    ["Name", "Manufacturer", "STC", "PTC", "V_oc_ref", "alpha_sc"],
    ["Units", "", "", "", "V", "A/K"],
    ["[0]", "lib_manufacturer", "", "", "", ""],
    ["Acme A-100", "Acme", "100", "NaN", "0", "-5.04E-05"],
    ["Acme A-200", "Acme", "", "NaN", "0", ""],
  ]);
  try {
    const feed = { ...sam, files: [{ ...lib, kind: "panel" as const }] };
    const rows = readSam(lib.dir, feed.files[0], feed);
    assert.deepEqual(
      rows.map((m) => [m.id, m.specs.map((s) => [s.name, s.value])]),
      [
        [
          "sam-cec-acme-acme-a-100",
          [
            ["Nameplate power at standard test conditions", "100"],
            ["Temperature coefficient of short-circuit current", "-5.04E-05"],
          ],
        ],
      ],
      "NaN, zero and an empty cell are dropped, and a row with no figure left is dropped with them",
    );
  } finally {
    rmSync(lib.dir, { recursive: true, force: true });
  }
});

test("a file whose bytes are not the pinned ones is refused before a row is read", () => {
  const lib = library([
    ["Name", "STC"],
    ["Units", ""],
    ["[0]", ""],
    ["Acme A-100", "100"],
  ]);
  try {
    const feed = { ...sam, files: [{ ...lib, sha256: "0".repeat(64), kind: "panel" as const }] };
    assert.throws(() => readSam(lib.dir, feed.files[0], feed), /sha256 is/);
  } finally {
    rmSync(lib.dir, { recursive: true, force: true });
  }
});

test("a feed file is a source at the pinned commit with the hash the pin states", () => {
  assert.deepEqual(
    feedSource(sam, { name: "CEC Modules.csv", sha256: "f".repeat(64), kind: "panel" }),
    {
      id: "sam-cec-cec-modules",
      url: "https://raw.githubusercontent.com/NatLabRockies/SAM/abc123/deploy/libraries/CEC%20Modules.csv",
      title: "SAM component libraries: CEC Modules.csv",
      publisher: "NREL",
      revision: "abc123",
      sha256: "f".repeat(64),
      retrievedAt: "2026-09-01",
      redistributable: true,
    },
  );
  const row = (id: string): FeedModel => ({
    id,
    feed: "f",
    source: "s",
    manufacturerName: "m",
    name: id,
    kind: "panel",
    specs: [],
  });
  assert.deepEqual(
    uniqueIds([row("a"), row("a"), row("a")]).map((m) => m.id),
    ["a", "a-2", "a-3"],
  );
  assert.deepEqual(uniqueIds([]), []);
});

test("a feed does not mint manufacturers; it attaches only to ones somebody confirmed", () => {
  const rows: FeedModel[] = [
    {
      id: "a",
      feed: "f",
      source: "s",
      manufacturerName: "EPEver",
      name: "X",
      kind: "panel",
      specs: [],
    },
    {
      id: "b",
      feed: "f",
      source: "s",
      manufacturerName: "Nobody At All",
      name: "Y",
      kind: "panel",
      specs: [],
    },
  ];
  const attached = attachMakers(rows, [
    { id: "epever", name: "EPEver (Beijing Epsolar Technology)", aliases: ["EP Solar"] },
  ]);
  assert.equal(attached[0].manufacturer, "epever", "a maker's short name reaches its record");
  assert.equal(
    attached[1].manufacturer,
    undefined,
    "an unknown name stays a name, and the gate decides",
  );
  assert.equal(
    attachMakers(rows, [{ id: "epever", name: "x", aliases: ["EP Solar"] }])[0].manufacturer,
    undefined,
  );
  assert.equal(
    attachMakers(
      [{ ...rows[0], manufacturerName: "ep solar" }],
      [{ id: "epever", name: "x", aliases: ["EP Solar"] }],
    )[0].manufacturer,
    "epever",
    "an alias the gate decided reaches it too",
  );
});
