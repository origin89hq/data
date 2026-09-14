import assert from "node:assert/strict";
import { test } from "node:test";
import { diffDumps, report } from "../tools/mappings/properties-diff.ts";
import type { Dump, DumpedProperty } from "../tools/mappings/properties-dump.ts";

const row = (over: Partial<DumpedProperty>): DumpedProperty => ({
  model: "acme-x",
  key: "pv.voc.max",
  status: "value",
  value: 150,
  unit: "V",
  conditions: {},
  claim: "acme-x--max-voc",
  ...over,
});

test("a properties diff names each row that appeared, went or changed, and each gap that moved", () => {
  const before: Dump = {
    properties: [row({}), row({ key: "pv.isc.max", value: 20, unit: "A", claim: "acme-x--isc" })],
    gaps: [
      { model: "acme-x", key: "pv.power.max", reason: "unparsed", detail: "no unit", claims: 1 },
    ],
  };
  const after: Dump = {
    properties: [
      row({ value: 145 }),
      row({ key: "pv.power.max", value: 1000, unit: "W", claim: "acme-x--pv-power" }),
    ],
    gaps: [
      {
        model: "acme-x",
        key: "pv.isc.max",
        reason: "unparsed",
        detail: '"Amax" is not a unit',
        claims: 1,
      },
    ],
  };
  const diff = diffDumps(before, after);
  assert.deepEqual(
    diff.added.map((p) => p.key),
    ["pv.power.max"],
  );
  assert.deepEqual(
    diff.removed.map((p) => p.key),
    ["pv.isc.max"],
  );
  assert.deepEqual(
    diff.changed.map((c) => [c.before.value, c.after.value]),
    [[150, 145]],
  );
  assert.deepEqual(
    diff.gaps.map((g) => [
      g.before?.key ?? g.after?.key,
      g.before?.reason ?? "none",
      g.after?.reason ?? "none",
    ]),
    [
      ["pv.power.max", "unparsed", "none"],
      ["pv.isc.max", "none", "unparsed"],
    ],
  );
  const lines = report(diff);
  assert.equal(lines[0], "1 properties added, 1 removed, 1 changed; 2 gaps moved");
  assert.ok(lines.some((l) => l.startsWith("+ acme-x pv.power.max = 1000 W")));
  assert.ok(lines.some((l) => l.startsWith("- acme-x pv.isc.max = 20 A")));
  assert.ok(lines.some((l) => l.startsWith("~ acme-x pv.voc.max: 150 V -> 145 V")));
  assert.ok(
    lines.some((l) => l.startsWith("? acme-x pv.power.max: unparsed (no unit), 1 claim -> no gap")),
  );
  // A gap whose reason stands but whose claims grew is a move too: a second unread figure arrived.
  const gap = (claims: number) => ({
    model: "acme-x",
    key: "pv.isc.max",
    reason: "unparsed" as const,
    detail: "no unit",
    claims,
  });
  const grew = diffDumps({ properties: [], gaps: [gap(1)] }, { properties: [], gaps: [gap(2)] });
  assert.equal(grew.gaps.length, 1);
  assert.ok(
    report(grew).some((l) =>
      l.endsWith("unparsed (no unit), 1 claim -> unparsed (no unit), 2 claims"),
    ),
  );
  // Nothing moved: one line.
  assert.deepEqual(report(diffDumps(before, before)), [
    "0 properties added, 0 removed, 0 changed; 0 gaps moved",
  ]);
});
